'use strict';

const fs = require('fs');
const path = require('path');
const { runGit } = require('./git-runner');
const { tr } = require('./text');

const SECRET_PATTERNS = [
  /^\.env$/i, /^\.env\..+$/i,
  /\.pem$/i, /\.key$/i,
  /^id_rsa$/i, /^id_ed25519$/i,
  /credentials\.json$/i,
  /service-account.*\.json$/i,
];
const SECRET_ALLOWED = [/^\.env\.example$/i];

function checkSecretFiles(files) {
  return files.filter(file => {
    const name = path.basename(file);
    return !SECRET_ALLOWED.some(pattern => pattern.test(name)) && SECRET_PATTERNS.some(pattern => pattern.test(name));
  });
}

// `git status --porcelain -z`: "XY path\0", renames add "\0original path".
function parsePorcelainZ(output) {
  if (!output) return [];
  const entries = output.split('\0').filter(Boolean);
  const files = [];
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index];
    if (entry.length <= 3) continue;
    const status = entry.slice(0, 2);
    const file = entry.slice(3);
    const originalFile = /[RC]/.test(status) ? entries[++index] : null;
    const paths = originalFile ? [file, originalFile] : [file];
    files.push({ file, ...(originalFile ? { originalFile } : {}), status, secret: checkSecretFiles(paths).length > 0 });
  }
  return files;
}

function parseGitHubRemote(remote) {
  if (typeof remote !== 'string') return null;
  const match = remote.trim().match(/^(?:https:\/\/(?:[^@/\s]+@)?github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i);
  return match ? { owner: match[1], repository: match[2] } : null;
}

// Only a project connected to GitHub gets the GitHub identity. A project
// without origin or on another server keeps its own git config untouched.
function usesGitHubIdentity(remote) {
  return parseGitHubRemote(remote) !== null;
}

async function readOriginUrl(cwd) {
  // The configured URL, not `remote get-url`, which expands url.insteadOf.
  return runGit(['config', '--get', 'remote.origin.url'], cwd).catch(() => null);
}

async function readRemotes(cwd) {
  const output = await runGit(['remote'], cwd).catch(() => '');
  return output.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
}

async function readUpstream(cwd) {
  const raw = await runGit(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], cwd).catch(() => '');
  const trimmed = raw.trim();
  if (!trimmed || !trimmed.includes('/')) return { upstream: '', upstreamRemote: '', upstreamBranch: '' };
  const slash = trimmed.indexOf('/');
  return {
    upstream: trimmed,
    upstreamRemote: trimmed.slice(0, slash),
    upstreamBranch: trimmed.slice(slash + 1),
  };
}

async function listWorktrees(cwd) {
  const output = await runGit(['worktree', 'list', '--porcelain'], cwd).catch(() => '');
  const byBranch = new Map();
  let currentPath = '';
  for (const line of output.split(/\r?\n/)) {
    if (line.startsWith('worktree ')) {
      currentPath = line.slice('worktree '.length).trim();
    } else if (line.startsWith('branch refs/heads/') && currentPath) {
      byBranch.set(line.slice('branch refs/heads/'.length).trim(), currentPath);
    } else if (!line.trim()) {
      currentPath = '';
    }
  }
  return byBranch;
}

async function readRefs(cwd) {
  const output = await runGit(['for-each-ref', '--format=%(refname)%09%(symref:short)', 'refs/heads', 'refs/remotes'], cwd).catch(() => '');
  const local = new Set();
  const remote = new Set();
  const remoteByHost = new Map();
  let originHead = '';
  for (const line of output.split(/\r?\n/)) {
    if (!line) continue;
    const tab = line.indexOf('\t');
    const ref = tab >= 0 ? line.slice(0, tab) : line;
    const symref = tab >= 0 ? line.slice(tab + 1) : '';
    if (ref.startsWith('refs/heads/')) {
      local.add(ref.slice('refs/heads/'.length));
    } else if (ref === 'refs/remotes/origin/HEAD') {
      originHead = symref.replace(/^origin\//, '');
    } else if (ref.startsWith('refs/remotes/')) {
      const rest = ref.slice('refs/remotes/'.length);
      const slash = rest.indexOf('/');
      if (slash <= 0) continue;
      const remoteName = rest.slice(0, slash);
      const branchName = rest.slice(slash + 1);
      if (branchName === 'HEAD') continue;
      if (!remoteByHost.has(remoteName)) remoteByHost.set(remoteName, new Set());
      remoteByHost.get(remoteName).add(branchName);
      if (remoteName === 'origin') remote.add(branchName);
    }
  }
  return { local, remote, remoteByHost, originHead };
}

function readCurrentBranchFast(gitDir) {
  try {
    const head = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim();
    if (head.startsWith('ref: refs/heads/')) return head.slice('ref: refs/heads/'.length);
    if (/^[0-9a-f]{40,64}$/i.test(head)) return '';
  } catch {}
  return null;
}

function pickDefaultBranch(refs, currentBranch) {
  if (refs.originHead) return refs.originHead;
  for (const name of ['main', 'master']) {
    if (refs.remote.has(name) || refs.local.has(name)) return name;
  }
  return [...refs.local][0] || currentBranch || 'main';
}

function describeBranches(refs, defaultBranch, currentBranch) {
  const names = [...new Set([...refs.local, ...refs.remote])].sort((a, b) => {
    if (a === defaultBranch) return -1;
    if (b === defaultBranch) return 1;
    return a.localeCompare(b);
  });
  return names.map(name => ({
    name,
    isLocal: refs.local.has(name),
    isRemote: refs.remote.has(name),
    isCurrent: name === currentBranch,
    isDefault: name === defaultBranch || name === 'main' || name === 'master',
  }));
}

async function listBranches(cwd, currentBranch) {
  const refs = await readRefs(cwd);
  const defaultBranch = pickDefaultBranch(refs, currentBranch);
  return { refs, defaultBranch, branches: describeBranches(refs, defaultBranch, currentBranch) };
}

async function getChangedFiles(cwd) {
  // Without optional locks a live refresh never holds index.lock while a
  // commit or switch is running.
  return parsePorcelainZ(await runGit(['--no-optional-locks', 'status', '--porcelain', '-z', '--untracked-files=all'], cwd, { raw: true }));
}

async function getConflictFiles(cwd) {
  const output = await runGit(['diff', '--name-only', '--diff-filter=U', '-z'], cwd, { raw: true });
  return output.split('\0').filter(Boolean);
}

function readOperation(gitDir) {
  return {
    mergeInProgress: fs.existsSync(path.join(gitDir, 'MERGE_HEAD')),
    rebaseInProgress: fs.existsSync(path.join(gitDir, 'rebase-merge')) || fs.existsSync(path.join(gitDir, 'rebase-apply')),
  };
}

async function countNumber(args, cwd) {
  const value = Number(await runGit(args, cwd).catch(() => '0'));
  return Number.isSafeInteger(value) ? value : 0;
}

// ahead: commits on this computer not on the tracking remote yet;
// behind: incoming commits on the tracking remote (upstream or origin/<branch>).
async function countAheadBehind(cwd, branch, refs, remote, upstreamInfo) {
  if (!refs.local.has(branch) || !remote) return { ahead: 0, behind: 0 };
  const trackRemote = upstreamInfo?.upstreamRemote || 'origin';
  const trackBranch = upstreamInfo?.upstreamBranch || branch;
  const hostSet = refs.remoteByHost?.get(trackRemote) || (trackRemote === 'origin' ? refs.remote : null);
  if (!hostSet || !hostSet.has(trackBranch)) {
    return { ahead: await countNumber(['rev-list', '--count', 'HEAD', '--not', `--remotes=${trackRemote}`], cwd), behind: 0 };
  }
  const output = await runGit(['rev-list', '--left-right', '--count', `HEAD...refs/remotes/${trackRemote}/${trackBranch}`], cwd).catch(() => '0 0');
  const [ahead, behind] = output.split(/\s+/).map(Number);
  return { ahead: ahead || 0, behind: behind || 0 };
}

function computeDiffStamp(root, changedFiles) {
  if (!root || !Array.isArray(changedFiles) || !changedFiles.length) return '';
  const parts = [];
  for (const item of changedFiles.slice(0, 20)) {
    if (!item?.file || item.secret) continue;
    try {
      const stat = fs.lstatSync(path.join(root, item.file));
      parts.push(`${item.file}:${item.status}:${stat.size}:${Math.trunc(stat.mtimeMs)}`);
    } catch {
      parts.push(`${item.file}:${item.status}:0`);
    }
  }
  return parts.join('|');
}

function emptyState(cwd) {
  return {
    cwd, root: null, gitDir: null, repoName: '', isRepo: false, branch: null, detached: false, headShort: '',
    remote: null, remotes: [], upstream: '', upstreamRemote: '', upstreamBranch: '', isGitHub: false,
    defaultBranch: 'main', branches: [], remoteBranches: [], changedFiles: [], diffStamp: '', conflicts: [],
    mergeInProgress: false, rebaseInProgress: false,
    hasCommits: false, remoteBranchExists: false, ahead: 0, behind: 0, error: null,
  };
}

async function collectState(cwd) {
  const state = emptyState(cwd);
  if (!cwd) {
    state.error = tr('Открой папку проекта.', 'Open a project folder.');
    return state;
  }
  // Launch independent git reads in one concurrent wave to minimize subprocess round-trips.
  const [location, remote, remotes, refs, changedFiles] = await Promise.all([
    runGit(['rev-parse', '--show-toplevel', '--absolute-git-dir'], cwd).catch(() => null),
    readOriginUrl(cwd),
    readRemotes(cwd),
    readRefs(cwd),
    getChangedFiles(cwd).catch(() => []),
  ]);
  if (!location) {
    state.error = tr('Эта папка не подключена к Git.', 'This folder is not a Git repository.');
    return state;
  }
  [state.root, state.gitDir] = location.split(/\r?\n/);
  state.isRepo = true;
  const gh = parseGitHubRemote(remote);
  state.repoName = gh ? `${gh.owner}/${gh.repository}` : path.basename(state.root || cwd);
  state.remote = remote;
  state.remotes = remotes.length ? remotes : (remote ? ['origin'] : []);
  state.isGitHub = gh !== null;
  Object.assign(state, readOperation(state.gitDir));
  const fastBranch = readCurrentBranchFast(state.gitDir);
  state.branch = fastBranch !== null ? fastBranch : await runGit(['branch', '--show-current'], cwd).catch(() => '');
  if (!state.branch) {
    state.detached = !state.rebaseInProgress;
    state.headShort = await runGit(['rev-parse', '--short', 'HEAD'], cwd).catch(() => '');
    state.error = state.rebaseInProgress
      ? tr('Идёт rebase.', 'A rebase is in progress.')
      : tr(`Сейчас не выбрана ни одна ветка (detached HEAD${state.headShort ? ' @ ' + state.headShort : ''}).`,
        `No branch is checked out (detached HEAD${state.headShort ? ' @ ' + state.headShort : ''}).`);
    return state;
  }
  const defaultBranch = pickDefaultBranch(refs, state.branch);
  const branches = describeBranches(refs, defaultBranch, state.branch);
  const remoteBranches = [];
  for (const [remoteName, set] of refs.remoteByHost.entries()) {
    for (const branchName of [...set].sort()) {
      remoteBranches.push({ remote: remoteName, branch: branchName, ref: `${remoteName}/${branchName}` });
    }
  }
  state.defaultBranch = defaultBranch;
  state.branches = branches;
  state.remoteBranches = remoteBranches;
  state.hasCommits = refs.local.has(state.branch);
  state.changedFiles = changedFiles;
  state.diffStamp = computeDiffStamp(state.root, changedFiles);
  const upstreamInfo = state.hasCommits ? await readUpstream(cwd) : { upstream: '', upstreamRemote: '', upstreamBranch: '' };
  state.upstream = upstreamInfo.upstream;
  state.upstreamRemote = upstreamInfo.upstreamRemote;
  state.upstreamBranch = upstreamInfo.upstreamBranch;
  const trackRemote = upstreamInfo.upstreamRemote || 'origin';
  const trackBranch = upstreamInfo.upstreamBranch || state.branch;
  state.remoteBranchExists = Boolean(refs.remoteByHost.get(trackRemote)?.has(trackBranch) || (trackRemote === 'origin' && refs.remote.has(state.branch)));
  const [conflicts, aheadBehind] = await Promise.all([
    state.mergeInProgress ? getConflictFiles(cwd).catch(() => []) : [],
    countAheadBehind(cwd, state.branch, refs, remote, upstreamInfo),
  ]);
  state.conflicts = conflicts;
  Object.assign(state, aheadBehind);
  return state;
}

module.exports = {
  checkSecretFiles,
  parsePorcelainZ,
  parseGitHubRemote,
  usesGitHubIdentity,
  readOriginUrl,
  readRemotes,
  readUpstream,
  listWorktrees,
  listBranches,
  getConflictFiles,
  collectState,
};
