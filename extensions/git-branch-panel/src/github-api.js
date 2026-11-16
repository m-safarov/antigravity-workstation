'use strict';

// The two GitHub REST calls the panel makes: the public profile of a
// repository owner and creating a repository with the editor's GitHub account.
const https = require('https');
const { PanelError } = require('./git-errors');
const { tr } = require('./text');

const TIMEOUT_MS = 15000;

// Resolves with { status, data }; rejects when GitHub cannot be reached or
// does not answer within the timeout.
function requestGitHub(method, apiPath, { token, body, timeout = TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : '';
    const headers = { 'User-Agent': 'git-branch-panel', Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
    if (token) headers.Authorization = 'Bearer ' + token;
    if (payload) Object.assign(headers, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) });
    const request = https.request('https://api.github.com' + apiPath, { method, headers, timeout }, response => {
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
function fetchPublicUser(owner, timeout) {
  return requestGitHub('GET', '/users/' + encodeURIComponent(owner), { timeout })
    .then(response => response.status === 200 ? response.data : null, () => null);
}

// Creates an empty repository for the signed-in account and returns GitHub's
// description of it (clone_url, owner.login).
async function createRepository(token, name, isPrivate) {
  let response;
  try {
    response = await requestGitHub('POST', '/user/repos', { token, body: { name, private: isPrivate } });
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

module.exports = { requestGitHub, fetchPublicUser, createRepository };
