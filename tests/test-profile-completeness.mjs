import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { runInstaller } = require('../lib/installer');
const { runDoctor } = require('../lib/doctor');
const { verifyProfileInventory } = require('../lib/profile-inventory');
const { getEnvironmentPaths } = require('../lib/paths');

const repoRoot = path.resolve(import.meta.dirname, '..');

function makeFixture(t, label = 'workstation-profile-complete-') {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), label));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const customRoots = {
    userProfile: path.join(base, 'Профиль с пробелами'),
    gitBashPath: process.execPath,
  };
  const env = getEnvironmentPaths(customRoots);
  return { base, customRoots, env };
}

test('Full isolated install reconciles single-source-of-truth inventory across installer and Doctor, catches deliberate omissions, recovers on restore, and repeats without duplicates', t => {
  const { customRoots, env } = makeFixture(t);
  const options = {
    repoRoot,
    customRoots,
    skipAgentBrowser: true,
    skipFont: true,
    skipPermissions: true,
    log() {},
  };

  // 1. Fresh install succeeds and reconciles exact totals.
  const installed = runInstaller(options);
  assert.equal(installed.success, true, installed.failures.join('; '));
  assert.ok(installed.inventory, 'Installer must return reconciled inventory report');
  assert.equal(installed.inventory.ok, true);
  assert.equal(installed.inventory.failed, 0);
  assert.equal(installed.inventory.unverified, 0);
  assert.equal(
    installed.inventory.verified + installed.inventory.intentionallyExcluded + installed.inventory.failed + installed.inventory.unverified,
    installed.inventory.expected,
    'Inventory totals must reconcile exactly',
  );
  // 5 bundled local VSIX extensions must all be verified even in isolated mode.
  assert.equal(installed.inventory.byCategory.extensions.verified, 5);
  assert.equal(installed.inventory.byCategory.extensions.intentionallyExcluded, 21);
  assert.equal(installed.inventory.byCategory.extensions.expected, 26);

  // Doctor uses the exact same single source of truth.
  const doctorOk = runDoctor({ customRoots, log() {} });
  assert.ok(doctorOk.inventory, 'Doctor must return reconciled inventory report');
  assert.equal(doctorOk.inventory.expected, installed.inventory.expected);
  assert.equal(doctorOk.inventory.verified, installed.inventory.verified);
  assert.equal(doctorOk.inventory.intentionallyExcluded, installed.inventory.intentionallyExcluded);
  assert.equal(doctorOk.inventory.failed, 0);
  const invCheck = doctorOk.checks.find(item => item.name === 'Complete profile inventory');
  assert.equal(invCheck?.status, 'pass');

  // 2. Deliberate omission/damage test: break one component at a time -> must fail naming exact component -> restore -> passes again!
  const sabotageCases = [
    {
      name: 'managed skill SKILL.md',
      expectedPattern: /agent-browser/,
      breakIt() {
        const target = path.join(env.geminiSkillsDir, 'agent-browser', 'SKILL.md');
        const backup = fs.readFileSync(target);
        fs.unlinkSync(target);
        return () => fs.writeFileSync(target, backup);
      },
    },
    {
      name: 'managed keybinding entry',
      expectedPattern: /acceptSelectedSuggestion|keybindings/i,
      breakIt() {
        const backup = fs.readFileSync(env.keybindingsJson);
        fs.writeFileSync(env.keybindingsJson, '[]');
        return () => fs.writeFileSync(env.keybindingsJson, backup);
      },
    },
    {
      name: 'bundled local extension directory',
      expectedPattern: /workstation\.git-branch-panel/,
      breakIt() {
        const panelVersion = require('../extensions/git-branch-panel/package.json').version;
        const dir = path.join(env.extensionsDir, `workstation.git-branch-panel-${panelVersion}`);
        const parked = path.join(env.extensionsDir, `.parked-panel-${panelVersion}`);
        fs.renameSync(dir, parked);
        return () => fs.renameSync(parked, dir);
      },
    },
    {
      name: 'global GEMINI.md instructions',
      expectedPattern: /GEMINI\.md/,
      breakIt() {
        const target = path.join(env.geminiDir, 'GEMINI.md');
        const backup = fs.readFileSync(target);
        fs.writeFileSync(target, '# tampered\n');
        return () => fs.writeFileSync(target, backup);
      },
    },
  ];

  for (const scenario of sabotageCases) {
    const restore = scenario.breakIt();
    try {
      const broken = verifyProfileInventory(env, { repoRoot, isolated: true, skipFont: true });
      assert.equal(broken.ok, false, `${scenario.name}: inventory check must fail when component is missing/damaged`);
      assert.ok(broken.failed >= 1, `${scenario.name}: failed count must be >= 1`);
      assert.ok(
        broken.issues.some(msg => scenario.expectedPattern.test(msg)),
        `${scenario.name}: issues must name exact broken component (got: ${broken.issues.join(' | ')})`,
      );
      const brokenDoctor = runDoctor({ customRoots, log() {} });
      const check = brokenDoctor.checks.find(item => item.name === 'Complete profile inventory');
      assert.equal(check?.status, 'fail', `${scenario.name}: Doctor must fail inventory check`);
      assert.match(check.detail, scenario.expectedPattern);
    } finally {
      restore();
    }
    const restored = verifyProfileInventory(env, { repoRoot, isolated: true, skipFont: true });
    assert.equal(restored.ok, true, `${scenario.name}: must pass again after restore (${restored.issues.join('; ')})`);
    assert.equal(restored.failed, 0);
  }

  // 3. Repeat install creates zero duplicates (settings, keybindings, extensions, hooks, skills, backups).
  const backupsBefore = fs.existsSync(env.backupsDir) ? fs.readdirSync(env.backupsDir).sort() : [];
  const keybindingsBefore = JSON.parse(fs.readFileSync(env.keybindingsJson, 'utf8'));
  const extensionsBefore = JSON.parse(fs.readFileSync(path.join(env.extensionsDir, 'extensions.json'), 'utf8'));
  const hooksBefore = JSON.parse(fs.readFileSync(env.nativeHooksJson, 'utf8'));
  const skillsBefore = JSON.parse(fs.readFileSync(path.join(env.geminiConfigDir, 'skill-inventory.json'), 'utf8'));

  const repeat = runInstaller(options);
  assert.equal(repeat.success, true, repeat.failures.join('; '));
  assert.equal(repeat.backupInfo, null, 'Idempotent repeat install must not create duplicate backups');
  assert.deepEqual(fs.readdirSync(env.backupsDir).sort(), backupsBefore);
  assert.deepEqual(JSON.parse(fs.readFileSync(env.keybindingsJson, 'utf8')), keybindingsBefore);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(env.extensionsDir, 'extensions.json'), 'utf8')), extensionsBefore);
  assert.deepEqual(JSON.parse(fs.readFileSync(env.nativeHooksJson, 'utf8')), hooksBefore);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(env.geminiConfigDir, 'skill-inventory.json'), 'utf8')), skillsBefore);
});
