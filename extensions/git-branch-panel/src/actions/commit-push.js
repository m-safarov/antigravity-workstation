'use strict';

const { runGit } = require('../git-runner');
const { PanelError } = require('../git-errors');
const { tr } = require('../text');
const { VISIBLE, loadReadyState, requireOrigin, fetchOrigin } = require('./common');

// --no-verify: the author change does not alter files, and the commit hooks
// already ran when the commits were created.
const RESET_AUTHOR = 'git commit --amend --reset-author --no-edit --no-verify --allow-empty';

function pathsToCommit(changedFiles, requested) {
  if (!Array.isArray(requested) || requested.length === 0) {
    throw new PanelError(tr('Отметь хотя бы один файл.', 'Tick at least one file.'));
  }
  const byName = new Map(changedFiles.map(item => [item.file, item]));
  const selected = [...new Set(requested)].map(file => byName.get(file));
  if (selected.some(item => !item)) {
    throw new PanelError(tr('Список файлов изменился. Отметь файлы ещё раз.', 'The file list changed. Tick the files again.'));
  }
  if (selected.some(item => item.secret)) {
    throw new PanelError(tr('Среди отмеченных файлов есть секретный файл. Добавь его в .gitignore.', 'A ticked file looks like a secret. Add it to .gitignore.'));
  }
  return selected.flatMap(item => item.originalFile ? [item.file, item.originalFile] : [item.file]);
}

// Commits the ticked files. With every changed file ticked these are the
// usual `git add -A` and `git commit -m`.
async function commitFiles(panel, cwd, state, files, message) {
  const paths = pathsToCommit(state.changedFiles, files);
  await panel.requireIdentity(cwd, state);
  panel.progress(tr('Commit…', 'Committing…'));
  if (state.changedFiles.every(item => files.includes(item.file))) {
    await runGit(['add', '-A'], cwd, VISIBLE);
    await runGit(['commit', '-m', message], cwd, VISIBLE);
    return;
  }
  await runGit(['add', '-A', '--', ...paths], cwd, VISIBLE);
  await runGit(['commit', '--only', '-m', message, '--', ...paths], cwd, VISIBLE);
}

async function commit(panel, request) {
  const cwd = panel.workspaceRoot();
  const state = await loadReadyState(cwd);
  const message = typeof request.message === 'string' ? request.message.trim() : '';
  if (!message) throw new PanelError(tr('Напиши сообщение commit.', 'Write a commit message.'));
  await commitFiles(panel, cwd, state, request.files, message);
  panel.notice('ok', tr('Commit создан.', 'Commit created.'), { clear: 'commitMessage' });
}

async function pushCurrentBranch(panel, cwd, branch) {
  const upstream = await runGit(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], cwd).catch(() => '');
  const args = upstream === `origin/${branch}` ? ['push', 'origin', branch] : ['push', '-u', 'origin', branch];
  panel.progress(`Push ${branch}…`);
  await runGit(args, cwd, VISIBLE);
  panel.notice('ok', tr(`Отправлено в GitHub: ${branch}.`, `Pushed to GitHub: ${branch}.`));
}

async function push(panel) {
  const cwd = panel.workspaceRoot();
  const state = await loadReadyState(cwd);
  requireOrigin(state);
  if (!state.hasCommits) throw new PanelError(tr('В ветке ещё нет commits.', 'The branch has no commits yet.'));
  await panel.requireIdentity(cwd, state);
  await pushCurrentBranch(panel, cwd, state.branch);
}

async function listCommits(cwd, args) {
  const output = await runGit(['rev-list', ...args], cwd);
  return output.split(/\r?\n/).filter(Boolean);
}

async function findForkPoint(cwd, state) {
  const defaultIsRemote = state.branches.some(branch => branch.name === state.defaultBranch && branch.isRemote);
  let ref = null;
  if (state.remoteBranchExists) ref = `refs/remotes/origin/${state.branch}`;
  else if (defaultIsRemote) ref = `refs/remotes/origin/${state.defaultBranch}`;
  if (!ref) return null;
  return runGit(['merge-base', 'HEAD', ref], cwd).catch(() => null);
}

// Only commits GitHub does not have yet may be rewritten: the range from the
// fork point to HEAD must be exactly the set of unpushed commits.
async function planAuthorRewrite(cwd, state) {
  const unpushed = await listCommits(cwd, ['HEAD', '--not', '--remotes=origin']);
  if (!unpushed.length) throw new PanelError(tr('Все commits этой ветки уже есть в GitHub.', 'GitHub already has every commit of this branch.'));
  const base = await findForkPoint(cwd, state);
  const range = base ? [`${base}..HEAD`] : ['HEAD'];
  const commits = await listCommits(cwd, range);
  const merges = await listCommits(cwd, ['--merges', ...range]);
  const unpushedSet = new Set(unpushed);
  if (merges.length || commits.length !== unpushed.length || commits.some(sha => !unpushedSet.has(sha))) {
    throw new PanelError(tr('Эти commits нельзя исправить автоматически: часть уже есть в GitHub или среди них есть merge.',
      'These commits cannot be fixed automatically: some are already on GitHub or one is a merge.'));
  }
  return { rebaseArgs: base ? [base] : ['--root'], count: commits.length };
}

async function rewriteAuthors(cwd, rebaseArgs) {
  try {
    await runGit(['rebase', '--autostash', ...rebaseArgs, '--exec', RESET_AUTHOR], cwd);
  } catch (error) {
    await runGit(['rebase', '--abort'], cwd).catch(() => {});
    throw new PanelError(tr('Не удалось исправить автора; ветка осталась как была.', 'Could not fix the author; the branch is unchanged.'),
      { details: error.stderr || error.message });
  }
}

// Authors of the commits GitHub does not have yet, other than email.
async function otherAuthors(cwd, email) {
  const output = await runGit(['log', '--format=%ae', 'HEAD', '--not', '--remotes=origin'], cwd).catch(() => '');
  return [...new Set(output.split(/\r?\n/).filter(author => author && author !== email))];
}

// Gives the commits GitHub does not have yet the GitHub author after one
// confirmation. Returns false when the user declined.
async function rewriteUnpushedAuthors(panel, cwd, state, identity) {
  const plan = await planAuthorRewrite(cwd, state);
  const question = tr(`Заменить автора в ${plan.count} commit(ах) ветки "${state.branch}", которых ещё нет в GitHub, на ${identity.login} <${identity.email}> и отправить?`,
    `Change the author of ${plan.count} commit(s) on "${state.branch}" that GitHub does not have yet to ${identity.login} <${identity.email}> and push?`);
  if (!await panel.confirm(question, tr('Исправить и отправить', 'Fix and push'))) return false;
  panel.progress(tr('Исправление автора…', 'Fixing the author…'));
  await rewriteAuthors(cwd, plan.rebaseArgs);
  return true;
}

// After GitHub rejected a push with GH007: the not-yet-pushed commits get the
// GitHub noreply author and the branch is pushed again.
async function fixAuthorAndPush(panel) {
  const cwd = panel.workspaceRoot();
  requireOrigin(await loadReadyState(cwd));
  await fetchOrigin(panel, cwd);
  const state = await loadReadyState(cwd);
  const identity = await panel.requireIdentity(cwd, state);
  if (!identity) throw new PanelError(tr('Нужно войти в GitHub.', 'Sign in to GitHub first.'), { action: 'signIn' });
  if (await rewriteUnpushedAuthors(panel, cwd, state, identity)) await pushCurrentBranch(panel, cwd, state.branch);
}

module.exports = { commit, push, fixAuthorAndPush, commitFiles, pushCurrentBranch, otherAuthors, rewriteUnpushedAuthors };
