'use strict';
const crypto = require('node:crypto');
const path = require('node:path');
const uiStyle = require('./ui-style.cjs');
const { SECTIONS } = require('./swatches.cjs');
const { FONT_STYLES, ANY_WEIGHTS, fontWeights, snapshot, updateGlobal, validate } = require('./appearance.cjs');

// The previews colour code by role (the classes match the page's --c-* colours)
// and show the coding ligatures; keywords, the comment and the declared name
// are marked so each role style shows.
const tag = (role, text) => `<span class="${role}">${text}</span>`;
const kw = word => tag('kw', word), op = text => tag('op', text), num = text => tag('num', text);
const PREVIEW = `${tag('cm', '// Счётчик: === !== =&gt; &lt;= &gt;= -&gt; != &amp;&amp; ||')}
${kw('import')} { ${tag('call', 'useState')} } ${kw('from')} ${tag('str', "'react'")};

${kw('export')} ${kw('function')} ${tag('fn', 'Counter')}({ ${tag('par', 'label')} }: { ${tag('prop', 'label')}: ${tag('ty', 'string')} }) {
  ${kw('const')} [${tag('var', 'count')}, ${tag('var', 'setCount')}] ${op('=')} ${tag('call', 'useState')}(${num('42')});
  ${kw('const')} ${tag('var', 'ready')} ${op('=')} ${tag('var', 'count')} ${op('!==')} ${num('0')} ${op('&amp;&amp;')} ${tag('var', 'count')} ${op('&lt;=')} ${num('99')} ${op('||')} ${tag('par', 'label')} ${op('===')} ${tag('str', "''")};
  ${kw('return')} &lt;${tag('tag', 'button')} ${tag('attr', 'onClick')}={() ${op('=&gt;')} ${tag('call', 'setCount')}(${tag('var', 'count')} ${op('+')} ${num('1')})}&gt;
    {${tag('par', 'label')}}: {${tag('var', 'count')}} — 0O 1lI -&gt; =&gt; &gt;= !=
  &lt;/${tag('tag', 'button')}&gt;;
}`;
const TUNE_PREVIEW = `${tag('cm', '// Цвета кода выбранной темы')}
${kw('const')} ${tag('var', 'total')} ${op('=')} ${tag('var', 'items')}.${tag('call', 'map')}((${tag('par', 'item')}) ${op('=&gt;')} ${tag('par', 'item')}.${tag('prop', 'price')} ${op('*')} ${num('2')});
${kw('function')} ${tag('fn', 'greet')}(${tag('par', 'name')}: ${tag('ty', 'string')}) { ${kw('return')} ${tag('str', '`Привет, ${name}`')}; }
&lt;${tag('tag', 'Button')} ${tag('attr', 'size')}=${tag('str', '"lg"')} /&gt;`;

// The primary family of a font list, and the bundled font it names (by any of
// the names its files carry, ignoring case, quotes, spaces and dashes).
const primary = family => String(family || '').split(',')[0].trim().replace(/^(['"])(.*)\1$/, '$2');
const nameKey = name => String(name).toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
const fontNames = font => new Set([font.family, ...font.localNames, ...font.files.flatMap(file => file.families || [])].map(nameKey));
const ERRORS = { 'apply-theme': 'Тема не применена', 'apply-tune': 'Яркость и контраст не применены', 'apply-font': 'Шрифт не применён' };

// The studio is one webview. Its page is written once; afterwards the
// extension only posts state, so a click never reloads the page, its scroll
// position or its focus.
function createStudio(host) {
  const { vscode, context, enqueue, read, fonts, service } = host;
  const root = context.extensionPath, storage = () => context.globalStorageUri.fsPath;
  const names = new Map(fonts.map(font => [font.id, fontNames(font)]));
  let panel, disposables = [], detection, detected, lastState, wantedTheme;
  const probes = new Map();
  const post = message => panel ? Promise.resolve(panel.webview.postMessage(message)).catch(() => false) : Promise.resolve(false);
  const warn = error => console.warn('Aster Atelier studio: ' + error.message);

  // The OS font list is read once per opened studio; fonts Aster installed are
  // recorded. The page never waits for the list: it opens at once and the font
  // availability follows in a state message.
  function detect() {
    detection ||= service.installed(fonts).then(found => ({ found }), error => ({ found: {}, error: error.message })).then(result => detected = result);
    return detection;
  }
  function fontState() {
    if (!detected) return { availability: {}, detecting: true };
    const recorded = new Set(service.recorded(storage(), fonts));
    return { availability: Object.fromEntries(fonts.map(font => [font.id, detected.found[font.id] === true || recorded.has(font.id)])), detectionError: detected.error };
  }
  // One read of the settings per state.
  function state() {
    const get = snapshot(vscode).get, theme = host.currentTheme(get), family = get('editor.fontFamily'), familyName = primary(family);
    const font = fonts.find(item => names.get(item.id).has(nameKey(familyName)));
    const { brightness, contrast } = host.themes.tuning({ brightness: get('asterAppearance.brightness'), contrast: get('asterAppearance.contrast') });
    return { ...fontState(), theme, current: !theme || host.gallery().some(option => option.value === theme) ? null : host.outsideCard(theme),
      family, familyName, fontId: font?.id || '', size: get('editor.fontSize'), weight: get('editor.fontWeight'), style: get('asterAppearance.fontStyle'),
      brightness, contrast, uiFont: get('asterAppearance.uiFont') === true, profileScope: context.globalState.get('applicationScopeVerification') };
  }
  const fontList = () => fonts.map(font => ({ id: font.id, family: font.family, localNames: font.localNames, fontFeatures: font.fontFeatures,
    ligatures: font.ligatures, cyrillic: font.cyrillic, weights: fontWeights(font), preview: font.files.filter(file => file.file.endsWith('.ttf'))
      .map(file => ({ uri: panel.webview.asWebviewUri(vscode.Uri.file(path.join(root, file.file))).toString(), italic: file.italic, weight: file.weight })) }));
  async function init() {
    if (!panel) return;
    const current = state();
    lastState = JSON.stringify(current);
    await post({ type: 'init', themes: host.gallery(), sections: SECTIONS, fonts: fontList(), styles: FONT_STYLES, anyWeights: ANY_WEIGHTS, state: current });
    if (!detected) detect().then(() => enqueue(update)).catch(warn);
  }
  // Only a state that differs from the one the page has is posted.
  async function update() {
    if (!panel) return;
    const next = state(), text = JSON.stringify(next);
    if (text === lastState) return;
    lastState = text;
    await post({ type: 'state', ...next });
  }

  // The page checks that the system really draws the family; a hidden or
  // closed page answers nothing, so the check gives up at once or after 4 s.
  function probe(font) {
    const id = crypto.randomUUID();
    return new Promise(resolve => {
      const timer = setTimeout(() => { probes.delete(id); resolve(false); }, 4000);
      probes.set(id, { resolve: value => { clearTimeout(timer); resolve(value); } });
      void post({ type: 'probe', id, family: font.family, localNames: font.localNames }).then(sent => sent || probes.get(id)?.resolve(false));
    });
  }
  async function applyFont(message) {
    const changes = { ...validate({ key: 'size', value: message.size }, fonts), ...validate({ key: 'style', value: message.style }, fonts),
      ...validate({ key: 'uiFont', value: message.uiFont }, fonts) };
    let note = 'Шрифт применён.', font;
    if (message.font) {
      font = validate({ key: 'font', value: message.font }, fonts);
      if (!fontWeights(font).includes(message.weight)) throw new Error('толщина ' + message.weight + ' недоступна для ' + font.family + ' (есть ' + fontWeights(font).join(', ') + ').');
      await detect();
      if (!fontState().availability[font.id]) {
        await post({ type: 'result', message: 'Устанавливаю ' + font.family + ' из расширения…' });
        // The install is recorded, so the font counts as available from now on.
        await service.install(root, font, storage());
      }
      if (!await probe(font)) note = 'Сохранено. ' + font.family + ' установлен, но редактор увидит его после полного перезапуска IDE.';
    } else validate({ key: 'weight', value: message.weight }, fonts);
    const settings = snapshot(vscode);
    Object.assign(changes, font ? host.fontChanges(font, message.weight) : { 'editor.fontWeight': String(message.weight), 'terminal.integrated.fontWeight': message.weight },
      host.styleChanges(message.style, settings));
    await updateGlobal(vscode, changes, settings);
    const ui = host.writeUiStyle();
    if (ui.error || ui.skipped) note += ' Шрифт интерфейса не записан: ' + (ui.error || ui.skipped);
    else if (message.uiFont) note += uiStyle.addonReady(vscode.env.appRoot) ? ' Весь интерфейс сменит шрифт через секунду.' : ' Шрифт интерфейса включится после перезапуска IDE.';
    return { message: note };
  }
  // A workspace or language value still wins over the saved global one.
  function overrides() {
    const scopes = vscode.window.visibleTextEditors.map(editor => ({ uri: editor.document.uri, languageId: editor.document.languageId }));
    const keys = ['editor.fontSize', 'editor.fontWeight', 'editor.fontFamily']
      .filter(key => scopes.some(scope => JSON.stringify(vscode.workspace.getConfiguration(undefined, scope).get(key)) !== JSON.stringify(read(key))));
    return keys.length ? ' Настройка проекта или языка перекрывает: ' + keys.join(', ') + '.' : '';
  }
  function run(type, action) {
    return enqueue(async () => {
      const outcome = await action();
      await update();
      await post({ type: 'result', action: type, ...outcome, message: outcome.message + overrides() });
    }).catch(error => post({ type: 'result', action: type, value: error.value, error: ERRORS[type] + ': ' + error.message }));
  }
  // Clicks on theme cards coalesce: while one theme is being written, a newer
  // click only replaces the theme that comes next, so a run of quick clicks
  // writes the first and the last theme, never a queue of stale ones.
  function applyTheme(value) {
    const running = wantedTheme !== undefined;
    wantedTheme = value;
    if (running) return;
    void run('apply-theme', async () => {
      try {
        for (;;) {
          const next = wantedTheme;
          try { await host.applyTheme(next); } catch (error) { if (wantedTheme === next) throw Object.assign(error, { value: next }); }
          if (wantedTheme === next) return { message: 'Тема применена.', value: next };
        }
      } finally { wantedTheme = undefined; }
    });
  }
  function receive(message) {
    if (message?.type === 'probe-result' && typeof message.id === 'string') {
      const request = probes.get(message.id);
      if (request) { probes.delete(message.id); request.resolve(message.loaded === true); }
      return;
    }
    if (message?.type === 'ready') enqueue(init).catch(warn);
    else if (message?.type === 'apply-theme') applyTheme(message.value);
    else if (message?.type === 'apply-tune') void run('apply-tune', async () => {
      await host.applyTune({ brightness: message.brightness, contrast: message.contrast });
      return { message: 'Яркость и контраст применены.' };
    });
    else if (message?.type === 'apply-font') void run('apply-font', () => applyFont(message));
  }

  function closed() {
    for (const item of disposables) item?.dispose?.();
    for (const request of probes.values()) request.resolve(false);
    disposables = []; probes.clear(); panel = undefined; detection = detected = lastState = undefined;
  }
  // A hidden studio is rebuilt by the IDE when shown again; the page then asks
  // for its state and restores its own scroll position.
  function open() {
    if (panel) { panel.reveal(); return; }
    panel = vscode.window.createWebviewPanel('asterAtelier', 'Aster Atelier', vscode.ViewColumn.One, { enableScripts: true, localResourceRoots: [vscode.Uri.file(root)] });
    disposables = [panel.webview.onDidReceiveMessage(receive), panel.onDidDispose(closed)];
    panel.webview.html = page(vscode, panel.webview, root);
  }
  return { open, update, dispose() { panel?.dispose?.(); } };
}

function page(vscode, webview, root) {
  const nonce = crypto.randomBytes(24).toString('hex');
  const uri = name => webview.asWebviewUri(vscode.Uri.file(path.join(root, name))).toString();
  return `<!doctype html><html lang="ru"><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource}; style-src ${webview.cspSource} 'unsafe-inline'; font-src ${webview.cspSource}; script-src 'nonce-${nonce}';"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="${uri('panel.css')}"><title>Aster Atelier</title></head><body><main id="studio">
<header><img src="${uri('icon.png')}" width="44" height="44" alt=""><div><h1>Aster Atelier</h1><p>Темы и шрифты для Antigravity</p></div></header>
<section><h2>Тема</h2>
<div id="gallery" role="group" aria-label="Темы"></div>
<h3 class="tune-title">Цвета кода темы Aster</h3>
<div class="controls tune"><label>Яркость цветов кода <output id="brightnessValue"></output><input id="brightness" type="range" min="-30" max="30" step="5"></label><label>Контраст кода <output id="contrastValue"></output><input id="contrast" type="range" min="-20" max="30" step="5"></label></div>
<pre id="tunePreview" class="code" aria-label="Пример кода в выбранной теме">${TUNE_PREVIEW}</pre>
<p id="tuneHint" class="hint" role="status"></p><div class="actions"><button id="applyTune" type="button" disabled>Применить яркость и контраст</button><button id="cancelTune" class="secondary" type="button" disabled>Отмена</button></div></section>
<section><h2>Шрифт</h2><select id="font" aria-label="Шрифт"></select><p id="fontNote" class="hint"></p><p id="availability" class="hint" role="status"></p>
<div class="controls"><label>Размер<input id="size" type="number" min="8" max="40" step="1"></label><div class="field"><span id="weightLabel" class="label">Толщина</span><div class="stepper" role="group" aria-labelledby="weightLabel"><button id="weightDown" class="secondary" type="button" aria-label="Тоньше">−</button><output id="weightValue" aria-live="polite"></output><button id="weightUp" class="secondary" type="button" aria-label="Толще">+</button></div></div><label>Начертание<select id="style">${FONT_STYLES.map(style => `<option value="${style.value}">${style.label}</option>`).join('')}</select></label></div>
<pre id="preview" class="code" tabindex="0">${PREVIEW}</pre>
<label class="check"><input id="uiFont" type="checkbox"> Этот шрифт — для всего интерфейса Antigravity (меню, панели, вкладки)</label>
<div class="actions"><button id="applyFont" type="button" disabled>Применить шрифт</button><button id="cancelFont" class="secondary" type="button" disabled>Отмена</button></div></section>
<p id="message" role="status" aria-live="polite"></p></main><script nonce="${nonce}" src="${uri('color.cjs')}"></script><script nonce="${nonce}" src="${uri('panel.js')}"></script></body></html>`;
}

module.exports = { createStudio, primary, nameKey };
