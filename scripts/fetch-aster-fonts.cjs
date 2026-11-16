'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const {execFileSync} = require('node:child_process');
const root = path.resolve(__dirname,'../extensions/aster-appearance');
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
// Coding ligatures measured in every font file with its editor features.
const LIGATURES = ['===','!==','=>','<=','>=','->','!=','&&','||'];
const monaspaceFeatures = "'calt', 'liga', 'ss01', 'ss02', 'ss03', 'ss04', 'ss05', 'ss06', 'ss07', 'ss08', 'ss09', 'ss10'";

// Every file comes from an immutable upstream: a pinned commit of google/fonts
// or of the font's own repository, or the font's official release package
// (a file inside its ZIP). Each source lists the font files and the licence,
// which is bundled as OFL.txt.
const GOOGLE = 'e7db6ca603fd4862010383ff17ffd6cc4ffac1c0';
const raw = (repo, ref, file) => `https://raw.githubusercontent.com/${repo}/${ref}/${file.split('/').map(encodeURIComponent).join('/')}`;
const google = (id, ...fonts) => ({revision:GOOGLE, source:`https://github.com/google/fonts/tree/${GOOGLE}/ofl/${id}`,
  files:[...fonts,'OFL.txt','METADATA.pb'].map(name=>({name, url:raw('google/fonts',GOOGLE,`ofl/${id}/${name}`)}))});
const repository = (repo, ref, folder, fonts, license) => ({revision:ref, source:`https://github.com/${repo}/tree/${ref}/${folder.split('/').map(encodeURIComponent).join('/')}`,
  files:[...fonts.map(name=>({name, url:raw(repo,ref,folder+'/'+name)})), {name:'OFL.txt', url:raw(repo,ref,license)}]});
const release = (repo, tag, asset, folder, fonts, license) => {
  const url = `https://github.com/${repo}/releases/download/${encodeURIComponent(tag)}/${asset}`;
  return {revision:tag, source:`https://github.com/${repo}/releases/tag/${encodeURIComponent(tag)}`,
    files:[...fonts.map(name=>({name, url, member:folder+name})), license.startsWith('https:') ? {name:'OFL.txt', url:license} : {name:'OFL.txt', url, member:license}]};
};
const italicPairs = (prefix, styles, suffix = '.ttf') => styles.flatMap(style => [`${prefix}-${style}${suffix}`, `${prefix}-${style === 'Regular' ? 'Italic' : style + 'Italic'}${suffix}`]);

// id, actual family, lightest and boldest weight with the step between the
// bundled weights, the coding ligatures the family does not draw, source and
// explicit OpenType features. Variable fonts are preferred: two files carry
// every weight. Iosevka has only static files of about 8.5 MB each, so it ships
// Regular and Italic (bold is drawn by the renderer); Rec Mono ships its static
// Regular and Bold with italics; IBM Plex Mono ships static 300-700 and has no
// coding ligatures.
const FAMILIES = [
  ['jetbrainsmono','JetBrains Mono',[100,800,100],[],google('jetbrainsmono','JetBrainsMono-Italic[wght].ttf','JetBrainsMono[wght].ttf')],
  ['firacode','Fira Code',[300,700,100],[],google('firacode','FiraCode[wght].ttf')],
  ['cascadiacode','Cascadia Code',[200,700,100],[],google('cascadiacode','CascadiaCode-Italic[wght].ttf','CascadiaCode[wght].ttf')],
  ['victormono','Victor Mono',[100,700,100],['||'],google('victormono','VictorMono-Italic[wght].ttf','VictorMono[wght].ttf')],
  ['monaspacekrypton','Monaspace Krypton Var',[200,800,100],[],repository('githubnext/monaspace','f31794b6e9e65698a062262e2f826f679dcb7070',
    'fonts/Variable Fonts/Monaspace Krypton',['Monaspace Krypton Var.ttf'],'LICENSE'),monaspaceFeatures],
  ['iosevka','Iosevka',[400,400,100],['&&'],release('be5invis/Iosevka','v34.9.1','PkgTTF-Unhinted-Iosevka-34.9.1.zip','',
    italicPairs('Iosevka',['Regular']),raw('be5invis/Iosevka','v34.9.1','LICENSE.md'))],
  ['ibmplexmono','IBM Plex Mono',[300,700,100],LIGATURES,release('IBM/plex','@ibm/plex-mono@2.5.0','ibm-plex-mono.zip','ibm-plex-mono/fonts/complete/ttf/',
    italicPairs('IBMPlexMono',['Light','Regular','Medium','SemiBold','Bold']),'ibm-plex-mono/LICENSE.txt')],
  ['geistmono','Geist Mono',[100,900,100],['&&','||'],repository('vercel/geist-font','77f0563c03009d6c15c6342183fa53b352255b22',
    'fonts/GeistMono/variable',['GeistMono[wght].ttf','GeistMono-Italic[wght].ttf'],'OFL.txt')],
  ['recmono','Rec Mono Linear',[400,700,300],[],release('arrowtype/recursive','v1.085','ArrowType-Recursive-1.085.zip',
    'ArrowType-Recursive-1.085/Recursive_Code/RecMonoLinear/',italicPairs('RecMonoLinear',['Regular','Bold'],'-1.085.ttf'),'ArrowType-Recursive-1.085/LICENSE.txt')],
  ['maplemono','Maple Mono',[100,800,100],[],release('subframe7536/maple-font','v7.9','MapleMono-Variable.zip','',
    ['MapleMono[wght].ttf','MapleMono-Italic[wght].ttf'],'LICENSE.txt')],
];

// Release packages are large; each URL is downloaded once per machine.
const cache = path.join(os.tmpdir(),'aster-font-downloads');
function download(url) {
  const file = path.join(cache,sha256(url).slice(0,24));
  if (!fs.existsSync(file)) {
    fs.mkdirSync(cache,{recursive:true});
    execFileSync('curl',['--fail','--location','--silent','--show-error','--retry','2','--max-time','900','--output',file+'.part',url]);
    fs.renameSync(file+'.part',file);
  }
  return fs.readFileSync(file);
}
// One member of a release ZIP (stored or deflated), read from its central directory.
function unzip(archive, member) {
  const end = archive.lastIndexOf(Buffer.from('504b0506','hex'));
  if (end < 0) throw new Error('Not a ZIP archive');
  for (let i = 0, entry = archive.readUInt32LE(end+16); i < archive.readUInt16LE(end+10); i++) {
    const nameLength = archive.readUInt16LE(entry+28), name = archive.toString('utf8',entry+46,entry+46+nameLength);
    if (name === member) {
      const method = archive.readUInt16LE(entry+10), size = archive.readUInt32LE(entry+20), local = archive.readUInt32LE(entry+42);
      const data = archive.subarray(local+30+archive.readUInt16LE(local+26)+archive.readUInt16LE(local+28)).subarray(0,size);
      if (method === 0) return data;
      if (method === 8) return zlib.inflateRawSync(data);
      throw new Error('Unsupported ZIP compression: '+member);
    }
    entry += 46+nameLength+archive.readUInt16LE(entry+30)+archive.readUInt16LE(entry+32);
  }
  throw new Error('Missing release file: '+member);
}

// Existing files must retain the SHA-256 recorded in fonts.json. Every font
// file must name the family, cover the declared weights and shape the coding
// ligatures the family promises before it is accepted.
function main() {
  const python = process.env.ASTER_PYTHON || 'python';
  const previous = JSON.parse(fs.readFileSync(path.join(root,'fonts.json'),'utf8'));
  const pinned = new Map(previous.flatMap(font=>font.files.map(file=>[file.file,file.sha256])));
  const fonts = [];
  for (const [id,family,[min,max,step],lacks,source,fontFeatures] of FAMILIES) {
    const dir = path.join(root,'fonts',id); fs.mkdirSync(dir,{recursive:true});
    const files = source.files.map(({name,url,member})=>{
      const relative = `fonts/${id}/${name}`, local = path.join(dir,name);
      const bytes = fs.existsSync(local) ? fs.readFileSync(local) : member ? unzip(download(url),member) : download(url);
      const sha = sha256(bytes);
      if (pinned.has(relative) && pinned.get(relative)!==sha) throw new Error('Pinned font file changed: '+relative);
      if (name.endsWith('.ttf') && !['00010000','4f54544f'].includes(bytes.subarray(0,4).toString('hex'))) throw new Error('Not a font: '+relative);
      if (name==='OFL.txt' && !/SIL Open Font License/i.test(bytes.toString('utf8'))) throw new Error('Missing font license: '+id);
      if (name==='METADATA.pb' && !/license:\s*"OFL"/.test(bytes.toString('utf8'))) throw new Error('Not an OFL family: '+id);
      fs.writeFileSync(local,bytes);
      const details = name.endsWith('.ttf') ? JSON.parse(execFileSync(python,['-I',path.join(__dirname,'inspect-aster-font.py'),local,...(fontFeatures?[fontFeatures]:[])])) : {};
      return {file:relative,url,...(member?{member}:{}),sha256:sha,bytes:bytes.length,...details};
    });
    const fontFiles = files.filter(file=>file.weight), required = LIGATURES.filter(text=>!lacks.includes(text));
    if (!fontFiles.every(file=>file.families.includes(family))) throw new Error('Family metadata mismatch: '+family);
    if (!fontFiles.every(file=>required.every(text=>file.ligatures.includes(text)))) throw new Error('Missing coding ligatures: '+family);
    for (let weight = min; weight <= max; weight += step)
      if (!fontFiles.some(file=>!file.italic && file.weight[0]<=weight && weight<=file.weight[1])) throw new Error(family+' has no '+weight+' weight');
    const upright = fontFiles.find(file=>!file.italic && file.weight[0]<=400 && 400<=file.weight[1]) || fontFiles[0];
    fonts.push({id,family,version:/\d+(?:\.\d+)+/.exec(upright.version)?.[0] || upright.version,
      localNames:[...new Set(fontFiles.flatMap(file=>file.localNames))],minWeight:min,maxWeight:max,weightStep:step,license:'OFL-1.1',
      revision:source.revision,source:source.source,...(fontFeatures?{fontFeatures}:{}),
      ligatures:LIGATURES.filter(text=>fontFiles.every(file=>file.ligatures.includes(text))),cyrillic:fontFiles.every(file=>file.cyrillic),files});
    console.log(`${family} ${fonts.at(-1).version}: ${fontFiles.length} font files`);
  }
  // Families and files no longer listed leave the bundle.
  const listed = new Set(fonts.flatMap(font=>font.files.map(file=>file.file))), folder = path.join(root,'fonts');
  for (const id of fs.readdirSync(folder)) {
    for (const name of fs.readdirSync(path.join(folder,id))) if (!listed.has(`fonts/${id}/${name}`)) fs.rmSync(path.join(folder,id,name));
    if (!fs.readdirSync(path.join(folder,id)).length) fs.rmdirSync(path.join(folder,id));
  }
  fs.writeFileSync(path.join(root,'fonts.json'),JSON.stringify(fonts,null,2)+'\n');
}
if (require.main === module) main();
module.exports = {FAMILIES,LIGATURES,unzip};
