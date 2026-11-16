# Aster palettes and their sources

Each Aster palette follows the colours of a widely used editor theme. Aster does
not copy theme files: it takes the published colour values of the original
(keyword, function, type, variable, property, string, number, tag, attribute,
parameter, comment, operator, regex) and generates every theme file from them
with `scripts/build-aster.cjs`.

All eleven themes colour the same 22 code roles through one shared scope map
(TextMate scopes and semantic tokens), so no theme falls back to the IDE's own
colours: keyword, storage (`const`, `function`), function declaration, function
call, method, variable declaration, variable, parameter, property, type, JSX tag
or component, JSX attribute, library name (imports, `console`, `Math`), string,
template string, constant (numbers, `true`, `null`), regex, operator,
punctuation, comment, doc comment and invalid. A declaration and its later use
share one hue; the declaration is a little brighter.

- Every code colour reads at 4.5:1 or more on the editor background; comments
  at 5:1 or more in a clear comment green (OKLCH chroma 0.12; sea green, teal
  or olive green where the palette's strings are green), never grey. Plain
  text reads at 7:1.
- Keyword, string, function, type, comment and variable stay visibly apart
  (OKLab distance 0.07 or more); a colour that comes too close moves in
  lightness first, then slightly in hue.
- Dark palettes keep their hues but not the neon edge: colourfulness is capped
  at OKLCH chroma 0.16 (0.19 on light backgrounds).
- Where the original leaves names in the plain text colour, they take the colour
  VS Code recommends for names (Dark+ light blue, Light+ dark blue).
- Workbench, terminal (each ANSI colour from the palette colour nearest its hue),
  selection, find, bracket pairs (three calm colours in turn) and Git
  decorations are defined in every theme. Squiggles and Error Lens messages use
  the palette's error, warning, info and muted colours at the opacity of the
  managed profile (70, 55, 45 and 35 %); Error Lens draws no backgrounds.

Every two palettes of a kind differ by at least 0.10 in OKLab on average. Aster
1.8.0 keeps eleven palettes. The removed ones open their closest kept palette of
the same kind (nearest in OKLab over background, text and code roles): Night
Owl and Panda open Catppuccin Mocha; Gruvbox Dark, Cobalt2 and SynthWave 84 open
Ayu Mirage; Everforest Dark, Rose Pine Moon, Kanagawa Wave and Vitesse Dark open
Nord; Solarized Light and Ayu Light open Catppuccin Latte. Monokai, Material
Palenight and Shades of Purple (removed in 1.3.0) open Dracula, Tokyo Night and
Ayu Mirage.

| Aster palette | Follows | Licence of the original |
| --- | --- | --- |
| One Dark Pro | One Dark Pro (Binaryify), after Atom One Dark | MIT |
| Dracula | Dracula Theme | MIT |
| Tokyo Night | Tokyo Night (enkia) | MIT |
| Catppuccin Mocha | Catppuccin | MIT |
| GitHub Dark | GitHub VS Code Theme (Primer) | MIT |
| Ayu Mirage | Ayu | MIT |
| Nord | Nord (Arctic Ice Studio) | MIT |
| GitHub Light | GitHub VS Code Theme (Primer) | MIT |
| One Light | Atom One Light | MIT |
| Catppuccin Latte | Catppuccin | MIT |
| Light Owl | Night Owl Light (Sarah Drasner) | MIT |

The names identify the colour scheme a palette follows. They are not the
original extensions and are not endorsed by their authors.

## Studio controls

- The gallery has two sections, dark and light; each goes from the darkest
  editor background to the brightest. A click on a theme card applies the
  theme at once.
- **Яркость цветов кода** (−30 … +30 %) makes code colours more or less colourful.
- **Контраст кода** (−20 … +30 %) moves code colours away from or towards the
  background. Text never drops below 4.5:1. A code sample follows both sliders
  live (with the same colour math as the editor); the editor changes with their
  own **Применить** button.

Brightness and contrast retune Aster palettes only; the Antigravity and VS Code
themes keep their own colours.
