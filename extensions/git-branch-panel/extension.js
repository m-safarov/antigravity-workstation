'use strict';

const vscode = require('vscode');
const { configureGit, findGitExecutable } = require('./src/git-runner');
const { GitTerminal } = require('./src/git-terminal');
const { GithubPanelProvider } = require('./src/panel-provider');
const { NpmScripts } = require('./src/npm-scripts');

const PANEL_ID = 'workstationGithubPanel';
let outputChannel = null;
let provider = null;

function log(message) {
  if (!outputChannel) outputChannel = vscode.window.createOutputChannel('Workstation GitHub Panel');
  outputChannel.appendLine(`[${new Date().toLocaleTimeString()}] ${message}`);
}

// Dependency folders and git's own object store, logs and lock files change
// in bursts (npm install, fetch) and never change what the panel shows.
const NOISE = /[\\/]node_modules[\\/]|[\\/]\.git[\\/](?:objects|logs|lfs)[\\/]|[\\/]\.git[\\/].*\.lock$/;
const GIT_CONFIG = /[\\/]\.git[\\/]config$/;

function isNoise(uri) {
  return NOISE.test(String(uri?.fsPath || ''));
}

function syncIdentity() {
  provider?.syncWorkspaceIdentity().catch(error => log('Identity: ' + error.message));
}

// Edits, branch switches and commits made in the terminal all change files in
// the working tree or in .git, so one watcher keeps the panel current. A
// changed .git/config (origin added in the terminal) also updates the commit
// author while the panel is hidden.
function watchRepositoryChanges(refresh) {
  const watcher = vscode.workspace.createFileSystemWatcher('**/*');
  const onChange = uri => {
    if (isNoise(uri)) return;
    refresh();
    if (GIT_CONFIG.test(String(uri?.fsPath || ''))) syncIdentity();
  };
  return [watcher, watcher.onDidCreate(onChange), watcher.onDidChange(onChange), watcher.onDidDelete(onChange)];
}

function activate(context) {
  const executable = findGitExecutable(vscode.workspace.getConfiguration('git').get('path'));
  const terminal = new GitTerminal(vscode, executable);
  configureGit({ executable, log, terminal: (args, cwd, timeout) => terminal.run(args, cwd, timeout) });
  provider = new GithubPanelProvider(vscode, context, log);
  const scripts = new NpmScripts(vscode);
  const refresh = () => provider?.refresh();
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(PANEL_ID, provider, { webviewOptions: { retainContextWhenHidden: true } }),
    vscode.commands.registerCommand(PANEL_ID + '.refresh', refresh),
    ...watchRepositoryChanges(refresh),
    vscode.window.onDidChangeActiveTextEditor(refresh),
    vscode.workspace.onDidChangeWorkspaceFolders(() => { syncIdentity(); refresh(); }),
    vscode.authentication.onDidChangeSessions(event => { if (event.provider.id === 'github') provider?.onGitHubSessionsChanged(); }),
    ...scripts.register(),
    terminal,
    { dispose: () => { provider?.dispose(); configureGit({ terminal: null }); } },
  );
  syncIdentity();
}

function deactivate() {
  provider = null;
}

module.exports = { activate, deactivate, isNoise };
