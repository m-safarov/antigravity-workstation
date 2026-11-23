import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(import.meta.dirname, '..');

const { RETIRED_EXTENSIONS } = require('../lib/extensions');
const { updateMcpConfig } = require('../lib/installer');
const { planPayload } = require('../lib/owned-files');
const { getEnvironmentPaths } = require('../lib/paths');
const workbenchUi = require('../extensions/workstation-stability/workbench-ui.cjs');
const jellyPatch = require('../extensions/workstation-stability/jelly-patch.cjs');
const profile = require('../extensions/workstation-stability/profile.cjs');
const repairChat = require('../extensions/workstation-stability/repair-chat.cjs');
const calm = require('../extensions/calm-typescript/extension.cjs');

test('mikestead.dotenv is retired and absent from the active extension catalog', () => {
  const catalog = require('../config/extensions.json');
  assert.equal(RETIRED_EXTENSIONS['mikestead.dotenv'], true);
  assert.equal(catalog.some(ext => ext.id.toLowerCase() === 'mikestead.dotenv'), false);
});

test('updateMcpConfig retires setup-owned sequential-thinking while preserving custom user servers', () => {
  const template = {
    mcpServers: {
      'chrome-devtools-mcp': {
        command: 'node',
        args: ['/home/u/.gemini/config/mcp-runtime/node_modules/chrome-devtools-mcp/build/src/bin/chrome-devtools-mcp.js'],
      },
    },
  };
  const currentWithSetupOwned = {
    mcpServers: {
      'sequential-thinking': {
        command: 'C:\\Program Files\\nodejs\\node.exe',
        args: ['C:\\Users\\u\\.gemini\\config\\mcp-runtime\\node_modules\\@modelcontextprotocol\\server-sequential-thinking\\dist\\index.js'],
      },
      'my-custom-mcp': { command: 'node', args: ['/custom/server.js'] },
    },
  };
  const merged = updateMcpConfig(currentWithSetupOwned, template);
  assert.equal('sequential-thinking' in merged.mcpServers, false, 'setup-owned sequential-thinking must be removed');
  assert.ok(merged.mcpServers['chrome-devtools-mcp'], 'managed chrome-devtools-mcp stays');
  assert.deepEqual(merged.mcpServers['my-custom-mcp'], currentWithSetupOwned.mcpServers['my-custom-mcp'], 'unrelated custom server stays');

  const currentWithPersonal = {
    mcpServers: {
      'sequential-thinking': {
        command: 'npx',
        args: ['-y', '@my-org/custom-thinking-server'],
      },
    },
  };
  const mergedPersonal = updateMcpConfig(currentWithPersonal, template);
  assert.deepEqual(
    mergedPersonal.mcpServers['sequential-thinking'],
    currentWithPersonal.mcpServers['sequential-thinking'],
    'personal sequential-thinking with a custom launcher must be preserved',
  );
});

test('planPayload auto-removes unmodified legacy files and preserves user-edited copies', t => {
  const legacy = require('../config/migrations/legacy-payload.json');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'workstation-retire-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const env = getEnvironmentPaths({
    userProfile: path.join(tmp, 'home'),
    appData: path.join(tmp, 'appdata'),
    localAppData: path.join(tmp, 'local'),
  });

  // Verify every retired legacy file has recorded LF/CRLF hashes in legacy-payload.json
  for (const rel of [
    'skills/workstation-workflow/SKILL.md',
    'skills/project-coding-rules/SKILL.md',
    'agents/workstation-verifier.md',
    'skills/workstation-frontend-mentor/references/history-and-verification.md',
  ]) {
    assert.ok(Array.isArray(legacy.files[rel]) && legacy.files[rel].length >= 1, 'legacy hash recorded for ' + rel);
  }

  // Create a user-edited copy of a retired file -> must be preserved, NOT deleted
  const editedAgent = path.join(env.geminiConfigDir, 'agents', 'workstation-verifier.md');
  fs.mkdirSync(path.dirname(editedAgent), { recursive: true });
  fs.writeFileSync(editedAgent, '# My custom edited verifier instructions\n');

  // Create a previous registry recording an unmodified retired skill -> must be scheduled for removal
  const retiredSkill = path.join(env.geminiSkillsDir, 'workstation-workflow', 'SKILL.md');
  const unmodifiedBytes = Buffer.from('# old workflow\n');
  fs.mkdirSync(path.dirname(retiredSkill), { recursive: true });
  fs.writeFileSync(retiredSkill, unmodifiedBytes);
  const { digest, statePath } = require('../lib/owned-files');
  const regFile = statePath(env);
  fs.mkdirSync(path.dirname(regFile), { recursive: true });
  fs.writeFileSync(regFile, JSON.stringify({
    schema: 1,
    contract: 'workstation-setup-payload-v1',
    files: [
      { key: 'skills/workstation-workflow/SKILL.md', hash: digest(unmodifiedBytes) },
      { key: 'agents/workstation-verifier.md', hash: legacy.files['agents/workstation-verifier.md'][0] },
    ],
  }, null, 2));

  const plan = planPayload(env, repoRoot, 'Test User');
  assert.ok(
    plan.removals.some(r => r.key === 'skills/workstation-workflow/SKILL.md'),
    'unmodified retired skill must be scheduled for removal',
  );
  assert.ok(
    plan.preserved.includes(editedAgent),
    'user-edited retired file must be preserved rather than deleted',
  );
  assert.equal(
    plan.removals.some(r => r.target === editedAgent),
    false,
    'user-edited retired file must not appear in removals',
  );
});

test('workbench-ui addon skips unfocused polls, backs off when idle, and wakes on focus', async () => {
  const source = workbenchUi.script();
  const listeners = new Map();
  let intervalFn = null;
  let visible = 'visible';
  let focused = true;
  let fetchCount = 0;

  const doc = {
    head: { appendChild() {} },
    getElementById() { return null; },
    createElement() { return { id: '', textContent: '' }; },
    addEventListener(type, fn) { listeners.set('doc:' + type, fn); },
    get visibilityState() { return visible; },
    hasFocus() { return focused; },
  };
  const win = { addEventListener(type, fn) { listeners.set('win:' + type, fn); } };
  const ctx = vm.createContext({
    document: doc,
    window: win,
    Date,
    fetch: async () => {
      fetchCount++;
      return { ok: true, text: async () => '/* unchanged */' };
    },
    setInterval(fn) { intervalFn = fn; return 1; },
  });
  vm.runInContext(source, ctx);
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(fetchCount, 1, 'initial fetch runs once on load');

  // 10 ticks while unfocused -> 0 fetches
  focused = false;
  for (let i = 0; i < 10; i++) { intervalFn(); await Promise.resolve(); await Promise.resolve(); }
  assert.equal(fetchCount, 1, 'unfocused window performs zero background fetches');

  // Focus event wakes immediately and resets idle counter
  focused = true;
  listeners.get('win:focus')();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(fetchCount, 2, 'focus event wakes immediately');

  // 100 visible idle ticks -> backs off to every 10th tick after 5 unchanged ticks
  for (let i = 0; i < 100; i++) { intervalFn(); await Promise.resolve(); await Promise.resolve(); }
  assert.ok(fetchCount <= 20, 'idle backoff drastically reduces fetches (got ' + fetchCount + ')');

  // Hidden visibility -> 0 fetches
  const beforeHidden = fetchCount;
  visible = 'hidden';
  for (let i = 0; i < 20; i++) { intervalFn(); await Promise.resolve(); await Promise.resolve(); }
  assert.equal(fetchCount, beforeHidden, 'hidden window performs zero fetches');
});

test('jelly-patch blink addon caches DOM nodes, deduplicates opacity writes, and pauses RAF while hidden', t => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'workstation-jelly-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const scriptFile = path.join(tmp, 'jelly-cursor.js');
  fs.writeFileSync(scriptFile, '// jelly base\n');
  assert.equal(jellyPatch.ensureBlink(scriptFile, 0.35), true);
  const full = fs.readFileSync(scriptFile, 'utf8');
  const addon = full.slice(full.indexOf('/* workstation-blink:start */'));

  let opacityReads = '1';
  let opacityWrites = 0;
  let queryCalls = 0;
  let visible = 'visible';
  let nextFrame = null;
  const listeners = new Map();

  const overlay = {
    isConnected: true,
    style: {
      _opacity: '',
      get opacity() { return this._opacity; },
      set opacity(val) { opacityWrites++; this._opacity = val; },
    },
  };
  const layer = { isConnected: true };
  const doc = {
    head: { appendChild() {} },
    createElement() { return { textContent: '' }; },
    querySelector(sel) {
      queryCalls++;
      return sel === '.jelly-cursor-layer' ? overlay : layer;
    },
    addEventListener(type, fn) { listeners.set(type, fn); },
    get visibilityState() { return visible; },
  };
  const ctx = vm.createContext({
    document: doc,
    getComputedStyle() { return { opacity: opacityReads }; },
    requestAnimationFrame(fn) { nextFrame = fn; return 1; },
  });
  vm.runInContext(addon, ctx);

  // Run 50 frames with steady opacity '1'
  for (let i = 0; i < 50; i++) {
    const fn = nextFrame;
    nextFrame = null;
    assert.ok(fn, 'RAF scheduled while visible');
    fn();
  }
  assert.equal(opacityWrites, 1, 'identical opacity is written only once across 50 steady frames');
  assert.equal(queryCalls, 2, 'overlay and layer are queried only once and cached across 50 frames');

  // Hide document -> RAF loop stops
  visible = 'hidden';
  const hiddenTick = nextFrame;
  nextFrame = null;
  hiddenTick();
  assert.equal(nextFrame, null, 'RAF loop pauses completely when document is hidden');

  // Become visible again -> visibilitychange restarts RAF
  visible = 'visible';
  opacityReads = '0.2';
  listeners.get('visibilitychange')();
  assert.ok(nextFrame, 'visibilitychange resumes RAF loop');
  nextFrame();
  assert.equal(overlay.style.opacity, '0.35', 'minimum alpha clamp still works after resume');
  assert.equal(opacityWrites, 2, 'only one new write when opacity actually changes');
});

test('watchEditorProfile ignores unrelated config changes and reacts to managed keys', async t => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'workstation-watch-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const profileFile = path.join(tmp, 'editor-profile.json');
  fs.writeFileSync(profileFile, JSON.stringify({
    schema: 1,
    requestId: '11111111-2222-3333-4444-555555555555',
    locale: 'en',
    settings: { 'editor.tabSize': 2 },
    quiet: false,
  }));

  let configListener = null;
  let checkCount = 0;
  const vscode = {
    workspace: {
      onDidChangeConfiguration(fn) { configListener = fn; return { dispose() {} }; },
      onDidChangeWorkspaceFolders() { return { dispose() {} }; },
      getConfiguration() {
        checkCount++;
        return {
          get() { return 2; },
          inspect() { return { key: 'editor.tabSize', defaultValue: 4, globalValue: 2 }; },
          async update() {},
        };
      },
      workspaceFolders: [],
      textDocuments: [],
    },
    window: {
      onDidChangeActiveTextEditor() { return { dispose() {} }; },
      onDidChangeWindowState() { return { dispose() {} }; },
      createStatusBarItem() { return { show() {}, hide() {}, dispose() {} }; },
    },
    commands: {
      registerCommand() { return { dispose() {} }; },
    },
    extensions: { all: [], onDidChange() { return { dispose() {} }; } },
    languages: { getLanguages: async () => [] },
    env: { language: 'en', appRoot: tmp },
    ConfigurationTarget: { Global: 1 },
    StatusBarAlignment: { Left: 1, Right: 2 },
  };
  const state = new Map();
  const context = {
    subscriptions: [],
    globalState: { get: k => state.get(k), update: async (k, v) => { state.set(k, v); } },
  };
  profile.watchEditorProfile(
    vscode,
    context,
    { appendLine() {} },
    { file: profileFile },
  );
  t.after(() => { for (const sub of context.subscriptions) sub.dispose(); });

  // Wait for initial 600ms startup debounce to run and populate managedKeys
  await new Promise(resolve => setTimeout(resolve, 750));
  const afterStartup = checkCount;
  assert.ok(afterStartup > 0, 'startup check ran');

  // Fire 5 unrelated configuration changes -> must NOT trigger recheck
  for (let i = 0; i < 5; i++) {
    configListener({ affectsConfiguration: key => key === 'unrelated.extension.option' });
  }
  await new Promise(resolve => setTimeout(resolve, 700));
  assert.equal(checkCount, afterStartup, 'unrelated config events do not trigger profile rechecks');

  // Fire a managed key configuration change -> MUST trigger recheck
  configListener({ affectsConfiguration: key => key === 'editor.tabSize' });
  await new Promise(resolve => setTimeout(resolve, 700));
  assert.ok(checkCount > afterStartup, 'managed key change triggers profile recheck');
});

test('watchRepairChat performs zero idle polling ticks when no repair request exists', async t => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'workstation-repair-idle-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const dir = path.join(tmp, 'repair-chat');
  fs.mkdirSync(dir, { recursive: true });

  const originalLstat = fs.lstatSync;
  let lstatCalls = 0;
  fs.lstatSync = function wrappedLstat(target, ...rest) {
    if (String(target).startsWith(dir)) lstatCalls++;
    return originalLstat.call(this, target, ...rest);
  };
  t.after(() => { fs.lstatSync = originalLstat; });

  const context = { subscriptions: [] };
  const vscode = { env: { appRoot: tmp }, commands: { getCommands: async () => [] } };
  repairChat.watchRepairChat(vscode, context, { appendLine() {} }, { directory: dir, intervalMs: 10 });
  t.after(() => { for (const sub of context.subscriptions) sub.dispose(); });

  await new Promise(resolve => setTimeout(resolve, 15));
  const afterInitial = lstatCalls;
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.equal(lstatCalls, afterInitial, 'idle repair-chat watcher performs zero interval lstat polls');
});

test('calm-typescript clears only the single active pulse decoration and caches config on keystrokes', t => {
  let changeDocListener = null;
  let configCalls = 0;
  let setDecorationCalls = 0;

  const vscode = {
    workspace: {
      getConfiguration() {
        configCalls++;
        return {
          get(_k, def) { return def; },
          inspect() { return {}; },
          async update() {},
        };
      },
      onDidChangeConfiguration() { return { dispose() {} }; },
      onDidChangeTextDocument(fn) { changeDocListener = fn; return { dispose() {} }; },
      onWillSaveTextDocument() { return { dispose() {} }; },
      onDidSaveTextDocument() { return { dispose() {} }; },
      onDidCloseTextDocument() { return { dispose() {} }; },
    },
    window: {
      activeTextEditor: null,
      visibleTextEditors: [],
      createTextEditorDecorationType(spec) { return { spec, dispose() {} }; },
      createStatusBarItem() { return { show() {}, hide() {}, dispose() {} }; },
      onDidChangeActiveTextEditor() { return { dispose() {} }; },
      onDidChangeTextEditorSelection() { return { dispose() {} }; },
      onDidChangeVisibleTextEditors() { return { dispose() {} }; },
    },
    commands: { registerCommand() { return { dispose() {} }; } },
    extensions: { getExtension() { return undefined; } },
    languages: { onDidChangeDiagnostics() { return { dispose() {} }; }, getDiagnostics() { return []; } },
    DiagnosticSeverity: { Error: 0, Warning: 1 },
    StatusBarAlignment: { Left: 1, Right: 2 },
    ConfigurationTarget: { Global: 1 },
    DecorationRangeBehavior: { ClosedClosed: 1 },
    Range: class Range { constructor(a, b, c, d) { this.a = a; this.b = b; this.c = c; this.d = d; } },
    Position: class Position { constructor(line, character) { this.line = line; this.character = character; } },
  };
  const editor = {
    document: {
      uri: { toString: () => 'file:///a.ts' },
      languageId: 'typescript',
      lineCount: 10,
      lineAt: () => ({ range: { start: { line: 0 }, end: { line: 0 } }, text: 'const x = 1;' }),
      positionAt: offset => new vscode.Position(0, offset),
    },
    selection: { active: { line: 0, character: 1 } },
    setDecorations() { setDecorationCalls++; },
  };
  vscode.window.activeTextEditor = editor;
  vscode.window.visibleTextEditors = [editor];

  const state = new Map();
  const context = {
    subscriptions: [],
    globalState: { get: k => state.get(k), update: async (k, v) => { state.set(k, v); } },
  };
  const ext = calm.createExtension(vscode, context);
  t.after(() => {
    ext.dispose?.();
    for (const sub of context.subscriptions) sub.dispose?.();
  });

  const configAfterActivate = configCalls;
  setDecorationCalls = 0;

  // Simulate 50 rapid keystrokes on the same editor
  for (let i = 0; i < 50; i++) {
    changeDocListener({
      document: editor.document,
      contentChanges: [{ range: { start: { line: 0, character: 0 } }, rangeOffset: 0, text: 'a' }],
    });
  }

  assert.equal(configCalls, configAfterActivate, 'typing keystrokes make zero getConfiguration() calls');
  // 1st keystroke: 1 setDecorations (no active to clear); subsequent 49: 1 clear + 1 set = 99 total (vs 50*8=400 before)
  assert.equal(setDecorationCalls, 99, 'each subsequent keystroke clears only the 1 active decoration instead of all 7');
});

test('git-branch-panel skips refresh on same-folder tab switch and refreshes on folder change', () => {
  const Module = require('node:module');
  let activeEditorListener = null;
  let activeFolder = { uri: { fsPath: '/repo-a' } };
  let webviewProvider = null;

  const vscodeMock = {
    env: { language: 'en' },
    window: {
      registerWebviewViewProvider(_id, provider) { webviewProvider = provider; return { dispose() {} }; },
      registerTreeDataProvider() { return { dispose() {} }; },
      createTreeView() { return { dispose() {}, onDidChangeVisibility() { return { dispose() {} }; } }; },
      createOutputChannel() { return { appendLine() {}, show() {}, dispose() {} }; },
      onDidChangeActiveTextEditor(fn) { activeEditorListener = fn; return { dispose() {} }; },
      onDidChangeWindowState() { return { dispose() {} }; },
      onDidCloseTerminal() { return { dispose() {} }; },
      onDidEndTerminalShellExecution() { return { dispose() {} }; },
      activeTextEditor: { document: { uri: { fsPath: '/repo-a/one.js' } } },
    },
    workspace: {
      workspaceFolders: [{ uri: { fsPath: '/repo-a' } }, { uri: { fsPath: '/repo-b' } }],
      getWorkspaceFolder() { return activeFolder; },
      createFileSystemWatcher() {
        return {
          onDidChange() { return { dispose() {} }; },
          onDidCreate() { return { dispose() {} }; },
          onDidDelete() { return { dispose() {} }; },
          dispose() {},
        };
      },
      onDidChangeWorkspaceFolders() { return { dispose() {} }; },
      onDidSaveTextDocument() { return { dispose() {} }; },
      getConfiguration() { return { get: (_k, d) => d }; },
    },
    commands: { registerCommand() { return { dispose() {} }; } },
    authentication: {
      getSession: async () => null,
      onDidChangeSessions() { return { dispose() {} }; },
    },
    EventEmitter: class {
      constructor() { this.event = () => ({ dispose() {} }); }
      fire() {}
      dispose() {}
    },
    TreeItem: class {},
    TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
    ThemeIcon: class {},
    ThemeColor: class {},
    Uri: { file: p => ({ fsPath: p }) },
  };

  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === 'vscode') return vscodeMock;
    return originalLoad.call(this, request, parent, isMain);
  };
  let ext;
  try {
    delete require.cache[require.resolve('../extensions/git-branch-panel/extension.js')];
    ext = require('../extensions/git-branch-panel/extension.js');
  } finally {
    Module._load = originalLoad;
  }

  const context = {
    subscriptions: [],
    globalState: { get: () => ({}), update: async () => {} },
    extensionUri: { fsPath: path.join(repoRoot, 'extensions/git-branch-panel') },
  };
  ext.activate(context);

  let refreshCount = 0;
  const origRefresh = webviewProvider.refresh.bind(webviewProvider);
  webviewProvider.refresh = () => { refreshCount++; };
  try {
    // 10 tab switches inside the SAME folder (/repo-a)
    for (let i = 0; i < 10; i++) {
      activeEditorListener({ document: { uri: { fsPath: '/repo-a/file-' + i + '.js' } } });
    }
    assert.equal(refreshCount, 0, 'switching tabs in the same workspace folder triggers zero git refreshes');

    // Switch tab to a DIFFERENT workspace folder (/repo-b)
    activeFolder = { uri: { fsPath: '/repo-b' } };
    activeEditorListener({ document: { uri: { fsPath: '/repo-b/index.js' } } });
    assert.equal(refreshCount, 1, 'switching to a different workspace folder triggers a git refresh');
  } finally {
    webviewProvider.refresh = origRefresh;
    for (const sub of context.subscriptions) sub.dispose?.();
    ext.deactivate?.();
  }
});
