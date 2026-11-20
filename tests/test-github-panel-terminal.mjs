import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import https from 'node:https';
import { EventEmitter } from 'node:events';
import { execFile, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

// The panel's git commands run visibly in the editor terminal. The fake
// terminal below has shell integration and runs every command line in real
// bash, so quoting, the working folder and git behave as in Git Bash.
const require = createRequire(import.meta.url);
const panelRoot = path.resolve(import.meta.dirname, '../extensions/git-branch-panel');
const { GithubPanelProvider } = require(path.join(panelRoot, 'src/panel-provider.js'));
const { GitTerminal } = require(path.join(panelRoot, 'src/git-terminal.js'));
const { configureGit } = require(path.join(panelRoot, 'src/git-runner.js'));
const { quoteArg, commandLine, stripAnsi } = require(path.join(panelRoot, 'src/shell.js'));
const { repositoryName } = require(path.join(panelRoot, 'src/actions/repository.js'));

const ACCOUNT = { id: '583231', label: 'octocat' };
const NOREPLY = '583231+octocat@users.noreply.github.com';
const GITHUB_URL = 'https://github.com/octocat/demo.git';

// The terminal shell: Git Bash on Windows (resolved via lib/paths so bare `bash`
// never hits a WindowsApps WSL stub), bash elsewhere.
const { getEnvironmentPaths } = require('../lib/paths');
const BASH = process.platform === 'win32'
  ? (getEnvironmentPaths().gitBashPath && fs.existsSync(getEnvironmentPaths().gitBashPath)
    ? getEnvironmentPaths().gitBashPath
    : execFileSync('bash', ['-c', 'cygpath -w /usr/bin/bash'], { encoding: 'utf8' }).trim())
  : '/bin/bash';

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function setEnv(t, name, value) {
  const previous = process.env[name];
  process.env[name] = value;
  t.after(() => { if (previous === undefined) delete process.env[name]; else process.env[name] = previous; });
}

// A bare "GitHub" remote reached through url.insteadOf, and a global git
// config with another person's name that must never be used or changed.
function fixture(t, { root = os.tmpdir(), name = 'repo' } = {}) {
  const base = fs.mkdtempSync(path.join(root, 'panel-terminal-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const remote = path.join(base, 'remote.git'), repo = path.join(base, name);
  git(base, 'init', '--bare', '-b', 'main', remote);
  fs.mkdirSync(repo);
  const globalFile = path.join(base, 'global.gitconfig');
  fs.writeFileSync(globalFile, `[user]\n\tname = Someone Else\n\temail = someone.else@gmail.com\n[url "${remote.replace(/\\/g, '/')}"]\n\tinsteadOf = ${GITHUB_URL}\n`);
  setEnv(t, 'GIT_CONFIG_GLOBAL', globalFile);
  return { base, remote, repo, globalFile, globalText: fs.readFileSync(globalFile, 'utf8') };
}

function fakeWindow(options = {}) {
  const listeners = { integration: new Set(), start: new Set(), end: new Set(), close: new Set() };
  const on = name => listener => { listeners[name].add(listener); return { dispose: () => listeners[name].delete(listener) }; };
  const fire = (name, event) => [...listeners[name]].forEach(listener => listener(event));
  const terminals = [], lines = [];
  function execute(terminal, line) {
    lines.push(line);
    let output = '', finished;
    const done = new Promise(resolve => { finished = resolve; });
    const execution = { commandLine: { value: line }, async *read() { await done; yield '\x1b[1m' + output + '\x1b[0m\x1b]633;D\x07'; } };
    setImmediate(() => fire('start', { terminal, execution }));
    if (options.hang?.(line, terminal)) return execution;
    if (options.interrupt?.(line)) {
      setImmediate(() => { finished(); fire('end', { terminal, execution, exitCode: 130 }); });
      return execution;
    }
    // pwd -W gives Git Bash's Windows path (C:/…), which Node can use as cwd.
    const script = `${line} 2>&1\nstatus=$?\nprintf '\\0%s' "$(pwd -W 2>/dev/null || pwd)"\nexit $status`;
    // From a file, as a terminal reads typed text: on Windows a -c argument would
    // pass through the C runtime's argv parsing and lose backslashes.
    const file = path.join(os.tmpdir(), `panel-terminal-${process.pid}-${lines.length}-${Date.now()}.sh`);
    fs.writeFileSync(file, script);
    execFile(BASH, [file], { cwd: terminal.cwd, env: process.env }, (error, stdout) => {
      fs.rmSync(file, { force: true });
      const split = stdout.lastIndexOf('\0');
      output = stdout.slice(0, split);
      terminal.cwd = stdout.slice(split + 1);
      finished();
      setImmediate(() => fire('end', { terminal, execution, exitCode: error ? error.code : 0 }));
    });
    return execution;
  }
  return {
    terminals, lines, fire,
    onDidChangeTerminalShellIntegration: on('integration'),
    onDidStartTerminalShellExecution: on('start'),
    onDidEndTerminalShellExecution: on('end'),
    onDidCloseTerminal: on('close'),
    createTerminal(terminalOptions) {
      const terminal = {
        options: terminalOptions, cwd: terminalOptions.cwd, sent: [], shown: [], shellIntegration: undefined,
        show(preserveFocus) { this.shown.push(preserveFocus); },
        sendText(text, addNewLine) { this.sent.push([text, addNewLine]); },
        dispose() { fire('close', terminal); },
      };
      const integration = { get cwd() { return { fsPath: terminal.cwd }; }, executeCommand: line => execute(terminal, line) };
      terminals.push(terminal);
      if (options.integration !== false) {
        setTimeout(() => { terminal.shellIntegration = integration; fire('integration', { terminal, shellIntegration: integration }); }, 10);
      }
      return terminal;
    },
  };
}

function memento() {
  const values = new Map();
  return { get: (key, fallback) => values.has(key) ? values.get(key) : fallback, update: async (key, value) => { values.set(key, value); } };
}

function openPanel(t, repo, window, extra = {}) {
  const messages = [], prompts = [], inputs = [], logs = [];
  Object.assign(window, {
    async showWarningMessage(text, _options, button) { prompts.push(text); return button; },
    async showQuickPick(items) { return extra.pick ? extra.pick(items) : items[0]; },
    async showInputBox(options) { inputs.push(options); return extra.input ? extra.input(options) : options.value; },
  });
  const vscode = {
    env: { language: 'ru', shell: BASH },
    ThemeIcon: class { constructor(id) { this.id = id; } },
    authentication: { async getSession(_id, scopes, options) { return { account: ACCOUNT, accessToken: 'test-token', scopes, options }; } },
    window,
    workspace: { workspaceFolders: [{ uri: { fsPath: repo } }], textDocuments: [],
      getConfiguration: () => ({ get: key => key === 'profiles.windows' ? { 'Git Bash': { path: BASH, args: ['--login', '-i'] } } : undefined }) },
  };
  const terminal = new GitTerminal(vscode, 'git');
  configureGit({ executable: 'git', log: message => logs.push(message), terminal: (args, cwd, timeout) => terminal.run(args, cwd, extra.timeout || timeout) });
  t.after(() => { configureGit({ terminal: null, log: () => {} }); terminal.dispose(); });
  const provider = new GithubPanelProvider(vscode, { globalState: memento() }, message => logs.push(message));
  provider.identities.lookupUser = async owner => ({ login: owner, id: 583231, type: 'User' });
  provider.resolveWebviewView({ webview: { postMessage: message => messages.push(message), onDidReceiveMessage: () => ({ dispose() {} }) } });
  return { provider, messages, prompts, inputs, logs, send: message => provider.handleMessage(message) };
}

const errors = h => h.messages.filter(message => message.type === 'notice' && message.level === 'error');
const lastState = h => h.messages.filter(message => message.type === 'state').at(-1).state;

function connectedRepository(f) {
  git(f.repo, 'init', '-b', 'main');
  git(f.repo, 'remote', 'add', 'origin', GITHUB_URL);
}

test('Bash quoting keeps every argument literal, also quotes, $, backticks, ! and line breaks in an interactive shell', () => {
  const samples = ['plain-word', 'with space', "it's", 'a "quoted" $HOME `id` $(id) \\ back', 'bang!! !$ !-1 x!y', 'line1\nline2\ttab\r', "mix'\n!x !!", '', 'привет мир', "'''"];
  for (const sample of samples) {
    const quoted = quoteArg(sample);
    assert.doesNotMatch(quoted, /[\n\r]/, 'the command stays on one line');
    assert.equal(execFileSync(BASH, ['-c', 'printf %s ' + quoted], { encoding: 'utf8' }), sample);
    // Interactive bash expands !! outside quotes; the quoted text stays as is.
    const typed = execFileSync(BASH, ['--norc', '--noprofile', '-i'], { input: `printf %s ${quoted}\nexit\n`, encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] });
    assert.equal(typed, sample, JSON.stringify(sample));
  }
  assert.equal(commandLine(['git', 'commit', '-m', 'Add form']), "git commit -m 'Add form'");
  assert.equal(commandLine(['git', 'push', '-u', 'origin', 'main']), 'git push -u origin main');
  assert.equal(commandLine(['git', 'commit', '-m', '/fix'], 'win32'), 'MSYS_NO_PATHCONV=1 git commit -m /fix', 'Git Bash would rewrite /fix into a Windows path');
  assert.equal(stripAnsi('\x1b[1mbold\x1b[0m \x1b]633;C\x07done\x1b[K'), 'bold done');
  assert.equal(repositoryName('Мой проект 2'), '2');
  assert.equal(repositoryName('Мой проект'), 'project');
  assert.equal(repositoryName('my app'), 'my-app');
});

test('Commit and Push run visibly in one reused GitHub terminal; a tricky message stays text and the owner is the author', async t => {
  const f = fixture(t);
  connectedRepository(f);
  fs.writeFileSync(path.join(f.repo, 'a.txt'), 'a\n');
  fs.writeFileSync(path.join(f.repo, 'b.txt'), 'b\n');
  const window = fakeWindow(), h = openPanel(t, f.repo, window);
  const message = 'feat: "форма" it\'s $HOME `touch hacked` $(touch hacked2) !! \\n end\nsecond line';
  await h.send({ command: 'commit', message, files: ['a.txt', 'b.txt'] });
  assert.deepEqual(errors(h), []);
  assert.equal(git(f.repo, 'log', '-1', '--format=%B'), message);
  assert.equal(git(f.repo, 'log', '-1', '--format=%an <%ae>'), `octocat <${NOREPLY}>`);
  assert.equal(fs.existsSync(path.join(f.repo, 'hacked')) || fs.existsSync(path.join(f.repo, 'hacked2')), false, 'the message never runs');
  assert.deepEqual(window.lines.slice(0, 2), ['git add -A', 'git commit -m ' + quoteArg(message)]);
  await h.send({ command: 'push' });
  assert.equal(window.lines.at(-1), 'git push -u origin main');
  assert.equal(git(f.remote, 'log', '-1', '--format=%an <%ae>', 'main'), `octocat <${NOREPLY}>`);
  assert.equal(window.terminals.length, 1, 'one terminal is reused');
  const [terminal] = window.terminals;
  assert.equal(terminal.options.name, 'GitHub');
  assert.equal(terminal.options.shellPath, BASH);
  assert.ok(terminal.shown.every(preserveFocus => preserveFocus === true), 'the panel keeps the focus');
  assert.deepEqual(terminal.sent, [], 'nothing is typed twice');
  assert.equal(git(f.repo, 'config', '--local', 'user.email'), NOREPLY);
  assert.equal(fs.readFileSync(f.globalFile, 'utf8'), f.globalText, 'the global git config is never changed');
  assert.equal(lastState(h).ahead, 0);
});

test('A failed command shows what git printed, the panel unlocks, and a terminal moved elsewhere goes back first', async t => {
  const f = fixture(t);
  connectedRepository(f);
  fs.writeFileSync(path.join(f.repo, 'a.txt'), 'a\n');
  const window = fakeWindow(), h = openPanel(t, f.repo, window);
  await h.send({ command: 'commit', message: 'first', files: ['a.txt'] });
  window.terminals[0].cwd = f.base;
  git(f.repo, 'remote', 'set-url', 'origin', path.join(f.base, 'missing.git'));
  await h.send({ command: 'push' });
  assert.deepEqual(window.lines.slice(-2), [`cd ${quoteArg(f.repo.replace(/\\/g, '/'))}`, 'git push -u origin main']);
  assert.match(errors(h)[0].text, /missing\.git/);
  assert.doesNotMatch(errors(h)[0].text, /\x1b/, 'colour codes are removed');
  assert.equal(lastState(h).busy, false);
  assert.equal(h.provider.busy, false);
});

test('Without shell integration git runs in the background, the command is logged and nothing is typed', async t => {
  const f = fixture(t);
  connectedRepository(f);
  fs.writeFileSync(path.join(f.repo, 'a.txt'), 'a\n');
  const window = fakeWindow({ integration: false }), h = openPanel(t, f.repo, window);
  await h.send({ command: 'commit', message: 'background', files: ['a.txt'] });
  assert.deepEqual(errors(h), []);
  assert.equal(git(f.repo, 'log', '-1', '--format=%s %ae'), 'background ' + NOREPLY);
  assert.deepEqual(window.lines, []);
  assert.deepEqual(window.terminals[0].sent, []);
  assert.ok(h.logs.some(line => line.startsWith('git add -A (background')), h.logs.join('\n'));
  await h.send({ command: 'push' });
  assert.equal(window.terminals.length, 1, 'no new terminal and no second wait');
  assert.equal(git(f.remote, 'rev-parse', 'main'), git(f.repo, 'rev-parse', 'HEAD'));
});

test('A command that never ends is stopped with Ctrl+C after its timeout and the panel unlocks', async t => {
  const f = fixture(t);
  connectedRepository(f);
  fs.writeFileSync(path.join(f.repo, 'a.txt'), 'a\n'); git(f.repo, 'add', '.'); git(f.repo, 'commit', '-m', 'a');
  const window = fakeWindow({ hang: line => line.startsWith('git push') }), h = openPanel(t, f.repo, window, { timeout: 300 });
  await h.send({ command: 'push' });
  assert.match(errors(h)[0].text, /не ответил вовремя/);
  assert.deepEqual(window.terminals[0].sent.at(-1), ['\x03', false]);
  assert.equal(lastState(h).busy, false);
});

test('Closing the terminal during a command reports it; a command the user runs there sends git to the background', async t => {
  const f = fixture(t);
  connectedRepository(f);
  fs.writeFileSync(path.join(f.repo, 'a.txt'), 'a\n'); git(f.repo, 'add', '.'); git(f.repo, 'commit', '-m', 'a');
  const window = fakeWindow({ hang: (line, terminal) => line.startsWith('git push') && setTimeout(() => terminal.dispose(), 30) });
  const h = openPanel(t, f.repo, window);
  await h.send({ command: 'push' });
  assert.match(errors(h)[0].text, /Терминал GitHub закрыт/);
  assert.equal(lastState(h).busy, false);
  const other = fakeWindow(), busy = openPanel(t, f.repo, other);
  await busy.send({ command: 'fetch' });
  const [terminal] = other.terminals;
  other.fire('start', { terminal, execution: { commandLine: { value: 'npm run dev' } } });
  await busy.send({ command: 'push' });
  assert.deepEqual(errors(busy), []);
  assert.equal(other.lines.some(line => line.startsWith('git push')), false, 'never typed into the running command');
  assert.equal(git(f.remote, 'rev-parse', 'main'), git(f.repo, 'rev-parse', 'HEAD'));
});

test('Create repository: git init on main, a .gitignore and a first commit without dependencies or secrets; git config is not written', async t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.repo, 'package.json'), '{"name":"site"}\n');
  fs.mkdirSync(path.join(f.repo, 'node_modules/react'), { recursive: true });
  fs.writeFileSync(path.join(f.repo, 'node_modules/react/index.js'), '');
  fs.writeFileSync(path.join(f.repo, '.env'), 'TOKEN=1\n');
  const window = fakeWindow(), h = openPanel(t, f.repo, window);
  await h.send({ command: 'ready' });
  assert.equal(lastState(h).isRepo, false);
  await h.send({ command: 'initRepository' });
  assert.deepEqual(errors(h), []);
  assert.deepEqual(window.lines, ['git init -b main', 'git add -A', "git commit -m 'Первый commit'"]);
  assert.equal(git(f.repo, 'branch', '--show-current'), 'main');
  assert.deepEqual(git(f.repo, 'ls-tree', '-r', '--name-only', 'HEAD').split('\n'), ['.gitignore', 'package.json']);
  assert.match(fs.readFileSync(path.join(f.repo, '.gitignore'), 'utf8'), /^node_modules\/$/m);
  assert.throws(() => git(f.repo, 'config', '--local', 'user.name'), 'a project without GitHub is never written to');
  await h.send({ command: 'initRepository' });
  assert.match(errors(h)[0].text, /уже в Git-репозитории/);
});

test('Connect to GitHub creates the repository with the editor account, re-authors earlier commits after confirmation and pushes main', async t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.repo, 'index.html'), '<h1>Hi</h1>\n');
  const requests = [];
  mock.method(https, 'request', (url, options, callback) => {
    const request = new EventEmitter();
    request.destroy = () => {};
    request.end = payload => {
      requests.push({ url, method: options.method, auth: options.headers.Authorization, body: JSON.parse(payload) });
      const response = new EventEmitter();
      Object.assign(response, { statusCode: 201, setEncoding() {} });
      setImmediate(() => {
        callback(response);
        response.emit('data', JSON.stringify({ clone_url: GITHUB_URL, owner: { login: 'octocat' } }));
        response.emit('end');
      });
    };
    return request;
  });
  t.after(() => mock.restoreAll());
  const window = fakeWindow(), h = openPanel(t, f.repo, window, { pick: items => items.find(item => item.isPrivate !== false) });
  await h.send({ command: 'initRepository' });
  assert.equal(git(f.repo, 'log', '-1', '--format=%an'), 'Someone Else', 'without origin git\'s own identity is used');
  await h.send({ command: 'connectGitHub' });
  assert.deepEqual(errors(h), []);
  assert.deepEqual(requests, [{ url: 'https://api.github.com/user/repos', method: 'POST', auth: 'Bearer test-token', body: { name: 'repo', private: true } }]);
  assert.match(h.prompts[0], /1 commit.*octocat/);
  assert.deepEqual(window.lines.slice(-2), ['git remote add origin ' + GITHUB_URL, 'git push -u origin main']);
  assert.equal(git(f.remote, 'log', '--format=%an <%ae>', 'main'), `octocat <${NOREPLY}>`);
  assert.equal(git(f.repo, 'rev-parse', '--abbrev-ref', 'main@{u}'), 'origin/main');
  assert.equal(fs.readFileSync(f.globalFile, 'utf8'), f.globalText);
  assert.ok(h.messages.some(message => message.level === 'ok' && /подключён к GitHub/.test(message.text)));
  await h.send({ command: 'connectGitHub' });
  assert.match(errors(h)[0].text, /уже подключён/);
});

test('Connecting an existing GitHub repository with its own README: Push is rejected, Pull merges the histories, Push succeeds', async t => {
  const f = fixture(t);
  const seed = path.join(f.base, 'seed');
  git(f.base, 'clone', f.remote, seed);
  fs.writeFileSync(path.join(seed, 'README.md'), '# demo\n');
  git(seed, 'add', '.'); git(seed, '-c', 'user.name=octocat', '-c', 'user.email=' + NOREPLY, 'commit', '-m', 'Initial commit'); git(seed, 'push', 'origin', 'HEAD:main');
  fs.writeFileSync(path.join(f.repo, 'app.js'), 'console.log(1)\n');
  const window = fakeWindow();
  const h = openPanel(t, f.repo, window, { pick: items => items[1], input: () => GITHUB_URL });
  await h.send({ command: 'connectGitHub' });
  const validate = h.inputs[0].validateInput;
  assert.equal(validate('https://github.com/octocat/demo'), null);
  assert.match(validate('https://gitlab.com/octocat/demo.git'), /github\.com/);
  assert.equal(errors(h)[0].action, 'syncBranch', 'GitHub has a commit this project does not have');
  await h.send({ command: 'syncBranch' });
  assert.deepEqual(errors(h).length, 1);
  assert.ok(window.lines.includes('git fetch origin --prune'));
  assert.ok(window.lines.includes('git merge --no-edit origin/main --allow-unrelated-histories'));
  await h.send({ command: 'push' });
  assert.equal(errors(h).length, 1);
  assert.deepEqual(git(f.remote, 'ls-tree', '-r', '--name-only', 'main').split('\n').sort(), ['.gitignore', 'README.md', 'app.js']);
  assert.deepEqual([...new Set(git(f.remote, 'log', '--format=%ae', 'main').split('\n'))], [NOREPLY]);
});

// GitHub's Windows runners keep their work folder on D: and the temp folder on
// C:, so there the project is on another drive than the terminal starts in.
test('A project in a folder with spaces and Cyrillic on any drive: init, branches, commit, connect, push and pull without errors', async t => {
  const root = process.platform === 'win32' && process.env.RUNNER_TEMP ? process.env.RUNNER_TEMP : os.tmpdir();
  const f = fixture(t, { root, name: 'Мой проект (D)' });
  fs.writeFileSync(path.join(f.repo, 'index.html'), '<h1>Салом</h1>\n');
  const window = fakeWindow();
  const h = openPanel(t, f.repo, window, { pick: items => items[1], input: () => GITHUB_URL });
  await h.send({ command: 'initRepository' });
  await h.send({ command: 'newBranch', name: 'feature' });
  assert.equal(git(f.repo, 'branch', '--show-current'), 'feature');
  fs.writeFileSync(path.join(f.repo, 'app.js'), 'console.log(1)\n');
  await h.send({ command: 'commit', message: 'Add app', files: ['app.js'] });
  await h.send({ command: 'switchBranch', name: 'main' });
  assert.equal(git(f.repo, 'branch', '--show-current'), 'main');
  await h.send({ command: 'deleteBranches', branches: ['feature'] });
  assert.equal(git(f.repo, 'branch', '--list', 'feature'), '', 'the branch is deleted');
  await h.send({ command: 'connectGitHub' });
  assert.deepEqual(errors(h), [], JSON.stringify(errors(h)));
  assert.equal(git(f.remote, 'rev-parse', 'main'), git(f.repo, 'rev-parse', 'HEAD'), 'main is on GitHub');
  // A commit made on GitHub reaches the project with Pull.
  const other = path.join(f.base, 'other');
  git(f.base, 'clone', f.remote, other);
  fs.writeFileSync(path.join(other, 'README.md'), '# demo\n');
  git(other, 'add', '.'); git(other, '-c', 'user.name=octocat', '-c', 'user.email=' + NOREPLY, 'commit', '-m', 'Readme'); git(other, 'push', 'origin', 'HEAD:main');
  await h.send({ command: 'fetch' });
  await h.send({ command: 'syncBranch' });
  assert.deepEqual(errors(h), [], JSON.stringify(errors(h)));
  assert.ok(fs.existsSync(path.join(f.repo, 'README.md')), 'Pull brought the GitHub commit');
  assert.equal(lastState(h).busy, false);
  assert.equal(window.terminals.length, 1, 'one GitHub terminal');
  assert.ok(window.lines.every(line => !/\\/.test(line)), 'Git Bash gets forward slashes: ' + window.lines.join(' | '));
});

test('A command Git Bash stops with Ctrl+C (exit 130) before git answers runs again in the background instead of failing', async t => {
  const f = fixture(t);
  connectedRepository(f);
  fs.writeFileSync(path.join(f.repo, 'a.txt'), 'a\n'); git(f.repo, 'add', '.'); git(f.repo, 'commit', '-m', 'a');
  git(f.repo, 'branch', 'week2-day3');
  const window = fakeWindow({ interrupt: line => line.startsWith('git switch') }), h = openPanel(t, f.repo, window);
  await h.send({ command: 'switchBranch', name: 'week2-day3' });
  assert.deepEqual(errors(h), [], JSON.stringify(errors(h)));
  assert.equal(git(f.repo, 'branch', '--show-current'), 'week2-day3');
  assert.ok(h.logs.some(line => line.startsWith('git switch week2-day3 (background')), h.logs.join('\n'));
  assert.equal(lastState(h).busy, false);
});
