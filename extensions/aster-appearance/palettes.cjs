'use strict';
// Eleven palettes after the most installed editor themes: the published
// colours of each original, by code role. scripts/build-aster.cjs generates
// the theme files from them. Sources and licences are listed in THEMES.md.
// name, kind, editor, chrome, text, accent, muted, syntax roles
const s = (keyword, func, type, variable, property, string, number, tag, attribute, parameter, comment, operator, regex) =>
  ({ keyword, func, type, variable, property, string, number, tag, attribute, parameter, comment, operator, regex });
module.exports = [
  ['One Dark Pro','dark','#282c34','#21252b','#abb2bf','#61afef','#7f848e',
    s('#c678dd','#61afef','#e5c07b','#e06c75','#e06c75','#98c379','#d19a66','#e06c75','#d19a66','#e06c75','#7f848e','#56b6c2','#56b6c2')],
  ['Dracula','dark','#282a36','#21222c','#f8f8f2','#bd93f9','#7a87b8',
    s('#ff79c6','#50fa7b','#8be9fd','#f8f8f2','#f8f8f2','#f1fa8c','#bd93f9','#ff79c6','#50fa7b','#ffb86c','#6272a4','#ff79c6','#ff5555')],
  ['Tokyo Night','dark','#1a1b26','#16161e','#c0caf5','#7aa2f7','#787c99',
    s('#bb9af7','#7aa2f7','#2ac3de','#c0caf5','#73daca','#9ece6a','#ff9e64','#f7768e','#bb9af7','#e0af68','#565f89','#89ddff','#b4f9f8')],
  ['Catppuccin Mocha','dark','#1e1e2e','#181825','#cdd6f4','#cba6f7','#a6adc8',
    s('#cba6f7','#89b4fa','#f9e2af','#cdd6f4','#b4befe','#a6e3a1','#fab387','#89b4fa','#f9e2af','#eba0ac','#9399b2','#89dceb','#f5c2e7')],
  ['GitHub Dark','dark','#0d1117','#010409','#e6edf3','#2f81f7','#8b949e',
    s('#ff7b72','#d2a8ff','#ffa657','#e6edf3','#79c0ff','#a5d6ff','#79c0ff','#7ee787','#79c0ff','#ffa657','#8b949e','#ff7b72','#7ee787')],
  ['Ayu Mirage','dark','#242936','#1f2430','#cccac2','#ffcc66','#707a8c',
    s('#ffad66','#ffd173','#73d0ff','#cccac2','#f28779','#d5ff80','#dfbfff','#5ccfe6','#ffd173','#dfbfff','#6e7c8f','#f29e74','#95e6cb')],
  ['Nord','dark','#2e3440','#292e39','#d8dee9','#88c0d0','#616e88',
    s('#81a1c1','#88c0d0','#8fbcbb','#d8dee9','#d8dee9','#a3be8c','#b48ead','#81a1c1','#8fbcbb','#d8dee9','#616e88','#81a1c1','#ebcb8b')],
  ['GitHub Light','light','#ffffff','#f6f8fa','#1f2328','#0969da','#59636e',
    s('#cf222e','#8250df','#953800','#1f2328','#0550ae','#0a3069','#0550ae','#116329','#0550ae','#953800','#59636e','#cf222e','#116329')],
  ['One Light','light','#fafafa','#eaeaeb','#383a42','#526fff','#696c77',
    s('#a626a4','#4078f2','#c18401','#e45649','#e45649','#50a14f','#986801','#e45649','#986801','#383a42','#a0a1a7','#0184bc','#0184bc')],
  ['Catppuccin Latte','light','#eff1f5','#e6e9ef','#4c4f69','#8839ef','#6c6f85',
    s('#8839ef','#1e66f5','#df8e1d','#4c4f69','#7287fd','#40a02b','#fe640b','#1e66f5','#df8e1d','#e64553','#7c7f93','#04a5e5','#ea76cb')],
  ['Light Owl','light','#fbfbfb','#f0f0f0','#403f53','#2aa298','#90a7b2',
    s('#994cc3','#4876d6','#bc5454','#403f53','#0c969b','#c96765','#aa0982','#994cc3','#4876d6','#0c969b','#989fb1','#0c969b','#5ca7e4')],
];
// Earlier labels (and their typos) open the closest kept palette, so a saved
// choice keeps working after the update. Palettes removed in Aster 1.8.0 open
// the kept palette of their kind nearest in OKLab (background, text and code roles).
module.exports.legacy = {
  'oceanic pro':'Catppuccin Mocha','neon cyan':'Catppuccin Mocha','nord polar':'Nord','one dark':'One Dark Pro',
  'graphite pro':'Dracula','grafite pro':'Dracula','slate night':'Tokyo Night','slate nigth':'Tokyo Night',
  'pure black':'GitHub Dark','black':'GitHub Dark','crimson pro':'Catppuccin Mocha','ocean wave':'Ayu Mirage','ocean wawe':'Ayu Mirage',
  'amber ledger':'Ayu Mirage','orchid dusk':'Ayu Mirage','evergreen terminal':'Ayu Mirage',
  'git hab light':'GitHub Light','nord light':'Catppuccin Latte','titanium':'Catppuccin Latte','show gray':'Catppuccin Latte',
  'material light':'Light Owl','material ligth':'Light Owl','horizon light':'One Light','cream light':'Catppuccin Latte','ligth':'Catppuccin Latte',
  'sandstone studio':'Catppuccin Latte','synthwave \'84':'Ayu Mirage',
  // Near-duplicates removed in Aster 1.3.0 open the palette they repeated.
  'monokai':'Dracula','material palenight':'Tokyo Night','shades of purple':'Ayu Mirage',
  // Removed in Aster 1.8.0.
  'night owl':'Catppuccin Mocha','panda':'Catppuccin Mocha','gruvbox dark':'Ayu Mirage','cobalt2':'Ayu Mirage','synthwave 84':'Ayu Mirage',
  'everforest dark':'Nord','rose pine moon':'Nord','kanagawa wave':'Nord','vitesse dark':'Nord',
  'solarized light':'Catppuccin Latte','ayu light':'Catppuccin Latte',
};
