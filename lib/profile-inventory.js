'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const { readJsonFile, parseJsonc } = require('./jsonc');
const payload = require('./owned-files');
const { expectedSettings, homeTemplate, isPersonalSetting } = require('./profile-settings');
const extensionProfiles = require('./extension-profiles');
const nativeHooks = require('./native-hooks');
const configMerge = require('./config-merge');
const managedProfile = require('../extensions/workstation-stability/profile.cjs');

const sha256File = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

function verifyMcpRuntime(directory, repoRoot = path.resolve(__dirname, '..')) {
  const dependencies = JSON.parse(fs.readFileSync(path.join(repoRoot, 'resources/mcp-runtime/package.json'), 'utf8')).dependencies;
  const entries = {
    'chrome-devtools-mcp': 'build/src/bin/chrome-devtools-mcp.js',
  };
  return Object.entries(entries).every(([name, entry]) => {
    const root = path.join(directory, 'node_modules', name);
    try {
      return JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version === dependencies[name]
        && fs.existsSync(path.join(root, entry));
    } catch { return false; }
  });
}

function matchesExpectedValue(actual, expected) {
  if (Array.isArray(expected)) return JSON.stringify(actual) === JSON.stringify(expected);
  if (expected && typeof expected === 'object') {
    return actual && typeof actual === 'object' && Object.entries(expected).every(([key, value]) => matchesExpectedValue(actual[key], value));
  }
  return actual === expected;
}

function resolveExtensionSelection(envPaths, repoRoot, options = {}) {
  if (Array.isArray(options.selectedExtensions)) {
    return {
      extensionProfile: options.extensionProfile || 'custom',
      selectedExtensions: options.selectedExtensions,
    };
  }
  const installOptionsFile = path.join(envPaths.geminiConfigDir, 'workstation-setup/install-options.json');
  let savedProfile = null;
  if (fs.existsSync(installOptionsFile)) {
    try { savedProfile = readJsonFile(installOptionsFile)?.extensionProfile || null; }
    catch { savedProfile = null; }
  }
  const extensionProfile = options.extensionProfile || savedProfile || 'full';
  const catalog = readJsonFile(path.join(repoRoot, 'config/extensions.json'));
  return {
    extensionProfile,
    selectedExtensions: extensionProfiles.selectExtensions(catalog, extensionProfile),
  };
}

function collectExpectedInventory(envPaths, options = {}) {
  const repoRoot = options.repoRoot || path.resolve(__dirname, '..');
  const displayName = options.displayName || 'Разработчик';
  const { extensionProfile, selectedExtensions } = resolveExtensionSelection(envPaths, repoRoot, options);
  const keybindings = readJsonFile(path.join(repoRoot, 'config/keybindings.json'));
  const skillInventory = readJsonFile(path.join(repoRoot, 'config/skill-inventory.json')).skills || [];
  const payloadItems = payload.collectPayload(repoRoot, displayName);
  const fontManifest = readJsonFile(path.join(repoRoot, 'config/font.json'));
  return {
    extensionProfile,
    selectedExtensions,
    keybindings,
    skillInventory,
    payloadItems,
    fontManifest,
    managedConfigs: [
      ['config/antigravity-settings.json', path.join(envPaths.geminiDir, 'antigravity/settings.json')],
      ['config/hooks.json', nativeHooks.nativeHooksPath(envPaths)],
      ['config/gemini-config.json', path.join(envPaths.geminiConfigDir, 'config.json')],
    ],
    mcpConfigs: [
      ['config/mcp/active.template.json', path.join(envPaths.geminiConfigDir, 'mcp_config.json')],
      ['config/mcp/mcp_antigravity.template.json', path.join(envPaths.geminiDir, 'antigravity/mcp_config.json')],
    ],
  };
}

function verifyProfileInventory(envPaths, options = {}) {
  const repoRoot = options.repoRoot || path.resolve(__dirname, '..');
  const displayName = options.displayName || 'Разработчик';
  const skipExtensions = options.skipExtensions === true;
  const skipFont = options.skipFont === true;
  const isolated = options.isolated === true;
  const mandatoryFiles = Array.isArray(options.mandatoryFiles) ? options.mandatoryFiles : [];
  const installedExtensions = Array.isArray(options.installedExtensions) ? options.installedExtensions : null;
  const spec = collectExpectedInventory(envPaths, { ...options, repoRoot, displayName });

  const items = [];
  const issues = [];
  let preservedPersonal = 0;

  function record(category, id, status, detail = '', issueMessage = null) {
    items.push({ category, id, status, detail });
    if (status === 'failed' && issueMessage) issues.push(issueMessage);
  }

  for (const file of mandatoryFiles) {
    const ok = fs.existsSync(file) && fs.statSync(file).isFile() && fs.statSync(file).size > 0;
    if (!ok) {
      record('mandatory-files', path.basename(file) + ':' + file, 'failed', 'Missing or empty', 'Mandatory file missing or empty: ' + file);
    }
  }

  // 1. Settings
  if (!fs.existsSync(envPaths.settingsJson)) {
    record('settings', 'settings.json', 'failed', 'Missing', 'Applied settings.json missing: ' + envPaths.settingsJson);
  } else {
    try {
      const actual = readJsonFile(envPaths.settingsJson, { jsonc: true, emptyValue: {} });
      if (options.mergedSettings) {
        const mismatched = Object.keys(options.mergedSettings).filter(key => !isDeepStrictEqual(actual[key], options.mergedSettings[key]));
        for (const key of Object.keys(actual)) {
          if (isPersonalSetting(key, actual[key])) preservedPersonal += 1;
        }
        if (mismatched.length) {
          record('settings', 'settings.json', 'failed', mismatched.slice(0, 8).join(', '),
            'Applied settings mismatch: ' + mismatched.slice(0, 8).join(', '));
        } else {
          record('settings', 'settings.json', 'verified', Object.keys(options.mergedSettings).length + ' keys verified');
        }
      } else {
        const expected = expectedSettings(envPaths, repoRoot);
        const profileFile = path.join(envPaths.geminiConfigDir, 'workstation-setup/editor-profile.json');
        if (fs.existsSync(profileFile)) {
          try {
            const profile = JSON.parse(fs.readFileSync(profileFile, 'utf8'));
            if (profile.schema === 1 && profile.settings && !Array.isArray(profile.settings) && typeof profile.settings === 'object') {
              for (const key of Object.keys(expected)) if (Object.hasOwn(profile.settings, key)) expected[key] = profile.settings[key];
            }
          } catch { /* fall back to canonical expectedSettings */ }
        }
        for (const key of ['errorLens.excludeBySource', 'errorLens.excludeByMessage']) {
          expected[key] = managedProfile.mergeManagedValue(key, actual[key], expected[key]);
        }
        for (const key of ['editor.fontFamily', 'editor.fontSize', 'editor.fontWeight', 'asterAppearance.theme']) {
          if (actual[key] !== undefined) { expected[key] = actual[key]; preservedPersonal += 1; }
        }
        expected['editor.tokenColorCustomizations'] = managedProfile.mergeManagedValue(
          'editor.tokenColorCustomizations', actual['editor.tokenColorCustomizations'], expected['editor.tokenColorCustomizations']);
        if (typeof actual['workbench.colorTheme'] === 'string' && actual['workbench.colorTheme'].trim()) {
          expected['workbench.colorTheme'] = actual['workbench.colorTheme'];
          preservedPersonal += 1;
        }
        const commandPolicy = actual['chat.tools.terminal.autoApprove'];
        for (const command of Object.keys(expected['chat.tools.terminal.autoApprove'] || {})) {
          if (commandPolicy?.[command] === false) expected['chat.tools.terminal.autoApprove'][command] = false;
        }
        const changed = Object.keys(expected).filter(key => !matchesExpectedValue(actual[key], expected[key]));
        if (changed.length) {
          record('settings', 'settings.json', 'failed', changed.slice(0, 8).join(', '),
            'Applied settings mismatch: ' + changed.slice(0, 8).join(', '));
        } else {
          record('settings', 'settings.json', 'verified', Object.keys(expected).length + ' managed keys verified');
        }
      }
    } catch (error) {
      record('settings', 'settings.json', 'failed', error.message, 'Applied settings.json unreadable: ' + error.message);
    }
  }

  // 2. Keybindings
  if (!fs.existsSync(envPaths.keybindingsJson)) {
    record('keybindings', 'keybindings.json', 'failed', 'Missing', 'Managed keybindings.json missing: ' + envPaths.keybindingsJson);
  } else {
    try {
      const kb = parseJsonc(fs.readFileSync(envPaths.keybindingsJson, 'utf8'), []);
      if (!Array.isArray(kb)) throw new Error('keybindings.json must contain an array');
      const expectedBindings = Array.isArray(options.mergedBindings) ? options.mergedBindings : spec.keybindings;
      const missing = expectedBindings.filter(binding => {
        if (kb.some(actual => isDeepStrictEqual(actual, binding))) return false;
        // Outside explicit mergedBindings checks, a personal binding on the exact same key+when is preserved intentionally.
        if (!Array.isArray(options.mergedBindings) && kb.some(actual => actual?.key === binding.key && (actual?.when || '') === (binding.when || ''))) {
          preservedPersonal += 1;
          return false;
        }
        return true;
      });
      if (missing.length) {
        const names = missing.slice(0, 5).map(b => `${b.key}->${b.command}`).join(', ');
        record('keybindings', 'keybindings.json', 'failed', 'Missing: ' + names, 'Managed keybindings missing: ' + names);
      } else {
        record('keybindings', 'keybindings.json', 'verified', expectedBindings.length + ' bindings verified');
      }
    } catch (error) {
      record('keybindings', 'keybindings.json', 'failed', error.message, 'Managed keybindings.json invalid: ' + error.message);
    }
  }

  // 3. argv.json
  try {
    const argv = parseJsonc(fs.readFileSync(envPaths.argvJson, 'utf8'));
    if (typeof argv?.locale === 'string' && argv.locale.trim()) {
      record('argv', 'argv.json', 'verified', 'locale=' + argv.locale);
    } else {
      record('argv', 'argv.json', 'failed', 'Missing locale', 'Managed argv.json missing valid locale');
    }
  } catch (error) {
    record('argv', 'argv.json', 'failed', error.message, 'Managed argv.json unreadable: ' + error.message);
  }

  // 4. Global GEMINI.md
  const geminiMd = path.join(envPaths.geminiDir, 'GEMINI.md');
  try {
    const expectedBytes = fs.readFileSync(path.join(repoRoot, 'rules/GEMINI.template.md'));
    if (fs.existsSync(geminiMd) && fs.readFileSync(geminiMd).equals(expectedBytes)) {
      record('instructions', 'GEMINI.md', 'verified', geminiMd);
    } else {
      record('instructions', 'GEMINI.md', 'failed', 'Missing or differs from template', 'Global instructions GEMINI.md missing or outdated');
    }
  } catch (error) {
    record('instructions', 'GEMINI.md', 'failed', error.message, 'Global instructions GEMINI.md check failed: ' + error.message);
  }

  // 5. Managed JSON configs (antigravity-settings, hooks, gemini-config)
  for (const [template, target] of spec.managedConfigs) {
    try {
      let expected = JSON.parse(homeTemplate(envPaths, template, repoRoot));
      const actual = JSON.parse(fs.readFileSync(target, 'utf8'));
      if (template === 'config/hooks.json') {
        expected = nativeHooks.mergeNativeHooks(actual, expected);
      } else {
        const retired = JSON.parse(homeTemplate(envPaths, 'config/migrations/retired-context-hook.template.json', repoRoot));
        const active = template === 'config/antigravity-settings.json' ? configMerge.retireOwnedHooks(actual, retired, expected) : actual;
        expected = configMerge.mergeUserConfiguration(active, expected);
      }
      if (isDeepStrictEqual(actual, expected)) {
        record('configs', template, 'verified', target);
      } else {
        record('configs', template, 'failed', 'Configuration differs', 'Managed config mismatch: ' + template);
      }
    } catch (error) {
      record('configs', template, 'failed', error.message, 'Managed config missing or invalid: ' + template);
    }
  }

  // 6. MCP configs & runtime
  for (const [template, target] of spec.mcpConfigs) {
    try {
      const servers = JSON.parse(fs.readFileSync(target, 'utf8')).mcpServers || {};
      const expected = JSON.parse(homeTemplate(envPaths, template, repoRoot)).mcpServers || {};
      const missingServers = Object.entries(expected).filter(([name, def]) => {
        const actual = servers[name];
        return actual?.command !== def.command || !isDeepStrictEqual(actual?.args, def.args);
      }).map(([name]) => name);
      if (missingServers.length) {
        record('mcp', path.basename(path.dirname(target)) + '/mcp_config.json', 'failed', 'Mismatch: ' + missingServers.join(', '),
          'MCP launcher mismatch in ' + target + ': ' + missingServers.join(', '));
      } else {
        record('mcp', path.basename(path.dirname(target)) + '/mcp_config.json', 'verified', Object.keys(expected).join(', '));
      }
    } catch (error) {
      record('mcp', path.basename(path.dirname(target)) + '/mcp_config.json', 'failed', error.message, 'MCP config missing or invalid: ' + target);
    }
  }

  if (isolated) {
    record('mcp', 'mcp-runtime', 'intentionallyExcluded', 'Isolated profile skips npm ci for MCP runtime');
  } else if (verifyMcpRuntime(path.join(envPaths.geminiConfigDir, 'mcp-runtime'), repoRoot)) {
    record('mcp', 'mcp-runtime', 'verified', 'Pinned MCP runtime version and entrypoint verified');
  } else {
    record('mcp', 'mcp-runtime', 'failed', 'Missing or wrong version/entrypoint', 'MCP runtime missing or version mismatch in ~/.gemini/config/mcp-runtime');
  }

  // 7. Managed payload (rules, guides, skills, scripts, runtime manifests)
  try {
    const plan = payload.planPayload(envPaths, repoRoot, displayName);
    const missingSet = new Set(plan.writes.map(item => item.key));
    for (const item of spec.payloadItems) {
      if (missingSet.has(item.key)) {
        record('payload', item.key, 'failed', 'Missing or differs from managed source', null);
      } else {
        record('payload', item.key, 'verified', 'Exact match');
      }
    }
    if (plan.writes.length) {
      issues.push('Missing or unapplied payload files: ' + plan.writes.slice(0, 6).map(item => item.key).join(', '));
    }
    if (plan.removals.length) {
      record('payload', 'obsolete-payload-cleanup', 'failed', plan.removals.map(item => item.key).join(', '),
        'Obsolete payload files still present: ' + plan.removals.slice(0, 6).map(item => item.key).join(', '));
    } else {
      record('payload', 'obsolete-payload-cleanup', 'verified', '0 obsolete owned files present');
    }
  } catch (error) {
    record('payload', 'payload-plan', 'failed', error.message, 'Payload verification failed: ' + error.message);
  }

  // 8. Skill inventory
  const inventoryPath = path.join(envPaths.geminiConfigDir, 'skill-inventory.json');
  try {
    const names = JSON.parse(fs.readFileSync(inventoryPath, 'utf8')).skills;
    if (!Array.isArray(names) || !names.length) throw new Error('Empty skill inventory');
    const missingBundled = spec.skillInventory.filter(name => !names.includes(name));
    const missingFiles = names.filter(name => !fs.existsSync(path.join(envPaths.geminiSkillsDir, name, 'SKILL.md')));
    if (missingBundled.length || missingFiles.length) {
      const missingAll = [...new Set([...missingBundled, ...missingFiles])];
      record('skills', 'skill-inventory', 'failed', 'Missing: ' + missingAll.join(', '),
        'Missing required skills: ' + missingAll.join(', '));
    } else {
      record('skills', 'skill-inventory', 'verified', names.length + ' skills verified');
    }
  } catch (error) {
    record('skills', 'skill-inventory', 'failed', error.message, 'Skill inventory invalid or missing: ' + error.message);
  }

  // 9. Extensions
  const indexPath = path.join(envPaths.extensionsDir, 'extensions.json');
  const extensionsDirExists = fs.existsSync(envPaths.extensionsDir);
  let indexEntries = null;
  let indexError = null;
  if (!skipExtensions) {
    if (!fs.existsSync(indexPath)) {
      indexError = 'Extension registration index missing: ' + indexPath;
    } else {
      try {
        const parsed = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
        if (!Array.isArray(parsed)) throw new Error('extensions.json is not an array');
        indexEntries = parsed;
      } catch (error) {
        indexError = 'Extension index unreadable: ' + error.message;
      }
    }
  }

  const activeDirsById = new Map();
  if (!skipExtensions && extensionsDirExists) {
    const obsoleteFile = path.join(envPaths.extensionsDir, '.obsolete');
    let obsolete = {};
    try { if (fs.existsSync(obsoleteFile)) obsolete = JSON.parse(fs.readFileSync(obsoleteFile, 'utf8')); } catch { obsolete = {}; }
    const managedIds = new Set(spec.selectedExtensions.map(ext => ext.id.toLowerCase()));
    for (const entry of fs.readdirSync(envPaths.extensionsDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || obsolete?.[entry.name] === true) continue;
      const lower = entry.name.toLowerCase();
      for (const id of managedIds) {
        if (!lower.startsWith(id + '-')) continue;
        if (!/^\d+\.\d+\.\d+/.test(lower.slice(id.length + 1))) continue;
        const list = activeDirsById.get(id) || [];
        list.push(entry.name);
        activeDirsById.set(id, list);
      }
    }
  }

  let indexErrorReported = false;
  for (const ext of spec.selectedExtensions) {
    const id = ext.id.toLowerCase();
    if (skipExtensions) {
      record('extensions', ext.id, 'intentionallyExcluded', '--skip-extensions');
      continue;
    }
    if (isolated && ext.source === 'gallery') {
      if (installedExtensions) {
        const cliEntry = installedExtensions.find(item => item.id === id);
        if (!cliEntry) {
          record('extensions', ext.id, 'failed', 'Absent from CLI inventory', 'Mandatory extension absent from IDE CLI inventory: ' + ext.id);
        } else {
          record('extensions', ext.id, 'verified', cliEntry.version || 'registered');
        }
      } else {
        record('extensions', ext.id, 'intentionallyExcluded', 'Isolated profile skips gallery CLI');
      }
      continue;
    }
    if (isolated && ext.source === 'local-vsix') {
      if (!extensionsDirExists && options.requireLocalExtensions !== true) {
        if (installedExtensions) {
          const cliEntry = installedExtensions.find(item => item.id === id);
          if (!cliEntry) {
            record('extensions', ext.id, 'failed', 'Absent from CLI inventory', 'Mandatory extension absent from IDE CLI inventory: ' + ext.id);
          } else if (ext.version && cliEntry.version !== ext.version) {
            record('extensions', ext.id, 'failed', `registered ${cliEntry.version}, expected ${ext.version}`,
              `Extension version mismatch for ${ext.id}: registered ${cliEntry.version}, expected ${ext.version}`);
          } else {
            record('extensions', ext.id, 'verified', cliEntry.version || 'registered');
          }
        } else {
          record('extensions', ext.id, 'intentionallyExcluded', 'Isolated profile installed with extensions skipped');
        }
        continue;
      }
      const activeDirs = activeDirsById.get(id) || [];
      if (activeDirs.length > 1) {
        record('extensions', ext.id, 'failed', activeDirs.length + ' active folders: ' + activeDirs.join(', '),
          'Duplicate active extension folders for ' + ext.id + ' (' + activeDirs.join(', ') + ')');
        continue;
      }
      if (activeDirs.length === 0) {
        record('extensions', ext.id, 'failed', 'Unpacked extension directory missing',
          'Mandatory local extension missing: ' + ext.id);
        continue;
      }
      const pkgPath = path.join(envPaths.extensionsDir, activeDirs[0], 'package.json');
      let pkgVersion = null;
      try { pkgVersion = JSON.parse(fs.readFileSync(pkgPath, 'utf8')).version; } catch { pkgVersion = null; }
      if (!pkgVersion || (ext.version && pkgVersion !== ext.version)) {
        record('extensions', ext.id, 'failed', `version ${pkgVersion || 'missing'}, expected ${ext.version}`,
          `Local extension package invalid or version mismatch for ${ext.id}`);
        continue;
      }
      if (Array.isArray(indexEntries)) {
        const matches = indexEntries.filter(entry => entry?.identifier?.id?.toLowerCase() === id);
        if (matches.length > 1) {
          record('extensions', ext.id, 'failed', matches.length + ' registrations',
            'Duplicate active extension registrations for ' + ext.id + ' (' + matches.length + ')');
          continue;
        }
      }
      record('extensions', ext.id, 'verified', pkgVersion);
      continue;
    }
    if (indexError) {
      record('extensions', ext.id, 'failed', indexError, indexErrorReported ? null : indexError);
      indexErrorReported = true;
      continue;
    }
    const matches = indexEntries.filter(entry => entry?.identifier?.id?.toLowerCase() === id);
    const activeDirs = activeDirsById.get(id) || [];
    if (matches.length === 0) {
      record('extensions', ext.id, 'failed', 'Not registered', 'Mandatory extension not registered: ' + ext.id);
      continue;
    }
    if (matches.length > 1) {
      record('extensions', ext.id, 'failed', matches.length + ' registrations',
        'Duplicate active extension registrations for ' + ext.id + ' (' + matches.length + ')');
      continue;
    }
    if (activeDirs.length > 1) {
      record('extensions', ext.id, 'failed', activeDirs.length + ' active folders: ' + activeDirs.join(', '),
        'Duplicate active extension folders for ' + ext.id + ' (' + activeDirs.join(', ') + ')');
      continue;
    }
    if (installedExtensions && !isolated) {
      const cliEntry = installedExtensions.find(item => item.id === id);
      if (!cliEntry) {
        record('extensions', ext.id, 'failed', 'Absent from CLI inventory', 'Mandatory extension absent from IDE CLI inventory: ' + ext.id);
        continue;
      }
      const unpinned = ext.trackLatest === true;
      const exact = typeof ext.version === 'string' && cliEntry.version === ext.version;
      if (!unpinned && !exact && !ext.allowCompatibleVersion) {
        record('extensions', ext.id, 'failed', `registered ${cliEntry.version}, expected ${ext.version}`,
          `Extension version mismatch for ${ext.id}: registered ${cliEntry.version}, expected ${ext.version}`);
        continue;
      }
    }
    record('extensions', ext.id, 'verified', matches[0].version || 'registered');
  }

  // 10. Fonts
  if (skipFont || isolated || process.platform !== 'win32') {
    const reason = isolated ? 'Isolated test profile: no system font changes'
      : skipFont ? '--skip-font' : 'Windows font registration not checked on ' + process.platform;
    record('fonts', 'JetBrains Mono', 'intentionallyExcluded', reason);
  } else {
    const fontDir = path.join(envPaths.localAppData, 'Microsoft', 'Windows', 'Fonts');
    const sets = [spec.fontManifest.files || [], spec.fontManifest.legacyFiles || []].filter(list => list.length);
    const matchedSet = sets.find(list => list.every(file => {
      const target = path.join(fontDir, file.name);
      return fs.existsSync(target) && sha256File(target) === file.sha256;
    }));
    if (matchedSet) {
      record('fonts', 'JetBrains Mono', 'verified', matchedSet.length + ' pinned TTF checksums verified');
    } else {
      record('fonts', 'JetBrains Mono', 'unverified', 'User font TTF checksums not matched; rerun full install without --skip-font');
    }
  }

  const byCategory = {};
  const totals = {
    expected: items.length,
    verified: 0,
    intentionallyExcluded: 0,
    failed: 0,
    unverified: 0,
    preservedPersonal,
  };
  for (const item of items) {
    totals[item.status] += 1;
    byCategory[item.category] ||= { expected: 0, verified: 0, intentionallyExcluded: 0, failed: 0, unverified: 0 };
    byCategory[item.category].expected += 1;
    byCategory[item.category][item.status] += 1;
  }

  return {
    ok: totals.failed === 0,
    extensionProfile: spec.extensionProfile,
    ...totals,
    byCategory,
    issues,
    items,
  };
}

module.exports = {
  collectExpectedInventory,
  verifyProfileInventory,
  verifyMcpRuntime,
};
