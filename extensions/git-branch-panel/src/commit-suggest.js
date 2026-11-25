'use strict';

const path = require('path');
const { runGit } = require('./git-runner');
const { checkSecretFiles } = require('./git-state');

const MAX_DIFF_CHARS = 5000;
const MAX_SUGGESTION_LEN = 72;

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

function inferScope(files) {
  if (!files.length) return '';
  const normalized = files.map(file => file.replace(/\\/g, '/'));
  const segments = normalized.map(file => file.split('/').filter(Boolean));
  const firstDirs = new Set(segments.filter(parts => parts.length > 1).map(parts => parts[0]));
  if (firstDirs.size === 1) {
    const top = [...firstDirs][0];
    if (['src', 'app', 'pages', 'components', 'lib', 'api', 'server', 'tests', 'docs', 'scripts', 'config', 'extensions'].includes(top)) {
      const subDirs = new Set(segments.filter(parts => parts.length > 2).map(parts => parts[1]));
      if (subDirs.size === 1) return [...subDirs][0].replace(/[^a-z0-9._-]/gi, '').slice(0, 20);
      return top;
    }
    return top.replace(/[^a-z0-9._-]/gi, '').slice(0, 20);
  }
  if (files.length === 1) {
    const stem = path.basename(normalized[0], path.extname(normalized[0])).replace(/[^a-z0-9._-]/gi, '');
    if (stem && stem.length <= 20) return stem;
  }
  return '';
}

function inferType(files, diffText, statuses) {
  const lower = files.map(file => file.replace(/\\/g, '/').toLowerCase());
  if (lower.every(file => /(^|\/)(docs?\/|readme|changelog|\.md$)/i.test(file))) return 'docs';
  if (lower.every(file => /(^|\/)(__tests__|tests?|specs?)\/|\.(test|spec)\.[a-z]+$/i.test(file))) return 'test';
  if (lower.every(file => /\.(css|scss|sass|less)$/i.test(file))) return 'style';
  if (lower.every(file => /(^|\/)(package(-lock)?\.json|tsconfig.*\.json|\.eslintrc|\.editorconfig|\.oxlintrc\.json|next\.config\.|vite\.config\.|\.github\/)/i.test(file))) return 'chore';
  const allAdded = statuses.length > 0 && statuses.every(st => st === '??' || st.startsWith('A'));
  if (allAdded) return 'feat';
  const addedLines = diffText.split(/\r?\n/).filter(line => line.startsWith('+') && !line.startsWith('+++')).join('\n');
  if (/\bfix(e[sd])?\b|\bbug\b|\bguard\b|\bprevent\b|\bhandle\b.*\berror\b/i.test(addedLines)) return 'fix';
  if (/\bexport\s+(async\s+)?(function|const|class|default)\b/.test(addedLines)) return 'feat';
  return 'chore';
}

function deterministicSuggestion(files, diffText, statusMap = new Map()) {
  const safeFiles = files.filter(file => checkSecretFiles([file]).length === 0);
  if (!safeFiles.length) return '';
  const statuses = safeFiles.map(file => statusMap.get(file) || '');
  const type = inferType(safeFiles, diffText, statuses);
  const scope = inferScope(safeFiles);
  const prefix = scope ? `${type}(${scope}): ` : `${type}: `;

  const allAdded = statuses.length > 0 && statuses.every(st => st === '??' || st.startsWith('A'));
  const allDeleted = statuses.length > 0 && statuses.every(st => st.includes('D'));
  const verb = allAdded ? 'add' : allDeleted ? 'remove' : 'update';

  let subject;
  if (safeFiles.length === 1) {
    const base = path.basename(safeFiles[0]);
    subject = `${verb} ${base}`;
  } else if (safeFiles.length === 2) {
    subject = `${verb} ${path.basename(safeFiles[0])} and ${path.basename(safeFiles[1])}`;
  } else {
    const lead = path.basename(safeFiles[0]);
    subject = `${verb} ${lead} and ${safeFiles.length - 1} other files`;
  }
  return cleanCommitLine(prefix + subject);
}

async function readSafeDiffForFiles(cwd, files) {
  const safeFiles = [...new Set(files)].filter(file => typeof file === 'string' && file && checkSecretFiles([file]).length === 0);
  if (!safeFiles.length) return { safeFiles: [], diff: '' };
  const chunks = [];
  const staged = await runGit(['--no-optional-locks', 'diff', '--cached', '--no-color', '--', ...safeFiles], cwd).catch(() => '');
  if (staged) chunks.push(staged);
  const unstaged = await runGit(['--no-optional-locks', 'diff', '--no-color', '--', ...safeFiles], cwd).catch(() => '');
  if (unstaged) chunks.push(unstaged);
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

  const { safeFiles, diff } = await readSafeDiffForFiles(cwd, selected);
  if (!safeFiles.length) return { suggestion: '', source: 'none', files: [] };

  const fallback = deterministicSuggestion(safeFiles, diff, statusMap);

  // Optional local AI assistance via workstation-stability (secrets never leave stability SecretStorage).
  if (panel?.vscode?.commands?.executeCommand) {
    try {
      const fileSummary = safeFiles.slice(0, 20).map(file => `${statusMap.get(file) || 'M'} ${file}`).join('\n');
      const aiResponse = await panel.vscode.commands.executeCommand('workstationStability.generateText', {
        systemPrompt: 'Write ONE concise conventional commit subject line (<=72 chars) strictly describing the provided changed files and diff. No markdown, no quotes, no fabrication.',
        userPrompt: `Files:\n${fileSummary}\n\nDiff excerpt:\n${diff || '(new or binary files only)'}`,
        maxTokens: 48,
        timeoutMs: 6000,
      });
      if (aiResponse && aiResponse.ok && aiResponse.text) {
        const line = cleanCommitLine(redactDiffText(aiResponse.text));
        if (line) return { suggestion: line, source: 'ai', files: safeFiles };
      }
    } catch {
      // Fall back cleanly to local deterministic diff summary when stability AI is disabled/unavailable.
    }
  }

  return { suggestion: fallback, source: 'local', files: safeFiles };
}

module.exports = {
  redactDiffText,
  cleanCommitLine,
  deterministicSuggestion,
  readSafeDiffForFiles,
  suggestCommitMessage,
};
