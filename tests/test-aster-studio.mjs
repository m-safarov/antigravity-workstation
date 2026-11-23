import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url), root = path.resolve(import.meta.dirname, '..'), source = path.join(root, 'extensions/aster-appearance');
const fonts = require('../extensions/aster-appearance/fonts.json'), themes = require('../extensions/aster-appearance/themes.cjs');
const swatches = require('../extensions/aster-appearance/swatches.cjs');
const { FONT_STYLES, STYLE_RULE, ANY_WEIGHTS, fontWeights, validate } = require('../extensions/aster-appearance/appearance.cjs');
const settle = async () => { for (let i = 0; i < 60; i++) await new Promise(resolve => setImmediate(resolve)); };

// A small fake of the studio webview DOM: elements keep their listeners and
// children, so a click or a key press runs the panel's own handlers.
function fakePanel(saved) {
  const nodes = new Map(), handlers = {}, posted = [], states = [];
  const element = tag => ({ tag, value: '', textContent: '', className: '', hidden: false, disabled: false, tabIndex: 0, children: [], options: [], dataset: {}, attributes: {}, listeners: {}, parent: null,
    style: { setProperty(key, value) { this[key] = value; } },
    setAttribute(key, value) { this.attributes[key] = String(value); },
    addEventListener(type, handler) { (this.listeners[type] ||= []).push(handler); },
    fire(type, extra = {}) { for (const handler of this.listeners[type] || []) handler({ currentTarget: this, target: this, preventDefault() {}, ...extra }); },
    click() { if (!this.disabled) this.fire('click'); }, focus() { context.document.activeElement = this; },
    insertBefore(child, next) {
      if (child && typeof child === 'object') { if (child.parent) child.parent.children.splice(child.parent.children.indexOf(child), 1); child.parent = this; }
      const index = next ? this.children.indexOf(next) : -1;
      this.children.splice(index < 0 ? this.children.length : index, 0, child);
    },
    append(...items) { for (const item of items) this.insertBefore(item, null); },
    replaceChildren(...items) { this.children = []; this.append(...items); this.options = items; } });
  const node = id => { if (!nodes.has(id)) nodes.set(id, element('#' + id)); return nodes.get(id); };
  const context = vm.createContext({
    acquireVsCodeApi: () => ({ postMessage(value) { posted.push(value); }, getState: () => saved, setState(value) { states.push(structuredClone(value)); } }),
    document: { getElementById: node, createElement: element, fonts: { add() {} }, activeElement: null },
    window: { addEventListener: (type, handler) => handlers[type] = handler, scrollTo(x, y) { context.window.scrollY = y; }, scrollY: 0 },
    Option: function (text, value) { this.text = text; this.value = value; }, FontFace: function () { this.load = async () => this; }, setTimeout, clearTimeout });
  // The page loads color.cjs first, like the real page: both share one global scope.
  vm.runInContext(fs.readFileSync(path.join(source, 'color.cjs'), 'utf8'), context);
  vm.runInContext(fs.readFileSync(path.join(source, 'panel.js'), 'utf8'), context);
  const grids = () => node('gallery').children.map(group => group.children[1]);
  const cards = () => grids().flatMap(grid => grid.children).filter(item => !item.hidden);
  const card = value => cards().find(item => item.dataset.value === value);
  const colour = role => node('studio').style['--c-' + role];
  return { node, handlers, posted, states, grids, cards, card, colour, context };
}
const gallery = () => swatches.arrange([{ label: 'Antigravity Dark', value: 'Antigravity Dark', kind: 'dark', builtin: true },
  ...themes.THEMES.map(theme => ({ label: theme.name, value: theme.name, kind: theme.type, builtin: false }))]
  .map(option => option.builtin ? swatches.card(option, swatches.builtinSwatch(option, []))
    : swatches.card(option, swatches.asterSwatch(themes.find(option.value)), swatches.asterCode(themes.find(option.value)))));
const fontOptions = fonts.map(font => ({ ...font, files: undefined, weights: fontWeights(font), preview: [] }));
const applied = (patch = {}) => ({ theme: 'One Dark Pro', current: null, availability: {}, family: "'JetBrains Mono', monospace", familyName: 'JetBrains Mono',
  fontId: 'jetbrainsmono', size: 15, weight: '400', style: 'normal', brightness: 0, contrast: 0, uiFont: false, profileScope: { status: 'application-scoped' }, ...patch });
async function opened(saved, patch = {}) {
  const panel = fakePanel(saved);
  panel.node('style').replaceChildren(...FONT_STYLES.map(style => ({ value: style.value })));
  await panel.handlers.message({ data: { type: 'init', themes: gallery(), sections: swatches.SECTIONS, fonts: fontOptions, styles: FONT_STYLES, anyWeights: ANY_WEIGHTS, state: applied(patch) } });
  return panel;
}

test('the gallery has exactly two sections, dark and light, each from the darkest editor background to the brightest', async () => {
  const { node, grids } = await opened();
  assert.deepEqual(node('gallery').children.map(group => group.children[0].children[0].textContent), ['Тёмные', 'Светлые']);
  const list = gallery();
  for (const [index, grid] of grids().entries()) {
    const section = swatches.SECTIONS[index], expected = list.filter(option => option.section === section.name);
    assert.deepEqual(grid.children.map(item => item.dataset.value), expected.map(option => option.value));
    assert.ok(expected.every(option => (option.kind === 'light') === (section.kind === 'light')), section.name + ' holds only its kind');
    const lightness = expected.map(option => option.lightness);
    assert.deepEqual(lightness, [...lightness].sort((a, b) => a - b), section.name + ' is ordered by editor lightness');
    assert.equal(node('gallery').children[index].children[0].children[1].textContent, String(expected.length), 'the heading counts its themes');
  }
  assert.equal(grids().flat().length, 2);
});

test('a card is selected at the click, applies at once, and the state that follows patches the page without rebuilding it', async () => {
  const { node, handlers, posted, cards, card, context } = await opened();
  const built = cards(), groups = node('gallery').children;
  assert.equal(card('One Dark Pro').className, 'card applied');
  card('Light Owl').focus(); card('Light Owl').click();
  assert.deepEqual(posted.filter(message => message.type === 'apply-theme').map(message => message.value), ['Light Owl'], 'one click applies, no Apply button');
  assert.equal(card('Light Owl').className, 'card applied pending', 'the clicked card is selected before the extension answers');
  assert.equal(card('One Dark Pro').className, 'card');
  context.window.scrollY = 640;
  await handlers.message({ data: { type: 'state', ...applied({ theme: 'Light Owl' }) } });
  await handlers.message({ data: { type: 'result', action: 'apply-theme', value: 'Light Owl', message: 'Тема применена.' } });
  assert.equal(node('gallery').children, groups, 'the gallery is not rebuilt');
  assert.deepEqual(cards(), built, 'every card is the same element');
  assert.equal(context.window.scrollY, 640, 'the scroll position stays');
  assert.equal(context.document.activeElement, card('Light Owl'), 'focus stays on the chosen card');
  assert.equal(card('Light Owl').className, 'card applied');
  card('Light Owl').click();
  assert.equal(posted.filter(message => message.type === 'apply-theme').length, 1, 'the applied theme is not applied again');
});

test('quick clicks: the newest card stays selected while older themes are still being written', async () => {
  const { handlers, posted, card } = await opened();
  card('Light Owl').click(); card('Nord').click(); card('GitHub Dark').click();
  assert.deepEqual(posted.filter(message => message.type === 'apply-theme').map(message => message.value), ['Light Owl', 'Nord', 'GitHub Dark']);
  assert.equal(card('GitHub Dark').className, 'card applied pending');
  await handlers.message({ data: { type: 'state', ...applied({ theme: 'Light Owl' }) } });
  await handlers.message({ data: { type: 'result', action: 'apply-theme', value: 'Light Owl', message: 'Тема применена.' } });
  assert.equal(card('GitHub Dark').className, 'card applied pending', 'an older result does not undo the newest selection');
  assert.equal(card('Light Owl').className, 'card');
  await handlers.message({ data: { type: 'result', action: 'apply-theme', value: 'GitHub Dark', error: 'Тема не применена: диск недоступен' } });
  assert.equal(card('Light Owl').className, 'card applied', 'a failed theme returns the selection to the applied one');
});

test('arrow keys move between cards without applying; a theme chosen elsewhere gets its own card in its section by brightness', async () => {
  const { handlers, posted, card, grids, context } = await opened();
  card('One Dark Pro').fire('keydown', { key: 'ArrowRight' });
  assert.notEqual(context.document.activeElement, card('One Dark Pro'));
  assert.equal(posted.filter(message => message.type === 'apply-theme').length, 0);
  assert.equal(card('Personal Theme'), undefined);
  const outside = swatches.card({ label: 'Personal Theme', value: 'Personal Theme', kind: 'light', builtin: true },
    { background: '#f4f4f4', foreground: '#222222', keyword: '#0000aa', function: '#795e26', string: '#a31515', type: '#267f99', comment: '#227722' });
  await handlers.message({ data: { type: 'state', ...applied({ theme: 'Personal Theme', current: outside }) } });
  const light = grids()[1].children.filter(item => !item.hidden).map(item => item.dataset.value);
  const before = gallery().filter(option => option.section === 'Светлые' && option.lightness < outside.lightness).length;
  assert.equal(light.indexOf('Personal Theme'), before, 'placed among the light themes by its editor lightness');
  assert.equal(card('Personal Theme').className, 'card applied');
  await handlers.message({ data: { type: 'state', ...applied() } });
  assert.equal(card('Personal Theme'), undefined, 'the extra card hides again');
});

test('the page restores its scroll position after the IDE rebuilds a hidden studio', async () => {
  const { states, context } = await opened({ scrollY: 812 });
  assert.equal(context.window.scrollY, 812);
  assert.ok(Array.isArray(states));
});

test('init does not reset scroll position to 0 when user already scrolled during initial load', async () => {
  const panel = fakePanel();
  panel.node('style').replaceChildren(...FONT_STYLES.map(style => ({ value: style.value })));
  panel.context.window.scrollY = 516;
  await panel.handlers.message({
    data: { type: 'init', themes: gallery(), sections: swatches.SECTIONS, fonts: fontOptions, styles: FONT_STYLES, anyWeights: ANY_WEIGHTS, state: applied() },
  });
  assert.equal(panel.context.window.scrollY, 516, 'init with no saved scrollY must not snap user back to 0');
});

test('the code preview shows the selected theme and follows the sliders live with the editor colours; Apply is still needed', async () => {
  const { node, handlers, posted, colour, card } = await opened();
  const dracula = themes.find('One Dark Pro'), editor = level => themes.blocks(dracula, {}, level).semantic.rules;
  assert.equal(colour('background'), dracula.colors['editor.background']);
  assert.equal(colour('keyword'), editor({}).keyword);
  assert.equal(colour('comment'), editor({}).comment, 'the comment colour is the one the editor draws');
  node('brightness').value = '30'; node('brightness').fire('input');
  node('contrast').value = '-20'; node('contrast').fire('input');
  assert.equal(colour('keyword'), editor({ brightness: 30, contrast: -20 }).keyword, 'the preview recolours while the slider moves');
  assert.equal(colour('comment'), editor({ brightness: 30, contrast: -20 }).comment);
  assert.equal(node('applyTune').disabled, false);
  assert.match(node('tuneHint').textContent, /Пример уже показывает новые цвета/);
  assert.equal(posted.filter(message => message.type === 'apply-tune').length, 0, 'moving a slider writes nothing');
  await handlers.message({ data: { type: 'state', ...applied({ size: 16 }) } });
  assert.equal(node('brightness').value, '30', 'an unrelated refresh keeps the pending value');
  card('Light Owl').click();
  assert.equal(colour('background'), themes.find('Light Owl').colors['editor.background'], 'a clicked card recolours the preview at once');
  assert.equal(colour('keyword'), themes.blocks(themes.find('Light Owl'), {}, { brightness: 30, contrast: -20 }).semantic.rules.keyword);
  node('applyTune').click();
  assert.deepEqual(JSON.parse(JSON.stringify(posted.filter(message => message.type === 'apply-tune'))), [{ type: 'apply-tune', brightness: 30, contrast: -20 }]);
  assert.equal(node('applyTune').disabled, true, 'busy while applying');
  await handlers.message({ data: { type: 'state', ...applied({ theme: 'Light Owl', brightness: 30, contrast: -20 }) } });
  await handlers.message({ data: { type: 'result', action: 'apply-tune', message: 'ok' } });
  assert.equal(node('applyTune').disabled, true, 'applied, nothing pending');
  card('Antigravity Dark').click();
  const native = gallery().find(option => option.value === 'Antigravity Dark');
  assert.equal(node('brightness').disabled, true, 'only Aster palettes are tuned');
  assert.equal(colour('keyword'), native.swatch.keyword, 'an IDE theme is previewed in its own colours');
  assert.match(node('tuneHint').textContent, /только темы Aster/);
});

test('the font section previews the chosen font and keeps a pending font until Apply or Cancel; a removed font is shown by name', async () => {
  const { node, handlers, posted } = await opened();
  assert.equal(node('font').value, 'jetbrainsmono');
  assert.equal(node('font').options.filter(option => /JetBrains Mono/.test(option.text)).length, 1, 'JetBrains Mono is listed once');
  assert.deepEqual(node('font').options.map(option => option.value), fonts.map(font => font.id), 'a bundled current font has no extra entry');
  assert.match(node('preview').style.fontFamily, /AsterPreview-jetbrainsmono/, 'the bundled file shows the font with its ligatures');
  assert.match(node('fontNote').textContent, /^Лигатуры: === !== => <= >= -> != && \|\|\. Толщина: 100–800\.$/);
  node('size').value = 30;
  await handlers.message({ data: { type: 'state', ...applied({ size: 18 }) } });
  assert.equal(node('size').value, 30, 'a pending edit survives a refresh');
  assert.equal(node('applyFont').disabled, false);
  assert.equal(posted.filter(message => message.type === 'apply-font').length, 0, 'editing alone never applies a font');
  await handlers.message({ data: { type: 'state', ...applied({ family: "'Lilex', monospace", familyName: 'Lilex', fontId: '' }) } });
  node('cancelFont').click();
  assert.equal(node('font').value, '');
  assert.equal(node('font').options[0].text, 'Lilex — текущий', 'a font removed from Aster is listed by its own name');
  assert.equal(node('font').options.length, fonts.length + 1);
  assert.equal(node('preview').style.fontFamily, "'Lilex', monospace", 'it keeps drawing in the installed font');
  assert.match(node('fontNote').textContent, /«Lilex» не входит в Aster Atelier, но остаётся в системе/);
  node('weightUp').click();
  assert.equal(node('weightValue').textContent, '500 · средний', 'its weight still steps by 100');
  const plex = node('font').options.find(option => option.value === 'ibmplexmono');
  assert.equal(plex.text, 'IBM Plex Mono — без лигатур', 'the family without coding ligatures says so in the list');
  node('font').value = 'ibmplexmono'; node('font').fire('change');
  assert.match(node('fontNote').textContent, /^Без лигатур кода/);
  node('font').value = 'recmono'; node('font').fire('change');
  assert.match(node('fontNote').textContent, /Кириллицы нет/);
});

test('seven styles never change the weight; − and + step through the weights the font has', async () => {
  assert.deepEqual(FONT_STYLES.map(style => [style.value, style.label]), [['normal', 'Обычный'], ['italic', 'Курсив'], ['comments', 'Курсивные комментарии'],
    ['keywords', 'Курсивные ключевые слова'], ['accent', 'Курсив: комментарии и ключевые слова'], ['bold-keywords', 'Жирные ключевые слова'], ['bold-names', 'Жирные объявления']]);
  assert.ok(FONT_STYLES.every(style => style.weight === undefined), 'no style carries a weight');
  const schema = require('../extensions/aster-appearance/package.json').contributes.configuration.properties['asterAppearance.fontStyle'];
  assert.deepEqual(schema.enum, FONT_STYLES.map(style => style.value));
  for (const style of FONT_STYLES) {
    const { node, handlers, posted } = await opened(undefined, { weight: '600' });
    validate({ key: 'style', value: style.value }, fonts);
    node('style').value = style.value; node('style').fire('input');
    assert.equal(node('weightValue').textContent, '600 · полужирный', style.value + ' keeps the weight');
    assert.equal(node('preview').style.fontWeight, '600');
    assert.equal(node('preview').style.fontStyle, style.italic ? 'italic' : 'normal');
    assert.equal(node('preview').dataset.style, style.role || '', 'a role style marks the preview');
    node('applyFont').click();
    if (style.value === 'normal') { assert.equal(posted.length, 1, 'nothing changed, nothing to apply'); continue; }
    assert.deepEqual([posted.at(-1).style, posted.at(-1).weight], [style.value, 600]);
    await handlers.message({ data: { type: 'state', ...applied({ style: style.value, weight: '600' }) } });
    await handlers.message({ data: { type: 'result', action: 'apply-font', message: 'ok' } });
    assert.equal(node('applyFont').disabled, true);
    assert.equal(node('style').value, style.value);
  }
  const { node } = await opened();
  const steps = (button, times) => { const seen = []; for (let i = 0; i < times; i++) { node(button).click(); seen.push(node('weightValue').textContent.split(' ')[0]); } return seen; };
  assert.deepEqual(steps('weightUp', 5), ['500', '600', '700', '800', '800'], 'JetBrains Mono stops at its boldest, 800');
  assert.equal(node('weightUp').disabled, true);
  assert.deepEqual(steps('weightDown', 8), ['700', '600', '500', '400', '300', '200', '100', '100']);
  assert.equal(node('weightDown').disabled, true);
  node('weightUp').click(); node('weightUp').click(); node('weightUp').click();
  node('font').value = 'iosevka'; node('font').fire('change');
  assert.equal(node('weightValue').textContent, '400 · обычный', 'Iosevka has only 400');
  assert.equal(node('weightUp').disabled && node('weightDown').disabled, true);
  node('font').value = 'recmono'; node('font').fire('change');
  assert.deepEqual(steps('weightUp', 2), ['700', '700'], 'Rec Mono steps from Regular straight to Bold');
  node('font').value = 'jetbrainsmono'; node('font').fire('change');
  assert.equal(node('weightValue').textContent, '700 · жирный', 'a weight the next font has is kept');
  node('style').value = 'bold-keywords'; node('style').fire('input');
  assert.equal(node('weightValue').textContent, '700 · жирный');
});

test('every font previews its configured ligatures and Cancel restores the applied feature set', async () => {
  const defaults = '"liga" 1, "calt" 1';
  for (const font of fonts) {
    const { node, handlers } = await opened();
    node('font').value = font.id; node('font').fire('change');
    assert.equal(node('preview').style.fontFeatureSettings, font.fontFeatures || defaults, font.family);
    node('cancelFont').click();
    assert.equal(node('font').value, 'jetbrainsmono');
    assert.equal(node('preview').style.fontFeatureSettings, defaults);
    await handlers.message({ data: { type: 'state', ...applied({ family: "'" + font.family + "', monospace", familyName: font.family, fontId: font.id }) } });
    assert.equal(node('font').value, font.id);
    assert.equal(node('preview').style.fontFeatureSettings, font.fontFeatures || defaults);
  }
});

// The extension with a fake IDE: the studio page is written once; every later
// change arrives as a state message. `hold` delays every settings write until released.
function host(values = {}, service = {}, options = {}) {
  const commands = new Map(), posted = [], writes = [], notices = [], counts = { inspect: 0, getConfiguration: 0 };
  let receive, html = [];
  const webview = { cspSource: 'csp', asWebviewUri: uri => uri, postMessage: async value => { posted.push(value); return true; },
    onDidReceiveMessage: callback => { receive = callback; return { dispose() {} }; } };
  Object.defineProperty(webview, 'html', { set(value) { html.push(value); }, get() { return html.at(-1) || ''; } });
  const vscode = { ConfigurationTarget: { Global: 1 }, version: '1.107.0', env: { appRoot: os.tmpdir() }, extensions: { all: options.extensions || [] },
    Uri: { file: file => ({ fsPath: file, toString: () => file }) }, ViewColumn: { One: 1 }, window: { visibleTextEditors: [], activeColorTheme: { kind: 2 },
      createWebviewPanel: () => ({ webview, onDidDispose: () => ({ dispose() {} }), reveal() {}, dispose() {} }),
      showErrorMessage: message => assert.fail(message), showInformationMessage: message => notices.push(message) },
    commands: { registerCommand: (name, callback) => { commands.set(name, callback); return { dispose() {} }; } },
    workspace: { onDidChangeConfiguration: () => ({ dispose() {} }), getConfiguration: () => { counts.getConfiguration++; return { get: key => values[key],
      inspect: key => { counts.inspect++; return { globalValue: values[key] }; },
      update: async (key, value) => { writes.push(key); await options.hold?.(key, value); values[key] = structuredClone(value); } }; } } };
  const fontService = { installed: async () => Object.fromEntries(fonts.map(font => [font.id, true])), recorded: () => [], ensureBundled: async () => ({ added: [], failed: [] }), ...service };
  const module = { exports: {} }, nativeRequire = createRequire(path.join(source, 'extension.cjs'));
  const loader = name => name === 'vscode' ? vscode : name === './font-service.cjs' ? fontService
    : name === './profiles.cjs' ? { ensureAllProfiles: async () => ({ status: 'application-scoped' }) } : nativeRequire(name);
  vm.runInNewContext(fs.readFileSync(path.join(source, 'extension.cjs'), 'utf8'), { module, exports: module.exports, require: loader, setTimeout, clearTimeout, console });
  const context = { extensionPath: source, subscriptions: [], globalStorageUri: { fsPath: os.tmpdir() }, globalState: { get: () => undefined, update: async () => {} } };
  return { module, context, commands, posted, writes, values, notices, counts, settle, html, receive: message => receive(message) };
}
async function openedHost(values, service, options) {
  const ide = host(values, service, options);
  await ide.module.exports.activate(ide.context);
  await ide.commands.get('asterAppearance.open')();
  ide.receive({ type: 'ready' }); await settle();
  return ide;
}
const PALETTE = ['workbench.colorCustomizations', 'editor.tokenColorCustomizations', 'editor.semanticTokenColorCustomizations'];

test('a theme switch writes only the keys that change, colours before the base theme, with each key inspected once', async () => {
  const ide = await openedHost({ 'workbench.colorTheme': 'Visual Studio Dark', 'asterAppearance.theme': 'One Dark Pro' });
  const switchTo = async value => {
    ide.writes.length = 0; ide.posted.length = 0; ide.counts.inspect = 0;
    ide.receive({ type: 'apply-theme', value }); await settle();
    assert.equal(ide.values['asterAppearance.theme'], value);
    assert.deepEqual(ide.posted.map(message => message.type), ['state', 'result'], 'one state patch and one result, never a new page');
    return [...ide.writes];
  };
  assert.deepEqual(await switchTo('Tokyo Night'), [...PALETTE, 'asterAppearance.theme'], 'dark to dark: four writes');
  assert.ok(ide.counts.inspect <= 7, 'five keys read once, two objects re-checked before writing: ' + ide.counts.inspect);
  assert.deepEqual(await switchTo('Light Owl'), [...PALETTE, 'workbench.colorTheme', 'asterAppearance.theme'], 'dark to light: five writes, the base theme last');
  assert.ok(ide.values['workbench.colorCustomizations']['[Visual Studio Dark]'], 'the dark block stays while it is on screen: no flash of the plain theme');
  assert.deepEqual(await switchTo('One Light'), [...PALETTE, 'asterAppearance.theme']);
  assert.equal(ide.values['workbench.colorCustomizations']['[Visual Studio Dark]'], undefined, 'the unused dark block goes with the next switch, in writes made anyway');
  ide.writes.length = 0;
  ide.receive({ type: 'apply-theme', value: 'One Light' }); await settle();
  assert.deepEqual(ide.writes, [], 'the theme that is on writes nothing');
  assert.equal(ide.html.length, 1, 'the page is written once');
  ide.receive({ type: 'apply-tune', brightness: 10, contrast: -5 }); await settle();
  assert.equal(ide.values['asterAppearance.brightness'], 10); assert.equal(ide.values['asterAppearance.contrast'], -5);
  assert.equal(ide.posted.at(-1).message, 'Яркость и контраст применены.');
  await ide.commands.get('asterAppearance.open')();
  assert.equal(ide.html.length, 1, 'opening an open studio only reveals it');
});

test('an IDE theme writes its readable comment rules and the theme once, then nothing', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aster-native-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.writeFileSync(path.join(directory, 'dark.json'), JSON.stringify({ colors: { 'editor.background': '#181818' }, tokenColors: [{ scope: 'comment', settings: { foreground: '#777777' } }] }));
  const extensions = [{ extensionPath: directory, packageJSON: { contributes: { themes: [{ id: 'Default Dark Modern', label: 'Dark Modern', path: 'dark.json' }] } } }];
  const ide = await openedHost({ 'workbench.colorTheme': 'Visual Studio Dark', 'asterAppearance.theme': 'One Dark Pro' }, {}, { extensions });
  ide.writes.length = 0;
  ide.receive({ type: 'apply-theme', value: 'Default Dark Modern' }); await settle();
  assert.deepEqual(ide.writes, ['editor.tokenColorCustomizations', 'editor.semanticTokenColorCustomizations', 'workbench.colorTheme', 'asterAppearance.theme']);
  assert.equal(ide.values['workbench.colorTheme'], 'Default Dark Modern');
  ide.writes.length = 0;
  ide.receive({ type: 'apply-theme', value: 'One Dark Pro' }); await settle();
  ide.receive({ type: 'apply-theme', value: 'Default Dark Modern' }); await settle();
  assert.deepEqual(ide.writes.slice(-2), ['workbench.colorTheme', 'asterAppearance.theme'], 'its readable rules are already there');
  ide.receive({ type: 'apply-theme', value: 'No Such Theme' }); await settle();
  assert.match(ide.posted.at(-1).error, /^Тема не применена: Темы «No Such Theme» нет в галерее\.$/);
});

test('quick clicks coalesce: the theme being written finishes, then only the newest click is written', async () => {
  let holding = false, release, entered;
  const writing = new Promise(resolve => entered = resolve), gate = new Promise(resolve => release = resolve);
  // Writes wait until the test lets them through.
  const ide = await openedHost({ 'workbench.colorTheme': 'Visual Studio Dark', 'asterAppearance.theme': 'One Dark Pro' }, {},
    { hold: async () => { if (holding) { entered(); await gate; } } });
  ide.writes.length = 0; ide.posted.length = 0; holding = true;
  ide.receive({ type: 'apply-theme', value: 'Tokyo Night' });
  await writing;
  for (const value of ['Nord', 'Light Owl', 'GitHub Dark', 'Dracula']) ide.receive({ type: 'apply-theme', value });
  holding = false; release(); await settle();
  assert.equal(ide.values['asterAppearance.theme'], 'Dracula', 'the newest click wins');
  assert.deepEqual(ide.writes, [...PALETTE, 'asterAppearance.theme', ...PALETTE, 'asterAppearance.theme'],
    'Tokyo Night (already being written) and Dracula; Nord, Light Owl and GitHub Dark are never written');
  assert.deepEqual(ide.posted.filter(message => message.type === 'result').map(message => [message.action, message.value]), [['apply-theme', 'Dracula']], 'one result, for the newest theme');
  assert.equal(ide.posted.filter(message => message.type === 'state').length, 1, 'one state patch');
});

test('the studio opens at once: the gallery never waits for the system font check', async () => {
  let release;
  const ide = await openedHost({ 'workbench.colorTheme': 'Visual Studio Dark', 'asterAppearance.theme': 'One Dark Pro' },
    { installed: () => new Promise(resolve => release = resolve) });
  const init = ide.posted.find(message => message.type === 'init');
  assert.ok(init, 'init is posted while the font check still runs');
  assert.equal(init.state.detecting, true);
  assert.deepEqual(init.sections.map(section => section.name), ['Тёмные', 'Светлые']);
  assert.equal(init.themes.length, themes.THEMES.length);
  ide.values['asterAppearance.theme'] = 'Nord';
  release(Object.fromEntries(fonts.map(font => [font.id, true]))); await settle();
  const state = ide.posted.filter(message => message.type === 'state').at(-1);
  assert.equal(state.detecting, undefined);
  assert.equal(state.availability.jetbrainsmono, true);
  assert.equal(state.theme, 'Nord', 'the state after the check is read after it');
});

test('the current family is matched to its bundled font by any of its names, so it is never listed twice', async () => {
  for (const [family, id] of [["'JetBrains Mono', monospace", 'jetbrainsmono'], ['"JetBrains Mono", Consolas', 'jetbrainsmono'], ['JetBrainsMono-Regular', 'jetbrainsmono'],
    ['jetbrains mono', 'jetbrainsmono'], ["'Fira Code Light'", 'firacode'], ["'Rec Mono Linear', monospace", 'recmono'], ["'Lilex', monospace", ''], ['Consolas, monospace', '']]) {
    const ide = await openedHost({ 'workbench.colorTheme': 'Visual Studio Dark', 'editor.fontFamily': family });
    const state = ide.posted.find(message => message.type === 'init').state;
    assert.equal(state.fontId, id, family);
    assert.equal(state.familyName, family.split(',')[0].trim().replace(/^(['"])(.*)\1$/, '$2'));
  }
});

test('the page has no removed hint texts, loads the shared colour math before the panel and marks every preview role', async () => {
  const ide = await openedHost({ 'workbench.colorTheme': 'Visual Studio Dark' });
  const page = ide.html[0];
  for (const text of ['Щелчок по карточке сразу применяет тему', 'Стрелки переходят между карточками', 'Тема меняется сразу; яркость, контраст и шрифт сохраняются'])
    assert.ok(!page.includes(text), text);
  assert.ok(page.indexOf('color.cjs') > 0 && page.indexOf('color.cjs') < page.indexOf('panel.js'));
  for (const marker of ['class="cm"', 'class="fn"', 'class="kw"', 'class="str"', 'class="call"']) assert.ok(page.includes(marker), marker);
  assert.match(page, /<pre id="tunePreview" class="code"/);
  const css = fs.readFileSync(path.join(source, 'panel.css'), 'utf8');
  for (const role of ['comments', 'keywords', 'accent', 'bold-keywords', 'bold-names']) assert.match(css, new RegExp('data-style="' + role + '"'), role);
  for (const role of swatches.CODE_ROLES) assert.ok(css.includes('var(--c-' + role + ')'), role + ' is coloured in the previews');
});

test('applying a font switches its coding ligatures on and writes the chosen weight to editor and terminal', async () => {
  const ide = await openedHost({ 'workbench.colorTheme': 'Visual Studio Dark', 'editor.fontLigatures': false });
  const apply = async (font, weight = 400, style = 'normal') => {
    ide.receive({ type: 'apply-font', font: font.id, size: 15, weight, style, uiFont: false });
    await settle();
    const request = ide.posted.filter(message => message.type === 'probe').at(-1);
    ide.receive({ type: 'probe-result', id: request.id, loaded: true }); await settle();
  };
  for (const font of fonts) {
    await apply(font, font.minWeight);
    assert.equal(ide.values['editor.fontLigatures'], font.fontFeatures || true, font.family);
    assert.equal(ide.values['editor.fontFamily'], "'" + font.family + "', monospace");
    assert.deepEqual([ide.values['editor.fontWeight'], ide.values['terminal.integrated.fontWeight']], [String(font.minWeight), font.minWeight]);
    assert.match(ide.posted.at(-1).message, /^Шрифт применён\./);
    await apply(fonts[0]);
    assert.equal(ide.values['editor.fontLigatures'], true, 'original family restores its default features');
  }
});

test('every style keeps the chosen weight and its code slant, and restart keeps personal rules and the chosen style', async () => {
  for (const style of FONT_STYLES) {
    const personal = { name: 'personal colour', scope: 'comment', settings: { foreground: '#123456' } };
    const ide = await openedHost({ 'workbench.colorTheme': 'Visual Studio Dark', 'editor.tokenColorCustomizations': { textMateRules: [personal] },
      'editor.semanticTokenColorCustomizations': { rules: { 'class.readonly': { foreground: '#abcdef' } } } });
    ide.receive({ type: 'apply-font', font: 'jetbrainsmono', size: 18, weight: 300, style: style.value, uiFont: false });
    await settle();
    ide.receive({ type: 'probe-result', id: ide.posted.find(message => message.type === 'probe').id, loaded: true }); await settle();
    assert.equal(ide.values['asterAppearance.fontStyle'], style.value);
    assert.equal(ide.values['editor.fontWeight'], '300', style.value + ' never changes the weight');
    const tokenRules = ide.values['editor.tokenColorCustomizations'].textMateRules;
    assert.deepEqual(tokenRules.find(rule => rule.name === personal.name), personal);
    assert.equal(tokenRules.find(rule => rule.name === STYLE_RULE).settings.fontStyle, style.italic ? 'italic' : '');
    assert.deepEqual(ide.values['editor.semanticTokenColorCustomizations'].rules['class.readonly'], { foreground: '#abcdef' });
    const values = structuredClone(ide.values), restarted = host(values);
    await restarted.module.exports.activate(restarted.context);
    assert.deepEqual(values, ide.values, style.value + ' survives a new host');
  }
});

test('a weight the font does not have is refused before installing or writing anything', async () => {
  const ide = await openedHost({ 'workbench.colorTheme': 'Visual Studio Dark' });
  const before = structuredClone(ide.values), errors = [];
  for (const choice of [{ font: 'iosevka', weight: 700 }, { font: 'jetbrainsmono', weight: 900 }, { font: 'recmono', weight: 500 }, { font: '', weight: 450 }]) {
    ide.receive({ type: 'apply-font', size: 15, style: 'normal', uiFont: false, ...choice });
    await settle();
    errors.push(ide.posted.at(-1).error);
    assert.match(errors.at(-1), /^Шрифт не применён: /, JSON.stringify(choice));
    assert.deepEqual(ide.values, before);
    assert.equal(ide.posted.some(message => message.type === 'probe'), false);
  }
  assert.equal(errors[2], 'Шрифт не применён: толщина 500 недоступна для Rec Mono Linear (есть 400, 700).');
  assert.equal(errors[3], 'Шрифт не применён: Недопустимое значение настройки «weight».');
});

test('weight presets saved by Aster 1.5-1.7 become their weight and a plain or italic style at startup', async () => {
  for (const [legacy, style, weight] of [['light', 'normal', 300], ['medium', 'normal', 500], ['semibold', 'normal', 600], ['bold', 'normal', 700], ['bold-italic', 'italic', 700]]) {
    const ide = host({ 'workbench.colorTheme': 'Visual Studio Dark', 'asterAppearance.fontStyle': legacy, 'editor.fontWeight': '400' });
    await ide.module.exports.activate(ide.context);
    assert.equal(ide.values['asterAppearance.fontStyle'], style, legacy);
    assert.deepEqual([ide.values['editor.fontWeight'], ide.values['terminal.integrated.fontWeight']], [String(weight), weight], legacy);
    assert.equal(ide.values['editor.tokenColorCustomizations'].textMateRules.find(rule => rule.name === STYLE_RULE).settings.fontStyle, style === 'italic' ? 'italic' : '');
    const writes = ide.writes.length;
    await ide.module.exports.activate(ide.context);
    assert.equal(ide.writes.length, writes, 'a second start writes nothing');
  }
});

test('a saved palette that was removed opens its closest kept palette at startup', async () => {
  const removed = { 'Night Owl': 'Catppuccin Mocha', Panda: 'Catppuccin Mocha', 'Gruvbox Dark': 'Ayu Mirage', Cobalt2: 'Ayu Mirage', 'SynthWave 84': 'Ayu Mirage',
    'Everforest Dark': 'Nord', 'Rose Pine Moon': 'Nord', 'Kanagawa Wave': 'Nord', 'Vitesse Dark': 'Nord', 'Solarized Light': 'Catppuccin Latte', 'Ayu Light': 'Catppuccin Latte' };
  for (const [name, kept] of Object.entries(removed)) {
    const theme = themes.find(kept), base = themes.BASE[theme.type];
    const ide = host({ 'workbench.colorTheme': base, 'asterAppearance.theme': name });
    await ide.module.exports.activate(ide.context);
    assert.equal(ide.values['asterAppearance.theme'], kept, name);
    assert.equal(ide.values['workbench.colorCustomizations'][`[${base}]`]['editor.background'], theme.colors['editor.background']);
    await ide.commands.get('asterAppearance.open')(); ide.receive({ type: 'ready' }); await settle();
    assert.equal(ide.posted.find(message => message.type === 'init').state.theme, kept, 'the studio shows the kept palette');
  }
});

// The real font service against a fake OS: fc-list, fc-cache and the user's
// font folder live in a temporary directory.
function fontService(home) {
  const listed = new Set(), calls = [];
  const execFile = (file, args, options, callback) => {
    calls.push(file);
    if (file === 'fc-list') return callback(null, [...listed].join('\n'), '');
    if (file === 'fc-cache') { for (const name of fs.readdirSync(path.join(home, '.local/share/fonts'))) listed.add(fonts.find(font => name.startsWith('Aster-' + font.id + '-')).family); return callback(null, '', ''); }
    return callback(new Error('unexpected ' + file));
  };
  const module = { exports: {} }, nativeRequire = createRequire(path.join(source, 'font-service.cjs'));
  const loader = name => name === 'node:child_process' ? { execFile } : name === 'node:os' ? { ...os, homedir: () => home } : nativeRequire(name);
  vm.runInNewContext(fs.readFileSync(path.join(source, 'font-service.cjs'), 'utf8'), { module, exports: module.exports, require: loader, process: { platform: 'linux', pid: 1 }, Buffer, console });
  return { service: module.exports, calls, listed };
}

test('bundled fonts install once per font version: no reinstall, no second notice after a restart or in another window', async t => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'aster-fonts-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const storage = path.join(base, 'storage'), home = path.join(base, 'home');
  const first = fontService(home);
  const [one, other] = await Promise.all([first.service.ensureBundled(source, fonts, storage), first.service.ensureBundled(source, fonts, storage)]);
  assert.deepEqual([one.added.length, other.added.length].sort(), [0, fonts.length], 'two windows starting together install once');
  assert.equal(first.calls.filter(file => file === 'fc-cache').length, fonts.length);
  // A restart: a new extension host, the same storage. Even if font detection
  // no longer lists the fonts, the record stops a second install.
  const restart = fontService(home);
  assert.deepEqual(JSON.parse(JSON.stringify(await restart.service.ensureBundled(source, fonts, storage))), { added: [], failed: [] });
  assert.equal(restart.calls.length, 0, 'nothing is run at all');
  // A new font version is installed once again.
  const updated = fonts.map(font => font.id === 'maplemono' ? { ...font, files: font.files.map(file => file.file.endsWith('.ttf') ? { ...file, sha256: '0'.repeat(64) } : file) } : font);
  assert.deepEqual(restart.service.recorded(storage, updated).includes('maplemono'), false);
  // The extension shows the notice only when fonts were installed now.
  const notices = [];
  for (const result of [{ added: fonts.map(font => font.id), failed: [] }, { added: [], failed: [] }, { added: [], failed: [], busy: true }]) {
    const ide = host({ 'workbench.colorTheme': 'Visual Studio Dark' }, { ensureBundled: async () => result });
    await ide.module.exports.activate(ide.context);
    notices.push(...ide.notices);
  }
  assert.equal(notices.length, 1);
  assert.ok(notices[0].includes('установил шрифты (' + fonts.length + ')'));
});

test('window opacity is gone from the extension, its settings and its package', () => {
  const pkg = require('../extensions/aster-appearance/package.json');
  assert.equal(pkg.contributes.configuration.properties['asterAppearance.windowOpacity'], undefined);
  assert.equal(fs.existsSync(path.join(source, 'window-opacity.ps1')), false);
  for (const file of ['extension.cjs', 'studio.cjs', 'panel.js', 'panel.css', 'appearance.cjs', 'README.md', 'THEMES.md'])
    assert.doesNotMatch(fs.readFileSync(path.join(source, file), 'utf8'), /windowOpacity|window-opacity|window opacity|прозрачност/i, file);
  const { SHARED } = require('../extensions/aster-appearance/appearance.cjs');
  assert.throws(() => validate({ key: 'opacity', value: 80 }, fonts));
  assert.ok(!SHARED.some(key => /opacity/i.test(key)));
  assert.ok(!Object.keys(require('../extensions/aster-appearance/manifest.json').files).some(file => /opacity|\.gif$|\.mp4$/.test(file)));
  assert.equal(require('../lib/profile-settings').isRetiredSetting('asterAppearance.windowOpacity'), true, 'a value written earlier leaves the profile on the next setup');
});

// GSUB feature tags straight from the font file.
function gsubFeatures(bytes) {
  const tables = bytes.readUInt16BE(4);
  for (let i = 0; i < tables; i++) {
    const record = 12 + i * 16;
    if (bytes.toString('ascii', record, record + 4) !== 'GSUB') continue;
    const table = bytes.readUInt32BE(record + 8), list = table + bytes.readUInt16BE(table + 6);
    return new Set(Array.from({ length: bytes.readUInt16BE(list) }, (_, index) => bytes.toString('ascii', list + 2 + index * 6, list + 6 + index * 6)));
  }
  return new Set();
}
test('every bundled font draws the coding ligatures it promises, measured in each file, with its OpenType features present', () => {
  const { FAMILIES, LIGATURES } = require('../scripts/fetch-aster-fonts.cjs');
  assert.deepEqual(fonts.map(font => font.id), FAMILIES.map(([id]) => id));
  for (const font of fonts) {
    const lacks = FAMILIES.find(([id]) => id === font.id)[3];
    assert.deepEqual(font.ligatures, LIGATURES.filter(text => !lacks.includes(text)), font.family);
    const files = font.files.filter(file => file.file.endsWith('.ttf'));
    assert.ok(files.length > 0, font.family);
    for (const file of files) {
      assert.deepEqual(font.ligatures.filter(text => !file.ligatures.includes(text)), [], file.file + ' draws every promised ligature');
      const tags = gsubFeatures(fs.readFileSync(path.join(source, file.file)));
      // editor.fontLigatures true turns on liga and calt; Monaspace names its own sets.
      if (font.fontFeatures) for (const [, tag] of font.fontFeatures.matchAll(/'([a-z0-9]{4})'/g)) assert.ok(tags.has(tag), file.file + ' carries configured feature ' + tag);
      else if (font.ligatures.length) assert.ok(tags.has('calt') || tags.has('liga'), file.file + ' carries liga or calt');
    }
  }
  assert.deepEqual(fonts.find(font => font.id === 'ibmplexmono').ligatures, [], 'IBM Plex Mono has no coding ligatures');
  assert.match(fs.readFileSync(path.join(source, 'panel.css'), 'utf8'), /#preview \{[^}]*"calt" 1/, 'the preview draws ligatures too');
});
