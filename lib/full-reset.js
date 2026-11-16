'use strict';
// README command 1 starts Antigravity from nothing. Every folder the IDE, its
// agent and this setup keep for the Windows user moves into one dated backup:
// settings, shortcuts, snippets, profiles, extensions, sign-in, chats, agent
// memory, rules, skills, agents, MCP servers, hooks and permissions. Project
// folders are not touched, and earlier backups stay where they are.
const fs = require('node:fs');
const path = require('node:path');

const USER_DATA_NAMES = ['Antigravity IDE', 'Antigravity'];
const HOME_FOLDERS = ['.antigravity-ide', '.antigravity', '.antigravity-tools'];
// What Electron and VS Code rebuild by themselves in a user-data folder: caches,
// downloaded VSIX copies, crash dumps and old logs. They are deleted from the
// backup once the move is complete, so the backup keeps only what can matter
// again. User\History (local file history), User\workspaceStorage,
// User\globalStorage (sign-in), Backups (unsaved files), Local Storage,
// IndexedDB, Network and Local State are data and stay in the backup.
const CACHE_FOLDERS = ['Cache', 'CachedConfigurations', 'CachedData', 'CachedExtensionVSIXs', 'CachedProfilesData',
  'Code Cache', 'Crashpad', 'DawnCache', 'DawnGraphiteCache', 'DawnWebGPUCache', 'GPUCache', 'GrShaderCache',
  'ShaderCache', 'Service Worker', 'blob_storage', 'logs'];
const BUSY = new Set(['EPERM', 'EBUSY', 'EACCES']);

const exists = file => fs.lstatSync(file, { throwIfNoEntry: false }) !== undefined;
const inside = (child, parent) => {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === '' || (!!relative && !relative.startsWith('..') && !path.isAbsolute(relative));
};
const pause = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// The folders to clear, each with its place inside the backup and, for an IDE
// profile, the user-data folder inside it that holds the caches.
function resetTargets(env) {
  const targets = [];
  const add = (from, area, name, userData) => { if (exists(from)) targets.push({ from, backup: area + '/' + name, userData }); };
  for (const name of USER_DATA_NAMES) add(path.join(env.appData, name), 'appdata', name, '');
  for (const name of HOME_FOLDERS) add(path.join(env.userProfile, name), 'home', name);
  // A "data" folder beside the executable is the IDE's portable profile; it wins over AppData.
  if (env.ideRoot) add(path.join(env.ideRoot, 'data'), 'portable', 'data', 'user-data');
  if (exists(env.geminiDir) && fs.lstatSync(env.geminiDir).isDirectory()) {
    // Earlier backups stay; the new one is created beside them.
    const backups = path.resolve(env.backupsDir).toLowerCase();
    for (const name of fs.readdirSync(env.geminiDir).sort()) {
      if (path.resolve(env.geminiDir, name).toLowerCase() !== backups) add(path.join(env.geminiDir, name), 'gemini', name);
    }
  }
  return targets;
}

function defaultMove(from, to) {
  for (let attempt = 1; ; attempt++) {
    try { fs.renameSync(from, to); return; } catch (error) {
      if (error.code === 'EXDEV') {
        // Another volume (for example a redirected AppData): copy, then remove the original.
        fs.cpSync(from, to, { recursive: true, errorOnExist: true, force: false, verbatimSymlinks: true });
        try { fs.rmSync(from, { recursive: true }); } catch (removeError) {
          fs.cpSync(to, from, { recursive: true, errorOnExist: false, force: false, verbatimSymlinks: true });
          fs.rmSync(to, { recursive: true, force: true });
          throw removeError;
        }
        return;
      }
      // Antivirus and search indexers hold files for a moment; a running program holds them longer.
      if (!BUSY.has(error.code) || attempt >= 5) throw error;
      pause(1000);
    }
  }
}

function writeManifest(file, manifest) {
  fs.writeFileSync(file, JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 });
}

function fullReset(env, options = {}) {
  const move = options.move || defaultMove;
  const targets = resetTargets(env);
  const protectedPaths = [['Antigravity IDE', env.ideRoot], ['this setup', options.repoRoot || path.resolve(__dirname, '..')]];
  for (const [label, protectedPath] of protectedPaths) {
    const holder = protectedPath && targets.find(target => inside(protectedPath, target.from));
    if (holder) throw new Error(label + ' is inside ' + holder.from + '; move it elsewhere before a full reset. Nothing was changed.');
  }
  const stamp = (options.now || new Date()).toISOString().replace(/[-:]/g, '').replace(/\..*$/, '');
  const root = path.join(env.backupsDir, 'full-reset-' + stamp);
  const items = targets.map(target => ({ from: target.from, to: path.join(root, ...target.backup.split('/')) }));
  const caches = targets.flatMap((target, index) => target.userData === undefined ? [] : CACHE_FOLDERS
    .map(name => path.join(target.userData, name))
    .filter(relative => exists(path.join(target.from, relative)))
    .map(relative => ({ from: path.join(target.from, relative), to: path.join(items[index].to, relative) })));
  if (options.dryRun) return { dryRun: true, backup: root, items, caches };
  if (exists(root)) throw new Error('Full reset backup already exists: ' + root + '; run the command again in a minute.');
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const manifestFile = path.join(root, 'manifest.json');
  const manifest = { format: 1, kind: 'full-reset', createdAt: new Date().toISOString(), state: 'moving', items };
  writeManifest(manifestFile, manifest);
  const moved = [];
  try {
    for (const item of items) {
      fs.mkdirSync(path.dirname(item.to), { recursive: true });
      move(item.from, item.to);
      moved.push(item);
    }
  } catch (error) {
    const failures = [];
    for (const item of moved.reverse()) {
      try { move(item.to, item.from); } catch (rollback) { failures.push(item.from + ': ' + rollback.message); }
    }
    manifest.state = failures.length ? 'rollback-incomplete' : 'rolled-back';
    manifest.error = error.message;
    writeManifest(manifestFile, manifest);
    const failed = items[moved.length]?.from || 'a profile folder';
    const busy = BUSY.has(error.code) ? ' A program still uses it (for example an Antigravity agent such as agy.exe or a Gemini CLI window).'
      + ' Close it or restart Windows, then run command 1 again.' : '';
    throw new Error('Full reset stopped at ' + failed + ': ' + error.message + '.' + busy
      + (failures.length ? ' Some folders are still in the backup ' + root + ': ' + failures.join('; ') : ' Nothing was removed: every moved folder is back in place.'));
  }
  // Only now, with everything in the backup, do the rebuildable caches leave it.
  // A cache that cannot be deleted stays in the backup and is listed.
  const deletedCaches = [], keptCaches = [];
  for (const cache of caches) {
    try { fs.rmSync(cache.to, { recursive: true, force: true, maxRetries: 2 }); deletedCaches.push(cache.from); }
    catch (error) { keptCaches.push(cache.to + ': ' + error.message); }
  }
  Object.assign(manifest, { state: 'complete', completedAt: new Date().toISOString(), deletedCaches }, keptCaches.length ? { keptCaches } : {});
  writeManifest(manifestFile, manifest);
  return { backup: root, items, deletedCaches, keptCaches };
}

module.exports = { CACHE_FOLDERS, resetTargets, fullReset };
