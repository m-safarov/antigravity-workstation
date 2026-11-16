'use strict';
const vscode = require('vscode');
const fonts = require('./fonts.json');
const service = require('./font-service.cjs');
const themes = require('./themes.cjs');
const uiStyle = require('./ui-style.cjs');
const swatches = require('./swatches.cjs');
const { createStudio } = require('./studio.cjs');
const {SHARED,FONT_FAMILY_KEYS,FONT_STYLES,LEGACY_STYLES,styleSettings,snapshot,updateGlobal,validate} = require('./appearance.cjs');
let queue = Promise.resolve();
function enqueue(action) { const result = queue.then(action); queue=result.catch(()=>{});return result; }
const read = key => vscode.workspace.getConfiguration(undefined,null).get(key);
// Colour customizations start from the user's own global value, so a
// workspace value is never copied into it; other settings are read as in effect.
const OBJECTS = new Set([...Object.values(themes.KEYS)]);
const reader = settings => key => OBJECTS.has(key) ? settings.global(key) : settings.get(key);
// A change computed on top of another one that is not written yet.
const overlay = (settings, changes) => ({ get: key => key in changes ? changes[key] : settings.get(key),
  global: key => key in changes ? changes[key] : settings.global(key) });

const contributedThemes = (extensions = vscode.extensions?.all || []) => extensions.flatMap(extension => extension.packageJSON?.contributes?.themes || []);
function nativeThemeOptions(extensions) {
  const contributed = contributedThemes(extensions);
  return ['Light', 'Dark'].flatMap(mode => {
    const ids = [`Antigravity ${mode}`, `Antigravity Default ${mode}`, `Default ${mode} Modern`, `Default ${mode}+`];
    const selected = ids.map(id => contributed.find(theme => (theme.id || theme.label) === id)).find(Boolean);
    return selected ? [{ label: `Antigravity ${mode}`, value: selected.id || selected.label, kind: mode.toLowerCase(), builtin: true }] : [];
  });
}
// Three standard VS Code themes that ship with the IDE sit beside Antigravity's
// own pair; the plain Visual Studio themes are left out because Aster palettes
// are drawn over them.
const VSCODE_THEMES = [['Dark+', 'Default Dark+', 'dark'], ['Light+', 'Default Light+', 'light'], ['Solarized Dark', 'Solarized Dark', 'dark']];
function vscodeThemeOptions(extensions, taken = []) {
  const contributed = contributedThemes(extensions);
  return VSCODE_THEMES.flatMap(([label, id, kind]) => {
    const theme = contributed.find(item => (item.id || item.label) === id);
    return theme && !taken.includes(id) ? [{ label, value: id, kind, builtin: true }] : [];
  });
}
function themeOptions() {
  const native = nativeThemeOptions();
  return [...native, ...vscodeThemeOptions(undefined, native.map(option => option.value)),
    ...themes.THEMES.map(theme => ({ label: theme.name, value: theme.name, kind: theme.type, builtin: false }))];
}
// The studio cards show each theme in its real colours; the IDE's theme files
// are read once per session.
const builtinSwatches = new Map();
function builtinSwatch(option) {
  if (!builtinSwatches.has(option.value)) builtinSwatches.set(option.value, swatches.builtinSwatch(option, vscode.extensions?.all || []));
  return builtinSwatches.get(option.value);
}
const card = option => {
  const aster = !option.builtin && themes.find(option.value);
  return aster ? swatches.card(option, swatches.asterSwatch(aster), swatches.asterCode(aster)) : swatches.card(option, builtinSwatch(option));
};
// Every theme in two sections, dark and light, each from the darkest editor
// to the brightest. Built once per session and again when extensions change.
let gallery;
const themeGallery = () => gallery ||= swatches.arrange(themeOptions().map(card));
// A theme chosen outside the studio gets a card of its own in its section.
function outsideCard(value) {
  const kind = [vscode.ColorThemeKind?.Light ?? 1, vscode.ColorThemeKind?.HighContrastLight ?? 4].includes(vscode.window?.activeColorTheme?.kind) ? 'light' : 'dark';
  return card({ label: value, value, kind, builtin: true });
}
// The studio shows the Aster palette while its Visual Studio base is active.
function currentTheme(get = read) {
  const selected = get('workbench.colorTheme'), aster = themes.find(get('asterAppearance.theme'));
  return aster && selected === themes.BASE[aster.type] ? aster.name : selected;
}
// The IDE's own themes offered here get their low-contrast code colours lifted
// in a block for that theme only; the user's own rules there come after and win.
const readableCache = new Map();
function readableChanges(value, settings) {
  const option = themeGallery().find(item => item.builtin && item.value === value);
  if (!option) return {};
  if (!readableCache.has(value)) readableCache.set(value, swatches.readableRules(swatches.builtinTheme(option, vscode.extensions?.all || []), option.kind));
  const before = settings.global('editor.tokenColorCustomizations') || {}, all = { ...before }, scope = `[${value}]`;
  const block = { ...(all[scope] && typeof all[scope] === 'object' ? all[scope] : {}) };
  const personal = (Array.isArray(block.textMateRules) ? block.textMateRules : []).filter(rule => rule?.name !== swatches.READABLE_RULE);
  const rules = [...readableCache.get(value), ...personal];
  if (rules.length) block.textMateRules = rules; else delete block.textMateRules;
  if (Object.keys(block).length) all[scope] = block; else delete all[scope];
  const changes = JSON.stringify(all) === JSON.stringify(before) ? {} : { 'editor.tokenColorCustomizations': all };
  const semantic = settings.global('editor.semanticTokenColorCustomizations') || {}, selected = semantic[scope] || {};
  const comment = readableCache.get(value).at(-1)?.settings.foreground;
  if (comment && !Object.hasOwn(selected.rules || {}, 'comment') && !Object.hasOwn(semantic.rules || {}, 'comment')) {
    changes['editor.semanticTokenColorCustomizations'] = { ...semantic,
      [scope]: { ...selected, rules: { ...selected.rules, comment } } };
  }
  return changes;
}
// One click writes only the keys that change; nothing is read twice.
function themeChanges(value, settings) {
  const option = themeGallery().find(item => item.value === value);
  if (!option) throw new Error('Темы «' + value + '» нет в галерее.');
  if (!option.builtin) return themes.themeChanges(reader(settings), themes.find(value));
  // The readable rules come first: the theme switch is the one visible repaint.
  return { ...readableChanges(value, settings), 'workbench.colorTheme': value, 'asterAppearance.theme': '' };
}
function applyTheme(value) {
  const settings = snapshot(vscode);
  return updateGlobal(vscode, themeChanges(value, settings), settings);
}
// Brightness and contrast retune the Aster palette that is on now.
function applyTune(tuned) {
  for (const key of ['brightness', 'contrast']) validate({ key, value: tuned?.[key] }, fonts);
  const settings = snapshot(vscode), aster = themes.find(currentTheme(settings.get));
  if (!aster) throw new Error('Яркость и контраст меняют только темы Aster.');
  return updateGlobal(vscode, themes.themeChanges(reader(settings), aster, { brightness: tuned.brightness, contrast: tuned.contrast }), settings);
}
function writeUiStyle() {
  try {
    const result = uiStyle.write(vscode.env.appRoot, { uiFont: read('asterAppearance.uiFont') === true, family: read('editor.fontFamily') });
    if (result.skipped) console.warn('Aster Atelier interface font: ' + result.skipped);
    return result;
  } catch (error) { console.warn('Aster Atelier interface font: ' + error.message); return { error: error.message }; }
}
// A bundled font is written to every font surface with its coding ligatures on.
function fontChanges(font, weight) {
  const family = `'${font.family}', monospace`;
  return {...Object.fromEntries(FONT_FAMILY_KEYS.map(key => [key, family])), 'editor.fontLigatures': font.fontFeatures || true,
    'editor.fontWeight': String(weight), 'terminal.integrated.fontWeight': weight};
}
// `name` is a FONT_STYLES value (true/false still mean italic/normal); the
// recorded style tells which bold flags Aster set.
function styleChanges(name, settings = snapshot(vscode)) {
  const known = value => FONT_STYLES.some(item => item.value === value);
  const previous = known(settings.get('asterAppearance.fontStyle')) ? settings.get('asterAppearance.fontStyle') : 'normal';
  const style = styleSettings({ text: settings.global('editor.tokenColorCustomizations'), semantic: settings.global('editor.semanticTokenColorCustomizations') },
    typeof name === 'boolean' ? name : known(name) ? name : 'normal', previous);
  return { 'editor.tokenColorCustomizations': style.text, 'editor.semanticTokenColorCustomizations': style.semantic };
}
// After an update, or a theme chosen in the IDE's own picker, the chosen style
// and the readable colours still apply. A weight preset saved by Aster 1.5-1.7
// becomes its weight and the plain or italic style.
async function syncLook() {
  const settings = snapshot(vscode), legacy = LEGACY_STYLES[settings.get('asterAppearance.fontStyle')];
  const migrated = legacy ? { 'asterAppearance.fontStyle': legacy[0], 'editor.fontWeight': String(legacy[1]), 'terminal.integrated.fontWeight': legacy[1] } : {};
  const style = styleChanges(legacy ? legacy[0] : settings.get('asterAppearance.fontStyle'), settings);
  const readable = readableChanges(settings.get('workbench.colorTheme'), overlay(settings, style));
  return updateGlobal(vscode, { ...migrated, ...style, ...readable }, settings);
}
// Starts a restored palette, follows a palette or tuning chosen in another
// window or in settings.json, or migrates a label from the contributed-theme era
// or a palette removed in an update (it opens its closest kept palette).
async function syncTheme() {
  const settings = snapshot(vscode), names = new Set(contributedThemes().flatMap(theme => [theme.id, theme.label]));
  // A profile that never chose a theme only reports the IDE default; the
  // shared palette then applies there too.
  const explicit = key => key === 'workbench.colorTheme' ? settings.global(key) : settings.get(key);
  const theme = themes.pending(explicit, name => names.has(name));
  if (!theme) return 0;
  // The recorded name is never written back: a newer choice made while this
  // sync runs must not be replaced by the one that started it.
  const changes = themes.themeChanges(reader(settings), theme, undefined, true);
  if (settings.get('asterAppearance.theme') === theme.name) delete changes['asterAppearance.theme'];
  return updateGlobal(vscode, changes, settings);
}
// Navigation never applies anything; only a click or Enter writes the theme.
function pickTheme() {
  const picker = vscode.window.createQuickPick(), options = themeGallery(), current = currentTheme();
  const group = (label, list) => list.length ? [{ label, kind: vscode.QuickPickItemKind?.Separator ?? -1 }, ...list] : [];
  const item = option => ({ label: option.label, description: option.value === current ? 'текущая' : option.builtin ? 'тема IDE' : '', option });
  picker.items = swatches.SECTIONS.flatMap(({ name }) => group(name, options.filter(o => o.section === name).map(item)));
  picker.placeholder = 'Тема меняется только по клику или Enter';
  picker.onDidAccept(() => {
    const picked = picker.selectedItems[0]?.option;
    picker.hide();
    if (picked) void enqueue(() => applyTheme(picked.value)).catch(error => vscode.window.showErrorMessage('Aster Atelier: тема не применена: ' + error.message));
  });
  picker.show();
}

// Settings events are collected for 150 ms and handled once. Every handler is
// idempotent, so the events of the extension's own writes change nothing more.
const WATCHED = {
  palette: ['asterAppearance.theme', 'asterAppearance.brightness', 'asterAppearance.contrast'],
  readable: ['workbench.colorTheme'],
  uiStyle: ['asterAppearance.uiFont', 'editor.fontFamily'],
  studio: SHARED,
};
function watchSettings(studio) {
  const due = new Set();
  let timer;
  async function handle(jobs) {
    if (jobs.includes('palette')) await syncTheme();
    if (jobs.includes('readable')) { const settings = snapshot(vscode); await updateGlobal(vscode, readableChanges(settings.get('workbench.colorTheme'), settings), settings); }
    if (jobs.includes('uiStyle')) writeUiStyle();
    if (jobs.includes('studio')) await studio.update();
  }
  const listener = vscode.workspace.onDidChangeConfiguration(event => {
    for (const [job, keys] of Object.entries(WATCHED)) if (keys.some(key => event.affectsConfiguration(key))) due.add(job);
    if (!due.size) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      const jobs = [...due]; due.clear();
      enqueue(() => handle(jobs)).catch(error => console.warn('Aster Atelier settings: ' + error.message));
    }, 150);
  });
  const extensions = vscode.extensions?.onDidChange?.(() => { gallery = undefined; builtinSwatches.clear(); readableCache.clear(); });
  return { dispose() { clearTimeout(timer); listener.dispose(); extensions?.dispose(); } };
}

// Bundled fonts are installed once per font version for this OS user; the
// notice appears only for fonts installed now.
async function installBundledFonts(context) {
  const result = await service.ensureBundled(context.extensionPath, fonts, context.globalStorageUri.fsPath);
  for (const failure of result.failed) console.warn('Aster Atelier fonts: ' + failure);
  if (result.added.length) void vscode.window.showInformationMessage(`Aster Atelier установил шрифты (${result.added.length}). Они появятся в редакторе после полного перезапуска IDE.`);
}

function activate(context) {
  const studio = createStudio({ vscode, context, enqueue, read, fonts, service, themes, gallery: themeGallery, outsideCard,
    currentTheme, applyTheme, applyTune, fontChanges, styleChanges, writeUiStyle });
  context.subscriptions.push(studio, watchSettings(studio),
    vscode.commands.registerCommand('asterAppearance.open', () => studio.open()),
    vscode.commands.registerCommand('asterAppearance.selectTheme', () => pickTheme()));
  return enqueue(async () => {
    const scope = await require('./profiles.cjs').ensureAllProfiles(vscode, context);
    await context.globalState.update('applicationScopeVerification', scope);
    if (scope.status !== 'application-scoped') console.warn('Aster Atelier: ' + scope.reason);
    await syncTheme();
    await syncLook();
    writeUiStyle();
    await installBundledFonts(context).catch(error => console.warn('Aster Atelier fonts: ' + error.message));
  }).catch(error => vscode.window.showErrorMessage('Aster Atelier: ' + error.message));
}
module.exports={activate,nativeThemeOptions,vscodeThemeOptions,themeOptions,themeGallery,FONT_FAMILY_KEYS};
