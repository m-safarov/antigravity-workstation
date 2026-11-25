'use strict';

const vscode = acquireVsCodeApi();
// The extension refreshes the panel on every file and .git change; this slow
// check only covers changes the editor's file watcher does not report.
const REFRESH_INTERVAL_MS = 20000;
const SUGGEST_DEBOUNCE_MS = 450;
let state = null;
let busy = false;
let renderedFilesKey = '';
let activeSuggestion = '';
let activeSuggestionSource = 'none';
let suggestRequestId = 0;
let suggestTimer = null;
let lastSuggestionContextKey = '';

function byId(id) {
  return document.getElementById(id);
}

function span(className, text) {
  const element = document.createElement('span');
  element.className = className;
  element.textContent = text;
  return element;
}

function hint(text) {
  const element = document.createElement('div');
  element.className = 'hint-text';
  element.textContent = text;
  return element;
}

function runAction(command, data) {
  if (busy) return;
  busy = true;
  renderControls();
  vscode.postMessage(Object.assign({ command }, data || {}));
}

function toggleBlock(id) {
  const content = byId('content-' + id);
  setBlockOpen(id, content.hidden);
}

function setBlockOpen(id, open) {
  byId('content-' + id).hidden = !open;
  byId('block-' + id).querySelector('.chevron').textContent = open ? '▼' : '▶';
}

// Commit message suggestion (debounced, Tab-accepted only when empty, never auto-commits)

function clearCommitSuggestion() {
  activeSuggestion = '';
  activeSuggestionSource = 'none';
  const bar = byId('commitSuggestionBar');
  if (bar) bar.hidden = true;
}

function renderCommitSuggestion() {
  const bar = byId('commitSuggestionBar');
  const box = byId('commitMessage');
  if (!bar || !box) return;
  const hasManual = Boolean(box.value && box.value.trim().length > 0);
  if (!activeSuggestion || hasManual || !checkedFiles().length) {
    bar.hidden = true;
    return;
  }
  bar.hidden = false;
  const textEl = byId('commitSuggestionText');
  const badgeEl = byId('commitSuggestionBadge');
  if (textEl) textEl.textContent = activeSuggestion;
  if (badgeEl) badgeEl.textContent = activeSuggestionSource === 'ai' ? UI.suggestAi : UI.suggestLocal;
}

function scheduleCommitSuggestion() {
  if (typeof clearTimeout === 'function' && suggestTimer) {
    clearTimeout(suggestTimer);
    suggestTimer = null;
  }
  const box = byId('commitMessage');
  const files = checkedFiles();
  if (!state || state.error || !files.length || (box && box.value.trim().length > 0)) {
    lastSuggestionContextKey = '';
    clearCommitSuggestion();
    return;
  }
  const contextKey = JSON.stringify([state.root, state.branch, files, renderedFilesKey]);
  if (contextKey === lastSuggestionContextKey && activeSuggestion) {
    renderCommitSuggestion();
    return;
  }
  lastSuggestionContextKey = contextKey;
  clearCommitSuggestion();
  const reqId = ++suggestRequestId;
  const dispatch = () => {
    suggestTimer = null;
    if (reqId !== suggestRequestId) return;
    if (box && box.value.trim().length > 0) return;
    vscode.postMessage({ command: 'suggestCommit', files, requestId: reqId });
  };
  if (typeof setTimeout === 'function') suggestTimer = setTimeout(dispatch, SUGGEST_DEBOUNCE_MS);
  else dispatch();
}

function handleCommitSuggestionResponse(message) {
  if (!message || message.requestId !== suggestRequestId) return;
  const box = byId('commitMessage');
  if (box && box.value.trim().length > 0) {
    clearCommitSuggestion();
    return;
  }
  activeSuggestion = typeof message.suggestion === 'string' ? message.suggestion.trim() : '';
  activeSuggestionSource = message.source || 'local';
  renderCommitSuggestion();
}

function handleCommitKeydown(event) {
  if (event.ctrlKey && event.key === 'Enter' && !byId('commitButton').disabled) {
    commit();
    return;
  }
  if (event.key === 'Tab' && !event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey) {
    const box = byId('commitMessage');
    if (activeSuggestion && box && box.value.trim().length === 0) {
      if (typeof event.preventDefault === 'function') event.preventDefault();
      box.value = activeSuggestion;
      clearCommitSuggestion();
      renderControls();
    }
  }
}

// Files

function fileInputs() {
  return Array.from(byId('changedFiles').querySelectorAll('input'));
}

function selectableFiles() {
  return fileInputs().filter(input => input.dataset.secret !== 'true');
}

function checkedFiles() {
  return selectableFiles().filter(input => input.checked).map(input => input.dataset.file);
}

function fileRow(item, previous) {
  const row = document.createElement('label');
  row.className = 'check-row' + (item.secret ? ' secret-file' : '');
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.checked = !item.secret && (previous.has(item.file) ? previous.get(item.file) : true);
  input.dataset.file = item.file;
  input.dataset.secret = String(item.secret);
  input.addEventListener('change', () => {
    renderControls();
    scheduleCommitSuggestion();
  });
  const name = (item.originalFile ? item.originalFile + ' → ' : '') + item.file + (item.secret ? ' 🔒' : '');
  row.append(input, span('file-status', item.status), span('file-name', name));
  return row;
}

// Rebuilt only when the list changed, so ticks survive live refreshes.
function updateChangedFiles(files) {
  const key = JSON.stringify(files);
  if (key === renderedFilesKey) return;
  renderedFilesKey = key;
  const list = byId('changedFiles');
  const previous = new Map(fileInputs().map(input => [input.dataset.file, input.checked]));
  list.innerHTML = '';
  if (!files.length) list.appendChild(hint(UI.noFiles));
  for (const item of files) list.appendChild(fileRow(item, previous));
}

function updateSelectAll() {
  const all = selectableFiles();
  const checked = all.filter(input => input.checked).length;
  byId('selectAll').checked = all.length > 0 && checked === all.length;
  byId('selectAll').indeterminate = checked > 0 && checked < all.length;
  byId('filesTitle').textContent = UI.files + (all.length ? ' (' + checked + '/' + all.length + ')' : '');
}

function selectAllFiles(checked) {
  selectableFiles().forEach(input => { input.checked = checked; });
  renderControls();
  scheduleCommitSuggestion();
}

// Repository / Push / Pull

function updateRepoSummary(current) {
  const summary = byId('repoSummary');
  if (!summary) return;
  if (!current || !current.isRepo || current.error) {
    summary.hidden = true;
    return;
  }
  const repoLabel = current.repoName || current.root || '';
  const upstreamLabel = current.upstream ? current.upstream : UI.noUpstream;
  summary.hidden = false;
  summary.textContent = repoLabel + ' · ' + current.branch + ' (' + upstreamLabel + ') · ↓' + (current.behind || 0) + ' ↑' + (current.ahead || 0);
}

function canPush(current) {
  const hasSomethingToPush = current.ahead > 0 || !current.remoteBranchExists;
  // With newer commits in GitHub a push is rejected; "Get and merge" comes first.
  return Boolean(current.remote) && current.hasCommits && hasSomethingToPush && current.behind === 0 && !current.mergeInProgress;
}

// Pull merges the tracking branch (configured upstream or origin/<branch>).
function canPull(current) {
  return Boolean(current.remote) && current.remoteBranchExists && !current.mergeInProgress;
}

function updatePush(current) {
  const connected = Boolean(current.remote);
  const targetRef = current.upstream || ('origin/' + current.branch);
  let summary = UI.noRemote;
  if (connected) {
    summary = 'Push: ' + current.branch + ' → ' + targetRef;
    if (current.ahead > 0) summary += ' · ' + UI.toPush + ': ' + current.ahead;
    else if (!current.remoteBranchExists) summary += ' · ' + UI.notOnGitHub;
  }
  byId('pushSummary').textContent = summary;
  const dirEl = byId('syncDirectionSummary');
  if (dirEl) {
    dirEl.hidden = !connected;
    dirEl.textContent = connected
      ? 'Pull: ' + targetRef + ' → ' + current.branch + (current.behind > 0 ? ' · ' + UI.incoming + ': ' + current.behind : '')
      : '';
  }
  byId('syncRow').hidden = !connected;
  byId('connectButton').hidden = connected;
  byId('pushButton').textContent = current.ahead > 0 ? UI.push + ' (' + current.ahead + ')' : UI.push;
  byId('syncButton').textContent = current.behind > 0 ? UI.pull + ' (' + current.behind + ')' : UI.pull;
  byId('behindText').hidden = !(connected && current.behind > 0);
  byId('behindText').textContent = UI.behind + ': ' + current.behind;
}

function updatePullSummary(current) {
  const el = byId('pullSummary');
  if (!el || !current) return;
  const source = byId('pullSource').value;
  const remoteName = current.upstreamRemote || 'origin';
  el.textContent = source ? (remoteName + '/' + source + ' → ' + current.branch) : '—';
}

// Branches & Pull Requests

function fillBranchSelect(id, branches, fallback, keepPrevious, emptyOptionLabel) {
  const select = byId(id);
  if (!select) return;
  const previous = select.value;
  const selected = keepPrevious && branches.some(branch => branch.name === previous) ? previous : fallback;
  select.innerHTML = '';
  if (emptyOptionLabel) {
    const emptyOpt = document.createElement('option');
    emptyOpt.value = '';
    emptyOpt.textContent = emptyOptionLabel;
    emptyOpt.selected = !selected;
    select.appendChild(emptyOpt);
  }
  for (const branch of branches) {
    const option = document.createElement('option');
    option.value = branch.name;
    option.textContent = branch.name + (branch.isCurrent ? ' (' + UI.active + ')' : '');
    option.selected = branch.name === selected;
    select.appendChild(option);
  }
}

function updateBranchLists(current) {
  const remote = current.branches.filter(branch => branch.isRemote);
  const upstreamBranch = current.upstreamBranch && remote.some(branch => branch.name === current.upstreamBranch) ? current.upstreamBranch : '';
  const pullFallback = upstreamBranch || (remote.some(branch => branch.name === current.branch) ? current.branch : current.defaultBranch);
  fillBranchSelect('branchSelect', current.branches, current.branch, false);
  fillBranchSelect('newBranchBase', current.branches, current.branch, true);
  fillBranchSelect('pullSource', remote, pullFallback, true);
  updatePullSummary(current);
  // PR selectors: explicit choices; never silently force main when user chose another base.
  fillBranchSelect('prHead', remote, remote.some(b => b.name === current.branch) ? current.branch : '', true, UI.prSelectBranch);
  const prBaseDefault = remote.some(b => b.name === current.defaultBranch && b.name !== current.branch) ? current.defaultBranch : '';
  fillBranchSelect('prBase', remote, prBaseDefault, true, UI.prSelectBranch);
}

function showPrResult(pr) {
  const box = byId('prResult');
  if (!box) return;
  if (!pr || !pr.url) {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  box.textContent = '#' + pr.number + ' (' + pr.head + ' → ' + pr.base + '): ' + pr.url;
}

function deleteSelection() {
  return Array.from(byId('deleteChecklist').querySelectorAll('input')).filter(input => input.checked).map(input => input.dataset.branch);
}

function updateDeleteList(branches, current) {
  const list = byId('deleteChecklist');
  const previous = new Set(deleteSelection());
  list.innerHTML = '';
  const deletable = branches.filter(branch => !branch.isDefault);
  if (!deletable.length) list.appendChild(hint(UI.noBranches));
  for (const branch of deletable) {
    const row = document.createElement('label');
    row.className = 'branch-item';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.dataset.branch = branch.name;
    input.checked = previous.has(branch.name);
    input.addEventListener('change', renderControls);
    const scopeHint = branch.isLocal && branch.isRemote ? '' : (branch.isLocal ? ' [local]' : ' [remote]');
    row.append(input, span('', (branch.name === current ? branch.name + ' (' + UI.active + ')' : branch.name) + scopeHint));
    list.appendChild(row);
  }
}

// Conflicts

function renderConflicts(files) {
  const list = byId('conflictList');
  const previous = new Map(Array.from(list.querySelectorAll('select'), select => [select.dataset.conflict, select.value]));
  list.innerHTML = '';
  for (const file of files) {
    const row = document.createElement('div');
    row.className = 'check-row';
    const select = document.createElement('select');
    select.dataset.conflict = file;
    for (const [value, label] of [['ours', UI.ours], ['theirs', UI.theirs]]) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = label;
      select.appendChild(option);
    }
    if (previous.has(file)) select.value = previous.get(file);
    row.append(span('file-name', file), select);
    list.appendChild(row);
  }
}

function updateConflicts(current) {
  byId('conflictPanel').hidden = !current.mergeInProgress;
  byId('pullButton').hidden = current.mergeInProgress;
  if (!current.mergeInProgress) return;
  setBlockOpen('receive', true);
  renderConflicts(current.conflicts);
}

function conflictChoices() {
  const choices = {};
  byId('conflictList').querySelectorAll('select').forEach(select => { choices[select.dataset.conflict] = select.value; });
  return choices;
}

function chooseForAll(side) {
  byId('conflictList').querySelectorAll('select').forEach(select => { select.value = side; });
  runAction('resolveConflicts', { resolutions: conflictChoices() });
}

// State and controls

// A folder without Git offers to create the repository or connect GitHub.
function updateRepoProblem(current) {
  byId('repoProblem').hidden = !current.error;
  byId('repoProblemText').textContent = current.error || '';
  byId('abortRebaseButton').hidden = !current.rebaseInProgress;
  byId('startRow').hidden = current.isRepo || !current.cwd;
}

// Whose name the next commit carries: the repository owner, the editor
// account (organisation repositories) or the name from git config.
function showAuthor(author) {
  const line = byId('authorLine');
  line.hidden = !author;
  if (!author) return;
  const source = { owner: UI.authorOwner, account: UI.authorAccount, git: UI.authorGit }[author.source];
  line.textContent = UI.author + ': ' + (author.name ? author.name + ' · ' + source : UI.authorNone);
}

function applyState(next) {
  const prevRoot = state ? state.root : null;
  const prevBranch = state ? state.branch : null;
  state = next;
  busy = Boolean(next.busy);
  updateRepoProblem(next);
  updateRepoSummary(next);
  byId('blocks').hidden = Boolean(next.error);
  if (next.error) {
    byId('authorLine').hidden = true;
    clearCommitSuggestion();
  }
  if (!next.error) {
    if (prevRoot !== next.root || prevBranch !== next.branch) {
      lastSuggestionContextKey = '';
      clearCommitSuggestion();
      showPrResult(null);
    }
    updateChangedFiles(next.changedFiles);
    updatePush(next);
    updateBranchLists(next);
    updateConflicts(next);
    updateDeleteList(next.branches, next.branch);
    scheduleCommitSuggestion();
  }
  renderControls();
}

function renderControls() {
  document.querySelectorAll('button, input, select, textarea').forEach(element => { element.disabled = busy; });
  if (busy || !state || state.error) return;
  fileInputs().forEach(input => { input.disabled = input.dataset.secret === 'true'; });
  updateSelectAll();
  byId('selectAll').disabled = selectableFiles().length === 0;
  byId('commitButton').disabled = checkedFiles().length === 0 || !byId('commitMessage').value.trim();
  byId('pushButton').disabled = !canPush(state);
  byId('syncButton').disabled = !canPull(state);
  byId('pullButton').disabled = !byId('pullSource').value;
  byId('newBranchButton').disabled = !byId('newBranchName').value.trim();
  const prHead = byId('prHead')?.value || '';
  const prBase = byId('prBase')?.value || '';
  const prTitle = byId('prTitle')?.value?.trim() || '';
  const prBtn = byId('createPrButton');
  if (prBtn) prBtn.disabled = !state.isGitHub || !prHead || !prBase || prHead === prBase || !prTitle;
  byId('deleteButton').disabled = deleteSelection().length === 0;
  byId('deleteButton').textContent = UI.deleteButton + (deleteSelection().length ? ' (' + deleteSelection().length + ')' : '');
}

function showNotice(message) {
  const notice = byId('notice');
  notice.hidden = message.level === 'clear';
  if (notice.hidden) return;
  notice.className = 'status-bar status-' + message.level;
  byId('noticeText').textContent = message.text;
  byId('noticeDetails').hidden = !message.details;
  byId('noticeDetails').textContent = message.details || '';
  const action = byId('noticeAction');
  action.hidden = !message.action;
  action.textContent = message.action ? UI[message.action] : '';
  action.dataset.command = message.action || '';
  if (message.clear && byId(message.clear)) byId(message.clear).value = '';
}

// Events

function onClick(event) {
  const commandButton = event.target.closest('[data-command]');
  if (commandButton) {
    event.stopPropagation();
    if (commandButton.dataset.command) runAction(commandButton.dataset.command);
    return;
  }
  const choose = event.target.closest('[data-choose]');
  if (choose) {
    chooseForAll(choose.dataset.choose);
    return;
  }
  const header = event.target.closest('.block-header');
  if (header) toggleBlock(header.dataset.block);
}

function commit() {
  runAction('commit', { message: byId('commitMessage').value, files: checkedFiles() });
}

function createBranch() {
  if (!byId('newBranchName').value.trim()) return;
  runAction('newBranch', { name: byId('newBranchName').value.trim(), baseBranch: byId('newBranchBase').value });
}

function createPr() {
  runAction('createPullRequest', {
    head: byId('prHead').value,
    base: byId('prBase').value,
    title: byId('prTitle').value.trim(),
    body: byId('prBody').value.trim(),
    draft: Boolean(byId('prDraft').checked),
  });
}

function wireControls() {
  document.addEventListener('click', onClick);
  byId('selectAll').addEventListener('change', event => selectAllFiles(event.target.checked));
  byId('commitMessage').addEventListener('input', () => {
    renderCommitSuggestion();
    renderControls();
    if (!byId('commitMessage').value.trim()) scheduleCommitSuggestion();
  });
  byId('commitMessage').addEventListener('keydown', handleCommitKeydown);
  byId('commitButton').addEventListener('click', commit);
  byId('pushButton').addEventListener('click', () => runAction('push'));
  byId('branchSelect').addEventListener('change', event => {
    if (state && event.target.value !== state.branch) runAction('switchBranch', { name: event.target.value });
  });
  byId('newBranchName').addEventListener('input', renderControls);
  byId('newBranchName').addEventListener('keydown', event => { if (event.key === 'Enter') createBranch(); });
  byId('newBranchButton').addEventListener('click', createBranch);
  byId('pullSource').addEventListener('change', () => updatePullSummary(state));
  byId('pullButton').addEventListener('click', () => runAction('pullBranch', { sourceBranch: byId('pullSource').value }));
  byId('resolveButton').addEventListener('click', () => runAction('resolveConflicts', { resolutions: conflictChoices() }));
  byId('prHead').addEventListener('change', renderControls);
  byId('prBase').addEventListener('change', renderControls);
  byId('prTitle').addEventListener('input', renderControls);
  byId('createPrButton').addEventListener('click', createPr);
  byId('deleteButton').addEventListener('click', () => runAction('deleteBranches', {
    branches: deleteSelection(),
    scope: byId('deleteScope')?.value || 'both',
  }));
}

window.addEventListener('message', event => {
  const message = event.data;
  if (message && message.type === 'state') applyState(message.state);
  if (message && message.type === 'notice') showNotice(message);
  if (message && message.type === 'author') showAuthor(message.author);
  if (message && message.type === 'commitSuggestion') handleCommitSuggestionResponse(message);
  if (message && message.type === 'prResult') showPrResult(message.pr);
});

wireControls();
vscode.postMessage({ command: 'ready' });
setInterval(() => {
  if (!busy && document.visibilityState === 'visible') vscode.postMessage({ command: 'refresh' });
}, REFRESH_INTERVAL_MS);
