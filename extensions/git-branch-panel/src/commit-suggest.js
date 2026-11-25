'use strict';

const fs = require('fs');
const path = require('path');
const { runGit } = require('./git-runner');
const { checkSecretFiles } = require('./git-state');

const MAX_DIFF_CHARS = 5000;
const MAX_SUGGESTION_LEN = 72;
const MAX_UNTRACKED_FILES = 4;
const MAX_UNTRACKED_BYTES = 32 * 1024;
const MAX_UNTRACKED_LINES = 50;

function redactDiffText(text) {
  return String(text || '')
    .replace(/(https?:\/\/)[^/\s@]+@/gi, '$1[REDACTED]@')
    .replace(/(\b(?:Bearer|Basic)\s+)[A-Za-z0-9_.~+/-]+=*/gi, '$1[REDACTED]')
    .replace(/((?:token|secret|password|passwd|api[_-]?key|private[_-]?key|authorization)\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;]+)/gi, '$1[REDACTED]')
    .replace(/\b(?:AQ\.[A-Za-z0-9._-]{12,}|AIza[0-9A-Za-z_-]{20,}|gh[opusr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|sk-[A-Za-z0-9_-]{16,})\b/g, '[REDACTED]')
    .replace(/-----BEGIN [A-Z ]+PRIVATE KEY-----[\s\S]*?-----END [A-Z ]+PRIVATE KEY-----/g, '[REDACTED PRIVATE KEY]');
}

function cleanCommitLine(raw) {
  if (typeof raw !== 'string') return '';
  const firstLine = raw
    .replace(/^```[^\n]*\n?/, '')
    .replace(/```$/, '')
    .split(/\r?\n/)
    .map(line => line.trim())
    .find(Boolean) || '';
  const stripped = firstLine.replace(/^["'`]+|["'`]+$/g, '').replace(/\s+/g, ' ').trim();
  if (!stripped || stripped.length < 4) return '';
  return stripped.length > MAX_SUGGESTION_LEN ? stripped.slice(0, MAX_SUGGESTION_LEN - 1).trimEnd() : stripped;
}

function sanitizeScopeToken(raw) {
  return String(raw || '').replace(/[^a-z0-9._/-]/gi, '').replace(/^\/+|\/+$/g, '').slice(0, 22);
}

function inferScope(files) {
  if (!files.length) return '';
  const normalized = files.map(file => file.replace(/\\/g, '/'));
  // Next.js App Router: app/api/users/route.ts -> api/users; app/dashboard/page.tsx -> dashboard
  if (normalized.length === 1) {
    const apiMatch = normalized[0].match(/(?:^|\/)app\/(api\/[^/]+)\/route\.[jt]sx?$/i);
    if (apiMatch) return sanitizeScopeToken(apiMatch[1]);
    const pageMatch = normalized[0].match(/(?:^|\/)app\/([^/]+)\/(?:page|layout|loading|error)\.[jt]sx?$/i);
    if (pageMatch) return sanitizeScopeToken(pageMatch[1]);
    if (/\.prisma$/i.test(normalized[0])) return 'prisma';
    if (/(^|\/)package\.json$/i.test(normalized[0])) return 'deps';
    if (/(^|\/)\.github\/workflows\//i.test(normalized[0])) return 'ci';
  }
  const segments = normalized.map(file => file.split('/').filter(Boolean));
  const firstDirs = new Set(segments.filter(parts => parts.length > 1).map(parts => parts[0]));
  if (firstDirs.size === 1) {
    const top = [...firstDirs][0];
    if (['src', 'app', 'pages', 'components', 'lib', 'api', 'server', 'tests', 'docs', 'scripts', 'config', 'extensions'].includes(top)) {
      const subDirs = new Set(segments.filter(parts => parts.length > 2).map(parts => parts[1]));
      if (subDirs.size === 1) return sanitizeScopeToken([...subDirs][0]);
      return sanitizeScopeToken(top);
    }
    return sanitizeScopeToken(top);
  }
  if (files.length === 1) {
    const stem = sanitizeScopeToken(path.basename(normalized[0], path.extname(normalized[0])));
    if (stem) return stem;
  }
  return '';
}

function extractSymbolsFromLines(lines) {
  const symbols = [];
  const httpMethods = new Set();
  const prismaModels = [];
  const headings = [];
  const testTitles = [];
  const seen = new Set();
  const push = name => {
    if (!name || name.length < 2 || name.length > 32 || seen.has(name)) return;
    if (/^(if|for|while|switch|catch|return|default|export|import|async|await|const|let|var|true|false|null|undefined)$/i.test(name)) return;
    seen.add(name);
    symbols.push(name);
  };
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const httpMatch = trimmed.match(/^export\s+(?:async\s+)?function\s+(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b/);
    if (httpMatch) {
      httpMethods.add(httpMatch[1]);
      continue;
    }
    const fnMatch = trimmed.match(/^(?:export\s+(?:default\s+)?)?(?:async\s+)?function\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/);
    if (fnMatch) { push(fnMatch[1]); continue; }
    const clsMatch = trimmed.match(/^(?:export\s+(?:default\s+)?)?(?:abstract\s+)?(?:class|interface|type|enum)\s+([A-Za-z_$][A-Za-z0-9_$]*)\b/);
    if (clsMatch) { push(clsMatch[1]); continue; }
    const constFnMatch = trimmed.match(/^(?:export\s+)?const\s+([A-Za-z_$][A-Za-z0-9_$]*)(?:\s*:\s*[^=\r\n]{1,40})?\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/);
    if (constFnMatch) { push(constFnMatch[1]); continue; }
    const prismaMatch = trimmed.match(/^(?:model|enum)\s+([A-Z][A-Za-z0-9_]*)\s*\{/);
    if (prismaMatch && !prismaModels.includes(prismaMatch[1])) { prismaModels.push(prismaMatch[1]); continue; }
    const mdMatch = trimmed.match(/^#{1,3}\s+([A-Za-z0-9\u0400-\u04FF][^#\r\n]{2,45})$/);
    if (mdMatch && headings.length < 3) { headings.push(mdMatch[1].trim()); continue; }
    const testMatch = trimmed.match(/^(?:test|it|describe)\s*\(\s*['"`]([^'"`\r\n]{4,50})['"`]/);
    if (testMatch && testTitles.length < 3) { testTitles.push(testMatch[1].trim()); }
  }
  return { symbols, httpMethods: [...httpMethods], prismaModels, headings, testTitles };
}

function extractHunkFunctionName(header) {
  const text = String(header || '').trim();
  if (!text) return '';
  const patterns = [
    /(?:async\s+)?function\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/,
    /(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*(?:async\s*)?(?:\(|function\b)/,
    /class\s+([A-Za-z_$][A-Za-z0-9_$]*)\b/,
    /^(?:async\s+)?([A-Za-z_$][A-Za-z0-9_$]*)\s*\([^)]*\)\s*\{/,
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (m && m[1] && !/^(if|for|while|switch|catch|constructor)$/i.test(m[1])) return m[1];
  }
  return '';
}

function extractPackageJsonChanges(addedLines, removedLines) {
  const parseEntries = lines => {
    const map = new Map();
    for (const line of lines) {
      const m = line.match(/^\s*"([^"]+)"\s*:\s*"([^"]+)"/);
      if (m) map.set(m[1], m[2]);
    }
    return map;
  };
  const added = parseEntries(addedLines);
  const removed = parseEntries(removedLines);
  const versionBump = added.get('version') && added.get('version') !== removed.get('version') ? added.get('version') : '';
  const addedDeps = [];
  const removedDeps = [];
  const updatedDeps = [];
  const skip = new Set(['name', 'version', 'description', 'main', 'license', 'author', 'type', 'private']);
  for (const [k, v] of added.entries()) {
    if (skip.has(k) || !/^[\^~>=<\d*]|^(?:workspace:|npm:|file:)/.test(v)) continue;
    if (removed.has(k)) {
      if (removed.get(k) !== v) updatedDeps.push(k);
    } else {
      addedDeps.push(k);
    }
  }
  for (const [k, v] of removed.entries()) {
    if (skip.has(k) || added.has(k) || !/^[\^~>=<\d*]|^(?:workspace:|npm:|file:)/.test(v)) continue;
    removedDeps.push(k);
  }
  return { versionBump, addedDeps, removedDeps, updatedDeps };
}

function analyzeDiff(files, diffText, statusMap = new Map()) {
  const lines = String(diffText || '').split(/\r?\n/);
  const addedLines = [];
  const removedLines = [];
  const hunkFunctions = [];
  const contextFunctions = [];
  const seenHunk = new Set();
  const seenContext = new Set();

  for (const line of lines) {
    if (line.startsWith('@@')) {
      const m = line.match(/^@@[^@]+@@\s*(.+)$/);
      if (m) {
        const fn = extractHunkFunctionName(m[1]);
        if (fn && !seenHunk.has(fn)) {
          seenHunk.add(fn);
          hunkFunctions.push(fn);
        }
      }
      continue;
    }
    if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('diff --git')) continue;
    if (line.startsWith('+')) addedLines.push(line.slice(1));
    else if (line.startsWith('-')) removedLines.push(line.slice(1));
    else if (line.startsWith(' ')) {
      const fn = extractHunkFunctionName(line.slice(1));
      if (fn && !seenHunk.has(fn) && !seenContext.has(fn)) {
        seenContext.add(fn);
        contextFunctions.push(fn);
      }
    }
  }
  for (const fn of contextFunctions) hunkFunctions.push(fn);

  const addedMeta = extractSymbolsFromLines(addedLines);
  const removedMeta = extractSymbolsFromLines(removedLines);
  const removedSet = new Set(removedMeta.symbols);
  const addedSet = new Set(addedMeta.symbols);
  const trulyAddedSymbols = addedMeta.symbols.filter(s => !removedSet.has(s));
  const trulyRemovedSymbols = removedMeta.symbols.filter(s => !addedSet.has(s));

  const nonEmptyAdded = addedLines.map(l => l.trim()).filter(Boolean);
  const nonEmptyRemoved = removedLines.map(l => l.trim()).filter(Boolean);
  const addedJoined = nonEmptyAdded.join('\n');
  const changedLines = [...nonEmptyAdded, ...nonEmptyRemoved];

  const lower = files.map(file => file.replace(/\\/g, '/').toLowerCase());
  const statuses = files.map(file => statusMap.get(file) || '');
  const allAdded = statuses.length > 0 && statuses.every(st => st === '??' || st.startsWith('A'));
  const allDeleted = statuses.length > 0 && statuses.every(st => st.includes('D'));
  const allDocs = lower.length > 0 && lower.every(f => /(^|\/)(docs?\/|readme|changelog|\.md$)/i.test(f));
  const allTests = lower.length > 0 && lower.every(f => /(^|\/)(__tests__|tests?|specs?)\/|\.(test|spec)\.[a-z]+$|\/test-[^/]+$/i.test(f) || /^test-[^/]+$/i.test(f));
  const allStyles = lower.length > 0 && lower.every(f => /\.(css|scss|sass|less)$/i.test(f));
  const allConfig = lower.length > 0 && lower.every(f => /(^|\/)(package(-lock)?\.json|tsconfig.*\.json|\.eslintrc|\.editorconfig|\.oxlintrc\.json|next\.config\.|vite\.config\.|tailwind\.config\.|postcss\.config\.|dockerfile|docker-compose|\.github\/)/i.test(f));
  const allPrisma = lower.length > 0 && lower.every(f => /\.prisma$/i.test(f));
  const isPackageJsonOnly = lower.length === 1 && /(^|\/)package\.json$/i.test(lower[0]);
  const isNextRoute = lower.length === 1 && /(^|\/)app\/.*\/route\.[jt]sx?$/i.test(lower[0]);
  const isNextPage = lower.length === 1 && /(^|\/)app\/.*\/(page|layout)\.[jt]sx?$/i.test(lower[0]);
  const pkgChanges = isPackageJsonOnly ? extractPackageJsonChanges(addedLines, removedLines) : null;

  const isTailwindLine = line => /className\s*=|class\s*=|@apply\b|^\s*[a-z-]+\s*:\s*[^;]+;\s*$/i.test(line);
  const isStyleOnly = !allAdded && trulyAddedSymbols.length === 0 && trulyRemovedSymbols.length === 0 && changedLines.length > 0 && changedLines.every(line => isTailwindLine(line) || /^[{}().,;\s]+$/.test(line));
  const hasFixSignal = /(?:\b(?:try\s*\{|catch\s*\(|throw\s+new\b|if\s*\(\s*!|fallback|retry|timeout|abort|guard|prevent|sanitize|validate|fix(?:ed|es)?\b|bug\b|return\s+null\b|status\(\s*[45]\d\d\s*\))|\?\.\w|\s\?\?\s)/i.test(addedJoined);
  const hasApiSignal = /\b(?:fetch\s*\(|Response\.json|NextResponse|req\.(?:json|body|query|params)|res\.(?:status|json)|axios\.|\/api\/)/i.test(addedJoined);
  const hasStateSignal = /\b(?:useState|useEffect|useReducer|useRouter|useSearchParams|useContext|createContext|setState|dispatch)\b/.test(addedJoined);
  const hasUiSignal = /<(?:button|form|input|select|textarea|nav|header|footer|main|section|dialog|table|Link|Image)\b/i.test(addedJoined);

  return {
    addedCount: nonEmptyAdded.length,
    removedCount: nonEmptyRemoved.length,
    hunkFunctions,
    trulyAddedSymbols,
    trulyRemovedSymbols,
    httpMethods: addedMeta.httpMethods,
    prismaModels: addedMeta.prismaModels,
    headings: addedMeta.headings,
    testTitles: addedMeta.testTitles,
    isStyleOnly,
    hasFixSignal,
    hasApiSignal,
    hasStateSignal,
    hasUiSignal,
    allAdded,
    allDeleted,
    allDocs,
    allTests,
    allStyles,
    allConfig,
    allPrisma,
    isPackageJsonOnly,
    isNextRoute,
    isNextPage,
    pkgChanges,
  };
}

function joinShort(items, maxItems = 2) {
  const picked = items.slice(0, maxItems);
  if (picked.length === 0) return '';
  if (picked.length === 1) return picked[0];
  return `${picked[0]} and ${picked[1]}`;
}

function isReactComponentName(name, files) {
  return /^[A-Z][A-Za-z0-9]*$/.test(name) && files.some(f => /\.[jt]sx$/i.test(f));
}

function deterministicSuggestion(files, diffText, statusMap = new Map()) {
  const safeFiles = files.filter(file => checkSecretFiles([file]).length === 0);
  if (!safeFiles.length) return '';

  const analysis = analyzeDiff(safeFiles, diffText, statusMap);
  const scope = inferScope(safeFiles);
  const withPrefix = (type, subject, customScope = scope) =>
    cleanCommitLine((customScope ? `${type}(${customScope}): ` : `${type}: `) + subject);

  // 1. package.json dependency / version changes
  if (analysis.isPackageJsonOnly && analysis.pkgChanges) {
    const { versionBump, addedDeps, removedDeps, updatedDeps } = analysis.pkgChanges;
    if (addedDeps.length) return withPrefix('chore', `add ${joinShort(addedDeps)}`, 'deps');
    if (removedDeps.length) return withPrefix('chore', `remove ${joinShort(removedDeps)}`, 'deps');
    if (updatedDeps.length) return withPrefix('chore', `update ${joinShort(updatedDeps)}`, 'deps');
    if (versionBump) return withPrefix('chore', `bump version to ${versionBump}`, 'release');
  }

  // 2. Prisma schema changes
  if (analysis.allPrisma) {
    if (analysis.prismaModels.length) {
      return withPrefix('feat', `add ${joinShort(analysis.prismaModels)} model${analysis.prismaModels.length > 1 ? 's' : ''}`, 'prisma');
    }
    return withPrefix('chore', 'update Prisma schema fields', 'prisma');
  }

  // 3. Next.js App Router API route handler
  if (analysis.isNextRoute) {
    if (analysis.httpMethods.length) {
      const verb = analysis.allAdded ? 'add' : (analysis.hasFixSignal ? 'fix' : 'update');
      const type = analysis.hasFixSignal && !analysis.allAdded ? 'fix' : 'feat';
      return withPrefix(type, `${verb} ${joinShort(analysis.httpMethods)} handler${analysis.httpMethods.length > 1 ? 's' : ''}`);
    }
    if (analysis.hasFixSignal) return withPrefix('fix', 'handle errors in API route');
    return withPrefix('feat', 'update API route logic');
  }

  // 4. Test files
  if (analysis.allTests) {
    if (analysis.testTitles.length) {
      const title = analysis.testTitles[0].toLowerCase().slice(0, 44).trim();
      return withPrefix('test', `cover ${title}`);
    }
    const base = path.basename(safeFiles[0], path.extname(safeFiles[0])).replace(/^test-|\.test$|\.spec$/gi, '');
    return withPrefix('test', `${analysis.allAdded ? 'add' : 'update'} ${base || 'unit'} tests`);
  }

  // 5. Documentation files
  if (analysis.allDocs) {
    if (analysis.headings.length) {
      return withPrefix('docs', `document ${analysis.headings[0].slice(0, 42).trim()}`);
    }
    return withPrefix('docs', `${analysis.allAdded ? 'add' : 'update'} ${path.basename(safeFiles[0])}`);
  }

  // 6. CSS/SCSS or Tailwind-only style changes
  if (analysis.allStyles || analysis.isStyleOnly) {
    const target = safeFiles.length === 1 ? path.basename(safeFiles[0]) : `${safeFiles.length} files`;
    return withPrefix('style', `update styling in ${target}`);
  }

  // 7. Pure deletions
  if (analysis.allDeleted) {
    if (safeFiles.length === 1) return withPrefix('chore', `remove ${path.basename(safeFiles[0])}`);
    return withPrefix('chore', `remove ${path.basename(safeFiles[0])} and ${safeFiles.length - 1} other files`);
  }

  // 8. Config files
  if (analysis.allConfig) {
    if (safeFiles.length === 1) return withPrefix('chore', `update ${path.basename(safeFiles[0])}`);
    return withPrefix('chore', `update ${safeFiles.length} config files`);
  }

  // 9. New functions / React components / hooks / types detected in diff
  if (analysis.trulyAddedSymbols.length) {
    const first = analysis.trulyAddedSymbols[0];
    if (analysis.trulyAddedSymbols.length === 1) {
      const kind = isReactComponentName(first, safeFiles)
        ? 'component'
        : /^use[A-Z]/.test(first) ? 'hook' : '';
      const base = path.basename(safeFiles[0]);
      if (kind) return withPrefix('feat', `add ${first} ${kind}`);
      const withFile = `add ${first} in ${base}`;
      return withPrefix('feat', withFile.length <= 52 ? withFile : `add ${first}`);
    }
    return withPrefix('feat', `add ${joinShort(analysis.trulyAddedSymbols)}`);
  }

  // 10. Removed functions / components
  if (analysis.trulyRemovedSymbols.length && analysis.removedCount > analysis.addedCount) {
    return withPrefix('refactor', `remove ${joinShort(analysis.trulyRemovedSymbols)}`);
  }

  // 11. Edits inside an existing function (from Git hunk context)
  if (analysis.hunkFunctions.length) {
    const fn = analysis.hunkFunctions[0];
    if (analysis.hasFixSignal) return withPrefix('fix', `guard edge cases in ${fn}`);
    if (analysis.hasApiSignal) return withPrefix('feat', `connect API request in ${fn}`);
    if (analysis.hasStateSignal || analysis.hasUiSignal) return withPrefix('feat', `update UI state in ${fn}`);
    if (analysis.removedCount > analysis.addedCount * 1.4 && analysis.removedCount >= 4) {
      return withPrefix('refactor', `simplify ${fn}`);
    }
    return withPrefix('refactor', `update ${fn} logic`);
  }

  // 12. Next.js page / layout edits
  if (analysis.isNextPage) {
    const kind = /layout\.[jt]sx?$/i.test(safeFiles[0]) ? 'layout' : 'page';
    if (analysis.hasFixSignal) return withPrefix('fix', `fix ${kind} rendering issue`);
    if (analysis.hasApiSignal) return withPrefix('feat', `wire data fetching in ${kind}`);
    return withPrefix('feat', `${analysis.allAdded ? 'add' : 'update'} ${kind} UI`);
  }

  // 13. Semantic fallback based on actual added/removed signals
  const target = safeFiles.length === 1
    ? path.basename(safeFiles[0])
    : safeFiles.length === 2
      ? `${path.basename(safeFiles[0])} and ${path.basename(safeFiles[1])}`
      : `${path.basename(safeFiles[0])} and ${safeFiles.length - 1} other files`;

  if (analysis.hasFixSignal && !analysis.allAdded) return withPrefix('fix', `handle errors in ${target}`);
  if (analysis.hasApiSignal) return withPrefix('feat', `update API logic in ${target}`);
  if (analysis.hasStateSignal || analysis.hasUiSignal) return withPrefix('feat', `update UI and state in ${target}`);
  if (analysis.removedCount > analysis.addedCount * 1.5 && analysis.removedCount >= 4) {
    return withPrefix('refactor', `clean up ${target}`);
  }
  const verb = analysis.allAdded ? 'add' : 'update';
  const type = analysis.allAdded ? 'feat' : 'chore';
  return withPrefix(type, `${verb} ${target}`);
}

function readUntrackedFilePreview(cwd, file) {
  try {
    const full = path.resolve(cwd, file);
    const root = path.resolve(cwd);
    if (!full.startsWith(root + path.sep)) return '';
    const stat = fs.lstatSync(full);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size === 0 || stat.size > MAX_UNTRACKED_BYTES) return '';
    const raw = fs.readFileSync(full);
    if (raw.includes(0)) return ''; // skip binary files
    const lines = raw.toString('utf8').split(/\r?\n/).slice(0, MAX_UNTRACKED_LINES);
    return `diff --git a/${file} b/${file}\nnew file\n+++ b/${file}\n` + lines.map(l => '+' + l).join('\n');
  } catch {
    return '';
  }
}

async function readSafeDiffForFiles(cwd, files, statusMap = new Map()) {
  const safeFiles = [...new Set(files)].filter(file => typeof file === 'string' && file && checkSecretFiles([file]).length === 0);
  if (!safeFiles.length) return { safeFiles: [], diff: '' };
  const chunks = [];
  const staged = await runGit(['--no-optional-locks', 'diff', '--cached', '--no-color', '-U1', '--', ...safeFiles], cwd).catch(() => '');
  if (staged) chunks.push(staged);
  const unstaged = await runGit(['--no-optional-locks', 'diff', '--no-color', '-U1', '--', ...safeFiles], cwd).catch(() => '');
  if (unstaged) chunks.push(unstaged);

  const untracked = safeFiles.filter(file => statusMap.get(file) === '??').slice(0, MAX_UNTRACKED_FILES);
  for (const file of untracked) {
    const preview = readUntrackedFilePreview(cwd, file);
    if (preview) chunks.push(preview);
  }

  const combined = redactDiffText(chunks.join('\n')).slice(0, MAX_DIFF_CHARS);
  return { safeFiles, diff: combined };
}

async function suggestCommitMessage(panel, cwd, state, requestedFiles) {
  const available = Array.isArray(state?.changedFiles) ? state.changedFiles : [];
  const statusMap = new Map(available.map(item => [item.file, item.status]));
  const selected = (Array.isArray(requestedFiles) && requestedFiles.length
    ? requestedFiles.filter(file => statusMap.has(file))
    : available.filter(item => !item.secret).map(item => item.file))
    .filter(file => checkSecretFiles([file]).length === 0);
  if (!selected.length) return { suggestion: '', source: 'none', files: [] };

  const { safeFiles, diff } = await readSafeDiffForFiles(cwd, selected, statusMap);
  if (!safeFiles.length) return { suggestion: '', source: 'none', files: [] };

  const fallback = deterministicSuggestion(safeFiles, diff, statusMap);

  // Optional local AI assistance via workstation-stability (secrets stay in IDE SecretStorage or private user .env).
  if (panel?.vscode?.commands?.executeCommand) {
    try {
      const fileSummary = safeFiles.slice(0, 20).map(file => `${statusMap.get(file) || 'M'} ${file}`).join('\n');
      const aiResponse = await panel.vscode.commands.executeCommand('workstationStability.generateText', {
        systemPrompt: 'Write ONE concise conventional commit subject line (<=72 chars, e.g. feat(scope): summary or fix(scope): summary) strictly describing the provided changed files and diff. Plain text only: no markdown, no quotes, no fabrication.',
        userPrompt: `Files:\n${fileSummary}\n\nDiff excerpt:\n${diff || '(new or binary files only)'}`,
        maxTokens: 64,
        timeoutMs: 8000,
        allowWhenKeyConfigured: true,
        allowProxy: true,
      });
      if (aiResponse && aiResponse.ok && aiResponse.text) {
        const line = cleanCommitLine(redactDiffText(aiResponse.text));
        if (line) return { suggestion: line, source: 'ai', files: safeFiles };
      }
    } catch {
      // Fall back cleanly to local diff-aware analyzer when stability AI is disabled/unavailable.
    }
  }

  return { suggestion: fallback, source: 'local', files: safeFiles };
}

module.exports = {
  redactDiffText,
  cleanCommitLine,
  analyzeDiff,
  deterministicSuggestion,
  readSafeDiffForFiles,
  suggestCommitMessage,
};
