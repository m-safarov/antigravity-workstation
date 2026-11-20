import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { runInstaller, verifySourceIntegrity, verifyInstalledCompleteness } = require('../lib/installer');
const { runDoctor } = require('../lib/doctor');
const { getEnvironmentPaths } = require('../lib/paths');
const repoRoot = path.resolve(import.meta.dirname, '..');

function copyRepo(target) {
  fs.mkdirSync(target, { recursive: true });
  for (const name of ['package.json', 'LICENSE', 'config', 'rules', 'skills', 'agents', 'resources', 'extensions', 'scripts']) {
    fs.cpSync(path.join(repoRoot, name), path.join(target, name), {
      recursive: true,
      filter: src => !src.split(path.sep).includes('node_modules'),
    });
  }
}

function snapshot(dir) {
  const result = {};
  if (!fs.existsSync(dir)) return result;
  (function walk(folder) {
    for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
      const file = path.join(folder, entry.name);
      if (entry.isDirectory()) walk(file);
      else result[path.relative(dir, file)] = fs.readFileSync(file).toString('base64');
    }
  })(dir);
  return result;
}

test('Preflight source integrity catches missing or corrupted bundled VSIX and font files before touching user profile', t => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'workstation-preflight-full-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const customRoots = { userProfile: path.join(base, 'User'), gitBashPath: process.execPath };
  const env = getEnvironmentPaths(customRoots);

  // Establish a baseline profile first.
  const baseline = runInstaller({
    repoRoot, customRoots, skipExtensions: true, skipFont: true, skipAgentBrowser: true, skipPermissions: true, log() {},
  });
  assert.equal(baseline.success, true);
  const before = snapshot(customRoots.userProfile);

  const calmVersion = require('../extensions/calm-typescript/package.json').version;
  const jellyVersion = require('../extensions/jelly-cursor/package.json').version;
  const fontManifest = require('../config/font.json');
  const asterFonts = require('../extensions/aster-appearance/fonts.json');
  const secondaryAsterFont = asterFonts.find(family => family.id !== 'jetbrainsmono')?.files?.[0]?.file;
  assert.ok(secondaryAsterFont, 'Expected a bundled non-JetBrains Aster font entry');

  assert.doesNotThrow(
    () => verifySourceIntegrity(repoRoot, env, require('../config/extensions.json'), {
      skipExtensions: false, skipFont: false, isolated: true, verifyFonts: true,
    }),
    'Clean repository must pass full preflight integrity including bundled VSIX and Aster font checks',
  );

  const cases = [
    ['corrupted calm-typescript VSIX', src => fs.appendFileSync(path.join(src, `extensions/calm-typescript/calm-typescript-${calmVersion}.vsix`), 'corrupt'), /Calm TypeScript VSIX hash mismatch/],
    ['missing calm-typescript VSIX', src => fs.unlinkSync(path.join(src, `extensions/calm-typescript/calm-typescript-${calmVersion}.vsix`)), /Calm TypeScript VSIX hash mismatch/],
    ['corrupted jelly-cursor VSIX', src => fs.appendFileSync(path.join(src, `extensions/jelly-cursor/jelly-cursor-${jellyVersion}.vsix`), 'corrupt'), /Jelly Cursor VSIX checksum mismatch/, false],
    ['corrupted JetBrains Mono TTF (with extensions)', src => fs.appendFileSync(path.join(src, fontManifest.source, fontManifest.files[0].source), 'corrupt'), /source differs from the packaged VSIX|font checksum mismatch/i, false],
    ['corrupted JetBrains Mono TTF (skipExtensions)', src => fs.appendFileSync(path.join(src, fontManifest.source, fontManifest.files[0].source), 'corrupt'), /font checksum mismatch/i, true],
    ['corrupted Aster font TTF', src => fs.appendFileSync(path.join(src, 'extensions/aster-appearance', secondaryAsterFont), 'corrupt'), /source differs from the packaged VSIX|Aster font checksum mismatch/i, false],
  ];

  for (const [label, corrupt, pattern, skipExtensions = false] of cases) {
    const src = path.join(base, 'src-' + label.replace(/[^a-z0-9]+/gi, '-'));
    copyRepo(src);
    corrupt(src);
    assert.throws(
      () => verifySourceIntegrity(src, env, require('../config/extensions.json'), { skipExtensions, skipFont: false, isolated: true, verifyFonts: true }),
      pattern,
      label + ' must fail preflight integrity check',
    );
  }

  // Verify the existing user profile stayed completely untouched.
  assert.deepEqual(snapshot(customRoots.userProfile), before);
});

test('Mid-install failure automatically rolls back settings, GEMINI.md, payload and extensions so profile is never half-updated', t => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'workstation-mid-rollback-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const customRoots = { userProfile: path.join(base, 'User'), gitBashPath: process.execPath };
  const env = getEnvironmentPaths(customRoots);

  // Seed a pre-existing previous version profile with user settings and a foreign extension.
  fs.mkdirSync(path.dirname(env.settingsJson), { recursive: true });
  fs.mkdirSync(env.geminiDir, { recursive: true });
  fs.mkdirSync(path.join(env.extensionsDir, 'personal.ext-1.0.0'), { recursive: true });
  const originalSettings = JSON.stringify({ 'editor.fontSize': 19, 'personal.flag': 'keep-me' }, null, 2);
  const originalGemini = '# Previous GEMINI rules\n';
  fs.writeFileSync(env.settingsJson, originalSettings);
  fs.writeFileSync(path.join(env.geminiDir, 'GEMINI.md'), originalGemini);
  fs.writeFileSync(path.join(env.extensionsDir, 'personal.ext-1.0.0', 'package.json'), JSON.stringify({ publisher: 'personal', name: 'ext', version: '1.0.0' }));
  fs.writeFileSync(path.join(env.extensionsDir, 'extensions.json'), JSON.stringify([{ identifier: { id: 'personal.ext' }, version: '1.0.0', relativeLocation: 'personal.ext-1.0.0' }]));

  const brokenSource = path.join(base, 'broken-source');
  copyRepo(brokenSource);
  // Trigger a deterministic Stage 8 failure after Stages 3-7 have written settings, GEMINI.md and payload.
  fs.writeFileSync(path.join(brokenSource, 'extensions/workstation-stability/package.json'), JSON.stringify({ publisher: 'wrong', name: 'helper', version: '1.0.0' }));

  const result = runInstaller({
    repoRoot: brokenSource,
    customRoots,
    applyProfile: true,
    cleanExtensions: true,
    skipAgentBrowser: true,
    skipFont: true,
    skipPermissions: true,
    log() {},
  });

  assert.equal(result.success, false);
  assert.ok(result.failures.some(item => /Unexpected stability helper identity/.test(item)));
  assert.equal(result.extensionReset?.restored, true, 'Extensions must roll back');
  assert.equal(result.backupRestored?.restored, true, 'Profile files must roll back');
  assert.equal(fs.readFileSync(env.settingsJson, 'utf8'), originalSettings, 'Original settings.json must be restored intact');
  assert.equal(fs.readFileSync(path.join(env.geminiDir, 'GEMINI.md'), 'utf8'), originalGemini, 'Original GEMINI.md must be restored intact');
  assert.equal(fs.existsSync(path.join(env.geminiConfigDir, 'workstation-setup/editor-profile.json')), false, 'Failed install must not leave queued editor-profile.json');
  assert.ok(fs.existsSync(path.join(env.extensionsDir, 'personal.ext-1.0.0/package.json')), 'Personal extension must be restored');
});

test('verifyInstalledCompleteness reports missing mandatory file, unapplied setting and duplicate active extension', t => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'workstation-completeness-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const customRoots = { userProfile: path.join(base, 'User'), gitBashPath: process.execPath };
  const env = getEnvironmentPaths(customRoots);
  const ok = runInstaller({
    repoRoot, customRoots, skipExtensions: true, skipFont: true, skipAgentBrowser: true, skipPermissions: true, log() {},
  });
  assert.equal(ok.success, true);

  const settings = JSON.parse(fs.readFileSync(env.settingsJson, 'utf8'));
  const missingFile = path.join(base, 'missing-mandatory.json');
  fs.mkdirSync(env.extensionsDir, { recursive: true });
  fs.writeFileSync(path.join(env.extensionsDir, 'extensions.json'), JSON.stringify([
    { identifier: { id: 'esbenp.prettier-vscode' }, version: '11.0.0', relativeLocation: 'esbenp.prettier-vscode-11.0.0' },
    { identifier: { id: 'esbenp.prettier-vscode' }, version: '12.0.0', relativeLocation: 'esbenp.prettier-vscode-12.0.0' },
  ]));

  const issues = verifyInstalledCompleteness(env, {
    repoRoot,
    mergedSettings: { ...settings, 'editor.tabSize': 99 },
    mandatoryFiles: [env.settingsJson, missingFile],
    selectedExtensions: [{ id: 'esbenp.prettier-vscode' }],
    skipExtensions: false,
    isolated: false,
  });
  assert.ok(issues.some(item => item.includes('Mandatory file missing or empty')));
  assert.ok(issues.some(item => item.includes('editor.tabSize')));
  assert.ok(issues.some(item => item.includes('Duplicate active extension registrations for esbenp.prettier-vscode')));
});

test('Doctor fails when a managed extension has duplicate active registrations or duplicate active folders', t => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'workstation-doctor-dups-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const customRoots = { userProfile: path.join(base, 'User'), gitBashPath: process.execPath };
  const env = getEnvironmentPaths(customRoots);
  runInstaller({
    repoRoot, customRoots, skipExtensions: true, skipFont: true, skipAgentBrowser: true, skipPermissions: true, log() {},
  });
  // Create a fake CLI so Doctor inspects extensionsDir.
  const fakeCli = path.join(base, 'fake-cli.cmd');
  const catalog = require('../config/extensions.json');
  const lines = catalog.map(ext => `echo ${ext.id}@${ext.version || '1.0.0'}`).join('\r\n');
  fs.writeFileSync(fakeCli, '@echo off\r\n' + lines + '\r\n');
  fs.mkdirSync(path.join(env.extensionsDir, 'esbenp.prettier-vscode-11.0.0'), { recursive: true });
  fs.mkdirSync(path.join(env.extensionsDir, 'esbenp.prettier-vscode-12.0.0'), { recursive: true });
  fs.writeFileSync(path.join(env.extensionsDir, 'extensions.json'), JSON.stringify([
    { identifier: { id: 'esbenp.prettier-vscode' }, version: '11.0.0', relativeLocation: 'esbenp.prettier-vscode-11.0.0' },
    { identifier: { id: 'esbenp.prettier-vscode' }, version: '12.0.0', relativeLocation: 'esbenp.prettier-vscode-12.0.0' },
  ]));

  const report = runDoctor({ customRoots: { ...customRoots, cliPath: fakeCli }, log() {} });
  const check = report.checks.find(item => item.name === 'Single active version per managed extension');
  assert.ok(check, 'Doctor must emit single active version check');
  assert.equal(check.status, 'fail');
  assert.match(check.detail, /esbenp\.prettier-vscode/);
});
