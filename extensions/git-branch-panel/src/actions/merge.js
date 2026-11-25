'use strict';

const { runGit } = require('../git-runner');
const { collectState, getConflictFiles, readOriginUrl, readRemotes } = require('../git-state');
const { PanelError } = require('../git-errors');
const { tr } = require('../text');
const { VISIBLE, loadReadyState, requireOrigin, requireNoChanges, fetchOrigin, checkBranchName } = require('./common');

async function fetchRemote(panel, cwd, remoteName = 'origin') {
  if (remoteName === 'origin') return fetchOrigin(panel, cwd);
  panel.progress(tr(`Получение данных с ${remoteName}…`, `Fetching from ${remoteName}…`));
  await runGit(['fetch', remoteName, '--prune'], cwd, VISIBLE);
}

// The ↻ button: git fetch, so the panel shows what GitHub/remotes have now.
async function fetchChanges(panel) {
  const cwd = panel.workspaceRoot();
  const remotes = await readRemotes(cwd);
  const hasOrigin = remotes.includes('origin') || Boolean(await readOriginUrl(cwd));
  if (!hasOrigin && !remotes.length) return;
  if (hasOrigin) await fetchOrigin(panel, cwd);
  for (const remote of remotes) {
    if (remote === 'origin') continue;
    await fetchRemote(panel, cwd, remote);
  }
  panel.notice('clear');
}

async function requireRemoteBranch(cwd, branch, remoteName = 'origin') {
  try {
    await runGit(['rev-parse', '--verify', '--quiet', `refs/remotes/${remoteName}/${branch}`], cwd);
  } catch {
    throw new PanelError(tr(`Ветки "${remoteName}/${branch}" нет на удалённом сервере (возможно, она удалена).`,
      `Remote branch "${remoteName}/${branch}" does not exist (it may have been deleted).`));
  }
}

// A project connected to a GitHub repository that was created with its own
// first commit (README) has no common history with it; git asks for
// --allow-unrelated-histories before it merges them.
async function merge(cwd, sourceRef) {
  const args = ['merge', '--no-edit', sourceRef];
  try {
    await runGit(args, cwd, VISIBLE);
  } catch (error) {
    if (!/refusing to merge unrelated histories/i.test(error.message)) throw error;
    await runGit([...args, '--allow-unrelated-histories'], cwd, VISIBLE);
  }
}

// Returns false when git stopped on conflicts; they then show in the panel.
async function mergeFromRemote(panel, cwd, sourceRef) {
  panel.progress(tr(`Объединение с ${sourceRef}…`, `Merging ${sourceRef}…`));
  try {
    await merge(cwd, sourceRef);
    return true;
  } catch (error) {
    const conflicts = await getConflictFiles(cwd).catch(() => []);
    if (!conflicts.length) throw error;
    panel.notice('warn', tr(`Конфликт в файлах: ${conflicts.length}. Выбери версию каждого файла ниже.`,
      `Conflicts in ${conflicts.length} file(s). Choose a version for each file below.`));
    return false;
  }
}

// Pull: fetch configured upstream (or origin/<current branch>) and merge into current local branch.
async function syncBranch(panel) {
  const cwd = panel.workspaceRoot();
  const state = await loadReadyState(cwd);
  requireOrigin(state);
  requireNoChanges(state);
  await panel.requireIdentity(cwd, state);
  const remoteName = state.upstreamRemote || 'origin';
  const sourceBranch = state.upstreamBranch || state.branch;
  const sourceRef = `${remoteName}/${sourceBranch}`;
  await fetchRemote(panel, cwd, remoteName);
  await requireRemoteBranch(cwd, sourceBranch, remoteName);
  if (await mergeFromRemote(panel, cwd, sourceRef)) {
    panel.notice('ok', tr(`Изменения из ${sourceRef} добавлены в ${state.branch}.`,
      `Changes from ${sourceRef} merged into ${state.branch}.`));
  }
}

function parseSourceSelection(rawSource, defaultRemote = 'origin') {
  const value = typeof rawSource === 'string' ? rawSource.trim() : '';
  if (!value) return { remoteName: defaultRemote, branchName: '' };
  return { remoteName: defaultRemote, branchName: value };
}

async function pullBranch(panel, request) {
  const cwd = panel.workspaceRoot();
  const state = await loadReadyState(cwd);
  requireOrigin(state);
  requireNoChanges(state);
  const remoteName = typeof request?.sourceRemote === 'string' && request.sourceRemote.trim()
    ? request.sourceRemote.trim()
    : (state.upstreamRemote || 'origin');
  const parsed = parseSourceSelection(request?.sourceBranch, remoteName);
  const source = await checkBranchName(cwd, parsed.branchName);
  const sourceRef = `${parsed.remoteName}/${source}`;
  if (source !== state.branch || parsed.remoteName !== (state.upstreamRemote || 'origin')) {
    const question = tr(`Получить изменения из "${source}" (${sourceRef}) и объединить с локальной веткой "${state.branch}"?`,
      `Merge changes from "${source}" (${sourceRef}) into local branch "${state.branch}"?`);
    if (!await panel.confirm(question, tr('Получить', 'Get changes'))) return;
  }
  await panel.requireIdentity(cwd, state);
  await fetchRemote(panel, cwd, parsed.remoteName);
  await requireRemoteBranch(cwd, source, parsed.remoteName);
  if (await mergeFromRemote(panel, cwd, sourceRef)) {
    panel.notice('ok', tr(`Изменения из "${sourceRef}" добавлены в "${state.branch}".`,
      `Changes from "${sourceRef}" were added to "${state.branch}".`));
  }
}

async function useVersion(cwd, file, side) {
  const stage = side === 'ours' ? 2 : 3;
  const exists = await runGit(['cat-file', '-e', `:${stage}:${file}`], cwd).then(() => true, () => false);
  if (!exists) {
    await runGit(['rm', '-f', '--', file], cwd);
    return;
  }
  await runGit(['checkout', side === 'ours' ? '--ours' : '--theirs', '--', file], cwd);
  await runGit(['add', '--', file], cwd);
}

async function resolveConflicts(panel, request) {
  const cwd = panel.workspaceRoot();
  const state = await collectState(cwd);
  if (!state.mergeInProgress) throw new PanelError(tr('Сейчас нет merge.', 'No merge is in progress.'));
  const choices = request.resolutions && typeof request.resolutions === 'object' ? request.resolutions : {};
  if (state.conflicts.some(file => !['ours', 'theirs'].includes(choices[file]))) {
    throw new PanelError(tr('Выбери версию для каждого файла.', 'Choose a version for every file.'));
  }
  await panel.requireIdentity(cwd, state);
  for (const file of state.conflicts) await useVersion(cwd, file, choices[file]);
  const remaining = await getConflictFiles(cwd);
  if (remaining.length) throw new PanelError(tr('Остались конфликты: ', 'Conflicts remain: ') + remaining.join(', '));
  await runGit(['commit', '--no-edit'], cwd, VISIBLE);
  panel.notice('ok', tr('Конфликты разрешены.', 'Conflicts resolved.'));
}

async function abortOperation(panel) {
  const cwd = panel.workspaceRoot();
  const state = await collectState(cwd);
  if (state.rebaseInProgress) await runGit(['rebase', '--abort'], cwd, VISIBLE);
  else if (state.mergeInProgress) await runGit(['merge', '--abort'], cwd, VISIBLE);
  else return;
  panel.notice('ok', tr('Отменено: файлы вернулись к прежнему виду.', 'Cancelled: the files are back as they were.'));
}

module.exports = { fetchChanges, syncBranch, pullBranch, resolveConflicts, abortOperation };
