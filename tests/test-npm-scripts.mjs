import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

// Explorer → npm scripts: discovery of package.json scripts and running them
// in the editor terminal, checked against a fake vscode API whose terminals
// report shell integration the way VS Code does.
const require = createRequire(import.meta.url);
const panelRoot = path.resolve(import.meta.dirname, '../extensions/git-branch-panel');
const { NpmScripts, sortScripts, findPackages, findLocalUrl } = require(path.join(panelRoot, 'src/npm-scripts.js'));

const VITE = '\r\n  \x1b[32m\x1b[1mVITE\x1b[22m v5.4.0\x1b[39m  ready in \x1b[1m312\x1b[22m ms\r\n\r\n  \x1b[32m➜\x1b[39m  \x1b[1mLocal\x1b[22m:   \x1b[36mhttp://localhost:\x1b[1m5173\x1b[22m/\x1b[39m\r\n  \x1b[32m➜\x1b[39m  \x1b[1mNetwork\x1b[22m: \x1b[2muse \x1b[22m\x1b[1m--host\x1b[22m\x1b[2m to expose\x1b[22m\r\n';

function folder(t, files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'npm-scripts-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const [name, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    fs.writeFileSync(path.join(root, name), typeof content === 'string' ? content : JSON.stringify(content));
  }
  return root;
}

// An execution whose output and end the test controls.
function execution(line) {
  const chunks = [];
  let wake = null, finished = false;
  return {
    commandLine: { value: line },
    async *read() {
      for (;;) {
        if (chunks.length) yield chunks.shift();
        else if (finished) return;
        else await new Promise(resolve => { wake = resolve; });
      }
    },
    write(chunk) { chunks.push(chunk); wake?.(); },
    finish() { finished = true; wake?.(); },
  };
}

function fakeVscode(dirs, options = {}) {
  const listeners = { integration: new Set(), start: new Set(), end: new Set(), close: new Set(), folders: new Set() };
  const on = name => listener => { listeners[name].add(listener); return { dispose: () => listeners[name].delete(listener) }; };
  const fire = (name, event) => [...listeners[name]].forEach(listener => listener(event));
  const terminals = [], commands = {}, watchers = [], notices = [], opened = [];
  class EventEmitter {
    constructor() { this.listeners = new Set(); this.event = listener => { this.listeners.add(listener); return { dispose: () => this.listeners.delete(listener) }; }; }
    fire(value) { this.listeners.forEach(listener => listener(value)); }
    dispose() {}
  }
  const end = (terminal, running, exitCode) => {
    running.finish();
    terminal.running = null;
    fire('end', { terminal, execution: running, exitCode });
  };
  const vscode = {
    EventEmitter,
    TreeItem: class { constructor(label, collapsibleState) { this.label = label; this.collapsibleState = collapsibleState; } },
    ThemeIcon: class { constructor(id) { this.id = id; } },
    TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
    Uri: { parse: value => ({ value }) },
    env: { language: 'ru', openExternal: async uri => { opened.push(uri.value); return true; } },
    commands: { registerCommand: (id, callback) => { commands[id] = callback; return { dispose() {} }; } },
    workspace: {
      workspaceFolders: dirs.map(dir => ({ name: path.basename(dir), uri: { fsPath: dir } })),
      createFileSystemWatcher: pattern => {
        const watcher = { pattern, handlers: {}, dispose() {} };
        for (const kind of ['Create', 'Change', 'Delete']) watcher['onDid' + kind] = listener => { watcher.handlers[kind] = listener; return { dispose() {} }; };
        watchers.push(watcher);
        return watcher;
      },
      onDidChangeWorkspaceFolders: on('folders'),
    },
    window: {
      createTreeView: (id, viewOptions) => ({ id, viewOptions, dispose() {} }),
      async showInformationMessage(text, ...buttons) { notices.push(text); return options.answer ? buttons[0] : undefined; },
      async showErrorMessage(text) { notices.push(text); },
      onDidChangeTerminalShellIntegration: on('integration'),
      onDidStartTerminalShellExecution: on('start'),
      onDidEndTerminalShellExecution: on('end'),
      onDidCloseTerminal: on('close'),
      createTerminal(terminalOptions) {
        const terminal = {
          options: terminalOptions, sent: [], shown: 0, executed: [], running: null, shellIntegration: undefined,
          show() { this.shown++; },
          // Ctrl+C ends the running command, as the shell reports it.
          sendText(text, addNewLine) { this.sent.push([text, addNewLine]); if (text === '\x03' && this.running) end(this, this.running, 130); },
          dispose() { fire('close', terminal); },
        };
        const integration = {
          executeCommand(line) {
            const started = execution(line);
            terminal.executed.push(line);
            terminal.running = started;
            setImmediate(() => fire('start', { terminal, execution: started }));
            return started;
          },
        };
        terminals.push(terminal);
        if (options.integration !== false) setTimeout(() => { terminal.shellIntegration = integration; fire('integration', { terminal, shellIntegration: integration }); }, 5);
        return terminal;
      },
    },
  };
  return { vscode, terminals, commands, watchers, notices, opened, fire, end };
}

function openView(dirs, options) {
  const fake = fakeVscode(dirs, options);
  const view = new NpmScripts(fake.vscode);
  const disposables = view.register();
  return { ...fake, view, dispose: () => disposables.forEach(item => item.dispose()) };
}

const tick = (ms = 20) => new Promise(resolve => setTimeout(resolve, ms));
const item = async (h, name) => {
  const nodes = await h.view.getChildren();
  const node = nodes.find(entry => entry.name === name);
  return { node, tree: h.view.getTreeItem(node) };
};

test('Common scripts come first in the usual order, the rest alphabetically', () => {
  assert.deepEqual(sortScripts(['zeta', 'test', 'alpha', 'preview', 'dev', 'build', 'lint', 'start', 'format']),
    ['dev', 'start', 'build', 'preview', 'lint', 'test', 'alpha', 'format', 'zeta']);
});

test('Scripts are read from each workspace folder, or from its first-level subfolders when the folder has none', async t => {
  const app = folder(t, { 'package.json': '﻿' + JSON.stringify({ name: 'shop', scripts: { lint: 'eslint .', dev: 'vite', 'test:unit': 'vitest', build: 'vite build' } }) });
  const mono = folder(t, {
    'package.json': { name: 'workspace', workspaces: ['frontend', 'backend'] },
    'frontend/package.json': { name: 'web', scripts: { dev: 'vite' } },
    'backend/package.json': { scripts: { start: 'node server.js' } },
    'docs/package.json': { name: 'docs' },
    'broken/package.json': '{ not json',
    'node_modules/vite/package.json': { scripts: { dev: 'x' } },
    '.cache/package.json': { scripts: { dev: 'x' } },
  });
  const empty = folder(t, { 'index.html': '<h1>Hi</h1>' });
  const packages = await findPackages([app, mono, empty].map(dir => ({ name: path.basename(dir), dir })));
  assert.deepEqual(packages.map(item => [item.label, item.nested, item.scripts.map(script => script.name)]), [
    [path.basename(app), false, ['dev', 'build', 'lint', 'test:unit']],
    ['backend', true, ['start']],
    ['frontend', true, ['dev']],
  ]);
  assert.deepEqual(packages[0].scripts[0], { name: 'dev', command: 'vite' });
  assert.equal(packages[1].dir, path.join(mono, 'backend'));
});

test('One package lists its scripts at the top with the command as description; several get a node each; none shows the welcome text', async t => {
  const app = folder(t, { 'package.json': { scripts: { build: 'vite build', dev: 'vite' } } });
  const h = openView([app]);
  t.after(h.dispose);
  const nodes = await h.view.getChildren();
  assert.deepEqual(nodes.map(node => node.name), ['dev', 'build']);
  const tree = h.view.getTreeItem(nodes[0]);
  assert.deepEqual([tree.label, tree.description, tree.contextValue, tree.iconPath.id], ['dev', 'vite', 'script', 'play']);
  assert.deepEqual(tree.command, { command: 'workstationNpmScripts.run', title: 'Запустить', arguments: [nodes[0]] });
  const mono = folder(t, { 'web/package.json': { name: 'shop-web', scripts: { dev: 'vite' } }, 'api/package.json': { scripts: { start: 'node .' } } });
  const several = openView([mono]);
  t.after(several.dispose);
  const groups = await several.view.getChildren();
  assert.deepEqual(groups.map(group => several.view.getTreeItem(group).label), ['api', 'web']);
  assert.equal(several.view.getTreeItem(groups[1]).description, 'shop-web');
  assert.deepEqual((await several.view.getChildren(groups[1])).map(node => node.name), ['dev']);
  const none = openView([folder(t, { 'index.html': '' })]);
  t.after(none.dispose);
  assert.deepEqual(await none.view.getChildren(), []);
  const manifest = require(path.join(panelRoot, 'package.json'));
  assert.ok(manifest.contributes.viewsWelcome.some(entry => entry.view === 'workstationNpmScripts'));
});

test('A click runs npm run dev in its own terminal with the default profile, finds the address in coloured output and offers it once', async t => {
  const app = folder(t, { 'package.json': { scripts: { dev: 'vite' } } });
  const h = openView([app], { answer: true });
  t.after(h.dispose);
  const { node } = await item(h, 'dev');
  await h.commands['workstationNpmScripts.run'](node);
  const [terminal] = h.terminals;
  assert.deepEqual(terminal.options, { name: 'npm: dev', cwd: app }, 'no shell path: the user default profile (Git Bash)');
  assert.equal(terminal.shown, 1);
  assert.deepEqual(terminal.executed, ['npm run dev']);
  assert.deepEqual(terminal.sent, [], 'not typed a second time');
  let tree = h.view.getTreeItem(node);
  assert.deepEqual([tree.iconPath.id, tree.contextValue, tree.description], ['sync~spin', 'running', 'vite']);
  // The address arrives split across chunks and wrapped in colour codes.
  terminal.running.write(VITE.slice(0, 120));
  await tick();
  assert.equal(h.view.getTreeItem(node).contextValue, 'running', 'half an address is not used');
  terminal.running.write(VITE.slice(120));
  await tick();
  tree = h.view.getTreeItem(node);
  assert.deepEqual([tree.description, tree.contextValue], ['🔗 http://localhost:5173/', 'serving']);
  assert.deepEqual(h.notices, ['Сервер запущен: http://localhost:5173/']);
  assert.deepEqual(h.opened, ['http://localhost:5173/'], 'the notification button opens the browser');
  await h.commands['workstationNpmScripts.openUrl'](node);
  assert.deepEqual(h.opened, ['http://localhost:5173/', 'http://localhost:5173/']);
  terminal.running.write('  page reload src/App.tsx http://localhost:5173/\r\n');
  await tick();
  assert.equal(h.notices.length, 1, 'one notification per run');
  await h.commands['workstationNpmScripts.run'](node);
  assert.deepEqual([h.terminals.length, terminal.executed.length, terminal.shown], [1, 1, 2], 'a running script only shows its terminal');
});

test('The end of the command clears the state; the next click reuses the terminal; Stop and Restart use Ctrl+C', async t => {
  const app = folder(t, { 'package.json': { scripts: { dev: 'vite', build: 'vite build' } } });
  const h = openView([app]);
  t.after(h.dispose);
  const { node: build } = await item(h, 'build');
  await h.commands['workstationNpmScripts.run'](build);
  await tick();
  const [terminal] = h.terminals;
  h.end(terminal, terminal.running, 0);
  await tick();
  let tree = h.view.getTreeItem(build);
  assert.deepEqual([tree.iconPath.id, tree.contextValue, tree.description], ['play', 'script', 'vite build']);
  await h.commands['workstationNpmScripts.run'](build);
  await tick();
  assert.deepEqual([h.terminals.length, terminal.executed], [1, ['npm run build', 'npm run build']]);
  await h.commands['workstationNpmScripts.stop'](build);
  assert.deepEqual(terminal.sent, [['\x03', false]]);
  await tick();
  assert.equal(h.view.getTreeItem(build).contextValue, 'script');
  const { node: dev } = await item(h, 'dev');
  await h.commands['workstationNpmScripts.run'](dev);
  await tick();
  const devTerminal = h.terminals[1];
  assert.equal(devTerminal.options.name, 'npm: dev');
  await h.commands['workstationNpmScripts.restart'](dev);
  assert.deepEqual(devTerminal.sent, [['\x03', false]]);
  assert.deepEqual(devTerminal.executed, ['npm run dev', 'npm run dev'], 'restarted in the same terminal');
  assert.equal(h.view.getTreeItem(dev).contextValue, 'running');
  devTerminal.dispose();
  tree = h.view.getTreeItem(dev);
  assert.deepEqual([tree.iconPath.id, tree.contextValue], ['play', 'script'], 'a closed terminal clears the state');
  await h.commands['workstationNpmScripts.run'](dev);
  assert.equal(h.terminals.length, 3, 'a closed terminal is replaced');
});

test('Without shell integration the command is typed as usual and counts as running until stopped', async t => {
  const app = folder(t, { 'package.json': { scripts: { 'test:unit': 'vitest' } } });
  const h = openView([app], { integration: false });
  t.after(h.dispose);
  const { node } = await item(h, 'test:unit');
  const started = Date.now();
  await h.commands['workstationNpmScripts.run'](node);
  assert.ok(Date.now() - started >= 2900, 'waits about 3 s for shell integration');
  const [terminal] = h.terminals;
  assert.deepEqual(terminal.sent, [['npm run test:unit', undefined]]);
  assert.equal(h.view.getTreeItem(node).contextValue, 'running');
  // Shell integration that starts late is still followed for the address.
  const late = execution('npm run test:unit');
  h.fire('start', { terminal, execution: late });
  late.write('UI at http://127.0.0.1:51204/__vitest__/\n');
  await tick();
  assert.equal(h.view.getTreeItem(node).description, '🔗 http://127.0.0.1:51204/__vitest__/');
  h.fire('end', { terminal, execution: late, exitCode: 0 });
  assert.equal(h.view.getTreeItem(node).contextValue, 'script');
  await h.commands['workstationNpmScripts.run'](node);
  assert.deepEqual(terminal.sent.at(-1), ['npm run test:unit', undefined], 'the same terminal, without a second wait');
  await h.commands['workstationNpmScripts.stop'](node);
  assert.deepEqual(terminal.sent.at(-1), ['\x03', false]);
  assert.equal(h.view.getTreeItem(node).contextValue, 'script');
});

test('A changed package.json reloads the list; package.json files in node_modules do not', async t => {
  const app = folder(t, { 'package.json': { scripts: { dev: 'vite' } } });
  const h = openView([app]);
  t.after(h.dispose);
  assert.deepEqual((await h.view.getChildren()).map(node => node.name), ['dev']);
  const watcher = h.watchers.find(entry => entry.pattern === '**/package.json');
  let changes = 0;
  h.view.onDidChangeTreeData(() => changes++);
  watcher.handlers.Change({ fsPath: path.join(app, 'node_modules', 'vite', 'package.json') });
  await tick(400);
  assert.equal(changes, 0);
  fs.writeFileSync(path.join(app, 'package.json'), JSON.stringify({ scripts: { dev: 'vite', preview: 'vite preview' } }));
  watcher.handlers.Change({ fsPath: path.join(app, 'package.json') });
  await tick(400);
  assert.equal(changes, 1);
  assert.deepEqual((await h.view.getChildren()).map(node => node.name), ['dev', 'preview']);
});

test('The dev server address is found in the output of common tools', () => {
  assert.equal(findLocalUrl(VITE), 'http://localhost:5173/');
  assert.equal(findLocalUrl('   ▲ Next.js 14.2.3\n   - Local:        http://localhost:3000\n   - Network:      http://192.168.1.20:3000\n'), 'http://localhost:3000');
  assert.equal(findLocalUrl('  Network: http://192.168.1.20:8080/\n  Local:   http://localhost:8080/\n'), 'http://localhost:8080/', 'the local address wins');
  assert.equal(findLocalUrl('Server listening on http://0.0.0.0:4000.\n'), 'http://localhost:4000');
  assert.equal(findLocalUrl('serving at http://[::]:8000/\n'), 'http://localhost:8000/');
  assert.equal(findLocalUrl('On Your Network: http://10.0.0.5:3000\n'), 'http://10.0.0.5:3000');
  assert.equal(findLocalUrl('https://localhost:4200/ (https)\n'), 'https://localhost:4200/');
  assert.equal(findLocalUrl('built in 2.1s, see https://vitejs.dev/guide\n'), null);
  assert.equal(findLocalUrl(''), null);
});
