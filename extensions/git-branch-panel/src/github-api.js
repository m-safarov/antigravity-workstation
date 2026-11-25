'use strict';

// GitHub REST API client used by the panel: public owner profile, repository
// creation, repository metadata/permissions, branch protection, and Pull Requests.
const http = require('http');
const https = require('https');
const { PanelError } = require('./git-errors');
const { tr } = require('./text');

const TIMEOUT_MS = 15000;
const DEFAULT_API_BASE = 'https://api.github.com';

// Resolves with { status, data }; rejects when GitHub cannot be reached or
// does not answer within the timeout.
function requestGitHub(method, apiPath, { token, body, timeout = TIMEOUT_MS, apiBase = DEFAULT_API_BASE } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : '';
    const headers = { 'User-Agent': 'git-branch-panel', Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
    if (token) headers.Authorization = 'Bearer ' + token;
    if (payload) Object.assign(headers, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) });
    const url = apiBase.replace(/\/+$/, '') + apiPath;
    const transport = url.startsWith('http://') ? http : https;
    const request = transport.request(url, { method, headers, timeout }, response => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { text += chunk; });
      response.on('end', () => {
        let data = null;
        try { data = JSON.parse(text); } catch {}
        resolve({ status: response.statusCode, data });
      });
    });
    request.on('timeout', () => request.destroy(new Error(`no answer within ${Math.round(timeout / 1000)} s`)));
    request.on('error', reject);
    request.end(payload);
  });
}

// Public profile of a GitHub account, without a token, or null.
function fetchPublicUser(owner, timeout, options = {}) {
  return requestGitHub('GET', '/users/' + encodeURIComponent(owner), { timeout, apiBase: options.apiBase })
    .then(response => response.status === 200 ? response.data : null, () => null);
}

// Repository metadata including default_branch and explicit GitHub permissions.
async function getRepositoryMeta(token, owner, repo, options = {}) {
  const path = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  const response = await requestGitHub('GET', path, { token, timeout: options.timeout, apiBase: options.apiBase });
  if (response.status === 200 && response.data) return { ok: true, status: 200, data: response.data };
  return { ok: false, status: response.status, data: response.data };
}

// Branch metadata including protection flag.
async function getBranchInfo(token, owner, repo, branch, options = {}) {
  const path = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/branches/${encodeURIComponent(branch)}`;
  const response = await requestGitHub('GET', path, { token, timeout: options.timeout, apiBase: options.apiBase });
  if (response.status === 200 && response.data) return { ok: true, status: 200, data: response.data };
  return { ok: false, status: response.status, data: response.data };
}

// Lists open pull requests matching head (owner:branch) and base.
async function listOpenPullRequests(token, owner, repo, { head, base } = {}, options = {}) {
  const query = new URLSearchParams({ state: 'open' });
  if (head) query.set('head', head.includes(':') ? head : `${owner}:${head}`);
  if (base) query.set('base', base);
  const path = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls?${query.toString()}`;
  const response = await requestGitHub('GET', path, { token, timeout: options.timeout, apiBase: options.apiBase });
  if (response.status === 200 && Array.isArray(response.data)) return { ok: true, status: 200, data: response.data };
  return { ok: false, status: response.status, data: response.data };
}

// Creates a Pull Request via GitHub REST API.
async function createPullRequestApi(token, owner, repo, { title, body = '', head, base, draft = false }, options = {}) {
  const path = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls`;
  const response = await requestGitHub('POST', path, {
    token,
    body: { title, body, head, base, draft: Boolean(draft) },
    timeout: options.timeout,
    apiBase: options.apiBase,
  });
  if (response.status === 201 && response.data?.html_url) return { ok: true, status: 201, data: response.data };
  const reasons = [response.data?.message, ...(response.data?.errors || []).map(item => item.message || item.code)];
  return { ok: false, status: response.status, details: reasons.filter(Boolean).join('\n'), data: response.data };
}

// Creates an empty repository for the signed-in account and returns GitHub's
// description of it (clone_url, owner.login).
async function createRepository(token, name, isPrivate, options = {}) {
  let response;
  try {
    response = await requestGitHub('POST', '/user/repos', { token, body: { name, private: isPrivate }, apiBase: options.apiBase });
  } catch (error) {
    throw new PanelError(tr('Нет связи с GitHub.', 'GitHub cannot be reached.'), { details: error.message });
  }
  if (response.status === 201 && response.data?.clone_url) return response.data;
  const reasons = [response.data?.message, ...(response.data?.errors || []).map(item => item.message || item.code)];
  const details = reasons.filter(Boolean).join('\n');
  if (response.status === 422 && /already exists/i.test(details)) {
    throw new PanelError(tr(`В GitHub уже есть репозиторий "${name}". Выбери другое имя или подключи его по адресу.`,
      `GitHub already has a repository "${name}". Choose another name or connect it by its address.`), { details });
  }
  if (response.status === 401 || response.status === 403) {
    throw new PanelError(tr('GitHub не разрешил создать репозиторий. Войди в GitHub в редакторе ещё раз.',
      'GitHub did not allow creating the repository. Sign in to GitHub in the editor again.'), { details });
  }
  throw new PanelError(tr('GitHub не создал репозиторий.', 'GitHub did not create the repository.'), { details: details || `HTTP ${response.status}` });
}

module.exports = {
  requestGitHub,
  fetchPublicUser,
  getRepositoryMeta,
  getBranchInfo,
  listOpenPullRequests,
  createPullRequestApi,
  createRepository,
};
