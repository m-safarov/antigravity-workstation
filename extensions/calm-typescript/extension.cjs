'use strict';

const LANGUAGES = ['javascript', 'javascriptreact', 'typescript', 'typescriptreact'];
const LEGACY_OVERRIDE = { 'editor.showUnused': false };
const QUIET_KEYS = {
  'typescript.validate.enable': false,
  'javascript.validate.enable': false,
  'typescript.suggestionActions.enabled': false,
  'javascript.suggestionActions.enabled': false
};
const SMOOTH_KEYS = {
  'editor.cursorSmoothCaretAnimation': 'on',
  'editor.cursorBlinking': 'smooth',
  'editor.cursorWidth': 2,
  'editor.smoothScrolling': true
};
const COLOR_CONTAINER = 'workbench.colorCustomizations';
const QUIET_COLORS = {
  'editorError.foreground': '#ef4444b3',
  'editorWarning.foreground': '#f59e0b8c',
  'editorInfo.foreground': '#0ea5e973',
  'errorLens.errorForeground': '#f87171b3',
  'errorLens.warningForeground': '#fbbf248c',
  'errorLens.infoForeground': '#7dd3fc73',
  'errorLens.hintForeground': '#94a3b859',
  'errorLens.errorForegroundLight': '#dc2626b3',
  'errorLens.warningForegroundLight': '#d977068c',
  'errorLens.infoForegroundLight': '#0284c773',
  'errorLens.hintForegroundLight': '#64748b59',
  'errorLens.errorBackground': '#00000000',
  'errorLens.warningBackground': '#00000000',
  'errorLens.infoBackground': '#00000000',
  'errorLens.hintBackground': '#00000000',
  'errorLens.errorBackgroundLight': '#00000000',
  'errorLens.warningBackgroundLight': '#00000000',
  'errorLens.infoBackgroundLight': '#00000000',
  'errorLens.hintBackgroundLight': '#00000000',
  'errorLens.errorMessageBackground': '#00000000',
  'errorLens.warningMessageBackground': '#00000000',
  'errorLens.infoMessageBackground': '#00000000',
  'errorLens.hintMessageBackground': '#00000000',
  'errorLens.errorRangeBackground': '#00000000',
  'errorLens.warningRangeBackground': '#00000000',
  'errorLens.infoRangeBackground': '#00000000',
  'errorLens.hintRangeBackground': '#00000000'
};
// Colours written by 3.3.x (~15% opacity) still count as Calm TypeScript's own
// when quiet mode is turned off.
const LEGACY_QUIET = new Set(['#f8717126', '#fbbf2426', '#7dd3fc26', '#94a3b826']);
const CALM_LENS = {
  'errorLens.enabled': true,
  'errorLens.followCursor': 'allLines',
  'errorLens.delay': 500,
  'errorLens.enabledDiagnosticLevels': ['error', 'warning', 'info', 'hint'],
  'errorLens.excludeBySource': [],
  'errorLens.excludeByMessage': []
};
const STORE_PREFIX = 'calmTypeScript.v31.managed.';

const LANGUAGE_SET = new Set(LANGUAGES);

function equal(a, b) {
  if (a === b) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!equal(a[i], b[i])) return false;
    return true;
  }
  if (Array.isArray(b)) return false;
  let aCount = 0, bCount = 0;
  for (const key in a) {
    if (!Object.hasOwn(a, key) || a[key] === undefined) continue;
    aCount++;
    if (!Object.hasOwn(b, key) || !equal(a[key], b[key])) return false;
  }
  for (const key in b) {
    if (Object.hasOwn(b, key) && b[key] !== undefined) bCount++;
  }
  return aCount === bCount;
}

function createExtension(vscode, context) {
  const { window, workspace, commands } = vscode;
  const subscriptions = context.subscriptions;
  const pulseTimers = new Map();
  // Half the earlier strength: the typed character is still traceable, but a
  // fast typist no longer sees a blinking strip along the line.
  const pulseFrames = [0.14, 0.12, 0.10, 0.08, 0.06, 0.04, 0.02];
  const pulses = pulseFrames.map(alpha => window.createTextEditorDecorationType({
    backgroundColor: `rgba(56, 189, 248, ${alpha})`,
    light: { backgroundColor: `rgba(2, 132, 199, ${alpha})` },
    borderRadius: '3px',
    rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed
  }));
  subscriptions.push(...pulses);
  // A manual save (Ctrl+S) softly washes the cursor lines green for 300 ms.
  // Auto Save stays silent, so the editor never flashes while the user is only typing.
  const saveFrames = [0.10, 0.08, 0.06, 0.04, 0.02];
  const savePulses = saveFrames.map(alpha => window.createTextEditorDecorationType({
    isWholeLine: true,
    backgroundColor: `rgba(74, 222, 128, ${alpha})`,
    light: { backgroundColor: `rgba(22, 163, 74, ${alpha})` }
  }));
  subscriptions.push(...savePulses);
  const saveTimers = new Map();
  const manualSaves = new Set();
  const MANUAL_SAVE = vscode.TextDocumentSaveReason?.Manual ?? 1;

  function settings() {
    return workspace.getConfiguration('calmTypeScript');
  }

  let typingPulseEnabled = settings().get('typingPulse', true);
  let savePulseEnabled = settings().get('savePulse', true);
  function refreshPulseFlags() {
    const cfg = settings();
    typingPulseEnabled = cfg.get('typingPulse', true);
    savePulseEnabled = cfg.get('savePulse', true);
  }

  function clearPulse(editor) {
    const entry = pulseTimers.get(editor);
    if (!entry) return;
    entry.timers.forEach(clearTimeout);
    pulseTimers.delete(editor);
    if (entry.active >= 0) editor.setDecorations(pulses[entry.active], []);
  }

  function clearAllPulses() {
    for (const editor of pulseTimers.keys()) clearPulse(editor);
  }

  function pulseOnType(event) {
    if (pulseTimers.size) clearAllPulses();
    if (!typingPulseEnabled) return;
    if (event.reason !== undefined || !LANGUAGE_SET.has(event.document.languageId)) return;
    if (event.contentChanges.length !== 1) return;
    const change = event.contentChanges[0];
    if (!change.text || change.text.length > 2 || /[\r\n]/.test(change.text)) return;
    const editor = window.activeTextEditor;
    if (!editor || editor.document !== event.document) return;
    const start = event.document.positionAt(change.rangeOffset);
    const end = event.document.positionAt(change.rangeOffset + change.text.length);
    if (start.line !== end.line) return;
    const range = new vscode.Range(start, end);
    editor.setDecorations(pulses[0], [range]);
    const entry = { active: 0, timers: [] };
    entry.timers = pulseFrames.map((_, index) => setTimeout(() => {
      editor.setDecorations(pulses[index], []);
      if (index + 1 < pulses.length) {
        entry.active = index + 1;
        editor.setDecorations(pulses[index + 1], [range]);
      } else {
        entry.active = -1;
        pulseTimers.delete(editor);
      }
    }, (index + 1) * 40));
    pulseTimers.set(editor, entry);
  }

  function clearSavePulse(editor) {
    const entry = saveTimers.get(editor);
    if (!entry) return;
    entry.timers.forEach(clearTimeout);
    saveTimers.delete(editor);
    if (entry.active >= 0) editor.setDecorations(savePulses[entry.active], []);
  }

  function clearAllSavePulses() {
    for (const editor of saveTimers.keys()) clearSavePulse(editor);
  }

  function pulseOnSave(document) {
    if (!manualSaves.delete(document) || !savePulseEnabled) return;
    const editor = window.activeTextEditor;
    if (!editor || editor.document !== document || !editor.selections?.length) return;
    clearSavePulse(editor);
    const ranges = editor.selections.map(selection => new vscode.Range(selection.active, selection.active));
    editor.setDecorations(savePulses[0], ranges);
    const entry = { active: 0, timers: [] };
    entry.timers = saveFrames.map((_, index) => setTimeout(() => {
      editor.setDecorations(savePulses[index], []);
      if (index + 1 < savePulses.length) {
        entry.active = index + 1;
        editor.setDecorations(savePulses[index + 1], ranges);
      } else {
        entry.active = -1;
        saveTimers.delete(editor);
      }
    }, (index + 1) * 60));
    saveTimers.set(editor, entry);
  }

  async function applyFlat(group, changes, enabled) {
    const key = STORE_PREFIX + group;
    const config = workspace.getConfiguration();
    const original = context.globalState.get(key);
    if (enabled) {
      if (!original) {
        const backup = {};
        for (const name of Object.keys(changes)) {
          const old = config.inspect(name)?.globalValue;
          backup[name] = { hasValue: old !== undefined, value: old };
        }
        await context.globalState.update(key, backup);
      }
      for (const [name, value] of Object.entries(changes)) {
        if (!equal(config.inspect(name)?.globalValue, value)) {
          await config.update(name, value, vscode.ConfigurationTarget.Global);
        }
      }
    } else if (!enabled && original) {
      for (const [name, value] of Object.entries(changes)) {
        if (equal(config.inspect(name)?.globalValue, value)) {
          const before = original[name];
          await config.update(name, before.hasValue ? before.value : undefined, vscode.ConfigurationTarget.Global);
        }
      }
      await context.globalState.update(key, undefined);
    }
  }

  async function restoreLegacyLanguages() {
    const key = STORE_PREFIX + 'quietLanguages';
    const original = context.globalState.get(key);
    if (!original) return;
    const config = workspace.getConfiguration();
    for (const language of LANGUAGES) {
      const name = `[${language}]`;
      const current = { ...config.inspect(name)?.globalValue };
      const previous = original[name]?.value || {};
      for (const [setting, quietValue] of Object.entries({ ...LEGACY_OVERRIDE, 'editor.renderValidationDecorations': 'off' })) {
        if (!equal(current[setting], quietValue)) continue;
        if (Object.prototype.hasOwnProperty.call(previous, setting)) current[setting] = previous[setting];
        else delete current[setting];
      }
      await config.update(name, Object.keys(current).length ? current : undefined, vscode.ConfigurationTarget.Global);
    }
    await context.globalState.update(key, undefined);
  }

  async function restoreLegacyErrorLens() {
    const lensKey = STORE_PREFIX + 'quietErrorLens';
    const lensPrevious = context.globalState.get(lensKey);
    if (!lensPrevious) return;
    const config = workspace.getConfiguration();
    if (vscode.extensions.getExtension('usernamehw.errorlens')) {
      const lensSettings = config.inspect('errorLens.excludeLanguages');
      if (lensSettings) {
        const current = Array.isArray(lensSettings.globalValue) ? lensSettings.globalValue : [];
        const added = LANGUAGES.filter(language => !lensPrevious.value.includes(language));
        const after = current.filter(language => !added.includes(language));
        await config.update('errorLens.excludeLanguages',
          after.length || lensPrevious.hasValue ? after : undefined,
          vscode.ConfigurationTarget.Global);
      }
    }
    await context.globalState.update(lensKey, undefined);
  }

  async function applyCalmColors(enabled) {
    const key = STORE_PREFIX + 'quietColors';
    const config = workspace.getConfiguration();
    const original = context.globalState.get(key);
    const current = config.inspect(COLOR_CONTAINER)?.globalValue;
    const isObj = current && typeof current === 'object' && !Array.isArray(current);
    if (enabled) {
      let backupMissing = !original;
      if (!backupMissing) {
        for (const color of Object.keys(QUIET_COLORS)) {
          if (!Object.hasOwn(original, color)) { backupMissing = true; break; }
        }
      }
      if (backupMissing) {
        const backup = { ...original };
        for (const color of Object.keys(QUIET_COLORS)) {
          if (!Object.hasOwn(backup, color)) {
            backup[color] = { hasValue: isObj && Object.hasOwn(current, color), value: isObj ? current[color] : undefined };
          }
        }
        await context.globalState.update(key, backup);
      }
      let needsUpdate = !isObj;
      if (isObj) {
        for (const [color, value] of Object.entries(QUIET_COLORS)) {
          if (current[color] !== value) { needsUpdate = true; break; }
        }
      }
      if (needsUpdate) {
        await config.update(COLOR_CONTAINER, { ...(isObj ? current : {}), ...QUIET_COLORS }, vscode.ConfigurationTarget.Global);
      }
      return;
    }
    if (!original) return;
    const base = isObj ? { ...current } : {};
    let changed = false;
    for (const [color, value] of Object.entries(QUIET_COLORS)) {
      if (!equal(base[color], value) && !LEGACY_QUIET.has(base[color])) continue;
      const before = original[color];
      if (before && before.hasValue) base[color] = before.value;
      else delete base[color];
      changed = true;
    }
    if (changed) await config.update(COLOR_CONTAINER, Object.keys(base).length ? base : undefined, vscode.ConfigurationTarget.Global);
    await context.globalState.update(key, undefined);
  }

  async function applyQuiet(enabled) {
    await applyFlat('quietFlags', QUIET_KEYS, false);
    await applyFlat('quietPresentation', { 'problems.visibility': false }, false);
    await restoreLegacyLanguages();
    await restoreLegacyErrorLens();
    await applyCalmColors(enabled);
    if (vscode.extensions.getExtension('usernamehw.errorlens')) await applyFlat('calmLens', CALM_LENS, enabled);
  }

  let updating = Promise.resolve();
  function syncSettings() {
    refreshPulseFlags();
    updating = updating.then(async () => {
      const cfg = settings();
      await applyQuiet(cfg.get('quietMode', true));
      await applyFlat('smooth', SMOOTH_KEYS, cfg.get('smoothTyping', true));
      typingPulseEnabled = cfg.get('typingPulse', true);
      savePulseEnabled = cfg.get('savePulse', true);
      if (!typingPulseEnabled) clearAllPulses();
      if (!savePulseEnabled) clearAllSavePulses();
    }).catch(error => console.error('Calm TypeScript: Unable to sync settings:', error));
    return updating;
  }

  subscriptions.push(workspace.onDidChangeTextDocument(event => {
    if (event.contentChanges.length) pulseOnType(event);
  }));
  // The will-save listener only records the reason and returns at once; it
  // never calls waitUntil, so it cannot delay or time out a save.
  subscriptions.push(workspace.onWillSaveTextDocument(event => {
    if (event.reason === MANUAL_SAVE) manualSaves.add(event.document);
    else manualSaves.delete(event.document);
  }));
  subscriptions.push(workspace.onDidSaveTextDocument(pulseOnSave));
  subscriptions.push(workspace.onDidCloseTextDocument(document => {
    for (const editor of pulseTimers.keys()) if (editor.document === document) clearPulse(editor);
    for (const editor of saveTimers.keys()) if (editor.document === document) clearSavePulse(editor);
    manualSaves.delete(document);
  }));
  subscriptions.push(window.onDidChangeActiveTextEditor(() => {
    clearAllPulses();
    clearAllSavePulses();
  }));
  subscriptions.push(workspace.onDidChangeConfiguration(event => {
    if (event.affectsConfiguration('calmTypeScript')) syncSettings();
  }));
  subscriptions.push(commands.registerCommand('calmTypeScript.resetManagedSettings', async () => {
    try {
      await applyQuiet(false);
      await applyFlat('smooth', SMOOTH_KEYS, false);
      clearAllPulses();
      void window.showInformationMessage('Calm TypeScript: managed editor values were restored to your originals. They are reapplied only while the matching Calm TypeScript settings are enabled.');
    } catch (error) {
      window.showWarningMessage(`Calm TypeScript: Reset failed: ${String(error.message || error)}`);
    }
  }));

  subscriptions.push({ dispose() {
    clearAllPulses();
    clearAllSavePulses();
  }});
  syncSettings();
  return { ready: () => updating };
}

function activate(context) {
  return createExtension(require('vscode'), context);
}

function deactivate() {}

module.exports = { activate, deactivate, createExtension, QUIET_COLORS, CALM_LENS, SMOOTH_KEYS };
