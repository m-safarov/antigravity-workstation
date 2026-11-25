import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const root = path.resolve(import.meta.dirname, '..');
const panelRoot = path.join(root, 'extensions', 'git-branch-panel');
const { GithubPanelProvider } = require(path.join(panelRoot, 'src/panel-provider.js'));
const { renderHtml, ENGLISH } = require(path.join(panelRoot, 'src/webview-html.js'));
const { suggestCommitMessage, redactDiffText } = require(path.join(panelRoot, 'src/commit-suggest.js'));

const ACCOUNT = { id: '583231', label: 'octocat' };

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function makeTeamFixture(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'github-panel-collab-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const remote = path.join(base, 'remote.git');
  const devA = path.join(base, 'dev-a');
  const devB = path.join(base, 'dev-b');
  fs.mkdirSync(remote);
  git(remote, 'init', '--bare', '-b', 'main');
  git(base, 'clone', remote, devA);
  git(devA, 'config', 'core.autocrlf', 'false');
  git(devA, 'config', 'user.name', 'Dev A');
  git(devA, 'config', 'user.email', 'deva@example.invalid');
  fs.writeFileSync(path.join(devA, 'app.tsx'), 'export default function App() { return <main>v1</main>; }\n');
  git(devA, 'add', '.');
  git(devA, 'commit', '-m', 'chore: initial app');
  git(devA, 'push', '-u', 'origin', 'main');
  git(base, 'clone', remote, devB);
  git(devB, 'config', 'core.autocrlf', 'false');
  git(devB, 'config', 'user.name', 'Dev B');
  git(devB, 'config', 'user.email', 'devb@example.invalid');
  return { base, remote, devA, devB };
}

function createPanel(repo, { language = 'en', token = 'gho_test_token', apiBase = null, commands = {}, confirmAnswer = undefined } = {}) {
  const messages = [];
  const prompts = [];
  const values = new Map();
  const vscode = {
    env: { language },
    authentication: {
      async getSession() {
        return token ? { account: ACCOUNT, accessToken: token } : undefined;
      },
    },
    window: {
      async showWarningMessage(text, _options, button) {
        prompts.push(text);
        return confirmAnswer === undefined ? button : confirmAnswer;
      },
    },
    workspace: { workspaceFolders: [{ uri: { fsPath: repo } }], textDocuments: [] },
    commands: {
      async executeCommand(name, arg) {
        if (commands[name]) return commands[name](arg);
        return undefined;
      },
    },
  };
  const provider = new GithubPanelProvider(vscode, {
    globalState: { get: (k, f) => values.has(k) ? values.get(k) : f, update: async (k, v) => values.set(k, v) },
  });
  if (apiBase) provider.githubApiOptions = { apiBase };
  provider.resolveWebviewView({
    webview: { postMessage: m => messages.push(m), onDidReceiveMessage: () => ({ dispose() {} }) },
  });
  return {
    provider,
    messages,
    prompts,
    send: m => provider.handleMessage(m),
    lastState: () => messages.filter(m => m.type === 'state').at(-1)?.state,
    notices: level => messages.filter(m => m.type === 'notice' && (!level || m.level === level)),
  };
}

test('Two-clone collaboration: upstream tracking, multi-remote, remote deletion, detached HEAD, and stale async refresh drop', async t => {
  const f = makeTeamFixture(t);
  // Dev B creates feature branch and pushes
  git(f.devB, 'switch', '-c', 'feat/nav');
  fs.writeFileSync(path.join(f.devB, 'nav.tsx'), 'export const Nav = () => <nav />;\n');
  git(f.devB, 'add', '.');
  git(f.devB, 'commit', '-m', 'feat(nav): add navigation');
  git(f.devB, 'push', '-u', 'origin', 'feat/nav');

  // Dev A refreshes and pulls feat/nav into main, then tests remote deletion handling
  const panelA = createPanel(f.devA);
  await panelA.send({ command: 'fetch' });
  const state1 = panelA.lastState();
  assert.equal(state1.upstream, 'origin/main');
  assert.equal(state1.upstreamRemote, 'origin');
  assert.equal(state1.upstreamBranch, 'main');
  assert.ok(state1.branches.some(b => b.name === 'feat/nav' && b.isRemote));

  // Add second remote to verify multi-remote reporting
  const secondRemote = path.join(f.base, 'upstream.git');
  fs.mkdirSync(secondRemote);
  git(secondRemote, 'init', '--bare', '-b', 'main');
  git(f.devA, 'remote', 'add', 'upstream', secondRemote);
  await panelA.send({ command: 'refresh' });
  assert.ok(panelA.lastState().remotes.includes('upstream'));

  // Dev B pushes to main, Dev A syncs cleanly via explicit upstream source -> dest
  git(f.devB, 'switch', 'main');
  fs.writeFileSync(path.join(f.devB, 'team.txt'), 'from dev B\n');
  git(f.devB, 'add', '.');
  git(f.devB, 'commit', '-m', 'chore: add team note');
  git(f.devB, 'push', 'origin', 'main');

  await panelA.send({ command: 'syncBranch' });
  assert.equal(fs.readFileSync(path.join(f.devA, 'team.txt'), 'utf8'), 'from dev B\n');
  assert.ok(panelA.notices('ok').some(n => /origin\/main.*main/.test(n.text)));

  // Delete feat/nav on remote from Dev B; Dev A trying to pull feat/nav gets factual deleted-branch error
  git(f.devB, 'push', 'origin', '--delete', 'feat/nav');
  await panelA.send({ command: 'pullBranch', sourceBranch: 'feat/nav' });
  assert.ok(panelA.notices('error').some(n => /does not exist|deleted/i.test(n.text)));

  // Detached HEAD reports clear detached state without crashing
  const headSha = git(f.devA, 'rev-parse', 'HEAD');
  git(f.devA, 'checkout', '--detach', headSha);
  await panelA.send({ command: 'refresh' });
  assert.equal(panelA.lastState().detached, true);
  assert.match(panelA.lastState().error, /detached HEAD/i);
  git(f.devA, 'switch', 'main');

  // Stale async response guard: bumping stateGeneration while collectAndPost is in flight drops older state
  const beforeCount = panelA.messages.filter(m => m.type === 'state').length;
  const inflight = panelA.provider.collectAndPost();
  panelA.provider.stateGeneration += 5;
  await inflight;
  assert.equal(panelA.messages.filter(m => m.type === 'state').length, beforeCount, 'stale async state must be dropped');
});

test('Pull Request workflow validates head/base explicitly, detects existing PR, creates new PR, and enforces GitHub permissions & branch protections on delete', async t => {
  const f = makeTeamFixture(t);
  const ghUrl = 'https://github.com/acme/next-app.git';
  git(f.devA, 'remote', 'set-url', 'origin', ghUrl);
  git(f.devA, 'config', `url.${f.remote}.insteadOf`, ghUrl);
  git(f.devA, 'switch', '-c', 'feat/api');
  fs.writeFileSync(path.join(f.devA, 'route.ts'), 'export async function GET() { return Response.json({ ok: true }); }\n');
  git(f.devA, 'add', '.');
  git(f.devA, 'commit', '-m', 'feat(api): add health route');
  git(f.devA, 'push', '-u', 'origin', 'feat/api');

  let openPrs = [];
  let repoPermissions = { push: true, admin: false, maintain: false };
  let protectedBranches = new Set();
  const createdRequests = [];

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (req.method === 'GET' && url.pathname === '/repos/acme/next-app/pulls') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(openPrs));
        return;
      }
      if (req.method === 'POST' && url.pathname === '/repos/acme/next-app/pulls') {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        createdRequests.push(body);
        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ number: 42, title: body.title, state: 'open', html_url: 'https://github.com/acme/next-app/pull/42' }));
        return;
      }
      if (req.method === 'GET' && url.pathname === '/repos/acme/next-app') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ default_branch: 'main', permissions: repoPermissions }));
        return;
      }
      if (req.method === 'GET' && url.pathname.startsWith('/repos/acme/next-app/branches/')) {
        const branch = decodeURIComponent(url.pathname.split('/').slice(5).join('/'));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ name: branch, protected: protectedBranches.has(branch) }));
        return;
      }
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ message: 'Not Found' }));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const apiBase = `http://127.0.0.1:${server.address().port}`;
  const panel = createPanel(f.devA, { apiBase });

  // 1. Missing base branch must NEVER silently substitute main
  await panel.send({ command: 'createPullRequest', head: 'feat/api', base: '', title: 'Add health route' });
  assert.ok(panel.notices('error').some(n => /Select both/i.test(n.text)));
  assert.equal(createdRequests.length, 0);

  // 2. Identical head & base refused
  await panel.send({ command: 'createPullRequest', head: 'feat/api', base: 'feat/api', title: 'Same' });
  assert.equal(createdRequests.length, 0);

  // 3. Existing open PR detected without creating duplicate
  openPrs = [{ number: 17, title: 'Existing PR', state: 'open', html_url: 'https://github.com/acme/next-app/pull/17' }];
  await panel.send({ command: 'createPullRequest', head: 'feat/api', base: 'main', title: 'Add health route' });
  assert.equal(createdRequests.length, 0);
  assert.ok(panel.notices('warn').some(n => /#17/.test(n.text)));

  // 4. Creates PR cleanly when none exists
  openPrs = [];
  await panel.send({ command: 'createPullRequest', head: 'feat/api', base: 'main', title: 'feat(api): add health route', body: 'Ready for review' });
  assert.equal(createdRequests.length, 1);
  assert.deepEqual({ head: createdRequests[0].head, base: createdRequests[0].base }, { head: 'feat/api', base: 'main' });
  assert.ok(panel.notices('ok').some(n => /#42/.test(n.text) && n.text.includes('https://github.com/acme/next-app/pull/42')));

  // 5. GitHub permission check blocks remote delete when push/admin are false (never inferred from username!)
  git(f.devA, 'switch', 'main');
  repoPermissions = { push: false, admin: false, maintain: false };
  await panel.send({ command: 'deleteBranches', branches: ['feat/api'], scope: 'remote' });
  assert.ok(panel.notices('error').some(n => /lack push\/admin permissions/i.test(n.text)));
  assert.ok(git(f.remote, 'rev-parse', 'refs/heads/feat/api'));

  // 6. GitHub branch protection blocks remote delete
  repoPermissions = { push: true, admin: false, maintain: false };
  protectedBranches.add('feat/api');
  await panel.send({ command: 'deleteBranches', branches: ['feat/api'], scope: 'remote' });
  assert.ok(panel.notices('error').some(n => /protected by GitHub branch protection/i.test(n.text)));
  assert.ok(git(f.remote, 'rev-parse', 'refs/heads/feat/api'));

  // 7. Scoped local-only delete removes local branch and keeps remote branch intact
  protectedBranches.clear();
  await panel.send({ command: 'deleteBranches', branches: ['feat/api'], scope: 'local' });
  assert.throws(() => git(f.devA, 'rev-parse', '--verify', 'refs/heads/feat/api'));
  assert.ok(git(f.remote, 'rev-parse', '--verify', 'refs/heads/feat/api'), 'local-only delete must keep remote branch');

  // 8. Scoped remote-only delete removes remote branch
  await panel.send({ command: 'deleteBranches', branches: ['feat/api'], scope: 'remote' });
  assert.throws(() => git(f.remote, 'rev-parse', '--verify', 'refs/heads/feat/api'));
});

test('Branch deletion blocks branches checked out in another Git worktree and reports partial outcomes for both-scope failures', async t => {
  const f = makeTeamFixture(t);
  git(f.devA, 'branch', 'wt-branch');
  const wtDir = path.join(f.base, 'extra-worktree');
  git(f.devA, 'worktree', 'add', wtDir, 'wt-branch');
  t.after(() => { try { git(f.devA, 'worktree', 'remove', '--force', wtDir); } catch {} });

  const panel = createPanel(f.devA);
  await panel.send({ command: 'deleteBranches', branches: ['wt-branch'], scope: 'local' });
  assert.ok(panel.notices('error').some(n => /another worktree/i.test(n.text)));
  assert.ok(git(f.devA, 'rev-parse', '--verify', 'refs/heads/wt-branch'));

  // Partial outcome test: local delete succeeds while remote delete is rejected by pre-receive hook
  git(f.devA, 'branch', 'partial-branch');
  git(f.devA, 'push', 'origin', 'partial-branch');
  const hook = path.join(f.remote, 'hooks', 'pre-receive');
  fs.writeFileSync(hook, '#!/bin/sh\necho "remote delete forbidden" >&2\nexit 1\n');
  fs.chmodSync(hook, 0o755);
  await panel.send({ command: 'deleteBranches', branches: ['partial-branch'], scope: 'both' });
  assert.throws(() => git(f.devA, 'rev-parse', '--verify', 'refs/heads/partial-branch'), 'local delete succeeded');
  assert.ok(git(f.remote, 'rev-parse', '--verify', 'refs/heads/partial-branch'), 'remote delete failed as simulated');
  assert.ok(panel.notices('warn').some(n => /local deleted;.*GitHub:/i.test(n.text)), 'partial outcome must be reported accurately');
});

test('Commit suggestion derives from actual diff, redacts secrets, uses optional AI or local fallback, and webview Tab accepts only when empty without auto-committing', async t => {
  const f = makeTeamFixture(t);
  fs.writeFileSync(path.join(f.devA, 'src-auth.ts'), 'export function login() { const token = "sk-secret1234567890abcdef"; return true; }\n');
  fs.writeFileSync(path.join(f.devA, '.env'), 'API_KEY=supersecret\n');

  assert.equal(redactDiffText('Authorization: Bearer secret_abc_123456').includes('secret_abc_123456'), false);

  // Deterministic local fallback when AI is unavailable/disabled
  const panelLocal = createPanel(f.devA);
  const stateLocal = { changedFiles: [{ file: 'src-auth.ts', status: '??', secret: false }, { file: '.env', status: '??', secret: true }] };
  const localRes = await suggestCommitMessage(panelLocal.provider, f.devA, stateLocal, ['src-auth.ts', '.env']);
  assert.equal(localRes.source, 'local');
  assert.match(localRes.suggestion, /src-auth\.ts/);
  assert.equal(localRes.files.includes('.env'), false, 'secret files must never be included in commit suggestion');

  // Optional AI path via workstationStability.generateText redacts secrets before sending
  let capturedPrompt = '';
  const panelAi = createPanel(f.devA, {
    commands: {
      'workstationStability.generateText': async payload => {
        capturedPrompt = payload.userPrompt;
        return { ok: true, text: 'feat(auth): add login helper' };
      },
    },
  });
  const aiRes = await suggestCommitMessage(panelAi.provider, f.devA, stateLocal, ['src-auth.ts']);
  assert.equal(aiRes.source, 'ai');
  assert.equal(aiRes.suggestion, 'feat(auth): add login helper');
  assert.equal(capturedPrompt.includes('sk-secret1234567890abcdef'), false);

  // Webview Tab behavior: Tab accepts active suggestion when textarea is empty (never auto-commits/pushes),
  // and keeps normal Tab navigation once manual text exists or suggestion is inactive.
  class El {
    constructor(tag) { this.tag = tag; this.children = []; this.dataset = {}; this.value = ''; this.hidden = false; this.listeners = {}; }
    set innerHTML(_v) { this.children = []; }
    appendChild(c) { this.children.push(c); if (this.tag === 'select' && (this.children.length === 1 || c.selected)) this.value = c.value; }
    append(...cs) { cs.forEach(c => this.appendChild(c)); }
    addEventListener(n, fn) { this.listeners[n] = fn; }
    querySelector() { return new El('span'); }
    querySelectorAll(sel) { return this.children.flatMap(c => [c, ...c.querySelectorAll(sel)]).filter(c => c.tag === sel); }
  }
  const map = new Map();
  const posted = [];
  const doc = {
    createElement: tag => new El(tag),
    getElementById: id => { if (!map.has(id)) map.set(id, new El(['branchSelect', 'newBranchBase', 'pullSource', 'prHead', 'prBase', 'deleteScope'].includes(id) ? 'select' : 'div')); return map.get(id); },
    querySelectorAll: () => [],
    addEventListener() {},
    visibilityState: 'visible',
  };
  let messageHandler = null;
  const ctx = {
    document: doc,
    UI: ENGLISH,
    acquireVsCodeApi: () => ({ postMessage: m => posted.push(m) }),
    window: { addEventListener: (e, fn) => { if (e === 'message') messageHandler = fn; } },
    setInterval() {},
    JSON, Object, Array, Map, Set, Boolean, String,
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(panelRoot, 'src/webview/view.js'), 'utf8'), ctx);
  messageHandler({
    data: {
      type: 'state',
      state: {
        root: f.devA, isRepo: true, branch: 'main', repoName: 'acme/next-app', remote: 'https://github.com/acme/next-app.git',
        isGitHub: true, defaultBranch: 'main', upstream: 'origin/main', upstreamRemote: 'origin', upstreamBranch: 'main',
        branches: [{ name: 'main', isLocal: true, isRemote: true, isCurrent: true, isDefault: true }],
        changedFiles: [{ file: 'src-auth.ts', status: '??', secret: false }],
        conflicts: [], mergeInProgress: false, rebaseInProgress: false, hasCommits: true, remoteBranchExists: true, ahead: 0, behind: 0, error: null,
      },
    },
  });
  const req = posted.find(m => m.command === 'suggestCommit');
  assert.ok(req, 'webview requests debounced commit suggestion');
  messageHandler({ data: { type: 'commitSuggestion', requestId: req.requestId, suggestion: 'feat(auth): add login helper', source: 'local' } });
  assert.equal(doc.getElementById('commitSuggestionBar').hidden, false);

  let prevented = false;
  ctx.handleCommitKeydown({ key: 'Tab', preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  assert.equal(doc.getElementById('commitMessage').value, 'feat(auth): add login helper');
  assert.equal(posted.some(m => m.command === 'commit' || m.command === 'push'), false, 'Tab must never auto-commit or auto-push');

  // Pressing Tab again now that text is in the textarea preserves normal Tab navigation
  let preventedSecond = false;
  ctx.handleCommitKeydown({ key: 'Tab', preventDefault() { preventedSecond = true; } });
  assert.equal(preventedSecond, false, 'normal Tab navigation preserved when no suggestion is active');

  // Compact extension attribution footer with inline SVG icon exists separately from commit author line
  const html = renderHtml();
  assert.match(html, /<footer class="ext-footer"[\s\S]*<svg[\s\S]*Antigravity Workstation \(m-safarov\)/);
  assert.match(html, /id="authorLine"/);

  // Multi-remote pullSource includes secondary remotes (upstream/release) and sends explicit sourceRemote + sourceBranch
  messageHandler({
    data: {
      type: 'state',
      state: {
        root: f.devA, isRepo: true, branch: 'main', repoName: 'acme/next-app', remote: 'https://github.com/acme/next-app.git',
        remotes: ['origin', 'upstream'],
        isGitHub: true, defaultBranch: 'main', upstream: 'origin/main', upstreamRemote: 'origin', upstreamBranch: 'main',
        branches: [{ name: 'main', isLocal: true, isRemote: true, isCurrent: true, isDefault: true }],
        remoteBranches: [
          { remote: 'origin', branch: 'main', ref: 'origin/main' },
          { remote: 'upstream', branch: 'release', ref: 'upstream/release' },
        ],
        changedFiles: [], conflicts: [], mergeInProgress: false, rebaseInProgress: false, hasCommits: true, remoteBranchExists: true, ahead: 0, behind: 0, error: null,
      },
    },
  });
  const pullSelect = doc.getElementById('pullSource');
  assert.equal(pullSelect.children.length, 2);
  assert.equal(pullSelect.children[1].textContent, 'upstream/release');
  pullSelect.value = pullSelect.children[1].value;
  pullSelect.listeners.change();
  assert.equal(doc.getElementById('pullSummary').textContent, 'upstream/release → main');
  doc.getElementById('pullButton').listeners.click();
  const pullMsg = posted.filter(m => m.command === 'pullBranch').at(-1);
  assert.deepEqual({ sourceRemote: pullMsg.sourceRemote, sourceBranch: pullMsg.sourceBranch }, { sourceRemote: 'upstream', sourceBranch: 'release' });
});
