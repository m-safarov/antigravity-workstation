'use strict';

// Antigravity 2.7.0 registers antigravity.inlineDiff.undo / .redo only while
// InlineDiffManager is alive. When inline diffs are disabled (for example via
// "Use Side-by-Side" after the Auto Save notice), InlineDiffManager.dispose()
// clears antigravity.hasActiveDiff and unregisters both commands, but leaves
// antigravity.inlineDiffCanUndo / .inlineDiffCanRedo stuck true. Pressing
// Ctrl+Z then hits the built-in binding and throws "command not found".
// This guard clears only stale context flags whose command is not registered,
// so native inlineDiff undo/redo keeps working whenever inline diff is active.
const GUARDED_COMMANDS = [
  ['antigravity.inlineDiff.undo', 'antigravity.inlineDiffCanUndo'],
  ['antigravity.inlineDiff.redo', 'antigravity.inlineDiffCanRedo'],
];

async function clearStaleInlineDiffUndo(vscode, output) {
  if (!vscode?.commands?.getCommands || !vscode?.commands?.executeCommand) {
    return { skipped: 'commands API unavailable', cleared: [] };
  }
  const available = new Set(await vscode.commands.getCommands(true));
  const cleared = [];
  for (const [command, contextKey] of GUARDED_COMMANDS) {
    if (available.has(command)) continue;
    await vscode.commands.executeCommand('setContext', contextKey, false);
    cleared.push(contextKey);
  }
  if (cleared.length && output?.appendLine) {
    output.appendLine('Inline diff undo guard cleared stale context keys: ' + cleared.join(', '));
  }
  return { cleared };
}

function isInlineDiffDisabled(vscode) {
  try {
    return vscode?.workspace?.getConfiguration?.('antigravity')?.get?.('enableInlineDiff') === false;
  } catch {
    return false;
  }
}

function watchInlineDiffUndo(vscode, context, output) {
  let disposed = false;
  let running = null;
  let rerun = false;
  const timers = new Set();

  async function sync() {
    if (disposed) return;
    if (running) {
      rerun = true;
      return running;
    }
    running = clearStaleInlineDiffUndo(vscode, output).catch(error => {
      if (!disposed && output?.appendLine) {
        output.appendLine('Inline diff undo guard error: ' + (error?.message || String(error)));
      }
      return { cleared: [], error: error?.message || String(error) };
    });
    try {
      return await running;
    } finally {
      running = null;
      if (rerun && !disposed) {
        rerun = false;
        void sync();
      }
    }
  }

  function schedule(delay) {
    if (disposed) return;
    const handle = setTimeout(() => {
      timers.delete(handle);
      void sync();
    }, delay);
    timers.add(handle);
  }

  // DeferredRendererSwitch disposes InlineDiffManager asynchronously after
  // enableInlineDiff flips to false or active diffs finish, so re-check once
  // right away and again shortly after.
  if (vscode?.workspace?.onDidChangeConfiguration) {
    context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(event => {
      if (event?.affectsConfiguration && !event.affectsConfiguration('antigravity.enableInlineDiff')) return;
      void sync();
      schedule(300);
      schedule(1500);
    }));
  }

  if (vscode?.window?.onDidChangeActiveTextEditor) {
    context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(() => {
      if (isInlineDiffDisabled(vscode)) void sync();
    }));
  }

  context.subscriptions.push({
    dispose() {
      disposed = true;
      for (const handle of timers) clearTimeout(handle);
      timers.clear();
    },
  });

  void sync();
  schedule(1500);
  return { sync };
}

module.exports = { GUARDED_COMMANDS, clearStaleInlineDiffUndo, watchInlineDiffUndo };
