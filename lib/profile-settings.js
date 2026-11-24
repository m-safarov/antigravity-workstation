'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { ideRootFromCli } = require('./install-paths');
const { readJsonFile } = require('./jsonc');
const { guard } = require('./owned-files');
const { isDeepStrictEqual } = require('node:util');
const { managedLanguageSettings, mergeManagedValue, isSetupLanguageValue } = require('../extensions/workstation-stability/profile.cjs');
const { FONT_FAMILY_KEYS } = require('../extensions/aster-appearance/appearance.cjs');

// Settings of extensions removed at the user's request; existing values are
// deleted on the next install instead of being carried forward.
// Antigravity 2.6.0 registers none of the VS Code Speech settings: the native
// settings audit found these three unregistered, so the IDE ignored them and
// flagged them as unknown in settings.json. They leave existing profiles too.
// Aster Atelier 1.4.0 removed window opacity at the user's request; the IDE's
// own linked editing replaced Auto Rename Tag.
const RETIRED_SETTING_PREFIXES = ['turboConsoleLog.', 'calmTypeScript.autoSave',
  'accessibility.voice.autoSynthesize', 'accessibility.voice.keywordActivation', 'accessibility.voice.speechTimeout',
  'asterAppearance.windowOpacity', 'auto-rename-tag.'];
const isRetiredSetting = key => RETIRED_SETTING_PREFIXES.some(prefix => key.startsWith(prefix));

// Values earlier releases wrote for the busier editor effects (Jelly bubbles,
// sparks, trail, ripples, glow and patch reminders, the per-keystroke typing
// pulse). A value still equal to one of them came from setup, so it moves to
// the calm profile; any other value is the user's own choice and stays.
const RETIRED_MANAGED_VALUES = {
  'jellyCursor.animationMode': ['full'], 'jellyCursor.fastSpeed': [0.5], 'jellyCursor.midSpeed': [0.34, 0.4, 0.38, 0.36],
  'jellyCursor.slowSpeed': [0.2, 0.35, 0.26], 'jellyCursor.twistBoost': [0.08, 0.06], 'jellyCursor.maxJumpAnimationDistance': [800],
  'jellyCursor.springEnabled': [true], 'jellyCursor.trailEnabled': [true], 'jellyCursor.trailLength': [4, 3],
  'jellyCursor.trailOpacity': [0.2, 0.12], 'jellyCursor.glowOpacity': [0.45, 0.2, 0.35], 'jellyCursor.glowIntensity': [1.2],
  'jellyCursor.glowSize': [12, 6, 10], 'jellyCursor.rippleEnabled': [true], 'jellyCursor.landingPulseEnabled': [true],
  'jellyCursor.sparkEnabled': [true], 'jellyCursor.reminders': [true], 'jellyCursor.glowEnabled': [false],
  'jellyCursor.shapeStyle': ['native'], 'jellyCursor.minAlpha': [0.3], 'calmTypeScript.typingPulse': [false],
  // Setup 3.1 brings back the active scope line and ligatures (=== !== =>) that earlier setups switched off.
  'editor.guides.bracketPairs': [false], 'editor.guides.highlightActiveBracketPair': [false], 'editor.fontLigatures': [false],
  // Two-space indentation, Enter that accepts only a changing suggestion, linked tag editing,
  // Unicode safety and visible end-tag labels replace the earlier profile values.
  'editor.tabSize': [3], 'prettier.tabWidth': [3], 'editor.acceptSuggestionOnEnter': ['on'], 'editor.linkedEditing': [false],
  'editor.unicodeHighlight.ambiguousCharacters': [false], 'editor.unicodeHighlight.invisibleCharacters': [false],
  'htmlEndTagLabels.labelColor': ['#00000000'],
  // Setup 3.12.0 removes the 12s+ AutoImportProviderProject stall and per-keystroke Oxlint contention.
  'typescript.preferences.includePackageJsonAutoImports': ['on'], 'oxc.lint.run': ['onType'],
};
const isRetiredManagedValue = (key, value) => Object.hasOwn(RETIRED_MANAGED_VALUES, key) && RETIRED_MANAGED_VALUES[key].includes(value);

// Near-invisible diagnostic colors (alpha 26 and 33: 15–20% opacity) and the hidden end-tag label
// that earlier setups wrote into workbench.colorCustomizations; other values there stay personal.
const RETIRED_MANAGED_COLORS = new Map([
  ...Object.entries({ error: '#f87171', warning: '#fbbf24', info: '#7dd3fc', hint: '#94a3b8' }).flatMap(([severity, color]) => {
    const keys = ['errorLens.' + severity + 'Foreground', 'errorLens.' + severity + 'ForegroundLight'];
    if (severity !== 'hint') keys.push('editor' + severity[0].toUpperCase() + severity.slice(1) + '.foreground');
    return keys.map(key => [key, [color + '26', color + '33']]);
  }),
  ['htmlEndTagLabels.labelColor', ['#00000000']],
]);
const isRetiredManagedColor = (key, value) => RETIRED_MANAGED_COLORS.get(key)?.includes(value) === true;

// Shortcuts earlier setups wrote: Ctrl+Shift+F is the IDE's Find in Files again.
const RETIRED_KEYBINDINGS = [{ key: 'ctrl+shift+f', command: 'editor.action.formatDocument', when: 'editorTextFocus && !editorReadonly' }];
const isRetiredKeybinding = binding => RETIRED_KEYBINDINGS.some(retired => isDeepStrictEqual(retired, binding));

// Appearance choices the user owns; every font surface the studio writes is
// included so --apply-profile cannot split the editor and terminal fonts.
const PERSONAL_SETTINGS = new Set(['workbench.colorTheme', 'asterAppearance.theme', 'asterAppearance.fontStyle', 'workbench.settings.applyToAllProfiles',
  'editor.semanticTokenColorCustomizations', 'editor.fontSize', 'editor.fontWeight', 'editor.fontLigatures',
  'terminal.integrated.fontWeight', 'prettier.requireConfig', 'git.autofetch', ...FONT_FAMILY_KEYS]);
// A personal value is an appearance choice the user made (theme, fonts, guides,
// Error Lens look). A value an earlier setup wrote is not personal: it moves on.
const isPersonalSetting = (key, value) => (PERSONAL_SETTINGS.has(key) || key.startsWith('editor.guides.') || key.startsWith('errorLens.'))
  && !isRetiredManagedValue(key, value);

function languageCacheFile(envPaths) {
  return guard(path.dirname(envPaths.userSettingsDir), 'languagepacks.json');
}

function ensureRussianLanguagePack(envPaths, options = {}) {
  const cacheFile = languageCacheFile(envPaths);
  if (options.dryRun) return { dryRun: true, cacheFile };
  const indexFile = path.join(envPaths.extensionsDir, 'extensions.json');
  const index = fs.existsSync(indexFile) ? readJsonFile(indexFile) : [];
  if (!Array.isArray(index)) throw new Error('Invalid extension registration index: ' + indexFile);
  const id = 'ms-ceintl.vscode-language-pack-ru';
  const entry = index.find(item => item.identifier?.id?.toLowerCase() === id);
  if (!entry) {
    if (options.allowMissing) return { skipped: true, reason: 'Russian language pack is not registered in this isolated/extension-skipped profile' };
    throw new Error('Russian language pack not registered; rerun full setup');
  }
  if (typeof entry.relativeLocation !== 'string' || !entry.relativeLocation.toLowerCase().startsWith(id + '-')
    || /[/\\]/.test(entry.relativeLocation)) throw new Error('Unsafe registered Russian language-pack location');
  const root = guard(envPaths.extensionsDir, entry.relativeLocation);
  const manifest = readJsonFile(guard(root, 'package.json'));
  if ((manifest.publisher + '.' + manifest.name).toLowerCase() !== id || manifest.version !== entry.version) {
    throw new Error('Russian language-pack identity/version does not match IDE registration');
  }
  const localization = manifest.contributes?.localizations?.find(item => item.languageId === 'ru');
  if (!localization || !Array.isArray(localization.translations)) throw new Error('Russian language-pack localization manifest missing');
  const translations = {};
  for (const translation of localization.translations) {
    if (typeof translation.id !== 'string' || typeof translation.path !== 'string') throw new Error('Invalid Russian translation entry');
    const relative = translation.path.replace(/^\.\//, '');
    const file = guard(root, relative);
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) throw new Error('Russian translation file missing: ' + file);
    const content = readJsonFile(file);
    if (translation.id === 'vscode' && (!content?.contents || typeof content.contents !== 'object' || Array.isArray(content.contents))) {
      throw new Error('Russian core translation contents missing: ' + file);
    }
    translations[translation.id] = file;
  }
  if (!translations.vscode) throw new Error('Russian core editor translation missing');
  const identifier = { id: entry.identifier.id };
  if (entry.identifier.uuid) identifier.uuid = entry.identifier.uuid;
  const hash = require('node:crypto').createHash('md5').update(identifier.uuid || identifier.id).update(manifest.version).digest('hex');
  const current = fs.existsSync(cacheFile) ? readJsonFile(cacheFile, { emptyValue: {} }) : {};
  if (!current || typeof current !== 'object' || Array.isArray(current)) throw new Error('Invalid language cache: ' + cacheFile);
  const next = { ...current, ru: { hash, extensions: [{ extensionIdentifier: identifier, version: manifest.version }], translations,
    label: localization.localizedLanguageName || localization.languageName || 'Русский' } };
  const bytes = JSON.stringify(next);
  const unchanged = fs.existsSync(cacheFile) && fs.readFileSync(cacheFile, 'utf8') === bytes;
  if (!unchanged) {
    fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
    const temporary = cacheFile + '.' + require('node:crypto').randomUUID() + '.tmp';
    try { fs.writeFileSync(temporary, bytes); fs.renameSync(temporary, cacheFile); }
    finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
  }
  return { verified: true, locale: 'ru', version: manifest.version, cacheFile, unchanged };
}

// The IDE's own workbench.html: Jelly Cursor and the workstation interface addon patch it.
function workbenchHtmlPath(envPaths) {
  const ideRoot = envPaths.ideRoot || ideRootFromCli(envPaths.cliPath) || path.join(envPaths.localAppData, 'Programs', 'Antigravity IDE');
  const workbenches = ['electron-browser', 'electron-sandbox'].map(renderer => path.join(ideRoot, 'resources/app/out/vs/code', renderer, 'workbench/workbench.html'));
  return workbenches.find(file => fs.existsSync(file)) || workbenches[0];
}

function expectedSettings(envPaths, repoRoot = path.resolve(__dirname, '..'), options = {}) {
  const settings = JSON.parse(fs.readFileSync(path.join(repoRoot, 'config/settings.json'), 'utf8'));
  if (!options.quietCompletion && !options.autoApprove) {
    delete settings['editor.inlineSuggest.enabled'];
    for (const key of Object.keys(settings)) if (key.startsWith('[') && settings[key] && typeof settings[key] === 'object') delete settings[key]['editor.inlineSuggest.enabled'];
  }
  if (!options.autoApprove) {
    delete settings['chat.tools.terminal.autoApprove'];
    delete settings['security.workspace.trust.untrustedFiles'];
  }
  settings['typescript.tsserver.maxTsServerMemory'] = require('./system-resources').typeScriptMemoryLimit(envPaths.totalMemoryBytes);
  settings['jellyCursor.workbenchHtmlPath'] = workbenchHtmlPath(envPaths).replace(/\\/g, '/');
  if (!envPaths.gitBashPath) throw new Error('Git Bash executable not found; install Git for Windows (or set GIT_BASH_PATH to bash.exe) before restoring terminal settings');
  settings['terminal.integrated.profiles.windows']['Git Bash'].path = envPaths.gitBashPath;
  return settings;
}

function homeTemplate(envPaths, relative, repoRoot = path.resolve(__dirname, '..')) {
  const content = fs.readFileSync(path.join(repoRoot, relative), 'utf8');
  if (!envPaths.gitBashPath) throw new Error('Git Bash executable not found for Antigravity hooks');
  const rendered = content
    .replaceAll('${USER_HOME}', () => JSON.stringify(envPaths.userProfile.replace(/\\/g, '/')).slice(1, -1))
    .replaceAll('${NODE_EXE}', () => JSON.stringify(envPaths.nodeExe.replace(/\\/g, '/')).slice(1, -1))
    .replaceAll('${GIT_BASH}', () => JSON.stringify(envPaths.gitBashPath.replace(/\\/g, '/')).slice(1, -1));
  JSON.parse(rendered);
  return rendered;
}

function mergeSettings(current, managed, options = {}) {
  const result = { ...current, ...managed };
  for (const key of Object.keys(result)) if (key.startsWith('tsMancho.') || isRetiredSetting(key)) delete result[key];
  for (const [key, value] of Object.entries(managed)) {
    result[key] = mergeManagedValue(key, current[key], value);
  }
  // Do not turn this into a blanket editor.* exemption: other managed settings
  // must still migrate. Preserve explicit personal appearance preferences only;
  // the existing managed TextMate merge retains its own ownership semantics.
  const personalAppearance = key => isPersonalSetting(key, undefined);
  const personalValue = isPersonalSetting;
  for (const [key, value] of Object.entries(current)) {
    if (key === 'workbench.settings.applyToAllProfiles' && Array.isArray(value)) {
      // Managed additions to the sharing list must reach existing installs;
      // entries the user added themselves are kept verbatim.
      const managedList = Array.isArray(managed[key]) ? managed[key] : [];
      result[key] = [...managedList, ...value.filter(item => !managedList.includes(item))];
    } else if (personalValue(key, value)) result[key] = structuredClone(value);
    if (/^\[[^\]]+\](?:\[[^\]]+\])*$/.test(key) && value && typeof value === 'object' && !Array.isArray(value)) {
      const combined = result[key] && typeof result[key] === 'object' ? {...result[key]} : {};
      // In the default preserve mode the user's explicit language values win
      // and managed additions fill the rest; --apply-profile and quiet modes
      // keep managed policy and preserve only personal appearance choices.
      const userLanguageWins = options.userLanguageOverrides !== false;
      const managedBlock = Object.hasOwn(managed, key) ? managed[key] : undefined;
      for (const [setting, personalValue] of Object.entries(value)) {
        if (!userLanguageWins && !personalAppearance(setting)) continue;
        // A value earlier setups repeated in managed language blocks gives way to the global profile value.
        if (managedBlock && !Object.hasOwn(managedBlock, setting) && isSetupLanguageValue(key, setting, personalValue)) continue;
        combined[setting] = structuredClone(personalValue);
      }
      result[key] = combined;
    }
  }
  // Retain both foreign and same-key personal palette customizations; colors an
  // earlier setup wrote move to the current profile colors.
  if (current['workbench.colorCustomizations'] && typeof current['workbench.colorCustomizations'] === 'object') {
    const preserve = (managed, personal) => {
      const next = {...managed};
      for (const [key, value] of Object.entries(personal)) {
        next[key] = value && typeof value === 'object' && !Array.isArray(value)
          ? preserve(managed?.[key] && typeof managed[key] === 'object' ? managed[key] : {}, value)
          : structuredClone(value);
      }
      return next;
    };
    const personal = Object.fromEntries(Object.entries(current['workbench.colorCustomizations'])
      .filter(([key, value]) => !isRetiredManagedColor(key, value)));
    result['workbench.colorCustomizations'] = preserve(result['workbench.colorCustomizations'] || {}, personal);
  }
  for (const key of ['files.watcherExclude', 'search.exclude', 'chat.tools.terminal.autoApprove']) {
    if (current[key] && typeof current[key] === 'object' && !Array.isArray(current[key])) result[key] = { ...current[key], ...managed[key] };
  }
  // Earlier setups wrote "**/node_modules/**": true in files.watcherExclude, which disables
  // TypeScript's native --canUseWatchEvents and forces slow legacy Node.js file watching.
  if (result['files.watcherExclude']?.['**/node_modules/**'] === true
    && managed['files.watcherExclude'] && !Object.hasOwn(managed['files.watcherExclude'], '**/node_modules/**')) {
    delete result['files.watcherExclude']['**/node_modules/**'];
  }
  for (const [command, value] of Object.entries(current['chat.tools.terminal.autoApprove'] || {})) {
    if (value === false) result['chat.tools.terminal.autoApprove'][command] = false;
  }
  return result;
}
// The installer passes the file's bindings first with --apply-profile and second otherwise,
// so retired setup shortcuts are dropped from both lists.
function mergeKeybindings(current, managed) {
  current = current.filter(binding => !isRetiredKeybinding(binding)).map(binding => typeof binding.command !== 'string' ? binding : { ...binding,
    command: binding.command.replace(/^(-?)tsMancho\./, '$1calmTypeScript.')
      .replace(/^(-?)mansurGithubPanel\./, '$1workstationGithubPanel.')
      .replace(/^(-?)mansurStability\./, '$1workstationStability.') });
  managed = managed.filter(binding => !isRetiredKeybinding(binding));
  const slot = binding => JSON.stringify([binding.key, binding.when || '', String(binding.command || '').startsWith('-')]);
  const slots = new Set(managed.map(slot));
  return [...current.filter(binding => !slots.has(slot(binding))), ...managed];
}
module.exports = { expectedSettings, workbenchHtmlPath, mergeSettings, isRetiredSetting, isRetiredManagedValue, isRetiredManagedColor, isPersonalSetting,
  managedLanguageSettings, mergeKeybindings, homeTemplate, ensureRussianLanguagePack, languageCacheFile };
