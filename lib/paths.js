'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFileSync } = require('child_process');
const { findAntigravity } = require('./install-paths');

function findGitBash(customRoots, { isWindows, paths, env, exists, run, userProfile, localAppData, programFiles }) {
  if (customRoots.gitBashPath && exists(customRoots.gitBashPath)) return customRoots.gitBashPath;
  if (env.GIT_BASH_PATH && exists(env.GIT_BASH_PATH)) return env.GIT_BASH_PATH;

  const candidates = [];
  const seen = new Set();
  const addCandidate = file => {
    if (!file) return;
    const key = isWindows ? file.toLowerCase() : file;
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push(file);
  };
  const addGitRoot = root => {
    if (!root) return;
    addCandidate(paths.join(root, 'bin', 'bash.exe'));
    addCandidate(paths.join(root, 'usr', 'bin', 'bash.exe'));
  };
  const addFromFile = file => {
    if (!file) return;
    let directory = paths.dirname(file);
    for (let level = 0; level < 4 && directory; level++) {
      addGitRoot(directory);
      const parent = paths.dirname(directory);
      if (!parent || parent === directory) break;
      directory = parent;
    }
  };

  const gitExecutables = [];
  if (isWindows) {
    // Check PATH entries directly first (no subprocess overhead) and also query where.exe.
    const rawPath = env.PATH || env.Path || '';
    for (const entry of rawPath.split(';').map(item => item.trim().replace(/^"|"$/g, '')).filter(Boolean)) {
      const gitCandidate = paths.join(entry, 'git.exe');
      if (exists(gitCandidate)) gitExecutables.push(gitCandidate);
      const gitBashLauncher = paths.join(entry, 'git-bash.exe');
      if (exists(gitBashLauncher)) addFromFile(gitBashLauncher);
    }
    try {
      const located = run('where.exe', ['git.exe'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, timeout: 5000 })
        .trim().split(/\r?\n/).map(line => line.trim()).filter(Boolean);
      gitExecutables.push(...located);
    } catch {}
    for (const gitExe of gitExecutables) addFromFile(gitExe);
  }

  // Standard Git for Windows install directories (machine-wide, per-user, 32-bit, Scoop, drive root).
  addGitRoot(paths.join(programFiles, 'Git'));
  if (isWindows) {
    if (env.ProgramW6432) addGitRoot(paths.join(env.ProgramW6432, 'Git'));
    if (env['ProgramFiles(x86)']) addGitRoot(paths.join(env['ProgramFiles(x86)'], 'Git'));
    addGitRoot(paths.join(localAppData, 'Programs', 'Git'));
    addGitRoot(paths.join(userProfile, 'scoop', 'apps', 'git', 'current'));
    addGitRoot(paths.join(env.SystemDrive || 'C:', 'Git'));
  }

  const foundFast = candidates.find(candidate => exists(candidate));
  if (foundFast) return foundFast;

  if (isWindows) {
    // Shim launchers (Scoop, Chocolatey, WinGet Links) live outside the real Git folder;
    // asking git.exe for --exec-path resolves the true Git installation directory.
    const probed = new Set();
    for (const gitExe of gitExecutables) {
      const key = gitExe.toLowerCase();
      if (probed.has(key) || !exists(gitExe)) continue;
      probed.add(key);
      try {
        const execPath = run(gitExe, ['--exec-path'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, timeout: 5000 })
          .trim().split(/\r?\n/)[0]?.trim();
        if (execPath) {
          addFromFile(paths.join(execPath.replace(/\//g, '\\'), 'git.exe'));
          const found = candidates.find(candidate => exists(candidate));
          if (found) return found;
        }
      } catch {}
    }
    // Fall back to Git for Windows registry keys when PATH only has MinGit or omits Git.
    for (const key of ['HKLM\\SOFTWARE\\GitForWindows', 'HKCU\\SOFTWARE\\GitForWindows', 'HKLM\\SOFTWARE\\WOW6432Node\\GitForWindows']) {
      try {
        const output = run('reg.exe', ['query', key, '/v', 'InstallPath'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, timeout: 5000 });
        const match = output.match(/InstallPath\s+REG_\w+\s+(.+)/i);
        if (match) {
          addGitRoot(match[1].trim().replace(/^"|"$/g, ''));
          const found = candidates.find(candidate => exists(candidate));
          if (found) return found;
        }
      } catch {}
    }
  }
  return null;
}

function getEnvironmentPaths(customRoots = {}, runtime = {}) {
  const isWindows = (runtime.platform || process.platform) === 'win32';
  // Windows paths on Windows; native paths elsewhere, so tests on Linux and macOS work on real folders.
  const paths = isWindows ? path.win32 : path;
  const env = runtime.env || process.env;
  const exists = runtime.existsSync || fs.existsSync;
  const run = runtime.execFileSync || execFileSync;
  const userProfile = customRoots.userProfile || env.USERPROFILE || os.homedir();
  const appData = customRoots.appData || (!customRoots.userProfile && env.APPDATA) || paths.join(userProfile, 'AppData', 'Roaming');
  const localAppData = customRoots.localAppData || (!customRoots.userProfile && env.LOCALAPPDATA) || paths.join(userProfile, 'AppData', 'Local');
  const programFiles = env.ProgramFiles || path.win32.join(env.SystemDrive || 'C:', 'Program Files');
  const { cliPath, ideRoot } = findAntigravity({ ...customRoots, localAppData, programFiles, isolated: !!customRoots.userProfile }, runtime);
  let userDataName = 'Antigravity IDE', dataFolderName = '.antigravity-ide', applicationName = 'antigravity-ide';
  if (ideRoot) {
    try {
      const read = runtime.readFileSync || fs.readFileSync;
      const product = JSON.parse(read(paths.join(ideRoot, 'resources', 'app', 'product.json'), 'utf8'));
      if (/^Antigravity(?: IDE)?$/i.test(product.nameShort)) userDataName = product.nameShort;
      if (/^\.antigravity(?:-ide)?$/i.test(product.dataFolderName)) dataFolderName = product.dataFolderName;
      if (/^antigravity(?:-ide)?$/i.test(product.applicationName)) applicationName = product.applicationName;
    } catch {   }
  }

  const userSettingsDir = paths.join(appData, userDataName, 'User');
  const extensionsDir = paths.join(userProfile, dataFolderName, 'extensions');
  const geminiDir = paths.join(userProfile, '.gemini');
  const geminiConfigDir = paths.join(geminiDir, 'config');
  const geminiRulesDir = paths.join(geminiConfigDir, 'rules');
  const geminiSkillsDir = paths.join(geminiConfigDir, 'skills');
  const geminiScriptsDir = paths.join(geminiDir, 'scripts');
  const antigravityToolsDir = paths.join(userProfile, '.antigravity-tools');
  const antigravityStateDir = paths.join(userProfile, '.antigravity');
  const backupsDir = paths.join(geminiDir, 'backups');

  const gitBashPath = findGitBash(customRoots, { isWindows, paths, env, exists, run, userProfile, localAppData, programFiles });

  return {
    isWindows,
    userProfile,
    appData,
    localAppData,
    programFiles,
    cliPath,
    ideRoot,
    userSettingsDir,
    settingsJson: paths.join(userSettingsDir, 'settings.json'),
    keybindingsJson: paths.join(userSettingsDir, 'keybindings.json'),
    argvJson: paths.join(userProfile, dataFolderName, 'argv.json'),
    extensionsDir,
    geminiDir,
    geminiConfigDir,
    applicationName,
    nativeHooksJson: paths.join(geminiDir, applicationName, 'hooks.json'),
    geminiRulesDir,
    geminiSkillsDir,
    geminiScriptsDir,
    antigravityToolsDir,
    antigravityStateDir,
    backupsDir,
    gitBashPath,
    nodeExe: process.execPath,
    totalMemoryBytes: customRoots.totalMemoryBytes ?? (runtime.totalmem || os.totalmem)(),
  };
}

module.exports = { getEnvironmentPaths };
