'use strict';

// Explorer → npm scripts: the scripts of each package.json in the open
// folders. A click runs `npm run <name>` in a terminal of its own with the
// user's default profile (Git Bash), exactly as if it was typed there; the
// output stays in that terminal. A dev server's local address is read from
// the terminal and offered for the browser.
const fs = require('fs');
const path = require('path');
const { quoteArg, stripAnsi, waitForShellIntegration, collectOutput } = require('./shell');
const { tr } = require('./text');

const VIEW_ID = 'workstationNpmScripts';
const COMMON_SCRIPTS = ['dev', 'start', 'build', 'preview', 'lint', 'test'];
const RELOAD_DELAY_MS = 300;
const STOP_WAIT_MS = 3000;
const URL_SEARCH_LIMIT = 4096;
const CTRL_C = '\x03';

// Common scripts first, in the usual order, then the rest alphabetically.
function sortScripts(names) {
  const rank = name => {
    const index = COMMON_SCRIPTS.indexOf(name);
    return index < 0 ? COMMON_SCRIPTS.length : index;
  };
  return [...names].sort((left, right) => rank(left) - rank(right) || left.localeCompare(right));
}

// { dir, name, scripts: [{ name, command }] } or null without scripts.
async function readPackage(dir) {
  try {
    const manifest = JSON.parse((await fs.promises.readFile(path.join(dir, 'package.json'), 'utf8')).replace(/^﻿/, ''));
    const scripts = manifest?.scripts && typeof manifest.scripts === 'object' ? manifest.scripts : {};
    const names = Object.keys(scripts).filter(name => typeof scripts[name] === 'string');
    if (!names.length) return null;
    return { dir, name: typeof manifest.name === 'string' ? manifest.name : '', scripts: sortScripts(names).map(name => ({ name, command: scripts[name] })) };
  } catch {
    return null;
  }
}

// Each workspace folder's own package.json; a folder without scripts there
// shows its first-level subfolders that have them (frontend/, backend/).
async function findPackages(folders) {
  const found = await Promise.all(folders.map(async folder => {
    const root = await readPackage(folder.dir);
    if (root) return [{ ...root, label: folder.name, nested: false }];
    const entries = await fs.promises.readdir(folder.dir, { withFileTypes: true }).catch(() => []);
    const subfolders = entries.filter(entry => entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules')
      .map(entry => entry.name).sort((left, right) => left.localeCompare(right));
    const packages = await Promise.all(subfolders.map(name => readPackage(path.join(folder.dir, name))
      .then(pkg => pkg && { ...pkg, label: name, nested: true })));
    return packages.filter(Boolean);
  }));
  return found.flat();
}

// http(s) on localhost, 127.0.0.1, 0.0.0.0, [::1] or a LAN address with a port.
const LOCAL_URL = /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\]|(?:\d{1,3}\.){3}\d{1,3}):\d{2,5}(?:\/[^\s'"<>`]*)?/gi;
const LOOPBACK = /^https?:\/\/(?:localhost|127\.|0\.0\.0\.0|\[)/i;

// The address a dev server printed (Vite, Next.js, …); the local one wins
// over a network one. 0.0.0.0 and [::] are opened as localhost.
function findLocalUrl(text) {
  const urls = stripAnsi(text).match(LOCAL_URL) || [];
  const url = urls.find(item => LOOPBACK.test(item)) || urls[0];
  return url ? url.replace(/\/\/(?:0\.0\.0\.0|\[::\])/, '//localhost').replace(/[.,;:)\]]+$/, '') : null;
}

class NpmScripts {
  constructor(vscode) {
    this.vscode = vscode;
    this.changes = new vscode.EventEmitter();
    this.onDidChangeTreeData = this.changes.event;
    this.packages = null;
    // Script key -> { terminal, running, execution, url, stopped }.
    this.runs = new Map();
    this.reloadTimer = null;
  }

  register() {
    const { window, commands, workspace } = this.vscode;
    const watcher = workspace.createFileSystemWatcher('**/package.json');
    const onPackage = uri => { if (!/[\\/]node_modules[\\/]/.test(uri?.fsPath || '')) this.reload(); };
    const command = (name, callback) => commands.registerCommand(`${VIEW_ID}.${name}`, node => this.guard(callback, node));
    return [
      window.createTreeView(VIEW_ID, { treeDataProvider: this }),
      command('refresh', () => this.reload()),
      command('run', node => this.run(node)),
      command('stop', node => this.stop(node)),
      command('restart', node => this.restart(node)),
      command('openUrl', node => this.openUrl(this.runs.get(node.key)?.url)),
      watcher, watcher.onDidCreate(onPackage), watcher.onDidChange(onPackage), watcher.onDidDelete(onPackage),
      workspace.onDidChangeWorkspaceFolders(() => this.reload()),
      window.onDidCloseTerminal(terminal => this.closed(terminal)),
      window.onDidStartTerminalShellExecution?.(event => this.started(event)),
      window.onDidEndTerminalShellExecution?.(event => this.ended(event)),
      this.changes,
      { dispose: () => clearTimeout(this.reloadTimer) },
    ].filter(Boolean);
  }

  async guard(callback, node) {
    try {
      await callback(node);
    } catch (error) {
      this.vscode.window.showErrorMessage(tr('npm-скрипт: ', 'npm script: ') + (error?.message || error));
    }
  }

  reload() {
    clearTimeout(this.reloadTimer);
    this.reloadTimer = setTimeout(() => {
      this.packages = null;
      this.changes.fire();
    }, RELOAD_DELAY_MS);
  }

  changed() {
    this.changes.fire();
  }

  loadPackages() {
    const folders = (this.vscode.workspace.workspaceFolders || []).map(folder => ({ name: folder.name, dir: folder.uri.fsPath }));
    this.packages ||= findPackages(folders);
    return this.packages;
  }

  // One package: its scripts at the top. Several: a node per package.
  async getChildren(node) {
    if (node?.kind === 'script') return [];
    const packages = await this.loadPackages();
    const pkg = node?.pkg || (packages.length === 1 ? packages[0] : null);
    if (!pkg) return packages.map(item => ({ kind: 'package', pkg: item }));
    return pkg.scripts.map(script => ({ kind: 'script', pkg, ...script, key: pkg.dir + '\0' + script.name }));
  }

  getTreeItem(node) {
    const { TreeItem, TreeItemCollapsibleState, ThemeIcon } = this.vscode;
    if (node.kind === 'package') {
      const item = new TreeItem(node.pkg.label, TreeItemCollapsibleState.Expanded);
      item.description = node.pkg.name && node.pkg.name !== node.pkg.label ? node.pkg.name : '';
      item.tooltip = node.pkg.dir;
      item.iconPath = new ThemeIcon('package');
      return item;
    }
    const run = this.runs.get(node.key);
    const item = new TreeItem(node.name, TreeItemCollapsibleState.None);
    item.description = run?.url ? '🔗 ' + run.url : node.command;
    item.tooltip = `npm run ${node.name}\n${node.command}`;
    item.iconPath = new ThemeIcon(run?.running ? 'sync~spin' : 'play');
    item.contextValue = run?.url ? 'serving' : run?.running ? 'running' : 'script';
    item.command = { command: `${VIEW_ID}.run`, title: tr('Запустить', 'Run'), arguments: [node] };
    return item;
  }

  terminalName(node) {
    return `npm: ${node.name}` + (node.pkg.nested ? ` (${node.pkg.label})` : '');
  }

  // A running script only shows its terminal; otherwise the command runs in
  // the script's terminal, which is created once and then reused.
  async run(node) {
    const previous = this.runs.get(node.key);
    if (previous?.running) {
      previous.terminal.show();
      return;
    }
    const { window } = this.vscode;
    const terminal = previous?.terminal || window.createTerminal({ name: this.terminalName(node), cwd: node.pkg.dir });
    const run = { terminal, running: true, execution: null, url: null, stopped: null };
    this.runs.set(node.key, run);
    this.changed();
    terminal.show();
    const integration = previous ? terminal.shellIntegration : await waitForShellIntegration(window, terminal);
    if (this.runs.get(node.key) !== run) return;
    const line = 'npm run ' + quoteArg(node.name);
    // Without shell integration the command is typed as usual; its address
    // and end are then unknown, so it counts as running until stopped.
    if (!integration) terminal.sendText(line);
    else this.watch(run, integration.executeCommand(line));
  }

  watch(run, execution) {
    run.execution = execution;
    collectOutput(execution, URL_SEARCH_LIMIT, text => {
      if (run.url || run.execution !== execution) return;
      // Only finished lines: a chunk may end in the middle of the address.
      const url = findLocalUrl(text.slice(0, text.lastIndexOf('\n') + 1));
      if (!url) return;
      run.url = url;
      this.changed();
      this.announce(url);
    });
  }

  async announce(url) {
    const open = tr('Открыть', 'Open');
    const choice = await this.vscode.window.showInformationMessage(tr(`Сервер запущен: ${url}`, `The server is running: ${url}`), open);
    if (choice === open) await this.openUrl(url);
  }

  openUrl(url) {
    if (url) return this.vscode.env.openExternal(this.vscode.Uri.parse(url));
  }

  stop(node) {
    const run = this.runs.get(node.key);
    if (!run?.running) return;
    run.terminal.sendText(CTRL_C, false);
    if (run.execution) return;
    run.running = false;
    this.changed();
  }

  // Ctrl+C and the same command again. A script that has not ended within a
  // few seconds, or one whose end cannot be seen, gets a fresh terminal.
  async restart(node) {
    const run = this.runs.get(node.key);
    if (run?.running) {
      const ended = run.execution && new Promise(resolve => {
        run.stopped = () => resolve(true);
        setTimeout(() => resolve(false), STOP_WAIT_MS);
      });
      run.terminal.sendText(CTRL_C, false);
      if (!ended || !await ended) {
        this.runs.delete(node.key);
        run.terminal.dispose();
        this.changed();
      }
    }
    return this.run(node);
  }

  findRun(test) {
    return [...this.runs.values()].find(test);
  }

  // The same command typed again in the script's terminal is followed too.
  started(event) {
    const run = this.findRun(item => item.terminal === event.terminal);
    if (!run || run.execution) return;
    run.running = true;
    this.watch(run, event.execution);
    this.changed();
  }

  ended(event) {
    const run = this.findRun(item => item.execution === event.execution);
    if (!run) return;
    Object.assign(run, { running: false, execution: null, url: null });
    run.stopped?.();
    this.changed();
  }

  closed(terminal) {
    for (const [key, run] of this.runs) {
      if (run.terminal !== terminal) continue;
      this.runs.delete(key);
      run.stopped?.();
      this.changed();
    }
  }
}

module.exports = { NpmScripts, sortScripts, findPackages, findLocalUrl, VIEW_ID };
