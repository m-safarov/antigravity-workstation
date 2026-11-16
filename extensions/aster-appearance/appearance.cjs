'use strict';
const STYLE_RULE = 'Aster Atelier · editor style';
// A style never changes the font weight: the weight has its own control.
// Role styles pick out parts of the code.
const FONT_STYLES = [
  {value:'normal',label:'Обычный',italic:false}, {value:'italic',label:'Курсив',italic:true},
  {value:'comments',label:'Курсивные комментарии',italic:false,role:'comments'},
  {value:'keywords',label:'Курсивные ключевые слова',italic:false,role:'keywords'},
  {value:'accent',label:'Курсив: комментарии и ключевые слова',italic:false,role:'accent'},
  {value:'bold-keywords',label:'Жирные ключевые слова',italic:false,role:'bold-keywords'},
  {value:'bold-names',label:'Жирные объявления',italic:false,role:'bold-names'},
];
// Weight presets of Aster 1.5-1.7 become a plain style and that weight.
const LEGACY_STYLES = {light:['normal',300],medium:['normal',500],semibold:['normal',600],bold:['normal',700],'bold-italic':['italic',700]};
const SHARED = ['workbench.colorTheme','asterAppearance.theme','editor.fontFamily','editor.fontSize','editor.fontWeight','asterAppearance.fontStyle',
  'asterAppearance.brightness','asterAppearance.contrast','asterAppearance.uiFont'];
// Every font surface the host registers, so a selected font reaches the whole
// IDE. The installer also treats these as personal choices. The legacy
// notebook.outputFontFamily string exists in host code but is not registered.
const FONT_FAMILY_KEYS = ['editor.fontFamily','terminal.integrated.fontFamily','debug.console.fontFamily',
  'chat.editor.fontFamily','chat.fontFamily','editor.inlayHints.fontFamily','editor.inlineSuggest.fontFamily',
  'notebook.output.fontFamily','notebook.markup.fontFamily','scm.inputFontFamily'];
// Italic is applied as one owned TextMate rule plus the semantic wildcard's
// italic flag; normal removes exactly those, leaving every other rule alone.
// The chosen style holds in every theme. Some themes set their own: Quiet Light
// draws functions and types bold and comments italic, Solarized Dark draws
// const/let/function bold. The rule names those scopes too, so at equal
// specificity it wins over the theme. Italic follows the user's own rules;
// the upright rule comes first, so the user's own font styles still win.
const STYLE_SCOPES = ['source','text','comment','string','keyword','storage','constant','entity','support','variable','punctuation','meta',
  'punctuation.definition.comment','comment.block.preprocessor','storage.type','storage.modifier','entity.name.function','support.function',
  'entity.name.type','entity.name.class','entity.name.namespace','entity.name.scope-resolution','entity.other.inherited-class','support.class',
  'support.type','entity.other.attribute-name','entity.other.attribute-name.html','meta.tag entity.other.attribute-name','keyword.other.important'];
// Role styles (Aster 1.7.0): italic comments, italic keywords, both, bold
// keywords or bold declarations. Each puts the upright rule first (so a
// theme's own italic or bold is gone) and its owned rule last. Operators such
// as => === && stay upright and regular.
const COMMENT_SCOPES = ['comment','punctuation.definition.comment','comment.block.documentation','comment.line.double-slash'];
const KEYWORD_SCOPES = ['keyword.control','keyword.other','keyword.operator.new','keyword.operator.expression','keyword.operator.typeof',
  'keyword.operator.instanceof','keyword.operator.wordlike','storage.type','storage.modifier','variable.language','keyword.control.import',
  'keyword.control.export','keyword.control.from','keyword.control.flow','keyword.control.conditional','keyword.control.loop'];
const KEYWORD_UPRIGHT = ['storage.type.function.arrow','keyword.operator','keyword.other.unit','keyword.operator.assignment','keyword.operator.comparison',
  'keyword.operator.logical','keyword.operator.relational','keyword.operator.arithmetic','keyword.operator.ternary','keyword.operator.spread'];
const NAME_SCOPES = ['meta.definition.function entity.name.function','meta.definition.method entity.name.function',
  'meta.method.declaration entity.name.function','meta.definition.variable entity.name.function','meta.function.python entity.name.function',
  'entity.name.type.class','entity.name.class','entity.name.type.interface','entity.name.type.alias','entity.name.type.enum','entity.name.type.module'];
const NAME_SEMANTIC = ['function.declaration','method.declaration','class.declaration','interface.declaration','type.declaration','enum.declaration'];
function roleRules(role) {
  const rule = (scope, fontStyle) => ({name:STYLE_RULE,scope,settings:{fontStyle}});
  if (role === 'comments') return [rule(COMMENT_SCOPES,'italic')];
  if (role === 'keywords') return [rule(KEYWORD_SCOPES,'italic'),rule(KEYWORD_UPRIGHT,'')];
  if (role === 'accent') return [rule([...COMMENT_SCOPES,...KEYWORD_SCOPES],'italic'),rule(KEYWORD_UPRIGHT,'')];
  if (role === 'bold-keywords') return [rule(KEYWORD_SCOPES,'bold'),rule(KEYWORD_UPRIGHT,'')];
  if (role === 'bold-names') return [rule(NAME_SCOPES,'bold')];
  return [];
}
// `style` is a FONT_STYLES value or, as before, true/false for italic/normal.
// `previous` is the style recorded before this change: the bold flags on the
// declaration selectors are removed only when Aster set them.
function styleSettings(current, style, previous) {
  const entry = typeof style === 'boolean' ? {italic:style} : FONT_STYLES.find(item => item.value === style);
  if (!entry) throw new Error('Неизвестное начертание: ' + style);
  const italic = entry.italic === true, role = entry.role;
  const text = structuredClone(current.text || {}), semantic = structuredClone(current.semantic || {});
  text.textMateRules = (text.textMateRules || []).filter(rule=>rule.name !== STYLE_RULE);
  if (italic) text.textMateRules.push({name:STYLE_RULE,scope:STYLE_SCOPES,settings:{fontStyle:'italic'}});
  else {
    text.textMateRules.unshift({name:STYLE_RULE,scope:STYLE_SCOPES,settings:{fontStyle:''}});
    text.textMateRules.push(...roleRules(role));
  }
  const rules = {...semantic.rules}, wildcard = rules['*'];
  const style2 = typeof wildcard==='string' ? {foreground:wildcard} : {...wildcard};
  if (italic) style2.italic = true; else delete style2.italic;
  if (Object.keys(style2).length) rules['*'] = typeof wildcard==='string' && Object.keys(style2).length===1 ? wildcard : style2; else delete rules['*'];
  if (role === 'bold-names' || previous === 'bold-names') for (const selector of NAME_SEMANTIC) {
    const value = rules[selector], item = typeof value==='string' ? {foreground:value} : {...value};
    if (role === 'bold-names') item.bold = true; else delete item.bold;
    if (!Object.keys(item).length) delete rules[selector];
    else rules[selector] = Object.keys(item).length===1 && typeof item.foreground==='string' ? item.foreground : item;
  }
  if (Object.keys(rules).length) semantic.rules = rules; else delete semantic.rules;
  return {text,semantic};
}
// One read of the settings for a whole change: every key is inspected once.
function snapshot(vscode) {
  const config = vscode.workspace.getConfiguration(undefined,null), inspected = new Map();
  const global = key => { if (!inspected.has(key)) inspected.set(key,config.inspect(key)?.globalValue); return structuredClone(inspected.get(key)); };
  return {get:key=>config.get(key),global};
}
// An unset object setting and an empty one mean the same: nothing is written.
const empty = value => value===undefined || (value && typeof value==='object' && !Array.isArray(value) && !Object.keys(value).length);
const same = (a,b) => JSON.stringify(a)===JSON.stringify(b) || (empty(a) && empty(b));
// Writes only the keys that change, in the given order, and returns how many
// were written. A setting edited elsewhere while an earlier write awaited is
// never overwritten: the writes made so far are rolled back instead.
async function updateGlobal(vscode, changes, read = snapshot(vscode)) {
  const target = vscode.ConfigurationTarget.Global, fresh = key => vscode.workspace.getConfiguration(undefined,null).inspect(key)?.globalValue;
  const pending = Object.entries(changes).map(([key,value])=>({key,value,before:read.global(key)})).filter(item=>!same(item.before,item.value));
  const applied = [];
  try {
    for (const item of pending) {
      if (applied.length && typeof item.value==='object') {
        const now = fresh(item.key);
        if (same(now,item.value)) continue;
        if (!same(now,item.before)) throw new Error('Настройка '+item.key+' изменилась во время применения');
      }
      await vscode.workspace.getConfiguration(undefined,null).update(item.key,item.value,target);
      applied.push(item);
    }
  } catch (error) {
    const failures = [];
    for (const item of applied.reverse()) {
      if (!same(fresh(item.key),item.value)) { failures.push(item.key+' изменена одновременно'); continue; }
      try { await vscode.workspace.getConfiguration(undefined,null).update(item.key,item.before,target); } catch (rollback) { failures.push(rollback.message); }
    }
    throw new Error(error.message+(failures.length?'; откат не завершён: '+failures.join('; '):'; прежние настройки восстановлены'));
  }
  return applied.length;
}
// The weights a bundled font draws: its lightest to its boldest, in its step.
const fontWeights = font => Array.from({length:Math.floor((font.maxWeight-font.minWeight)/font.weightStep)+1},(_,index)=>font.minWeight+index*font.weightStep);
const ANY_WEIGHTS = fontWeights({minWeight:100,maxWeight:900,weightStep:100});
function validate(change, fonts) {
  if (!change || typeof change!=='object') throw new Error('Недопустимая настройка.');
  if (change.key==='size' && Number.isInteger(change.value) && change.value>=8 && change.value<=40) return {'editor.fontSize':change.value};
  if (change.key==='weight' && ANY_WEIGHTS.includes(change.value)) return {'editor.fontWeight':String(change.value)};
  if (change.key==='style' && FONT_STYLES.some(style=>style.value===change.value)) return {'asterAppearance.fontStyle':change.value};
  if (change.key==='font' && fonts.some(font=>font.id===change.value)) return fonts.find(font=>font.id===change.value);
  if (change.key==='brightness' && Number.isInteger(change.value) && change.value>=-30 && change.value<=30) return {'asterAppearance.brightness':change.value};
  if (change.key==='contrast' && Number.isInteger(change.value) && change.value>=-20 && change.value<=30) return {'asterAppearance.contrast':change.value};
  if (change.key==='uiFont' && typeof change.value==='boolean') return {'asterAppearance.uiFont':change.value};
  throw new Error('Недопустимое значение настройки'+(typeof change.key==='string'?' «'+change.key+'»':'')+'.');
}
module.exports = {STYLE_RULE,STYLE_SCOPES,NAME_SEMANTIC,FONT_STYLES,LEGACY_STYLES,SHARED,FONT_FAMILY_KEYS,ANY_WEIGHTS,styleSettings,snapshot,updateGlobal,fontWeights,validate};
