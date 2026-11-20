import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { clearStaleInlineDiffUndo, watchInlineDiffUndo } = require('../extensions/workstation-stability/inline-diff-guard.cjs');
const keybindings = require('../config/keybindings.json');
const stabilityPkg = require('../extensions/workstation-stability/package.json');

test('Inline diff undo guard preserves context when inlineDiff commands are registered and clears only missing commands', async () => {
  const calls = [];
  let registered = ['undo', 'redo', 'antigravity.inlineDiff.undo', 'antigravity.inlineDiff.redo'];
  const vscode = {
    commands: {
      async getCommands() { return [...registered]; },
      async executeCommand(...args) { calls.push(args); },
    },
  };

  const healthy = await clearStaleInlineDiffUndo(vscode);
  assert.deepEqual(healthy.cleared, []);
  assert.deepEqual(calls, []);

  registered = ['undo', 'redo'];
  const broken = await clearStaleInlineDiffUndo(vscode);
  assert.deepEqual(broken.cleared, ['antigravity.inlineDiffCanUndo', 'antigravity.inlineDiffCanRedo']);
  assert.deepEqual(calls, [
    ['setContext', 'antigravity.inlineDiffCanUndo', false],
    ['setContext', 'antigravity.inlineDiffCanRedo', false],
  ]);
});

test('Inline diff undo watcher reacts to enableInlineDiff changes and editor switches only when inline diff is disabled', async t => {
  let enableInlineDiff = true;
  let registered = ['antigravity.inlineDiff.undo', 'antigravity.inlineDiff.redo'];
  const executed = [];
  let configListener;
  let editorListener;
  const context = { subscriptions: [] };
  const vscode = {
    commands: {
      async getCommands() { return [...registered]; },
      async executeCommand(...args) { executed.push(args); },
    },
    workspace: {
      getConfiguration(section) {
        assert.equal(section, 'antigravity');
        return { get(key) { return key === 'enableInlineDiff' ? enableInlineDiff : undefined; } };
      },
      onDidChangeConfiguration(listener) {
        configListener = listener;
        return { dispose() {} };
      },
    },
    window: {
      onDidChangeActiveTextEditor(listener) {
        editorListener = listener;
        return { dispose() {} };
      },
    },
  };

  const watcher = watchInlineDiffUndo(vscode, context, { appendLine() {} });
  t.after(() => { for (const item of context.subscriptions) item.dispose(); });
  await watcher.sync();
  assert.deepEqual(executed, []);

  // Unrelated setting change does not clear anything while inlineDiff commands exist.
  configListener({ affectsConfiguration: key => key === 'editor.fontSize' });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual(executed, []);

  // Switching to side-by-side disposes InlineDiffManager and unregisters both commands.
  enableInlineDiff = false;
  registered = [];
  configListener({ affectsConfiguration: key => key === 'antigravity.enableInlineDiff' });
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.deepEqual(executed.slice(0, 2), [
    ['setContext', 'antigravity.inlineDiffCanUndo', false],
    ['setContext', 'antigravity.inlineDiffCanRedo', false],
  ]);

  executed.length = 0;
  editorListener({});
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(executed.length, 2);
});

test('Fallback undo/redo keybindings match in config and stability package and never shadow active inline diffs', () => {
  assert.deepEqual(stabilityPkg.contributes.keybindings, keybindings);
  const undo = keybindings.find(item => item.key === 'ctrl+z' && item.command === 'undo');
  assert.ok(undo, 'ctrl+z fallback undo binding must exist');
  for (const clause of ['editorTextFocus', '!editorReadonly', 'antigravity.inlineDiffCanUndo', '!antigravity.hasActiveDiff', 'config.antigravity.enableInlineDiff == false']) {
    assert.ok(undo.when.split(' && ').includes(clause), 'ctrl+z fallback must guard: ' + clause);
  }
  for (const key of ['ctrl+y', 'ctrl+shift+z']) {
    const redo = keybindings.find(item => item.key === key && item.command === 'redo');
    assert.ok(redo, key + ' fallback redo binding must exist');
    for (const clause of ['editorTextFocus', '!editorReadonly', 'antigravity.inlineDiffCanRedo', '!antigravity.hasActiveDiff', 'config.antigravity.enableInlineDiff == false']) {
      assert.ok(redo.when.split(' && ').includes(clause), key + ' fallback must guard: ' + clause);
    }
  }
});
