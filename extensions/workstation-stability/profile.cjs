'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function contains(actual, expected, key) {
  if (key === 'textMateRules' && Array.isArray(expected)) return Array.isArray(actual) && expected.every(rule => actual.some(item => same(item, rule)));
  if (!expected || typeof expected !== 'object' || Array.isArray(expected)) return same(actual, expected);
  return !!actual && Object.entries(expected).every(([key, value]) => contains(actual[key], value, key));
}

const MERGED_SETTINGS = new Set(['workbench.colorCustomizations', 'files.associations',
  'editor.tokenColorCustomizations', 'explorer.fileNesting.patterns',
  'emmet.includeLanguages', 'tailwindCSS.includeLanguages', 'terminal.integrated.profiles.windows',
  'highlight-matching-tag.styles', 'workbench.editorAssociations', 'files.watcherExclude', 'search.exclude']);
const PERSONAL_EXCLUSIONS = ['errorLens.excludeBySource', 'errorLens.excludeByMessage'];

// Earlier setups repeated these global editor values in each of the ten managed
// language blocks, where a user-level language value outranks even a project's
// .vscode/settings.json. A managed language block now leaves them to the global
// profile value: applying the profile removes them from the block, and an
// ordinary update removes those that still hold the value setup wrote.
const LANGUAGE_POLICY_VALUES = Object.freeze({ 'editor.tabSize': 3, 'editor.insertSpaces': true, 'editor.detectIndentation': false,
  'editor.tabCompletion': 'on', 'editor.snippetSuggestions': 'top', 'editor.suggest.showSnippets': true,
  'editor.suggestOnTriggerCharacters': true, 'editor.quickSuggestions': { other: true, comments: false, strings: true },
  'editor.autoClosingBrackets': 'always', 'editor.autoClosingQuotes': 'always', 'editor.autoClosingOvertype': 'always',
  'editor.autoClosingDelete': 'always' });
const POLICY_LANGUAGES = new Set(['javascript', 'javascriptreact', 'typescript', 'typescriptreact', 'html', 'css', 'scss', 'json', 'jsonc', 'markdown']);
const isPolicySelector = selector => selectorLanguages(selector).length > 0 && selectorLanguages(selector).every(id => POLICY_LANGUAGES.has(id));
const isSetupLanguageValue = (selector, setting, value) => isPolicySelector(selector)
  && Object.hasOwn(LANGUAGE_POLICY_VALUES, setting) && same(LANGUAGE_POLICY_VALUES[setting], value);
function mergeLanguageBlock(selector, previous, managed) {
  const kept = Object.entries(previous && typeof previous === 'object' ? previous : {}).filter(([setting]) =>
    Object.hasOwn(managed, setting) || !isPolicySelector(selector) || !Object.hasOwn(LANGUAGE_POLICY_VALUES, setting));
  return { ...Object.fromEntries(kept), ...managed };
}

function mergeManagedValue(key, previous, managed) {
  if (PERSONAL_EXCLUSIONS.includes(key) && Array.isArray(previous) && Array.isArray(managed) && managed.length === 0) return [...previous];
  if (!MERGED_SETTINGS.has(key)) return /^\[.+\]$/.test(key) ? mergeLanguageBlock(key, previous, managed) : managed;
  function merge(current, desired, name) {
    if (key === 'editor.tokenColorCustomizations' && name === 'textMateRules' && Array.isArray(desired)) {
      return [...desired, ...(Array.isArray(current) ? current : []).filter(rule => !desired.some(item => same(item, rule)))];
    }
    if (!desired || typeof desired !== 'object' || Array.isArray(desired)) return desired;
    const next = current && typeof current === 'object' && !Array.isArray(current) ? { ...current } : {};
    for (const [name, value] of Object.entries(desired)) next[name] = merge(next[name], value, name);
    return next;
  }
  return merge(previous, managed);
}

function vendorCompletionSettings(extensions) {
  const settings = {};
  for (const extension of extensions) {
    const contributions = extension.packageJSON?.contributes?.configuration;
    for (const section of Array.isArray(contributions) ? contributions : [contributions]) {
      for (const [key, definition] of Object.entries(section?.properties || {})) {
        if (!/^(antigravity|codeium)\./i.test(key) || definition.type !== 'boolean') continue;
        if (!/(auto.?complet|super.?complet|inline.?suggest|tab.?complet|(?:^|\.)tab\.|(?:enable|disable)Tab$)/i.test(key)) continue;
        if (/(?:^|\.)(?:disable\w*|\w*Disabled)$/i.test(key)) settings[key] = true;
        else if (/(?:^|\.)(?:enable\w*|\w*Enabled)$/i.test(key)) settings[key] = false;
      }
    }
  }
  return settings;
}

const WINDOW_SCOPED_SETTINGS = new Set([
  'files.associations', 'editor.tokenColorCustomizations', 'editor.semanticTokenColorCustomizations',
  'security.workspace.trust.enabled', 'security.workspace.trust.untrustedFiles',
  'extensions.autoUpdate', 'extensions.autoCheckUpdates', 'window.menuBarVisibility', 'window.zoomLevel',
  'problems.visibility',
]);
const NON_LANGUAGE_RESOURCE_SETTINGS = new Set([
  'files.watcherExclude', 'files.exclude', 'search.exclude', 'files.autoSave', 'files.autoSaveDelay',
  'git.enableSmartCommit', 'git.autofetch', 'diffEditor.codeLens', 'diffEditor.renderSideBySide',
]);

function indexExtensionConfigs(extensions) {
  const registered = new Set();
  const windowScoped = new Set(WINDOW_SCOPED_SETTINGS);
  for (const extension of extensions || []) {
    const configuration = extension.packageJSON?.contributes?.configuration;
    for (const section of Array.isArray(configuration) ? configuration : [configuration]) {
      for (const [key, definition] of Object.entries(section?.properties || {})) {
        registered.add(key);
        if (!definition.scope || ['window', 'application', 'machine', 'machine-overridable'].includes(definition.scope)) {
          windowScoped.add(key);
        }
      }
    }
  }
  return { registered, windowScoped };
}

function isRegisteredSetting(vscode, key, registeredSet) {
  if (/^\[.+\]$/.test(key)) return true;
  if (vscode.workspace.getConfiguration().inspect(key)?.defaultValue !== undefined) return true;
  if (registeredSet) return registeredSet.has(key);
  return vscode.extensions.all.some(extension => {
    const configuration = extension.packageJSON?.contributes?.configuration;
    return (Array.isArray(configuration) ? configuration : [configuration]).some(section => Object.hasOwn(section?.properties || {}, key));
  });
}

function selectorLanguages(key) {
  return /^(?:\[[^\[\]]+\])+$/.test(key) ? [...key.matchAll(/\[([^\]]+)\]/g)].map(match => match[1]) : [];
}

function managedLanguageSettings(current, managed) {
  const result = {};
  for (const selector of Object.keys(current)) {
    const ids = selectorLanguages(selector);
    const languages = ids.map(id => managed['[' + id + ']']);
    if (!ids.length || languages.some(value => !value || typeof value !== 'object')) continue;
    const shared = Object.fromEntries(Object.entries(languages[0]).filter(([key, value]) =>
      languages.every(settings => same(settings[key], value))));
    if (Object.keys(shared).length) result[selector] = { ...managed[selector], ...shared };
  }
  return result;
}

function parseSettings(content) {
  let quoted = false, escaped = false, stripped = '';
  for (let i = 0; i < content.length; i++) {
    const ch = content[i], next = content[i + 1];
    if (quoted) {
      stripped += ch;
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') quoted = false;
    } else if (ch === '"') { quoted = true; stripped += ch; }
    else if (ch === '/' && next === '/') { while (i + 1 < content.length && content[i + 1] !== '\n') i++; stripped += ' '; }
    else if (ch === '/' && next === '*') {
      const end = content.indexOf('*/', i + 2);
      if (end === -1) throw new Error('Incomplete comment');
      i = end + 1; stripped += ' ';
    } else stripped += ch;
  }
  let cleaned = ''; quoted = false; escaped = false;
  for (let i = 0; i < stripped.length; i++) {
    const ch = stripped[i];
    if (!quoted && ch === ',') {
      let after = i + 1;
      while (/\s/.test(stripped[after] || '') && after < stripped.length) after++;
      if (stripped[after] === '}' || stripped[after] === ']') continue;
    }
    cleaned += ch;
    if (quoted && escaped) escaped = false;
    else if (quoted && ch === '\\') escaped = true;
    else if (ch === '"') quoted = !quoted;
  }
  return JSON.parse(cleaned.replace(/^\uFEFF/, ''));
}

function uriLabel(uri) { return uri?.scheme && uri.scheme !== 'file' ? uri.toString() : uri?.fsPath || uri?.path; }
function folderSettingsUri(vscode, uri) {
  if (vscode.Uri?.joinPath) return vscode.Uri.joinPath(uri, '.vscode', 'settings.json');
  if (uri?.fsPath) return { scheme: uri.scheme || 'file', fsPath: path.join(uri.fsPath, '.vscode', 'settings.json') };
}

async function inspectProjectConflicts(vscode, desired, options = {}) {
  const workspace = vscode.workspace, root = workspace.getConfiguration(undefined, null);
  const windowSettings = options.windowScoped || indexExtensionConfigs(vscode.extensions.all).windowScoped;
  const isWindowSetting = key => windowSettings.has(key) || /^(workbench|terminal|explorer|chat|inlineChat|accessibility|window|extensions|security|debug|notebook|scm)\./.test(key);
  const folders = workspace.workspaceFolders || [];
  const sources = [], readErrors = [];
  const userSelectors = Object.fromEntries(Object.keys(root).filter(key => selectorLanguages(key).length)
    .map(key => [key, root.inspect(key)?.globalValue || root.get(key)]));
  async function source(uri, scope, folder, isWorkspaceFile = false) {
    if (!uri) return;
    const label = uriLabel(uri);
    try {
      let bytes;
      if ((!uri.scheme || uri.scheme === 'file') && uri.fsPath) {
        if (!fs.existsSync(uri.fsPath)) return;
        const info = fs.statSync(uri.fsPath);
        if (!info.isFile() || info.size > 8 * 1024 * 1024) throw new Error('Unsupported settings file');
        bytes = fs.readFileSync(uri.fsPath);
      } else if (workspace.fs?.readFile) bytes = await workspace.fs.readFile(uri);
      else return;
      if (bytes.length > 8 * 1024 * 1024) throw new Error('Settings file too large');
      const parsed = parseSettings(Buffer.from(bytes).toString('utf8'));
      const settings = isWorkspaceFile ? parsed.settings || {} : parsed;
      sources.push({ scope, folder, source: label, settings });
    } catch (error) {
      if (!['ENOENT', 'FileNotFound'].includes(error.code)) readErrors.push({ source: label, error: 'settings source could not be read or parsed' });
    }
  }
  await source(workspace.workspaceFile, 'workspace', undefined, true);
  for (const folder of folders) await source(folderSettingsUri(vscode, folder.uri), workspace.workspaceFile ? 'workspace-folder' : 'workspace', uriLabel(folder.uri));
  const keys = new Set(), languages = new Set(), relevantLanguages = new Set();
  const desiredByLanguage = new Map();
  for (const [key, value] of Object.entries(desired)) {
    const ids = selectorLanguages(key);
    if (ids.length) {
      for (const id of ids) {
        languages.add(id);
        relevantLanguages.add(id);
        let map = desiredByLanguage.get(id);
        if (!map) { map = new Map(); desiredByLanguage.set(id, map); }
        for (const [subKey, subValue] of Object.entries(value || {})) {
          keys.add(subKey);
          map.set(subKey, subValue);
        }
      }
    } else keys.add(key);
  }
  for (const key of keys) {
    for (const id of root.inspect(key)?.languageIds || []) {
      languages.add(id);
      relevantLanguages.add(id);
    }
  }
  for (const selector of [...Object.keys(root), ...sources.flatMap(item => Object.keys(item.settings))]) {
    for (const id of selectorLanguages(selector)) {
      languages.add(id);
      relevantLanguages.add(id);
    }
  }
  try { for (const id of await vscode.languages?.getLanguages?.() || []) languages.add(id); }
  catch { readErrors.push({ source: 'editor languages API', error: 'registered languages could not be enumerated' }); }
  for (const document of workspace.textDocuments || []) {
    if (document.languageId) { languages.add(document.languageId); relevantLanguages.add(document.languageId); }
  }
  const active = vscode.window.activeTextEditor?.document;
  if (active?.languageId) { languages.add(active.languageId); relevantLanguages.add(active.languageId); }
  const contexts = [...(!folders.length || workspace.workspaceFile ? [{ uri: undefined, folder: undefined }] : []),
    ...folders.map(folder => ({ uri: folder.uri, folder: uriLabel(folder.uri) }))];
  if (active?.uri && !folders.length) contexts.push({ uri: active.uri, folder: undefined });
  const conflicts = [], seen = new Set();
  const keyList = [...keys];
  const languageCandidateKeys = keyList.filter(key => !isWindowSetting(key) && !NON_LANGUAGE_RESOURCE_SETTINGS.has(key));
  const globalLangRegex = /^(editor\.|files\.|prettier\.|oxc\.|antigravity\.|codeium\.)/;
  const globalLanguageKeys = languageCandidateKeys.filter(key => globalLangRegex.test(key));
  function expected(key, languageId) {
    if (languageId) {
      const langMap = desiredByLanguage.get(languageId);
      if (langMap && langMap.has(key)) return langMap.get(key);
    }
    return desired[key];
  }
  function add(conflict) {
    const identity = JSON.stringify([conflict.key, conflict.languageId, conflict.scope, conflict.source, conflict.selector, conflict.folder, conflict.actual]);
    if (!seen.has(identity)) { seen.add(identity); conflicts.push(conflict); }
  }
  const levels = [
    ['defaultValue', 'default'], ['globalValue', 'user'], ['workspaceValue', 'workspace'], ['workspaceFolderValue', 'workspace-folder'],
    ['defaultLanguageValue', 'default-language'], ['globalLanguageValue', 'user-language'],
    ['workspaceLanguageValue', 'workspace'], ['workspaceFolderLanguageValue', 'workspace-folder'], ['policyValue', 'policy'],
  ];
  const scanLanguages = options.activeOnly && languages.size > 25 ? relevantLanguages : languages;
  let scannedCount = 0;
  for (const context of contexts) {
    for (const languageId of [undefined, ...scanLanguages]) {
      if (scannedCount > 0 && scannedCount % 15 === 0) {
        await new Promise(resolve => setImmediate(resolve));
      }
      scannedCount++;
      const config = languageId ? workspace.getConfiguration(undefined, { uri: context.uri, languageId }) : context.uri ? workspace.getConfiguration(undefined, context.uri) : root;
      const langMap = languageId ? desiredByLanguage.get(languageId) : undefined;
      const keysToCheck = !languageId
        ? keyList
        : langMap ? [...new Set([...globalLanguageKeys, ...langMap.keys()])].filter(k => !isWindowSetting(k) && !NON_LANGUAGE_RESOURCE_SETTINGS.has(k)) : globalLanguageKeys;
      for (const key of keysToCheck) {
        const want = expected(key, languageId);
        if (want === undefined) continue;
        const scoped = isWindowSetting(key) ? root : config;
        const inspected = scoped.inspect(key), actual = scoped.get(key);
        if (!inspected) continue;
        if (contains(actual, want)) continue;
        let winning;
        for (const [field, scope] of levels) if (inspected?.[field] !== undefined) winning = { field, scope, value: inspected[field] };
        const managedLanguage = !!(langMap && langMap.has(key));
        const activeConflict = winning?.scope !== 'default-language' || managedLanguage;
        const location = sources.find(item => (item.scope === winning?.scope
          || (!workspace.workspaceFile && folders.length === 1 && item.scope === 'workspace' && winning?.scope === 'workspace-folder'))
          && (!item.folder || item.folder === context.folder));
        const declarations = location?.settings || (winning?.scope === 'user-language' ? userSelectors : undefined);
        const declared = winning?.field.includes('Language') && languageId && declarations ? Object.keys(declarations).filter(selector =>
          selectorLanguages(selector).includes(languageId) && same(declarations[selector]?.[key], winning.value)) : [];
        add({ key, languageId: languageId || null, scope: winning?.scope || 'effective', source: location?.source || null,
          selector: declared.length ? declared.join(', ') : null,
          folder: context.folder || null, expected: want, actual, effective: actual, active: activeConflict });
      }
    }
  }
  for (const item of sources) {
    for (const [selector, values] of Object.entries(item.settings)) {
      const ids = selectorLanguages(selector);
      for (const languageId of ids.length ? ids : [undefined]) for (const key of ids.length ? Object.keys(values || {}) : [selector]) {
        if (!keys.has(key)) continue;
        const want = expected(key, languageId), actual = ids.length ? values[key] : values;
        if (want === undefined || contains(actual, want)) continue;
        for (const context of contexts.filter(context => !item.folder || context.folder === item.folder)) {
          const config = languageId ? workspace.getConfiguration(undefined, { uri: context.uri, languageId }) : context.uri ? workspace.getConfiguration(undefined, context.uri) : root;
          const effective = (isWindowSetting(key) ? root : config).get(key);
          add({ key, languageId: languageId || null, scope: item.scope, source: item.source, selector: ids.length ? selector : null,
            folder: context.folder || null, expected: want, actual, effective, active: !contains(effective, want) && same(effective, actual) });
        }
      }
    }
  }
  return { conflicts, checkedLanguages: [...languages].sort(), checkedFolders: folders.map(folder => uriLabel(folder.uri)), readErrors };
}

function readProfile(file) {
  if (!fs.existsSync(file)) return;
  if (fs.lstatSync(file).isSymbolicLink()) throw new Error('Linked editor profile is unsupported');
  const plan = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (plan.schema !== 1 || typeof plan.requestId !== 'string' || !/^[a-f0-9-]{36}$/.test(plan.requestId)
    || typeof plan.locale !== 'string' || !/^[a-zA-Z0-9-]{1,35}$/.test(plan.locale) || !plan.settings || Array.isArray(plan.settings) || typeof plan.settings !== 'object') throw new Error('Invalid managed editor profile');
  return plan;
}

async function inspectEditorRuntime(vscode, context, options = {}) {
  const file = options.file || path.join(os.homedir(), '.gemini/config/workstation-setup/editor-profile.json');
  const plan = readProfile(file);
  if (!plan) return { skipped: 'no setup profile' };
  const desired = { ...plan.settings, ...(plan.settings['editor.inlineSuggest.enabled'] === false ? vendorCompletionSettings(vscode.extensions.all) : {}) };
  for (const key of PERSONAL_EXCLUSIONS) if (Object.hasOwn(desired, key)) desired[key] = mergeManagedValue(key, vscode.workspace.getConfiguration(undefined, null).inspect(key)?.globalValue, desired[key]);
  const selectedTheme = vscode.workspace.getConfiguration(undefined, null).get('workbench.colorTheme');
  if (typeof selectedTheme === 'string' && selectedTheme.trim()) desired['workbench.colorTheme'] = selectedTheme;
  const palette = vscode.workspace.getConfiguration(undefined, null).get('asterAppearance.theme');
  if (typeof palette === 'string') desired['asterAppearance.theme'] = palette;
  const diagnostics = await inspectProjectConflicts(vscode, desired);
  return { setupVersion: plan.setupVersion, language: vscode.env.language, ...diagnostics,
    reactSnippets: require('./react-snippets.cjs').getReactSnippetsReloadState(),
    status: diagnostics.readErrors.length || diagnostics.conflicts.some(item => item.active) ? 'needs-attention' : 'checked', runtimeSettingsRead: true };
}

async function applyEditorProfile(vscode, context, options = {}) {
  const file = options.file || path.join(os.homedir(), '.gemini/config/workstation-setup/editor-profile.json');
  const plan = readProfile(file);
  if (!plan) return { skipped: 'no setup profile' };
  const alreadyApplied = !options.force && context.globalState.get('editorProfileRequest') === plan.requestId;
  const config = vscode.workspace.getConfiguration(undefined, null);
  const desired = { ...plan.settings, ...(plan.settings['editor.inlineSuggest.enabled'] === false ? vendorCompletionSettings(vscode.extensions.all) : {}) };
  for (const key of PERSONAL_EXCLUSIONS) if (Object.hasOwn(desired, key)) desired[key] = mergeManagedValue(key, config.inspect(key)?.globalValue, desired[key]);
  if (!options.force && typeof config.inspect('workbench.colorTheme')?.globalValue === 'string') {
    desired['workbench.colorTheme'] = config.inspect('workbench.colorTheme').globalValue;
  }
  for (const key of ['editor.fontFamily', 'editor.fontSize', 'editor.fontWeight', 'asterAppearance.theme']) {
    if (!options.force && config.inspect(key)?.globalValue !== undefined) desired[key] = config.inspect(key).globalValue;
  }
  Object.assign(desired, managedLanguageSettings(config, desired));
  if (context.globalState.get('editorProfilePreviousSettings')?.requestId !== plan.requestId) {
    await context.globalState.update('editorProfilePreviousSettings', { requestId: plan.requestId,
      settings: Object.keys(desired).map(key => ({ key, value: config.inspect(key)?.globalValue })) });
  }
  // After a request is applied, an explicit user value stays (it is reported as an
  // override); a value back at its default is restored once per request, so a
  // reset settings file is repaired without fighting a later deliberate reset.
  const restored = context.globalState.get('editorProfileRestored');
  const restoredKeys = new Set(restored?.requestId === plan.requestId ? restored.keys : []);
  const { registered: registeredKeys, windowScoped } = indexExtensionConfigs(vscode.extensions.all);
  const failed = [], overrides = [], applied = [], unavailable = [], preservedExisting = [];
  let configSnapshot = config;
  for (const [key, value] of Object.entries(desired)) {
    try {
      const inspected = configSnapshot.inspect(key);
      if (!isRegisteredSetting(vscode, key, registeredKeys)) {
        unavailable.push(key);
        continue;
      }
      const previous = inspected?.globalValue;
      if (plan.preserveExisting === true && previous !== undefined) {
        preservedExisting.push(key);
        desired[key] = previous;
        continue;
      }
      const next = mergeManagedValue(key, previous, value);
      const stale = /^\[.+\]$/.test(key) ? !same(previous, next) : !contains(previous, value);
      const restore = alreadyApplied && previous === undefined && !restoredKeys.has(key);
      if (stale && (!alreadyApplied || restore)) {
        await configSnapshot.update(key, next, vscode.ConfigurationTarget.Global);
        applied.push(key);
        if (restore) restoredKeys.add(key);
        configSnapshot = vscode.workspace.getConfiguration(undefined, null);
      }
      if (!contains(configSnapshot.get(key), value)) overrides.push(key);
    } catch { failed.push(key); }
  }
  let reactSnippets;
  if (desired['reactSnippets.settings.importReactOnTop'] === false) {
    try { reactSnippets = await require('./react-snippets.cjs').refreshReactSnippets(vscode); }
    catch (error) { reactSnippets = { status: 'reload-required', reason: error.message }; }
  }
  const diagnostics = await inspectProjectConflicts(vscode,
    Object.fromEntries(Object.entries(desired).filter(([key]) => !unavailable.includes(key))),
    { activeOnly: true, windowScoped });
  for (const conflict of diagnostics.conflicts) if (conflict.active) {
    const key = conflict.languageId ? '[' + conflict.languageId + '].' + conflict.key : conflict.key;
    if (!overrides.includes(key)) overrides.push(key);
  }
  const actualLanguage = vscode.env.language.toLowerCase(), requestedLanguage = plan.locale.toLowerCase();
  const restartRequired = actualLanguage !== requestedLanguage && !actualLanguage.startsWith(requestedLanguage + '-');
  const result = { setupVersion: plan.setupVersion, settingsApplied: applied.length, settingsChecked: Object.keys(desired).length - unavailable.length,
    failed, overrides, unavailable, preservedExisting, ...diagnostics, language: vscode.env.language, requestedLanguage: plan.locale, restartRequired,
    vendorCompletionSwitches: Object.keys(vendorCompletionSettings(vscode.extensions.all)).filter(key => Object.hasOwn(desired, key)), reactSnippets,
    status: failed.length || overrides.length || diagnostics.readErrors.length ? 'needs-attention' : restartRequired ? 'restart-required' : 'applied' };
  if (alreadyApplied) {
    result.skipped = applied.length ? 'already applied in this IDE profile; restored ' + applied.length + ' managed values found at defaults'
      : 'already applied in this IDE profile; verified current values';
    if (applied.length) await context.globalState.update('editorProfileRestored', { requestId: plan.requestId, keys: [...restoredKeys] });
  }
  await context.globalState.update('editorProfileStatus', result);
  if (!failed.length) await context.globalState.update('editorProfileRequest', plan.requestId);
  return result;
}

function formatConflictReport(result) {
  const unique = new Map();
  for (const conflict of result.conflicts || []) {
    if (!conflict.active) continue;
    const key = JSON.stringify([conflict.key, conflict.scope, conflict.source, conflict.selector, conflict.expected, conflict.actual]);
    if (!unique.has(key)) unique.set(key, conflict);
  }
  const rows = ['\nWorkstation settings — read-only', 'Active setting conflicts: ' + unique.size];
  const value = data => {
    const text = JSON.stringify(data) ?? 'undefined';
    return text.length > 200 ? text.slice(0, 200) + '… (full JSON above)' : text;
  };
  for (const conflict of [...unique.values()].slice(0, 10)) {
    rows.push('', conflict.key + (conflict.selector ? ' ' + conflict.selector : ''),
      'Scope: ' + conflict.scope, 'File: ' + (conflict.source || 'No file location exposed by IDE'),
      'Current: ' + value(conflict.actual), 'Managed: ' + value(conflict.expected));
  }
  if (unique.size > 10) rows.push('Additional conflicts: ' + (unique.size - 10) + '; full JSON above.');
  for (const error of result.readErrors || []) rows.push('Read failed: ' + error.source + '; ' + error.error);
  if (result.reactSnippets?.reloadWindowMayBeRequired || result.reactSnippets?.status === 'reload-required') rows.push('React Snippets: use Developer: Reload Window after saving your work. The legacy snippet cache needs a window reload; no window was closed automatically.');
  rows.push('', 'No project settings or code were changed by this inspection.');
  return rows.join('\n');
}

function watchEditorProfile(vscode, context, output, options = {}) {
  const file = options.file || path.join(os.homedir(), '.gemini/config/workstation-setup/editor-profile.json');
  const directory = path.dirname(file);
  let disposed = false, timer, running, rerun = false, pendingForce = false;
  const seenLanguages = new Set();
  const indicator = vscode.window.createStatusBarItem?.(vscode.StatusBarAlignment?.Right, 20);
  if (indicator) {
    indicator.command = 'workstationStability.inspectConflicts';
    context.subscriptions.push(indicator);
  }
  function showStatus(result) {
    if (!indicator) return;
    if (result.skipped === 'no setup profile') { indicator.hide?.(); return; }
    const count = new Set(result.conflicts?.filter(item => item.active).map(item => JSON.stringify([item.key, item.source, item.selector]))).size;
    const incomplete = result.readErrors?.length;
    const reload = result.reactSnippets?.reloadWindowMayBeRequired || result.reactSnippets?.status === 'reload-required';
    indicator.text = count || incomplete || reload ? '$(warning) Workstation: ' + (count || (reload ? 'Reload' : '?')) : '$(check) Workstation';
    indicator.tooltip = reload ? 'React Snippets cache refreshed. Save your work, then use Developer: Reload Window. No window was closed automatically.' : incomplete ? 'Some settings sources could not be inspected. Click for the read-only report.' : count ? 'Managed settings differ in this editor. Click for exact scope and settings file.' : 'Workstation managed settings checked. Click for the read-only report.';
    indicator.show();
  }
  async function apply(force = false) {
    if (disposed) return;
    if (running) { rerun = true; pendingForce = pendingForce || force; return running; }
    running = applyEditorProfile(vscode, context, { force, file });
    try {
      const result = await running;
      if (!disposed) {
        for (const id of result?.checkedLanguages || []) seenLanguages.add(id);
        output.appendLine('Editor profile: ' + JSON.stringify(result));
        output.appendLine('User-profile values applied: ' + (result.settingsApplied || 0) + '; conflict inspection follows.');
        output.appendLine(formatConflictReport(result));
        showStatus(result);
        if (!result.skipped && !result.failed.length && !result.overrides.length && result.restartRequired) {
          void vscode.window.showInformationMessage('Русский язык выбран. Сохраните работу, полностью закройте все окна Antigravity и откройте IDE снова. Reload Window не меняет язык.');
        }
      }
      return result;
    } catch {
      if (!disposed) output.appendLine('Editor profile failed to apply; rerun setup or use Workstation: Apply and Check Editor Settings.');
    } finally {
      running = undefined;
      if (rerun && !disposed) { rerun = false; schedule(); }
    }
  }
  function schedule() { clearTimeout(timer); timer = setTimeout(() => { const forced = pendingForce; pendingForce = false; void apply(forced); }, 600); }
  context.subscriptions.push(vscode.commands.registerCommand('workstationStability.applySettings', async () => {
    const choice = await vscode.window.showWarningMessage(
      'Restore managed defaults, including the configured theme? Your selected theme will be replaced. Personal token rules are preserved.',
      { modal: true }, 'Restore defaults', 'Cancel');
    return choice === 'Restore defaults' ? apply(true) : { cancelled: true };
  }));
  context.subscriptions.push(vscode.commands.registerCommand('workstationStability.inspectConflicts', async () => {
    try {
      const result = await inspectEditorRuntime(vscode, context, { file });
      output.appendLine('Read-only editor settings report: ' + JSON.stringify(result));
      output.appendLine(formatConflictReport(result));
      showStatus(result);
      output.show?.(true);
      return result;
    } catch {
      const result = { status: 'failed', error: 'Managed editor profile could not be read. Existing settings were preserved.' };
      output.appendLine(JSON.stringify(result)); output.show?.(true); return result;
    }
  }));
  if (vscode.workspace.onDidChangeConfiguration) context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(schedule));
  if (vscode.workspace.onDidChangeWorkspaceFolders) context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(() => { seenLanguages.clear(); schedule(); }));
  if (vscode.window.onDidChangeActiveTextEditor) {
    context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(editor => {
      const doc = editor?.document;
      if (!doc) return;
      const hasFolders = (vscode.workspace.workspaceFolders || []).length > 0;
      if (hasFolders && (!doc.languageId || seenLanguages.has(doc.languageId))) return;
      schedule();
    }));
  }
  if (fs.existsSync(directory)) {
    const watcher = fs.watch(directory, (_event, filename) => { if (!filename || filename === path.basename(file)) schedule(); });
    watcher.on('error', () => { if (!disposed) output.appendLine('Profile watcher unavailable; settings will be checked at next startup.'); });
    context.subscriptions.push({ dispose() { watcher.close(); } });
  }
  context.subscriptions.push({ dispose() { disposed = true; clearTimeout(timer); } });
  schedule();
}

module.exports = { applyEditorProfile, vendorCompletionSettings, isRegisteredSetting, watchEditorProfile, inspectProjectConflicts, inspectEditorRuntime, managedLanguageSettings, mergeManagedValue, isSetupLanguageValue, formatConflictReport };
