'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { isRussian } = require('./text');

const RUSSIAN = {
  commit: 'Commit', refresh: 'Обновить из GitHub', files: 'Файлы', noFiles: 'Нет изменений', message: 'Сообщение commit',
  suggestTab: 'Tab →', suggestLocal: 'diff', suggestAi: 'AI',
  push: 'Push', pull: 'Pull', sync: 'Push и Pull', toPush: 'Исходящие', incoming: 'Входящие', notOnGitHub: 'Ветки ещё нет в GitHub', noRemote: 'Проект не подключён к GitHub (нет origin).',
  noUpstream: 'upstream не настроен',
  behind: 'В GitHub новые commits этой ветки, нажми Pull', syncBranch: 'Получить и объединить',
  initRepository: 'Создать репозиторий', connectGitHub: 'Подключить к GitHub',
  switchBranch: 'Переключить ветку', newBranch: 'Новая ветка', branchName: 'Имя', fromBranch: 'Из ветки', create: 'Создать',
  receive: 'Получить изменения', receiveFrom: 'Из ветки', receiveButton: 'Получить',
  pullRequest: 'Pull Request', prHead: 'Из ветки (head)', prBase: 'В ветку (base)', prTitle: 'Заголовок PR', prBody: 'Описание (необязательно)', prDraft: 'Draft PR', prCreate: 'Создать Pull Request', prSelectBranch: '— выбери ветку —',
  conflicts: 'Конфликты', ours: 'Моё', theirs: 'Из GitHub', oursAll: 'Всё моё', theirsAll: 'Всё из GitHub', apply: 'Применить', abortMerge: 'Отменить merge',
  abortRebase: 'Отменить rebase',
  deleteBranch: 'Удалить ветку', deleteScope: 'Область удаления', scopeBoth: 'Локально и в GitHub', scopeLocal: 'Только локально', scopeRemote: 'Только в GitHub', deleteButton: 'Удалить', noBranches: 'Нет веток для удаления', active: 'активная',
  fixAuthor: 'Исправить автора и отправить', signIn: 'Войти в GitHub',
  author: 'Автор commits', authorOwner: 'владелец репозитория', authorAccount: 'аккаунт редактора', authorGit: 'из git config', authorNotGitHub: 'не аккаунт GitHub: войди в GitHub', authorSignIn: 'не задан: войди в GitHub', authorNone: 'не задан: подключи репозиторий GitHub',
  extensionCredit: 'Расширение: Antigravity Workstation (m-safarov)',
};

const ENGLISH = {
  commit: 'Commit', refresh: 'Update from GitHub', files: 'Files', noFiles: 'No changes', message: 'Commit message',
  suggestTab: 'Tab →', suggestLocal: 'diff', suggestAi: 'AI',
  push: 'Push', pull: 'Pull', sync: 'Push and Pull', toPush: 'Outgoing', incoming: 'Incoming', notOnGitHub: 'The branch is not on GitHub yet', noRemote: 'The project is not connected to GitHub (no origin).',
  noUpstream: 'no upstream configured',
  behind: 'GitHub has newer commits on this branch, press Pull', syncBranch: 'Get and merge',
  initRepository: 'Create repository', connectGitHub: 'Connect to GitHub',
  switchBranch: 'Switch branch', newBranch: 'New branch', branchName: 'Name', fromBranch: 'From branch', create: 'Create',
  receive: 'Get changes', receiveFrom: 'From branch', receiveButton: 'Get',
  pullRequest: 'Pull Request', prHead: 'Source branch (head)', prBase: 'Target branch (base)', prTitle: 'PR title', prBody: 'Description (optional)', prDraft: 'Draft PR', prCreate: 'Create Pull Request', prSelectBranch: '— select branch —',
  conflicts: 'Conflicts', ours: 'Mine', theirs: 'From GitHub', oursAll: 'All mine', theirsAll: 'All from GitHub', apply: 'Apply', abortMerge: 'Cancel merge',
  abortRebase: 'Cancel rebase',
  deleteBranch: 'Delete branch', deleteScope: 'Delete scope', scopeBoth: 'Local and GitHub', scopeLocal: 'Local only', scopeRemote: 'GitHub only', deleteButton: 'Delete', noBranches: 'No branches to delete', active: 'active',
  fixAuthor: 'Fix author and push', signIn: 'Sign in to GitHub',
  author: 'Commit author', authorOwner: 'repository owner', authorAccount: 'editor account', authorGit: 'from git config', authorNotGitHub: 'not a GitHub account: sign in to GitHub', authorSignIn: 'not set: sign in to GitHub', authorNone: 'not set: connect a GitHub repository',
  extensionCredit: 'Extension: Antigravity Workstation (m-safarov)',
};

function readAsset(name) {
  return fs.readFileSync(path.join(__dirname, 'webview', name), 'utf8');
}

function block(id, title, open, content, extraHeader = '') {
  return `
<div class="block" id="block-${id}">
  <div class="block-header" data-block="${id}">
    <div class="header-left"><span class="chevron">${open ? '▼' : '▶'}</span><span>${title}</span></div>${extraHeader}
  </div>
  <div class="block-content" id="content-${id}"${open ? '' : ' hidden'}>${content}
  </div>
</div>`;
}

function renderBody(ui) {
  const commit = `
    <label class="check-row select-all"><input type="checkbox" id="selectAll"><span id="filesTitle">${ui.files}</span></label>
    <div class="file-list" id="changedFiles"></div>
    <textarea id="commitMessage" rows="2" placeholder="${ui.message}"></textarea>
    <div class="commit-suggestion" id="commitSuggestionBar" hidden>
      <span class="suggest-key">${ui.suggestTab}</span>
      <span class="suggest-text" id="commitSuggestionText"></span>
      <span class="suggest-badge" id="commitSuggestionBadge"></span>
    </div>
    <button class="btn btn-primary" id="commitButton" disabled>${ui.commit}</button>`;
  const push = `
    <div class="target-summary" id="pushSummary">—</div>
    <div class="target-summary sub-summary" id="syncDirectionSummary" hidden>—</div>
    <div class="btn-row" id="syncRow">
      <button class="btn btn-primary" id="pushButton" disabled>${ui.push}</button>
      <button class="btn btn-secondary" id="syncButton" data-command="syncBranch">${ui.pull}</button>
    </div>
    <button class="btn btn-primary" id="connectButton" data-command="connectGitHub" hidden>${ui.connectGitHub}</button>
    <div class="behind-text" id="behindText" hidden></div>`;
  const switchBranch = `
    <select id="branchSelect"></select>`;
  const newBranch = `
    <div class="field-label">${ui.branchName}</div><input type="text" id="newBranchName" placeholder="day-2">
    <div class="field-label">${ui.fromBranch}</div><select id="newBranchBase"></select>
    <button class="btn btn-secondary" id="newBranchButton">${ui.create}</button>`;
  const receive = `
    <div class="field-label">${ui.receiveFrom}</div><select id="pullSource"></select>
    <div class="target-summary sub-summary" id="pullSummary">—</div>
    <button class="btn btn-primary" id="pullButton">${ui.receiveButton}</button>
    <div id="conflictPanel" hidden>
      <div class="field-label">${ui.conflicts}</div>
      <div id="conflictList"></div>
      <div class="btn-row"><button class="btn btn-secondary" data-choose="ours">${ui.oursAll}</button><button class="btn btn-secondary" data-choose="theirs">${ui.theirsAll}</button></div>
      <button class="btn btn-primary" id="resolveButton">${ui.apply}</button>
      <button class="btn btn-secondary" data-command="abortOperation">${ui.abortMerge}</button>
    </div>`;
  const pr = `
    <div class="field-label">${ui.prHead}</div><select id="prHead"></select>
    <div class="field-label">${ui.prBase}</div><select id="prBase"></select>
    <div class="field-label">${ui.prTitle}</div><input type="text" id="prTitle" placeholder="feat: describe your change">
    <div class="field-label">${ui.prBody}</div><textarea id="prBody" rows="2" placeholder="${ui.prBody}"></textarea>
    <label class="check-row"><input type="checkbox" id="prDraft"><span>${ui.prDraft}</span></label>
    <button class="btn btn-primary" id="createPrButton" disabled>${ui.prCreate}</button>
    <div class="target-summary sub-summary" id="prResult" hidden></div>`;
  const remove = `
    <div class="field-label">${ui.deleteScope}</div>
    <select id="deleteScope">
      <option value="both">${ui.scopeBoth}</option>
      <option value="local">${ui.scopeLocal}</option>
      <option value="remote">${ui.scopeRemote}</option>
    </select>
    <div class="branch-checklist" id="deleteChecklist"></div>
    <button class="btn btn-danger" id="deleteButton" disabled>${ui.deleteButton}</button>`;
  const footer = `
<footer class="ext-footer" aria-label="Extension attribution">
  <svg class="ext-footer-icon" width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
    <path d="M8 1.5L9.8 6.2L14.5 8L9.8 9.8L8 14.5L6.2 9.8L1.5 8L6.2 6.2L8 1.5Z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/>
  </svg>
  <span>${ui.extensionCredit}</span>
</footer>`;
  return `
<div class="status-bar" id="notice" hidden>
  <div id="noticeText"></div>
  <pre id="noticeDetails" hidden></pre>
  <button class="btn btn-secondary" id="noticeAction" hidden></button>
</div>
<div class="status-bar status-warn" id="repoProblem" hidden>
  <div id="repoProblemText"></div>
  <button class="btn btn-secondary" id="abortRebaseButton" data-command="abortOperation" hidden>${ui.abortRebase}</button>
  <div class="btn-row" id="startRow" hidden>
    <button class="btn btn-primary" data-command="initRepository">${ui.initRepository}</button>
    <button class="btn btn-secondary" data-command="connectGitHub">${ui.connectGitHub}</button>
  </div>
</div>
<div class="repo-summary" id="repoSummary" hidden></div>
<div class="author-line" id="authorLine" hidden></div>
<div id="blocks">${block('commit', ui.commit, true, commit, `<button class="refresh-btn" data-command="fetch" title="${ui.refresh}">↻</button>`)}${block('push', ui.sync, true, push)}${block('switch', ui.switchBranch, false, switchBranch)}${block('new', ui.newBranch, false, newBranch)}${block('receive', ui.receive, false, receive)}${block('pr', ui.pullRequest, false, pr)}${block('delete', ui.deleteBranch, false, remove)}
</div>${footer}`;
}

function renderHtml() {
  const ui = isRussian() ? RUSSIAN : ENGLISH;
  const nonce = crypto.randomBytes(16).toString('hex');
  return `<!DOCTYPE html>
<html lang="${isRussian() ? 'ru' : 'en'}">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
${readAsset('view.css')}</style>
</head>
<body>${renderBody(ui)}
<script nonce="${nonce}">const UI = ${JSON.stringify(ui)};</script>
<script nonce="${nonce}">
${readAsset('view.js')}</script>
</body>
</html>`;
}

module.exports = { renderHtml, RUSSIAN, ENGLISH };
