'use strict';

const path = require('path');
const { GitError } = require('./git-runner');
const { collectState, usesGitHubIdentity } = require('./git-state');
const { PanelError, explainError } = require('./git-errors');
const { RepositoryIdentities, writeLocalIdentity, hasGitIdentity, readGitUserName } = require('./identity');
const { renderHtml } = require('./webview-html');
const { setLanguage, tr } = require('./text');
const { suggestCommitMessage } = require('./commit-suggest');
const commitPush = require('./actions/commit-push');
const merge = require('./actions/merge');
const branches = require('./actions/branches');
const repository = require('./actions/repository');
const pullRequests = require('./actions/pull-requests');

const REFRESH_DELAY_MS = 300;

async function signIn(panel) {
  const identity = await panel.identities.signIn();
  if (!identity) throw new PanelError(tr('Не удалось войти в GitHub.', 'Could not sign in to GitHub.'));
  panel.identityWritten.clear();
  panel.notice('ok', tr(`Вход в GitHub: ${identity.login}.`, `Signed in to GitHub: ${identity.login}.`));
}

// Webview command -> function(panel, message). No other command changes the repository.
const ACTIONS = {
  commit: commitPush.commit,
  push: commitPush.push,
  fixAuthor: commitPush.fixAuthorAndPush,
  syncBranch: merge.syncBranch,
  pullBranch: merge.pullBranch,
  resolveConflicts: merge.resolveConflicts,
  abortOperation: merge.abortOperation,
  newBranch: branches.newBranch,
  switchBranch: branches.switchBranch,
  deleteBranches: branches.deleteBranches,
  fetch: merge.fetchChanges,
  initRepository: repository.initRepository,
  connectGitHub: repository.connectGitHub,
  createPullRequest: pullRequests.createPullRequest,
  signIn,
};

class GithubPanelProvider {
  constructor(vscode, context = {}, log = () => {}) {
    this.vscode = vscode;
    this.log = log;
    setLanguage(vscode.env?.language);
    this.identities = new RepositoryIdentities(vscode.authentication, context.globalState);
    this.identityWritten = new Map();
    this.gitAuthor = null;
    this.postedAuthor = null;
    this.view = null;
    this.viewDisposables = [];
    this.busy = false;
    this.refreshTimer = null;
    this.collecting = null;
    this.refreshAgain = false;
    // Monotonic tokens drop stale async reads so older responses never overwrite newer state.
    this.stateGeneration = 0;
    this.suggestGeneration = 0;
    this.githubApiOptions = {};
  }

  resolveWebviewView(view) {
    this.disposeView();
    this.view = view;
    this.postedAuthor = null;
    view.webview.options = { enableScripts: true };
    view.webview.html = renderHtml();
    this.viewDisposables = [
      view.webview.onDidReceiveMessage(message => this.handleMessage(message)),
      view.onDidChangeVisibility?.(() => { if (view.visible) this.refresh(); }),
      view.onDidDispose?.(() => { this.disposeView(); this.view = null; }),
    ].filter(item => item && typeof item.dispose === 'function');
  }

  disposeView() {
    for (const disposable of this.viewDisposables) {
      try { disposable.dispose(); } catch {}
    }
    this.viewDisposables = [];
  }

  dispose() {
    clearTimeout(this.refreshTimer);
    this.refreshTimer = null;
    this.stateGeneration++;
    this.suggestGeneration++;
    this.disposeView();
    this.view = null;
  }

  async handleSuggestCommit(message) {
    const seq = ++this.suggestGeneration;
    const requestId = message?.requestId ?? seq;
    const cwd = this.workspaceRootOrNull();
    if (!cwd) {
      this.post({ type: 'commitSuggestion', requestId, suggestion: '', source: 'none' });
      return;
    }
    try {
      const state = await collectState(cwd);
      if (seq !== this.suggestGeneration || cwd !== this.workspaceRootOrNull()) return;
      if (!state.isRepo || state.error) {
        this.post({ type: 'commitSuggestion', requestId, suggestion: '', source: 'none' });
        return;
      }
      const result = await suggestCommitMessage(this, cwd, state, message?.files);
      if (seq !== this.suggestGeneration || cwd !== this.workspaceRootOrNull()) return;
      this.post({ type: 'commitSuggestion', requestId, suggestion: result.suggestion, source: result.source, files: result.files });
    } catch {
      if (seq === this.suggestGeneration) {
        this.post({ type: 'commitSuggestion', requestId, suggestion: '', source: 'none' });
      }
    }
  }

  async handleMessage(message) {
    const command = message?.command;
    if (command === 'suggestCommit') return this.handleSuggestCommit(message);
    if (command === 'ready' || command === 'refresh') return this.sendState();
    const action = Object.hasOwn(ACTIONS, command) ? ACTIONS[command] : null;
    // The webview locks its buttons when it sends a command; fresh state unlocks
    // them. A running action sends that state itself when it ends.
    if (!action || this.busy) return this.sendState();
    this.busy = true;
    this.stateGeneration++;
    this.suggestGeneration++;
    try {
      await action(this, message);
    } catch (error) {
      this.showError(error);
    } finally {
      this.busy = false;
      this.gitAuthor = null;
      await this.sendState();
    }
  }

  // A hidden panel reads nothing; it refreshes when it is shown again.
  refresh() {
    if (!this.view || this.view.visible === false) return;
    clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      this.sendState();
    }, REFRESH_DELAY_MS);
  }

  // A refresh asked for while one is running runs again afterwards, so the
  // panel never stays on data read before the latest change.
  async sendState() {
    if (!this.view || this.busy) return;
    if (this.collecting) {
      this.refreshAgain = true;
      return this.collecting;
    }
    this.collecting = this.collectAndPost();
    try {
      await this.collecting;
    } finally {
      this.collecting = null;
    }
    if (this.refreshAgain) {
      this.refreshAgain = false;
      await this.sendState();
    }
  }

  async collectAndPost() {
    const gen = ++this.stateGeneration;
    const cwd = this.workspaceRootOrNull();
    try {
      const state = await collectState(cwd);
      if (gen !== this.stateGeneration || cwd !== this.workspaceRootOrNull()) return;
      state.busy = this.busy;
      this.post({ type: 'state', state });
      const identity = await this.syncIdentity(state);
      if (gen !== this.stateGeneration || cwd !== this.workspaceRootOrNull()) return;
      await this.postAuthor(state, identity);
    } catch (error) {
      if (gen === this.stateGeneration) this.showError(error);
    }
  }

  post(message) {
    this.view?.webview?.postMessage(message);
  }

  notice(level, text, extra = {}) {
    this.post({ type: 'notice', level, text, ...extra });
  }

  progress(text) {
    this.notice('info', text);
  }

  showError(error) {
    const { text, details, action } = explainError(error);
    if (!(error instanceof GitError)) this.log(details ? `${text}\n${details}` : text);
    this.notice('error', text, { details, action });
  }

  async confirm(text, button) {
    return await this.vscode.window.showWarningMessage(text, { modal: true }, button) === button;
  }

  workspaceRootOrNull() {
    const folders = this.vscode.workspace?.workspaceFolders;
    if (!folders?.length) return null;
    const document = this.vscode.window?.activeTextEditor?.document;
    const folder = document && this.vscode.workspace.getWorkspaceFolder?.(document.uri);
    return (folder || folders[0]).uri.fsPath;
  }

  workspaceRoot() {
    const cwd = this.workspaceRootOrNull();
    if (!cwd) throw new PanelError(tr('Открой папку проекта.', 'Open a project folder.'));
    return cwd;
  }

  hasUnsavedEditors(cwd) {
    return (this.vscode.workspace?.textDocuments || []).some(document => {
      if (!document.isDirty || !document.uri?.fsPath) return false;
      const relative = path.relative(cwd, document.uri.fsPath);
      return relative === '' || (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative));
    });
  }

  // Shows whose name the next commit carries. Sent only when it changed.
  async postAuthor(state, identity) {
    let author = null;
    if (state.isRepo && !state.error) {
      if (identity) author = { name: identity.login, source: identity.source };
      else {
        if (this.gitAuthor?.root !== state.root) this.gitAuthor = { root: state.root, name: await readGitUserName(state.cwd) };
        author = { name: this.gitAuthor.name, source: this.gitAuthor.name ? 'git' : 'none' };
      }
    }
    const key = JSON.stringify(author);
    if (key === this.postedAuthor) return;
    this.postedAuthor = key;
    this.post({ type: 'author', author });
  }

  // Called before every commit, merge and push. Returns null when git's own
  // identity is used: a project without origin or on another server (its
  // config is never written), or no GitHub identity could be found but git
  // already has user.name and user.email.
  async requireIdentity(cwd, state) {
    if (!state.remote) {
      if (await hasGitIdentity(cwd)) return null;
      throw new PanelError(tr('Проект не подключён к GitHub, и в git не заданы user.name и user.email. Подключи репозиторий GitHub (origin).',
        'The project is not connected to GitHub and git has no user.name and user.email. Connect a GitHub repository (origin).'), { action: 'connectGitHub' });
    }
    if (!usesGitHubIdentity(state.remote)) return null;
    const identity = await this.identities.forRepository(state.root, state.remote);
    if (!identity) {
      await this.removeOwnerGuess(cwd, state);
      if (await hasGitIdentity(cwd)) return null;
      throw new PanelError(tr('Нужно войти в GitHub.', 'Sign in to GitHub first.'), { action: 'signIn' });
    }
    await writeLocalIdentity(cwd, identity);
    this.identityWritten.set(state.root, identity.email);
    return identity;
  }

  // Runs whenever a GitHub repository is opened or the account changes, so
  // commits made in the terminal carry the same identity. Returns the GitHub
  // identity in use, or null when git's own config stays in use.
  async syncIdentity(state) {
    if (!state.isRepo || !state.isGitHub) return null;
    try {
      const identity = await this.identities.forRepository(state.root, state.remote);
      if (!identity) {
        await this.removeOwnerGuess(state.cwd, state);
        return null;
      }
      if (this.identityWritten.get(state.root) === identity.email) return identity;
      if (await writeLocalIdentity(state.cwd, identity)) this.log(`${state.root}: user.name ${identity.name}, user.email ${identity.email}`);
      this.identityWritten.set(state.root, identity.email);
      return identity;
    } catch (error) {
      this.log('Identity: ' + error.message);
      return null;
    }
  }

  // With nobody signed in, an owner identity that an earlier version guessed
  // must not stay in the repository config: git's own identity applies.
  async removeOwnerGuess(cwd, state) {
    if (!await this.identities.removeOwnerGuess(cwd, state.root, state.remote)) return;
    this.gitAuthor = null;
    this.log(`${state.root}: removed the guessed owner user.name and user.email`);
  }

  async syncWorkspaceIdentity() {
    const cwd = this.workspaceRootOrNull();
    if (cwd) await this.syncIdentity(await collectState(cwd));
  }

  onGitHubSessionsChanged() {
    this.identities.forgetSession();
    this.identityWritten.clear();
    this.gitAuthor = null;
    this.syncWorkspaceIdentity().catch(error => this.log('Identity: ' + error.message));
    this.refresh();
  }
}

module.exports = { GithubPanelProvider, ACTIONS };
