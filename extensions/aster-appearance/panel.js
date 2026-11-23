'use strict';
const api=acquireVsCodeApi();
const $=id=>document.getElementById(id);
// The page is built once from the `init` message. Later `state` messages only
// patch it, so the scroll position, the focused card and pending edits stay.
// color.cjs is loaded before this file: AsterColor is the colour math the
// extension itself uses, so the previews show exactly the editor's colours.
let view=null, applied=null, fontBusy=false, tuneBusy=false, previewId=0, weight=400, outside=null;
const grids=new Map(), cardParts=new Map(), loadedPreviews=new Map();
const saved=api.getState()||{};
const remember=patch=>{Object.assign(saved,patch);api.setState(saved);};
const signed=value=>(value>0?'+':'')+value+'%';

// ---- Theme gallery: every theme is a card in its own colours, in two
// sections, dark and light, each from the darkest editor to the brightest.
// A click (or Enter on the focused card) applies the theme at once.
const SWATCH=['background','foreground','keyword','function','string','type','comment'];
function span(className,text){const item=document.createElement('span');item.className=className;item.textContent=text;return item;}
function line(...parts){const item=span('line','');item.append(...parts);return item;}
function paint(button,option){
  button.dataset.value=option.value;button.dataset.lightness=String(option.lightness??0);
  const parts=cardParts.get(button);parts.label.textContent=option.label;parts.tag.hidden=!option.builtin;
  for(const key of SWATCH)if(option.swatch?.[key])button.style.setProperty('--'+key,option.swatch[key]);
}
function card(option){
  const button=document.createElement('button');
  button.type='button';button.className='card';button.tabIndex=-1;button.setAttribute('aria-pressed','false');
  const sample=span('sample','');sample.setAttribute('aria-hidden','true');
  sample.append(line(span('k','const'),' ',span('f','greet'),' = ',span('t','User')),line(span('s','"hi"'),' ',span('c','// ok')));
  const label=span('label',''),tag=span('tag','IDE'),name=span('name','');
  name.append(label,tag,span('badge','сейчас'));
  button.append(sample,name);cardParts.set(button,{label,tag});paint(button,option);
  button.addEventListener('click',()=>chooseTheme(button.dataset.value));
  button.addEventListener('keydown',move);
  return button;
}
function buildGallery(){
  $('gallery').replaceChildren(...view.sections.map(({name})=>{
    const list=view.themes.filter(option=>option.section===name);
    const block=document.createElement('div');block.className='group';
    const heading=document.createElement('h3');heading.append(span('title',name),span('note',String(list.length)));
    const grid=document.createElement('div');grid.className='grid';grid.append(...list.map(card));
    grids.set(name,grid);block.append(heading,grid);return block;
  }));
  // A theme chosen outside the studio gets one more card, at its place by brightness.
  outside=card({label:'',value:'',swatch:{}});outside.hidden=true;
}
const shownCards=()=>[...grids.values()].flatMap(grid=>[...grid.children]).filter(item=>!item.hidden);
function placeOutside(){
  const option=applied.current;
  outside.hidden=!option;
  if(!option)return;
  paint(outside,option);
  const grid=grids.get(option.section),next=[...grid.children].find(item=>item!==outside&&Number(item.dataset.lightness)>option.lightness);
  grid.insertBefore(outside,next||null);
}
// Arrow keys only move the focus; nothing is applied until Enter or a click.
function move(event){
  const shown=shownCards(),index=shown.indexOf(event.currentTarget);
  const next={ArrowRight:index+1,ArrowDown:index+1,ArrowLeft:index-1,ArrowUp:index-1,Home:0,End:shown.length-1}[event.key];
  if(next===undefined||index<0)return;
  event.preventDefault();
  const target=shown[(next+shown.length)%shown.length];
  for(const item of shown)item.tabIndex=item===target?0:-1;
  target.focus();remember({focus:target.dataset.value});
}
// The clicked card is selected at once; the extension writes the newest click.
const selectedValue=()=>saved.pendingTheme||applied.theme;
const selectedTheme=()=>view.themes.find(option=>option.value===selectedValue())||applied.current;
function markThemes(){
  const shown=shownCards(),selected=selectedValue();
  const focusable=shown.find(item=>item.dataset.value===saved.focus)||shown.find(item=>item.dataset.value===selected)||shown[0];
  for(const item of shown){
    const on=item.dataset.value===selected;
    item.className='card'+(on?' applied':'')+(on&&saved.pendingTheme?' pending':'');
    item.setAttribute('aria-pressed',String(on));
    item.tabIndex=item===focusable?0:-1;
  }
}
function chooseTheme(value){
  if(!value||value===selectedValue())return;
  remember({pendingTheme:value,focus:value});markThemes();renderTune();
  say('Применяю тему…');
  api.postMessage({type:'apply-theme',value});
}

// ---- Code colours: the previews draw code in the selected theme, retuned
// live by the sliders; only their Apply button writes brightness and contrast.
const tunable=()=>selectedTheme()?.builtin===false;
const tuneValues=()=>({brightness:Number($('brightness').value),contrast:Number($('contrast').value)});
const tunePending=()=>['brightness','contrast'].some(key=>tuneValues()[key]!==applied[key]);
function paintCode(){
  const option=selectedTheme(),style=$('studio').style;
  if(!option?.code)return;
  const {brightness,contrast:shift}=tuneValues(),background=option.swatch.background;
  style.setProperty('--c-background',background);style.setProperty('--c-foreground',option.swatch.foreground);
  for(const [role,colour] of Object.entries(option.code))
    style.setProperty('--c-'+role,option.builtin?colour:AsterColor.codeInk(colour,background,brightness,shift,role==='comment'));
}
function renderTune(){
  const can=tunable();
  $('brightness').disabled=$('contrast').disabled=tuneBusy||!can;
  $('brightnessValue').textContent=signed(tuneValues().brightness);$('contrastValue').textContent=signed(tuneValues().contrast);
  $('applyTune').disabled=tuneBusy||!can||!tunePending();$('cancelTune').disabled=tuneBusy||!tunePending();
  $('tuneHint').textContent=!can?'Яркость и контраст меняют только темы Aster.'
    :tunePending()?'Пример уже показывает новые цвета. В редакторе они появятся после «Применить яркость и контраст».':'';
  paintCode();
}
function restoreTune(){$('brightness').value=applied.brightness;$('contrast').value=applied.contrast;}

// ---- Fonts: family, size, weight and style are previewed here and applied
// together with «Применить шрифт». A style never changes the weight; the
// weight steps through the weights the selected font really has.
const WEIGHT_NAMES={100:'тонкий',200:'очень светлый',300:'светлый',400:'обычный',500:'средний',600:'полужирный',700:'жирный',800:'очень жирный',900:'чёрный'};
const selectedFont=()=>view.fonts.find(font=>font.id===$('font').value);
const weights=()=>selectedFont()?.weights||view.anyWeights;
const fontValues=()=>({font:$('font').value,size:Number($('size').value),weight,style:$('style').value,uiFont:$('uiFont').checked});
const fontPending=()=>['font','size','weight','style','uiFont'].some(key=>fontValues()[key]!==applied[key]);
function stepWeight(direction){
  const list=direction>0?weights():[...weights()].reverse(),next=list.find(value=>direction>0?value>weight:value<weight);
  if(next!==undefined){weight=next;preview();}
}
function renderFont(){
  const values=fontValues(),list=weights();
  $('weightValue').textContent=weight+(WEIGHT_NAMES[weight]?' · '+WEIGHT_NAMES[weight]:'');
  $('weightDown').disabled=fontBusy||!list.some(value=>value<weight);$('weightUp').disabled=fontBusy||!list.some(value=>value>weight);
  $('applyFont').disabled=fontBusy||!fontPending()||!Number.isInteger(values.size)||values.size<8||values.size>40;
  $('cancelFont').disabled=fontBusy||!fontPending();
}
// The current family is listed by its own name when it is not one of the
// bundled fonts (a font removed from Aster stays installed and keeps working).
function fillFonts(){
  const label=applied.font?'':(applied.familyName||'Шрифт редактора')+' — текущий';
  const first=$('font').options[0];
  if(first&&(first.value==='')===!applied.font&&(applied.font||first.text===label))return;
  const value=$('font').value;
  $('font').replaceChildren(...(applied.font?[]:[new Option(label,'')]),
    ...view.fonts.map(font=>new Option(font.family+(font.ligatures.length?'':' — без лигатур'),font.id)));
  $('font').value=value;
}
function restoreFont(){
  $('font').value=applied.font;weight=applied.weight;
  $('size').value=applied.size;$('style').value=applied.style;$('uiFont').checked=applied.uiFont;
}
function fontNote(font){
  if(!font)return applied.familyName?'«'+applied.familyName+'» не входит в Aster Atelier, но остаётся в системе и работает. Размер, толщину и начертание можно менять.':'';
  const range=font.weights.length>1?font.weights[0]+'–'+font.weights.at(-1):String(font.weights[0]);
  return (font.ligatures.length?'Лигатуры: '+font.ligatures.join(' ')+'.':'Без лигатур кода: => и === рисуются отдельными знаками.')
    +' Толщина: '+range+'.'+(font.cyrillic?'':' Кириллицы нет: русский текст рисуется запасным шрифтом.');
}
async function localFont(family,names=[]){
  const face=new FontFace('AsterLocalProbe',[family,...names].map(name=>`local(${JSON.stringify(name)})`).join(','));
  try{await face.load();return true;}catch{return false;}
}
// The bundled files load into the preview, so it shows the font and its
// ligatures before the font is installed.
async function previewFamily(font,id){
  if(applied.availability[font.id]===true&&await localFont(font.family,font.localNames))return font.family;
  const family='AsterPreview-'+font.id;
  if(!loadedPreviews.has(font.id))loadedPreviews.set(font.id,Promise.all(font.preview.map(async file=>{
    const face=new FontFace(family,`url(${JSON.stringify(file.uri)})`,{style:file.italic?'italic':'normal',weight:file.weight[0]===file.weight[1]?String(file.weight[0]):file.weight.join(' ')});
    await face.load();document.fonts.add(face);
  })));
  try{await loadedPreviews.get(font.id);return family;}
  catch(error){loadedPreviews.delete(font.id);if(id===previewId)$('availability').textContent='Предпросмотр не загрузился: '+error.message;return null;}
}
async function preview(){
  const id=++previewId,font=selectedFont(),style=view.styles.find(item=>item.value===$('style').value);
  Object.assign($('preview').style,{fontSize:$('size').value+'px',fontWeight:String(weight),fontStyle:style?.italic?'italic':'normal',fontFeatureSettings:font?.fontFeatures||'"liga" 1, "calt" 1'});
  $('preview').dataset.style=style?.role||'';
  renderFont();
  $('fontNote').textContent=fontNote(font);
  if(!font){$('preview').style.fontFamily=applied.family||'monospace';$('availability').textContent='';return;}
  $('availability').textContent=applied.detectionError?'Не удалось проверить шрифты системы: '+applied.detectionError
    :applied.detecting?'Проверяю шрифты системы…'
    :applied.availability[font.id]===true?'Установлен в системе.':'Входит в расширение и будет установлен при нажатии «Применить шрифт».';
  const family=await previewFamily(font,id);
  if(family&&id===previewId)$('preview').style.fontFamily=JSON.stringify(family)+', monospace';
}

// ---- State from the extension
function normalise(data){
  return {theme:data.theme,current:data.current||null,family:data.family,familyName:data.familyName||'',font:data.fontId||'',size:data.size,
    weight:data.weight==='bold'?700:parseInt(data.weight,10)||400,style:view.styles.some(item=>item.value===data.style)?data.style:'normal',
    brightness:data.brightness,contrast:data.contrast,uiFont:data.uiFont===true,availability:data.availability||{},detecting:data.detecting===true,detectionError:data.detectionError};
}
// A control still showing the old applied value follows the new one; an edit
// the user has not applied yet stays.
function applyState(data){
  const tuneEdited=applied&&tunePending(),fontEdited=applied&&fontPending();
  applied=normalise(data);
  if(saved.pendingTheme===applied.theme)remember({pendingTheme:null});
  fillFonts();
  if(!tuneEdited)restoreTune();
  if(!fontEdited||![...$('font').options].some(option=>option.value===fontValues().font))restoreFont();
  placeOutside();markThemes();renderTune();
  if(data.profileScope&&data.profileScope.status!=='application-scoped'&&!$('message').textContent)say(data.profileScope.reason||'');
  return preview();
}
function say(text,error){
  $('message').textContent=text;$('message').className=error?'error':'';
  // Marks the page busy while a change is being written (the live IDE test waits on it).
  if(document.body)document.body.dataset.busy=fontBusy||tuneBusy||saved.pendingTheme?'1':'';
}
function result(data){
  if(data.action==='apply-theme'&&(data.value===undefined||data.value===saved.pendingTheme))remember({pendingTheme:null});
  if(data.action==='apply-tune')tuneBusy=false;
  if(data.action==='apply-font')fontBusy=false;
  if(data.error){if(data.action==='apply-tune')restoreTune();if(data.action==='apply-font')restoreFont();}
  say(data.error||data.message,Boolean(data.error));
  markThemes();renderTune();return preview();
}
window.addEventListener('message',async({data})=>{
  if(data.type==='probe'){api.postMessage({type:'probe-result',id:data.id,loaded:await localFont(data.family,data.localNames)});return;}
  if(data.type==='init'){
    view=data;remember({pendingTheme:null});buildGallery();await applyState(data.state);
    if(saved.scrollY&&window.scrollY===0)window.scrollTo(0,saved.scrollY);return;
  }
  if(!view)return;
  if(data.type==='state')await applyState(data);
  else if(data.type==='result'&&data.action)await result(data);
  else if(data.type==='result')say(data.error||data.message,Boolean(data.error));
});
let scrollTimer;
window.addEventListener('scroll',()=>{clearTimeout(scrollTimer);scrollTimer=setTimeout(()=>remember({scrollY:window.scrollY}),100);});
for(const key of ['brightness','contrast'])$(key).addEventListener('input',renderTune);
$('applyTune').addEventListener('click',()=>{if(tuneBusy||!tunePending())return;tuneBusy=true;renderTune();say('Применяю яркость и контраст…');api.postMessage({type:'apply-tune',...tuneValues()});});
$('cancelTune').addEventListener('click',()=>{restoreTune();renderTune();});
$('uiFont').addEventListener('change',renderFont);
// A new family keeps the weight when it has it, otherwise takes its nearest.
$('font').addEventListener('change',()=>{weight=weights().reduce((best,value)=>Math.abs(value-weight)<Math.abs(best-weight)?value:best);preview();});
$('style').addEventListener('input',preview);
$('weightDown').addEventListener('click',()=>stepWeight(-1));
$('weightUp').addEventListener('click',()=>stepWeight(1));
$('size').addEventListener('input',preview);
$('applyFont').addEventListener('click',()=>{if(fontBusy)return;fontBusy=true;renderFont();say('Применяю шрифт…');api.postMessage({type:'apply-font',...fontValues()});});
$('cancelFont').addEventListener('click',()=>{restoreFont();preview();});
api.postMessage({type:'ready'});
