import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
const require = createRequire(import.meta.url);
const { mergeConfiguration, mergeUserConfiguration } = require('../lib/config-merge');
const { mergeSettings } = require('../lib/profile-settings');
const { mergeManagedValue } = require('../extensions/workstation-stability/profile.cjs');

test('Ordinary user configuration never supplies permission grants; explicit opt-in extends the allow list and retains personal policies', () => {
  const managed = { permissions: { allow: ['command(*)', 'write_file(*)'] }, userSettings: { useAiCredits: true } };
  assert.deepEqual(mergeUserConfiguration({}, managed), { userSettings: { useAiCredits: true } });
  assert.deepEqual(mergeUserConfiguration({}, managed, { allowPermissions: true }), managed);
  const personal = { permissions: { allow: ['command(git *)'], deny: ['write_file(*)'], custom: false }, userSettings: { useAiCredits: false } };
  const snapshot = structuredClone(personal);
  assert.deepEqual(mergeUserConfiguration(personal, managed), personal);
  const optedIn = mergeUserConfiguration(personal, managed, { allowPermissions: true });
  assert.deepEqual(optedIn, { ...personal, permissions: { ...personal.permissions, allow: ['command(git *)', 'command(*)', 'write_file(*)'] } });
  assert.deepEqual(mergeUserConfiguration(optedIn, managed, { allowPermissions: true }), optedIn, 'a repeated update adds nothing');
  assert.deepEqual(personal, snapshot);
});

test('The agent allow list matches the native global grant written by the README commands', () => {
  const { AUTO_ALLOW } = require('../lib/mcp-permissions');
  const template = JSON.parse(fs.readFileSync(new URL('../config/antigravity-settings.json', import.meta.url), 'utf8'));
  assert.deepEqual(template.permissions.allow, [...AUTO_ALLOW]);
  const previousSetup = { permissions: { allow: ['command(npx tsc --noEmit)', 'command(git *)', 'write_file(*)', 'read_url(*)'] } };
  const updated = mergeUserConfiguration(previousSetup, template, { allowPermissions: true });
  for (const grant of AUTO_ALLOW) assert.ok(updated.permissions.allow.includes(grant), grant + ' reaches an existing install');
});

test('Retiring a known exact hook preserves modified hooks, mixed foreign hooks and group metadata', () => {
  const { retireOwnedHooks } = require('../lib/config-merge');
  const old = { type: 'command', command: 'known owned command', timeout: 10 };
  const retired = { hooks: { AfterTool: [{ matcher: 'Read', hooks: [old] }] } };
  const changed = { ...old, timeout: 99 };
  const foreign = { type: 'command', command: 'foreign command' };
  const current = { hooks: { AfterTool: [{ matcher: 'Read', hooks: [old] },
    { matcher: 'Read', label: 'personal', hooks: [old, foreign] }, { matcher: 'Read', hooks: [changed] }] } };
  const next = retireOwnedHooks(current, retired, {});
  assert.deepEqual(next.hooks.AfterTool, [{ matcher: 'Read', label: 'personal', hooks: [foreign] }, { matcher: 'Read', hooks: [changed] }]);
  assert.deepEqual(retireOwnedHooks(next, retired, {}), next);
  assert.deepEqual(retireOwnedHooks(current, retired, retired), current);
});

test('Real installer preserves personal configuration through update, repeat and backup rollback', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workstation-personal-merge-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const customRoots = { userProfile: path.join(root, 'User with spaces'), gitBashPath: process.execPath };
  const env = require('../lib/paths').getEnvironmentPaths(customRoots);
  const options = { customRoots, skipExtensions: true, skipAgentBrowser: true, skipFont: true, skipPermissions: true, log() {} };
  const run = () => {
    const result = require('../lib/installer').runInstaller(options);
    assert.equal(result.success, true, result.failures.join('; '));
    return result;
  };
  run();
  const screenshotRoot = path.join(env.geminiSkillsDir, 'in-chat-screenshot-to-code');
  const personalSettings = JSON.parse(fs.readFileSync(env.settingsJson));
  personalSettings['errorLens.excludeBySource'] = ['personal-linter', 'typescript'];
  personalSettings['errorLens.excludeByMessage'] = ['^personal ignored warning$'];
  const personalSettingsBytes = JSON.stringify(personalSettings, null, 3);
  fs.writeFileSync(env.settingsJson, personalSettingsBytes);
  for (const relative of ['SKILL.md', 'SOURCE.md', 'references/replication_instructions.md', 'references/stack_recipes.md', 'references/repo_orientation.md']) {
    assert.deepEqual(fs.readFileSync(path.join(screenshotRoot, relative)), fs.readFileSync(path.resolve(import.meta.dirname, '../skills/in-chat-screenshot-to-code', relative)));
  }
  assert.equal(fs.existsSync(path.join(env.geminiSkillsDir, '.DS_Store')), false);
  assert.equal(fs.existsSync(path.join(env.geminiSkillsDir, '__MACOSX')), false);
  for (const file of ['audit-configuration.cjs', 'package-git-panel.cjs',
    'audit-powershell-syntax.ps1','audit-tracked-files.cjs','build-aster-icon.cjs','build-aster.cjs','fetch-aster-fonts.cjs','inspect-running-antigravity.ps1','migrate-aster-profile.cjs','package-aster.cjs','run-test-coverage.cjs'])
    assert.equal(fs.existsSync(path.join(env.geminiScriptsDir, file)), false, 'Source-only development tooling must not be globally deployed');
  const files = [path.join(env.geminiDir, 'antigravity/settings.json'), path.join(env.geminiConfigDir, 'config.json')];
  const originals = files.map(file => {
    const value = JSON.parse(fs.readFileSync(file));
    value.personalPlugin = { nested: { list: ['original', 'keep'] } };
    value.userSettings = { ...value.userSettings, personal: { flag: true } };
    const bytes = JSON.stringify(value, null, 3);
    fs.writeFileSync(file, bytes);
    return bytes;
  });
  const updated = run();
  const checkExclusions = () => {
    const settings = JSON.parse(fs.readFileSync(env.settingsJson));
    for (const key of ['errorLens.excludeBySource', 'errorLens.excludeByMessage']) assert.deepEqual(settings[key], personalSettings[key]);
  };
  checkExclusions();
  for (const file of files) {
    const value = JSON.parse(fs.readFileSync(file));
    assert.deepEqual(value.personalPlugin, { nested: { list: ['original', 'keep'] } });
    assert.deepEqual(value.userSettings.personal, { flag: true });
  }
  const after = files.map(file => fs.readFileSync(file, 'utf8'));
  run();
  checkExclusions();
  assert.deepEqual(files.map(file => fs.readFileSync(file, 'utf8')), after);
  const doctor = require('../lib/doctor').runDoctor({ customRoots, log() {} });
  assert.equal(doctor.checks.find(item => item.name === 'Managed editor settings').status, 'pass');
  for (const template of ['config/antigravity-settings.json', 'config/gemini-config.json']) {
    assert.equal(doctor.checks.find(item => item.name === template).status, 'pass');
  }
  require('../lib/backup').restoreBackup(updated.backupInfo.backupDir, env);
  assert.deepEqual(files.map(file => fs.readFileSync(file, 'utf8')), originals);
  assert.equal(fs.readFileSync(env.settingsJson, 'utf8'), personalSettingsBytes);
});

test('Configuration updates preserve nested personal values, permissions and foreign hook groups and are idempotent', () => {
  const managedHook = { type: 'command', command: 'managed command', timeout: 10 };
  const personalHook = { type: 'command', command: 'personal command', timeout: 55 };
  const before = { userSettings: { personal: true, useAiCredits: false }, otherPlugin: { nested: ['keep'] },
    permissions: { allow: ['personal permission'], deny: ['personal denial'] },
    hooks: { BeforeTool: [{ matcher: 'Read', label: 'keep metadata', hooks: [{ ...managedHook, timeout: 1 }, personalHook] }],
      PersonalEvent: [{ hooks: [personalHook] }] } };
  const snapshot = structuredClone(before);
  const managed = { userSettings: { useAiCredits: true }, permissions: { allow: ['managed permission', 'managed permission'] },
    hooks: { BeforeTool: [{ matcher: 'Read', hooks: [managedHook] }] } };
  const next = mergeConfiguration(before, managed);
  assert.deepEqual(before, snapshot);
  assert.deepEqual(next.otherPlugin, before.otherPlugin);
  assert.deepEqual(next.userSettings, { personal: true, useAiCredits: true });
  assert.deepEqual(next.permissions, { allow: ['personal permission', 'managed permission'], deny: ['personal denial'] });
  assert.deepEqual(next.hooks.BeforeTool, [{ matcher: 'Read', label: 'keep metadata', hooks: [managedHook, personalHook] }]);
  assert.deepEqual(next.hooks.PersonalEvent, before.hooks.PersonalEvent);
  assert.deepEqual(mergeConfiguration(next, managed), next);
  assert.deepEqual(mergeConfiguration({}, managed), { ...managed, permissions: { allow: ['managed permission'] } });
});

test('Managed object type collisions refuse before discarding personal scalar or array values',()=>{
  for(const value of [null,false,42,'personal value',['personal value']]){
    const current={userSettings:value,personal:{keep:true}},snapshot=structuredClone(current);
    assert.throws(()=>mergeConfiguration(current,{userSettings:{useAiCredits:true}}),/Invalid managed object at userSettings.*preserved/);
    assert.deepEqual(current,snapshot);
  }
  assert.throws(()=>mergeConfiguration([],{userSettings:{useAiCredits:true}}),/Invalid managed object at <root>/);
});

test('Corrupt extension inventory is rejected in installer preflight before settings or backup changes',t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'workstation-index-preflight-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const customRoots={userProfile:path.join(root,'User'),gitBashPath:process.execPath},env=require('../lib/paths').getEnvironmentPaths(customRoots);
  const options={customRoots,skipExtensions:true,skipAgentBrowser:true,skipFont:true,skipPermissions:true,log(){}};
  assert.equal(require('../lib/installer').runInstaller(options).success,true);
  fs.mkdirSync(env.extensionsDir,{recursive:true});fs.writeFileSync(path.join(env.extensionsDir,'extensions.json'),'null');
  const snapshot=()=>{
    const values={};const walk=dir=>{for(const entry of fs.readdirSync(dir,{withFileTypes:true})){const file=path.join(dir,entry.name);if(entry.isDirectory())walk(file);else values[path.relative(root,file)]=crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');}};
    walk(root);return values;
  };
  const before=snapshot();
  assert.throws(()=>require('../lib/installer').runInstaller({...options,skipExtensions:false}),/Invalid Aster Atelier extension index/);
  assert.deepEqual(snapshot(),before,'Failed preflight changes neither active settings, ownership nor backup files');
});

for(const kind of ['settings','keybindings','argv','gemini','antigravity','mcp'])test('Planning race preserves concurrent personal edits in '+kind,t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'workstation-plan-race-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const customRoots={userProfile:path.join(root,'User'),gitBashPath:process.execPath},env=require('../lib/paths').getEnvironmentPaths(customRoots);
  const options={customRoots,skipExtensions:true,skipAgentBrowser:true,skipFont:true,skipPermissions:true,log(){}};
  assert.equal(require('../lib/installer').runInstaller(options).success,true);
  const targets={settings:env.settingsJson,keybindings:env.keybindingsJson,argv:env.argvJson,
    gemini:path.join(env.geminiConfigDir,'config.json'),antigravity:path.join(env.geminiDir,'antigravity/settings.json'),mcp:path.join(env.geminiConfigDir,'mcp_config.json')};
  const target=targets[kind];
  const before=new Map(Object.values(targets).map(file=>[file,fs.readFileSync(file)])),backups=fs.readdirSync(env.backupsDir);
  const originalRead=fs.readFileSync;let reads=0,injected=false;
  t.mock.method(fs,'readFileSync',function(file,...args){
    const bytes=originalRead.call(fs,file,...args);
    if(file===target&&++reads===2){
      const value=JSON.parse(bytes.toString());
      if(kind==='keybindings')value.push({key:'ctrl+alt+shift+9',command:'personal.concurrentEdit'});else value['personal.concurrentEdit']='preserve exactly';
      fs.writeFileSync(file,JSON.stringify(value));injected=true;
    }
    return bytes;
  });
  let failure;
  try{require('../lib/installer').runInstaller(options);}catch(error){failure=error;}
  assert.equal(injected,true);
  const after=JSON.parse(originalRead(target,'utf8'));
  if(kind==='keybindings')assert.equal(after.some(binding=>binding.command==='personal.concurrentEdit'),true);else assert.equal(after['personal.concurrentEdit'],'preserve exactly');
  assert.match(failure?.message||'',/Profile file changed during installation/);
  assert.deepEqual(fs.readdirSync(env.backupsDir),backups,'Planning conflict stops before backup creation');
  for(const [file,bytes] of before)if(file!==target)assert.deepEqual(originalRead(file),bytes,'Unrelated active files are untouched');
  t.mock.restoreAll();assert.equal(require('../lib/installer').runInstaller(options).success,true,'A fresh retry can merge the new personal setting safely');
  const retried=JSON.parse(fs.readFileSync(target,'utf8'));
  if(kind==='keybindings')assert.equal(retried.some(binding=>binding.command==='personal.concurrentEdit'),true);else assert.equal(retried['personal.concurrentEdit'],'preserve exactly');
});

test('Rules-only update preserves edits made while its backup is being created',t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'workstation-rules-race-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const env=require('../lib/paths').getEnvironmentPaths({userProfile:path.join(root,'User')});
  const files=[path.join(env.geminiDir,'GEMINI.md'),...['workstation-unified-design','workstation-unified-full-stack'].map(name=>path.join(env.geminiRulesDir,name+'.md')),
    ...['design.md','full-stack.md'].map(name=>path.join(env.geminiConfigDir,'workstation-unified/guides',name))];
  for(const file of files){fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,'original '+path.basename(file));}
  const before=files.map(file=>fs.readFileSync(file)),copy=fs.copyFileSync;let injected=false;
  t.mock.method(fs,'copyFileSync',function(source,...args){const result=copy.call(fs,source,...args);if(source===files[0]){fs.writeFileSync(source,'concurrent personal instructions');injected=true;}return result;});
  let failure;try{require('../lib/installer').runInstaller({rulesOnly:true,home:env.userProfile,log(){}});}catch(error){failure=error;}
  assert.equal(injected,true);assert.equal(fs.readFileSync(files[0],'utf8'),'concurrent personal instructions');
  assert.match(failure?.message||'',/Profile file changed during installation/);
  for(let index=1;index<files.length;index++)assert.deepEqual(fs.readFileSync(files[index]),before[index]);
});

test('Personal theme token rules survive installer and editor application with personal rules retaining last priority', () => {
  const ownRule = { scope: 'comment', settings: { fontStyle: 'italic' } };
  const userRule = { scope: 'comment', settings: { foreground: '#123456' } };
  const previous = { '[Light+]': { textMateRules: [userRule] }, textMateRules: [userRule],
    '[One Dark Pro]': { textMateRules: [userRule], personalSetting: true } };
  const desired = { '[One Dark Pro]': { comments: '#7F848E', textMateRules: [ownRule] } };
  const merged = mergeSettings({ 'workbench.colorTheme': 'Light+', 'editor.tokenColorCustomizations': previous },
    { 'workbench.colorTheme': 'One Dark Pro', 'editor.tokenColorCustomizations': desired });
  assert.equal(merged['workbench.colorTheme'], 'Light+');
  const tokens = merged['editor.tokenColorCustomizations'];
  assert.deepEqual(tokens['[Light+]'], previous['[Light+]']);
  assert.deepEqual(tokens.textMateRules, [userRule]);
  assert.deepEqual(tokens['[One Dark Pro]'].textMateRules, [ownRule, userRule]);
  assert.equal(tokens['[One Dark Pro]'].personalSetting, true);
  assert.deepEqual(mergeManagedValue('editor.tokenColorCustomizations', tokens, desired), tokens);
});

test('personal editor visual preferences survive setup without replacing false values and nested palettes', () => {
  const { mergeSettings } = require('../lib/profile-settings');
  const current = {
    'editor.guides.indentation': false,
    'editor.guides.bracketPairs': true,
    'editor.fontFamily': 'Personal Mono',
    'workbench.settings.applyToAllProfiles': ['personal.key'],
    'workbench.colorCustomizations': { 'editor.background': '#123456', '[My Theme]': { 'editor.foreground': '#abcdef' } },
    'editor.semanticTokenColorCustomizations': { rules: { 'variable.readonly': { bold: true } } },
    'errorLens.enabled': false,
    'prettier.requireConfig': true,
    'git.autofetch': false,
    '[typescriptreact]': { 'editor.fontSize': 21, 'editor.guides.indentation': false }
  };
  const desired = Object.fromEntries(Object.keys(current).map(key => [key, {}]));
  const merged = mergeSettings(current, desired);
  for (const [key,value] of Object.entries(current)) {
    if (key === 'editor.tokenColorCustomizations') continue;
    assert.deepEqual(merged[key], value, key);
  }
  assert.equal(mergeSettings({'editor.tabSize': 6}, {'editor.tabSize': 2})['editor.tabSize'], 2,
    'Non-appearance managed settings still migrate');
  const restored = mergeSettings({ 'editor.guides.bracketPairs': false, 'editor.fontLigatures': false },
    { 'editor.guides.bracketPairs': 'active', 'editor.fontLigatures': true });
  assert.deepEqual(restored, { 'editor.guides.bracketPairs': 'active', 'editor.fontLigatures': true },
    'Values earlier setups wrote move to the active scope line and ligatures');
});

test('Upgrade delivers new managed appearance keys while personal values stay verbatim', () => {
  const current = {
    'htmlEndTagLabels.labelPrefix': '/',
    'htmlEndTagLabels.labelColor': '#8b949e99',
    'workbench.colorCustomizations': {
      'errorLens.errorForeground': '#ff000080',
      'errorLens.errorBackground': '#00000000',
      // Near-invisible colors an earlier setup wrote, not personal choices.
      'editorWarning.foreground': '#fbbf2426',
      'errorLens.hintForegroundLight': '#94a3b833',
      'htmlEndTagLabels.labelColor': '#8b949e99',
    },
    'workbench.settings.applyToAllProfiles': ['personal.setting', 'window.zoomLevel'],
    'editor.fontFamily': 'Personal Mono',
  };
  const managed = require('../config/settings.json');
  const merged = mergeSettings(current, managed);
  const customizations = merged['workbench.colorCustomizations'];
  assert.equal(customizations['errorLens.errorForeground'], '#ff000080', 'personal errorLens value preserved');
  for (const key of ['editorWarning.foreground', 'errorLens.hintForegroundLight']) {
    assert.equal(customizations[key], managed['workbench.colorCustomizations'][key], key + ' moves to the visible profile color');
  }
  assert.equal(Object.hasOwn(merged, 'htmlEndTagLabels.labelPrefix'), false, 'retired HTML End Tag Labels prefix leaves on upgrade');
  assert.equal(Object.hasOwn(merged, 'htmlEndTagLabels.labelColor'), false, 'retired HTML End Tag Labels color leaves on upgrade');
  assert.equal(Object.hasOwn(customizations, 'htmlEndTagLabels.labelColor'), false, 'retired HTML End Tag Labels color customization leaves on upgrade');
  const legacyZero = mergeSettings({ 'workbench.colorCustomizations': { 'htmlEndTagLabels.labelColor': '#00000000' } }, managed);
  assert.equal(Object.hasOwn(legacyZero['workbench.colorCustomizations'], 'htmlEndTagLabels.labelColor'), false, 'older hidden #00000000 end-tag color also leaves on upgrade');
  assert.equal(customizations['errorLens.errorBackgroundLight'], '#00000000', 'new managed transparent keys reach the upgrade');
  assert.equal(customizations['errorLens.warningRangeBackground'], '#00000000', 'new managed range keys reach the upgrade');
  const shared = merged['workbench.settings.applyToAllProfiles'];
  assert.ok(shared.includes('personal.setting'), 'user-added sharing entries survive');
  assert.ok(shared.includes('terminal.integrated.fontFamily'), 'managed sharing additions reach the upgrade');
  assert.ok(shared.includes('scm.inputFontFamily'), 'scm sharing additions reach the upgrade');
  assert.equal(merged['editor.fontFamily'], 'Personal Mono', 'personal font stays');
});

test('Apply-profile keeps a studio font on every surface instead of splitting editor and terminal', () => {
  const { FONT_FAMILY_KEYS } = require('../extensions/aster-appearance/appearance.cjs');
  const current = Object.fromEntries(FONT_FAMILY_KEYS.map(key => [key, "'Fira Code', monospace"]));
  current['terminal.integrated.fontWeight'] = 500;
  const managed = require('../config/settings.json');
  const merged = mergeSettings(current, managed, { userLanguageOverrides: false });
  for (const key of FONT_FAMILY_KEYS) assert.equal(merged[key], "'Fira Code', monospace", key + ' keeps the personal font');
  assert.equal(merged['terminal.integrated.fontWeight'], 500);
});

test('Settings of removed extensions are deleted instead of being carried forward', () => {
  const { isRetiredSetting } = require('../lib/profile-settings');
  const current = { 'turboConsoleLog.quote': "'", 'turboConsoleLog.includeLineNum': true, 'tsMancho.quiet': true, 'editor.fontSize': 17 };
  const merged = mergeSettings(current, require('../config/settings.json'));
  assert.equal(Object.keys(merged).some(isRetiredSetting), false);
  assert.equal(isRetiredSetting('tsMancho.quiet'), false, 'old Calm TypeScript keys keep their own migration');
  assert.equal(merged['editor.fontSize'], 17, 'personal settings stay');
  assert.equal(isRetiredSetting('editor.turboConsoleLog'), false, 'only the exact prefix is retired');
  const autoRename = mergeSettings({ 'auto-rename-tag.activationOnLanguage': ['html'] }, require('../config/settings.json'));
  assert.equal(Object.hasOwn(autoRename, 'auto-rename-tag.activationOnLanguage'), false, 'Auto Rename Tag settings leave with the extension');
});

test('Language blocks drop the values earlier setups repeated there while personal language values stay', () => {
  const managed = require('../config/settings.json');
  const oldBlock = { 'editor.defaultFormatter': 'esbenp.prettier-vscode', 'editor.inlineSuggest.enabled': false, 'editor.tabSize': 3,
    'editor.insertSpaces': true, 'editor.detectIndentation': false, 'editor.tabCompletion': 'on', 'editor.snippetSuggestions': 'top',
    'editor.suggest.showSnippets': true, 'editor.suggestOnTriggerCharacters': true,
    'editor.quickSuggestions': { other: true, comments: false, strings: true }, 'editor.autoClosingBrackets': 'always',
    'editor.autoClosingQuotes': 'always', 'editor.autoClosingOvertype': 'always', 'editor.autoClosingDelete': 'always' };
  const current = { 'editor.tabSize': 3, 'prettier.tabWidth': 3, '[typescript]': { ...oldBlock, 'editor.rulers': [100] },
    '[markdown]': { 'editor.quickSuggestions': oldBlock['editor.quickSuggestions'], 'editor.tabSize': 3 },
    '[javascript]': { 'editor.tabSize': 4, 'editor.tabCompletion': 'off' }, '[python]': { 'editor.tabSize': 3 } };
  const ordinary = mergeSettings(current, managed);
  assert.deepEqual(ordinary['[typescript]'], { 'editor.defaultFormatter': 'esbenp.prettier-vscode', 'editor.inlineSuggest.enabled': false, 'editor.rulers': [100] });
  assert.deepEqual(ordinary['[markdown]'], managed['[markdown]'], 'a value the block still manages stays, the repeated one leaves');
  assert.deepEqual(ordinary['[javascript]'], { 'editor.tabSize': 4, 'editor.tabCompletion': 'off', 'editor.defaultFormatter': 'esbenp.prettier-vscode' },
    'an ordinary update keeps personal language values');
  assert.deepEqual(ordinary['[python]'], { 'editor.tabSize': 3 }, 'unmanaged languages are not touched');
  const profile = mergeSettings(current, managed, { userLanguageOverrides: false });
  assert.deepEqual(profile['[javascript]'], managed['[javascript]'], 'command 2 lets the global profile values apply in managed languages');
  assert.deepEqual(profile['[python]'], { 'editor.tabSize': 3 });
  const quiet = mergeSettings(current, { ...managed, '[python]': { 'editor.inlineSuggest.enabled': false } }, { userLanguageOverrides: false });
  assert.deepEqual(quiet['[python]'], { 'editor.tabSize': 3, 'editor.inlineSuggest.enabled': false }, 'other languages keep their own indentation');
  for (const key of ['editor.tabSize', 'prettier.tabWidth']) assert.equal(managed[key], 2, key);
  for (const block of Object.keys(managed).filter(key => key.startsWith('['))) {
    assert.ok(Object.keys(managed[block]).every(setting => !Object.hasOwn(oldBlock, setting) || setting === 'editor.defaultFormatter'
      || (block === '[markdown]' && setting === 'editor.quickSuggestions')), block + ' keeps only language-specific values');
  }
});

test('Retired setup shortcuts leave both merge directions while personal shortcuts stay', () => {
  const { mergeKeybindings } = require('../lib/profile-settings');
  const managed = require('../config/keybindings.json');
  const retired = { key: 'ctrl+shift+f', command: 'editor.action.formatDocument', when: 'editorTextFocus && !editorReadonly' };
  const personal = { key: 'ctrl+shift+f', command: 'personal.search' };
  assert.equal(managed.some(binding => binding.key === 'ctrl+shift+f'), false, 'Ctrl+Shift+F is Find in Files again');
  for (const binding of ['shift+alt+f', 'ctrl+alt+f']) assert.ok(managed.some(item => item.key === binding && item.command === 'editor.action.formatDocument'));
  const current = [retired, personal];
  for (const merged of [mergeKeybindings(current, managed), mergeKeybindings(managed, current)]) {
    assert.equal(merged.some(binding => JSON.stringify(binding) === JSON.stringify(retired)), false);
    assert.ok(merged.some(binding => binding.command === 'personal.search'));
    assert.equal(merged.filter(binding => binding.command === 'editor.action.formatDocument').length, 2);
  }
});

test('Auto-approve workflow persists full-stack grants while preserving explicit denials and ignoring workspace files', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workstation-perms-boundary-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const customRoots = { userProfile: path.join(root, 'Owner'), gitBashPath: process.execPath };
  const env = require('../lib/paths').getEnvironmentPaths(customRoots);
  // Seed personal explicit denials and an unrelated untrusted workspace with a hostile .vscode/settings.json
  fs.mkdirSync(path.dirname(env.settingsJson), { recursive: true });
  fs.writeFileSync(env.settingsJson, JSON.stringify({
    'chat.tools.terminal.autoApprove': { 'rm -rf': false, 'git push --force': false },
    'personal.orgPolicy': 'keep',
  }));
  const antigravityFile = path.join(env.geminiDir, 'antigravity/settings.json');
  fs.mkdirSync(path.dirname(antigravityFile), { recursive: true });
  fs.writeFileSync(antigravityFile, JSON.stringify({
    permissions: { allow: ['command(git status)'], deny: ['command(rm -rf *)', 'write_file(/etc/*)'] },
  }));
  const untrustedWorkspace = path.join(root, 'untrusted-repo', '.vscode');
  fs.mkdirSync(untrustedWorkspace, { recursive: true });
  fs.writeFileSync(path.join(untrustedWorkspace, 'settings.json'), JSON.stringify({
    'permissions': { allow: ['dangerous_override(*)'] },
    'chat.tools.terminal.autoApprove': { 'rm -rf': true },
  }));

  const opts = { customRoots, autoApprove: true, applyProfile: true, quietCompletion: true, skipExtensions: true, skipAgentBrowser: true, skipFont: true, log() {} };
  const first = require('../lib/installer').runInstaller(opts);
  assert.equal(first.success, true, first.failures?.join('; '));

  const settings = JSON.parse(fs.readFileSync(env.settingsJson, 'utf8'));
  assert.equal(settings['chat.tools.terminal.autoApprove']['/.*/'], true);
  assert.equal(settings['chat.tools.terminal.autoApprove']['rm -rf'], false, 'explicit terminal denial must survive --auto-approve');
  assert.equal(settings['chat.tools.terminal.autoApprove']['git push --force'], false);
  assert.equal(settings['personal.orgPolicy'], 'keep');

  const agentSettings = JSON.parse(fs.readFileSync(antigravityFile, 'utf8'));
  for (const grant of ['command(*)', 'read_file(*)', 'write_file(*)', 'read_url(*)', 'unsandboxed(*)', 'mcp(*)']) {
    assert.ok(agentSettings.permissions.allow.includes(grant), grant + ' granted for full-stack automation');
  }
  assert.deepEqual(agentSettings.permissions.deny, ['command(rm -rf *)', 'write_file(/etc/*)'], 'explicit agent denials stay intact');
  assert.equal(agentSettings.permissions.allow.includes('dangerous_override(*)'), false, 'untrusted workspace settings cannot expand global permissions');

  // Repeat upgrade preserves everything identically without duplicating grants
  const second = require('../lib/installer').runInstaller(opts);
  assert.equal(second.success, true, second.failures?.join('; '));
  const afterSecond = JSON.parse(fs.readFileSync(antigravityFile, 'utf8'));
  assert.deepEqual(afterSecond.permissions.allow, agentSettings.permissions.allow);
  assert.deepEqual(afterSecond.permissions.deny, agentSettings.permissions.deny);
});
