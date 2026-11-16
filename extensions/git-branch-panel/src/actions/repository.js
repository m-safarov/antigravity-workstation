'use strict';

// A folder without Git or without GitHub. "Create repository": git init and
// the first commit on main. "Connect to GitHub": a new repository made with
// the editor's GitHub account or the address of an existing one, then
// git remote add origin and the first push under the owner's identity.
const fs = require('fs');
const path = require('path');
const { runGit } = require('../git-runner');
const { collectState, parseGitHubRemote } = require('../git-state');
const { PanelError } = require('../git-errors');
const { createRepository } = require('../github-api');
const { tr } = require('../text');
const { VISIBLE, requireReady, loadReadyState } = require('./common');
const { commitFiles, pushCurrentBranch, otherAuthors, rewriteUnpushedAuthors } = require('./commit-push');

// The usual Node.js entries keep dependencies and secrets out of the first
// commit. An existing .gitignore is never changed.
const GITIGNORE = 'node_modules/\n.env\n.env.*\n!.env.example\n';

const repositoryName = folder => folder.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-.]+|-+$/g, '') || 'project';
const validName = value => /^[A-Za-z0-9._-]{1,100}$/.test(value.trim()) && !/^\.+$/.test(value.trim());

async function initGit(panel, cwd) {
  panel.progress(tr('Создание репозитория…', 'Creating the repository…'));
  await runGit(['init', '-b', 'main'], cwd, VISIBLE);
}

// Every changed file except secrets.
async function firstCommit(panel, cwd, root) {
  const gitignore = path.join(root, '.gitignore');
  if (!fs.existsSync(gitignore)) fs.writeFileSync(gitignore, GITIGNORE);
  const state = await loadReadyState(cwd);
  const files = state.changedFiles.filter(item => !item.secret).map(item => item.file);
  if (!files.length) throw new PanelError(tr('В папке нет файлов для первого commit.', 'The folder has no files for the first commit.'));
  await commitFiles(panel, cwd, state, files, tr('Первый commit', 'First commit'));
}

async function initRepository(panel) {
  const cwd = panel.workspaceRoot();
  if ((await collectState(cwd)).isRepo) throw new PanelError(tr('Эта папка уже в Git-репозитории.', 'This folder is already in a Git repository.'));
  await initGit(panel, cwd);
  await firstCommit(panel, cwd, cwd);
  panel.notice('ok', tr('Репозиторий создан: ветка main и первый commit.', 'Repository created: branch main with the first commit.'));
}

async function askRepositoryUrl(window) {
  const url = await window.showInputBox({
    prompt: tr('Адрес репозитория GitHub', 'GitHub repository address'),
    placeHolder: 'https://github.com/owner/project.git',
    ignoreFocusOut: true,
    validateInput: value => parseGitHubRemote(value) ? null : tr('Нужен адрес вида https://github.com/владелец/проект', 'Use an address like https://github.com/owner/project'),
  });
  return url?.trim() || null;
}

// A new empty repository of the editor's GitHub account; returns its address.
async function createOnGitHub(panel, folderName) {
  const { window, authentication } = panel.vscode;
  const name = (await window.showInputBox({
    prompt: tr('Имя нового репозитория в GitHub', 'Name of the new GitHub repository'),
    value: repositoryName(folderName),
    ignoreFocusOut: true,
    validateInput: value => validName(value) ? null : tr('Латинские буквы, цифры, ".", "-" и "_".', 'Use letters, digits, ".", "-" and "_".'),
  }))?.trim();
  if (!name) return null;
  const visibility = await window.showQuickPick([
    { label: tr('Закрытый (private)', 'Private'), description: tr('видишь только ты', 'only you can see it'), isPrivate: true },
    { label: tr('Открытый (public)', 'Public'), description: tr('виден всем', 'anyone can see it'), isPrivate: false },
  ], { placeHolder: tr('Кто видит репозиторий?', 'Who can see the repository?'), ignoreFocusOut: true });
  if (!visibility) return null;
  let session;
  try {
    session = await authentication.getSession('github', ['repo'], { createIfNone: true });
  } catch (error) {
    throw new PanelError(tr('Вход в GitHub не выполнен.', 'GitHub sign-in did not complete.'), { details: error.message });
  }
  // The new repository belongs to this account, so it becomes the author.
  panel.identities.forgetSession();
  panel.progress(tr(`Создание репозитория ${name} в GitHub…`, `Creating ${name} on GitHub…`));
  return (await createRepository(session.accessToken, name, visibility.isPrivate)).clone_url;
}

async function chooseRepository(panel, folderName) {
  const create = { label: tr('Создать новый репозиторий в GitHub', 'Create a new GitHub repository'), description: tr('аккаунтом GitHub редактора', 'with the editor GitHub account') };
  const existing = { label: tr('Подключить существующий репозиторий', 'Connect an existing repository'), description: 'https://github.com/…' };
  const choice = await panel.vscode.window.showQuickPick([create, existing], { placeHolder: tr('Подключить проект к GitHub', 'Connect the project to GitHub'), ignoreFocusOut: true });
  if (choice === existing) return askRepositoryUrl(panel.vscode.window);
  return choice === create ? createOnGitHub(panel, folderName) : null;
}

async function connectGitHub(panel) {
  const cwd = panel.workspaceRoot();
  const before = await collectState(cwd);
  if (before.remote) throw new PanelError(tr(`Проект уже подключён: ${before.remote}`, `The project is already connected: ${before.remote}`));
  if (before.isRepo) requireReady(before);
  const url = await chooseRepository(panel, path.basename(before.root || cwd));
  if (!url) return;
  if (!before.isRepo) await initGit(panel, cwd);
  panel.progress(tr('Подключение к GitHub…', 'Connecting to GitHub…'));
  await runGit(['remote', 'add', 'origin', url], cwd, VISIBLE);
  let state = await loadReadyState(cwd);
  if (!state.hasCommits) {
    await firstCommit(panel, cwd, state.root);
    state = await loadReadyState(cwd);
  }
  // Commits made before the project had a GitHub owner may carry another name.
  const identity = await panel.requireIdentity(cwd, state);
  if (identity && (await otherAuthors(cwd, identity.email)).length) {
    const fixed = await rewriteUnpushedAuthors(panel, cwd, state, identity).catch(error => {
      if (!(error instanceof PanelError)) throw error;
      panel.log(error.message);
      return true;
    });
    if (!fixed) {
      panel.notice('ok', tr(`Проект подключён к GitHub: ${url}. Нажми Push, когда будешь готов.`, `The project is connected to GitHub: ${url}. Press Push when ready.`));
      return;
    }
  }
  await pushCurrentBranch(panel, cwd, state.branch);
  panel.notice('ok', tr(`Проект подключён к GitHub и отправлен: ${url}`, `The project is connected to GitHub and pushed: ${url}`));
}

module.exports = { initRepository, connectGitHub, repositoryName };
