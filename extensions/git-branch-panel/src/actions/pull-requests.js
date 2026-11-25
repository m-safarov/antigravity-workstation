'use strict';

const { runGit } = require('../git-runner');
const { parseGitHubRemote } = require('../git-state');
const { PanelError } = require('../git-errors');
const { getRepositoryMeta, listOpenPullRequests, createPullRequestApi } = require('../github-api');
const { tr } = require('../text');
const { loadReadyState, requireOrigin, checkBranchName } = require('./common');

async function getGitHubToken(panel, { interactive = false } = {}) {
  const auth = panel.vscode?.authentication;
  if (!auth?.getSession) return null;
  for (const scopes of [['repo'], ['repo', 'workflow', 'user:email', 'read:user']]) {
    try {
      const session = await auth.getSession('github', scopes, { silent: true });
      if (session?.accessToken) return session.accessToken;
    } catch {}
  }
  if (!interactive) return null;
  try {
    const session = await auth.getSession('github', ['repo'], { createIfNone: true });
    return session?.accessToken || null;
  } catch {
    return null;
  }
}

async function validatePullRequestEligibility(cwd, state, { head, base, remoteName }) {
  const remote = remoteName || state.upstreamRemote || 'origin';
  const headBranch = await checkBranchName(cwd, head);
  const baseBranch = await checkBranchName(cwd, base);
  if (headBranch === baseBranch) {
    throw new PanelError(tr('Ветки head и base совпадают. Выбери разные ветки для Pull Request.',
      'Head and base branches are identical. Choose two different branches for the Pull Request.'));
  }
  const hasRemoteHead = await runGit(['rev-parse', '--verify', '--quiet', `refs/remotes/${remote}/${headBranch}`], cwd).then(() => true, () => false);
  if (!hasRemoteHead) {
    throw new PanelError(tr(`Ветки "${headBranch}" ещё нет на ${remote}. Сначала сделай Push.`,
      `Branch "${headBranch}" is not on ${remote} yet. Push the branch first.`));
  }
  const hasRemoteBase = await runGit(['rev-parse', '--verify', '--quiet', `refs/remotes/${remote}/${baseBranch}`], cwd).then(() => true, () => false);
  if (!hasRemoteBase) {
    throw new PanelError(tr(`Базовая ветка "${baseBranch}" не найдена на ${remote}. Обнови ветки.`,
      `Base branch "${baseBranch}" was not found on ${remote}. Refresh branches first.`));
  }
  const aheadCount = Number(await runGit(['rev-list', '--count', `refs/remotes/${remote}/${baseBranch}..refs/remotes/${remote}/${headBranch}`], cwd).catch(() => '0'));
  if (!Number.isSafeInteger(aheadCount) || aheadCount <= 0) {
    throw new PanelError(tr(`В "${headBranch}" нет новых commits относительно "${baseBranch}".`,
      `"${headBranch}" has no new commits ahead of "${baseBranch}".`));
  }
  return { headBranch, baseBranch, remote, aheadCount };
}

async function createPullRequest(panel, request) {
  const cwd = panel.workspaceRoot();
  const state = await loadReadyState(cwd);
  requireOrigin(state);
  const gh = parseGitHubRemote(state.remote);
  if (!gh) {
    throw new PanelError(tr('Pull Request доступен только для репозиториев GitHub.',
      'Pull Requests are only supported for GitHub repositories.'));
  }
  // Never silently substitute main: require explicit base and head selections.
  const rawHead = typeof request?.head === 'string' ? request.head.trim() : '';
  const rawBase = typeof request?.base === 'string' ? request.base.trim() : '';
  if (!rawHead || !rawBase) {
    throw new PanelError(tr('Выбери обе ветки: источник (head) и целевую ветку (base).',
      'Select both the source (head) and target (base) branches.'));
  }
  const title = typeof request?.title === 'string' ? request.title.trim() : '';
  if (!title) {
    throw new PanelError(tr('Укажи заголовок Pull Request.', 'Enter a Pull Request title.'));
  }
  const body = typeof request?.body === 'string' ? request.body.trim() : '';
  const draft = Boolean(request?.draft);

  const { headBranch, baseBranch } = await validatePullRequestEligibility(cwd, state, {
    head: rawHead,
    base: rawBase,
    remoteName: request?.remote,
  });

  const apiOptions = panel.githubApiOptions || {};
  const token = await getGitHubToken(panel, { interactive: true });
  if (!token) {
    throw new PanelError(tr('Для создания Pull Request нужно войти в GitHub с правами repo.',
      'Sign in to GitHub with repo permissions to create a Pull Request.'), { action: 'signIn' });
  }

  panel.progress(tr(`Проверка Pull Request ${headBranch} → ${baseBranch}…`, `Checking Pull Request ${headBranch} → ${baseBranch}…`));
  const existing = await listOpenPullRequests(token, gh.owner, gh.repository, { head: headBranch, base: baseBranch }, apiOptions);
  if (!existing.ok && (existing.status === 401 || existing.status === 403)) {
    throw new PanelError(tr('Токен GitHub отклонён или истёк. Войди в GitHub ещё раз.',
      'GitHub rejected or expired the token. Sign in to GitHub again.'), { action: 'signIn', details: `HTTP ${existing.status}` });
  }
  if (existing.ok && existing.data.length > 0) {
    const pr = existing.data[0];
    panel.post({ type: 'prResult', pr: { number: pr.number, title: pr.title, url: pr.html_url, state: pr.state, existing: true, head: headBranch, base: baseBranch } });
    panel.notice('warn', tr(`Открытый Pull Request #${pr.number} (${headBranch} → ${baseBranch}) уже существует: ${pr.html_url}`,
      `An open Pull Request #${pr.number} (${headBranch} → ${baseBranch}) already exists: ${pr.html_url}`));
    return pr;
  }

  panel.progress(tr(`Создание Pull Request ${headBranch} → ${baseBranch}…`, `Creating Pull Request ${headBranch} → ${baseBranch}…`));
  const created = await createPullRequestApi(token, gh.owner, gh.repository, {
    title,
    body,
    head: headBranch,
    base: baseBranch,
    draft,
  }, apiOptions);

  if (!created.ok) {
    if (created.status === 401 || created.status === 403) {
      throw new PanelError(tr('Недостаточно прав GitHub для создания Pull Request.',
        'Insufficient GitHub permissions to create a Pull Request.'), { action: 'signIn', details: created.details || `HTTP ${created.status}` });
    }
    throw new PanelError(tr('GitHub не создал Pull Request.', 'GitHub could not create the Pull Request.'),
      { details: created.details || `HTTP ${created.status}` });
  }

  const pr = created.data;
  panel.post({ type: 'prResult', pr: { number: pr.number, title: pr.title, url: pr.html_url, state: pr.state || 'open', existing: false, head: headBranch, base: baseBranch } });
  panel.notice('ok', tr(`Pull Request #${pr.number} создан (${headBranch} → ${baseBranch}): ${pr.html_url}`,
    `Pull Request #${pr.number} created (${headBranch} → ${baseBranch}): ${pr.html_url}`), { clear: 'prTitle' });
  return pr;
}

async function checkRemoteDeleteAuthorization(panel, remoteUrl, branch) {
  const gh = parseGitHubRemote(remoteUrl);
  if (!gh) return { checked: false, allowed: true };
  const token = await getGitHubToken(panel, { interactive: false });
  if (!token) return { checked: false, allowed: true };
  const apiOptions = panel.githubApiOptions || {};
  const meta = await getRepositoryMeta(token, gh.owner, gh.repository, apiOptions).catch(() => null);
  if (!meta) return { checked: false, allowed: true };
  if (meta.status === 401 || meta.status === 403) {
    return {
      checked: true,
      allowed: false,
      reason: tr('Токен GitHub не имеет доступа к этому репозиторию.', 'GitHub token lacks access to this repository.'),
    };
  }
  if (meta.ok && meta.data) {
    const perms = meta.data.permissions;
    if (perms && !perms.push && !perms.admin && !perms.maintain) {
      return {
        checked: true,
        allowed: false,
        reason: tr('Нет прав push/admin в этом репозитории GitHub для удаления удалённых веток.',
          'You lack push/admin permissions on this GitHub repository to delete remote branches.'),
      };
    }
    if (meta.data.default_branch && branch === meta.data.default_branch) {
      return {
        checked: true,
        allowed: false,
        reason: tr(`Ветка "${branch}" является веткой по умолчанию на GitHub и не может быть удалена.`,
          `Branch "${branch}" is the default branch on GitHub and cannot be deleted.`),
      };
    }
  }
  const { getBranchInfo } = require('../github-api');
  const branchInfo = await getBranchInfo(token, gh.owner, gh.repository, branch, apiOptions).catch(() => null);
  if (branchInfo?.ok && branchInfo.data?.protected) {
    return {
      checked: true,
      allowed: false,
      reason: tr(`Ветка "${branch}" защищена правилами branch protection на GitHub.`,
        `Branch "${branch}" is protected by GitHub branch protection rules.`),
    };
  }
  return { checked: true, allowed: true };
}

module.exports = {
  getGitHubToken,
  validatePullRequestEligibility,
  createPullRequest,
  checkRemoteDeleteAuthorization,
};
