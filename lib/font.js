'use strict';
// Fonts for the current Windows user, installed by scripts/install-font.ps1:
// JetBrains Mono (the editor and terminal font) and the other Aster Atelier
// families, all from the pinned files inside extensions/aster-appearance.

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { stageScriptFiles } = require('./script-staging');

const JETBRAINS_SOURCE = 'extensions/aster-appearance/fonts/jetbrainsmono';

// Windows PowerShell 5.1 with its own modules, also when Node was started from PowerShell 7.
function powershell(run, args, options) {
  return run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', ...args], { windowsHide: true, ...options,
    env: { ...process.env, PSModulePath: path.win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'Modules') } });
}

// Windows PowerShell 5.1 cannot start a script whose path is longer than MAX_PATH;
// such a source is copied to a short temporary folder first.
function scriptRoot(repoRoot, inputs) {
  if (path.join(repoRoot, 'scripts/install-font.ps1').length < 200) return { root: repoRoot, dispose() {} };
  return stageScriptFiles(repoRoot, ['scripts/install-font.ps1', 'extensions/aster-appearance/install-font.ps1', ...inputs], 'workstation-font-');
}

function readFontManifest(repoRoot) {
  const manifest = JSON.parse(fs.readFileSync(path.join(repoRoot, 'config', 'font.json'), 'utf8'));
  const files = Array.isArray(manifest.files) ? manifest.files : [];
  if (manifest.family !== 'JetBrains Mono' || manifest.source !== JETBRAINS_SOURCE || files.length !== 2
    || files.some(file => !/^JetBrainsMono(?:-Italic)?\[wght\]\.ttf$/.test(file.source) || !/^[a-f0-9]{64}$/.test(file.sha256)
      || file.name !== 'Aster-jetbrainsmono-' + file.sha256.slice(0, 12) + '.ttf')) {
    throw new Error('Invalid pinned font manifest');
  }
  return manifest;
}

function ensureJetBrainsMono(options = {}) {
  const { dryRun = false, log = console.log, platform = process.platform,
    repoRoot = path.resolve(__dirname, '..'), run = spawnSync } = options;
  if (platform !== 'win32') return { installed: false, skipped: true, reason: 'Automatic font installation requires Windows' };
  const manifest = readFontManifest(repoRoot);
  if (dryRun) {
    log('  [DRY-RUN] Would keep an installed JetBrains Mono, or install the 2 verified JetBrains Mono files of Aster Atelier for the current Windows user.');
    return { installed: false, dryRun: true };
  }
  log('  JetBrains Mono: an installed copy is kept; otherwise the verified files of Aster Atelier are installed (no download).');
  const errorReportPath = path.join(os.tmpdir(), `workstation-font-error-${randomUUID()}.json`);
  const staged = scriptRoot(repoRoot, ['config/font.json', manifest.source]);
  try {
    const result = powershell(run, ['-File', path.join(staged.root, 'scripts', 'install-font.ps1'),
      '-ManifestPath', path.join(staged.root, 'config/font.json'), '-ErrorReportPath', errorReportPath], { stdio: 'inherit' });
    if (result.error || result.status !== 0) {
      let detail = '';
      try {
        const report = JSON.parse(fs.readFileSync(errorReportPath, 'utf8').replace(/^\uFEFF/, ''));
        if (typeof report.stage === 'string' && typeof report.message === 'string') detail = `: ${report.stage}: ${report.message}`;
      } catch { /* the exit code is reported instead */ }
      throw new Error('JetBrains Mono installation/verification failed'
        + (result.error ? ': ' + result.error.message : ` (exit ${result.status})`) + detail);
    }
  } finally {
    fs.rmSync(errorReportPath, { force: true });
    staged.dispose();
  }
  return { installed: true };
}

// The other Aster Atelier families ship inside the extension. Setup registers
// the missing ones for the current Windows user from those pinned files, so a
// family picked in the studio works without a download.
function ensureAsterFonts(options = {}) {
  const { dryRun = false, log = console.log, platform = process.platform,
    repoRoot = path.resolve(__dirname, '..'), run = spawnSync } = options;
  if (platform !== 'win32') return { installed: [], skipped: true, reason: 'Automatic font installation requires Windows' };
  const root = path.join(repoRoot, 'extensions', 'aster-appearance');
  const fonts = JSON.parse(fs.readFileSync(path.join(root, 'fonts.json'), 'utf8'));
  const processOptions = { encoding: 'utf8', timeout: 120000 };
  const listed = powershell(run, ['-Command', '[Console]::OutputEncoding=[Text.Encoding]::UTF8; Add-Type -AssemblyName System.Drawing; '
    + '(New-Object System.Drawing.Text.InstalledFontCollection).Families.Name | ConvertTo-Json -Compress'], processOptions);
  if (listed.error || listed.status !== 0) throw new Error('Could not list installed fonts: ' + (listed.error?.message || listed.stderr));
  const names = new Set([].concat(JSON.parse(String(listed.stdout).replace(/^\uFEFF/, '') || '[]')).map(name => String(name).toLowerCase()));
  const missing = fonts.filter(font => !names.has(font.family.toLowerCase()));
  if (dryRun) {
    log(`  [DRY-RUN] Would register ${missing.length} bundled Aster font families for the current Windows user.`);
    return { installed: [], dryRun: true, missing: missing.map(font => font.family) };
  }
  const { stageBundled } = require(path.join(root, 'font-service.cjs'));
  const script = missing.length ? scriptRoot(repoRoot, []) : null;
  try {
    for (const font of missing) {
      const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'aster-font-'));
      try {
        stageBundled(root, font, stage);
        const result = powershell(run, ['-File', path.join(script.root, 'scripts', 'install-font.ps1'), '-Stage', stage], processOptions);
        if (result.error || result.status !== 0) throw new Error(font.family + ' registration failed: ' + (result.error?.message || result.stderr || 'exit ' + result.status));
      } finally { fs.rmSync(stage, { recursive: true, force: true }); }
      log(`  Aster font registered: ${font.family}`);
    }
  } finally { script?.dispose(); }
  log(`  Aster fonts: ${fonts.length - missing.length} already present, ${missing.length} registered from the bundle.`);
  return { installed: missing.map(font => font.family) };
}

module.exports = { ensureJetBrainsMono, ensureAsterFonts };
