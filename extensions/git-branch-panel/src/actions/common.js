'use strict';

const { runGit } = require('../git-runner');
const { collectState } = require('../git-state');
const { PanelError } = require('../git-errors');
const { tr } = require('../text');

// Commands the user would type run visibly in the GitHub terminal.
const VISIBLE = { visible: true };

// State for an action that changes the repository: a branch is checked out
// and no merge or rebase is waiting to be finished.
function requireReady(state) {
  if (state.error) throw new PanelError(state.error);
  if (state.mergeInProgress) throw new PanelError(tr('Сначала разреши конфликты или отмени merge.', 'Resolve the conflicts or cancel the merge first.'));
  if (state.rebaseInProgress) throw new PanelError(tr('Сначала отмени rebase.', 'Cancel the rebase first.'));
  return state;
}

async function loadReadyState(cwd) {
  return requireReady(await collectState(cwd));
}

function requireOrigin(state) {
  if (!state.remote) throw new PanelError(tr('Проект не подключён к GitHub (нет origin).', 'The project is not connected to GitHub (no origin).'));
}

function requireNoChanges(state) {
  if (state.changedFiles.length) throw new PanelError(tr('Сначала сделай Commit своих изменений.', 'Commit your changes first.'));
}

async function fetchOrigin(panel, cwd) {
  panel.progress(tr('Получение данных из GitHub…', 'Fetching from GitHub…'));
  await runGit(['fetch', 'origin', '--prune'], cwd, VISIBLE);
}

async function checkBranchName(cwd, name) {
  if (typeof name !== 'string' || !name.trim() || name.trim().startsWith('-')) {
    throw new PanelError(tr('Укажи имя ветки.', 'Enter a branch name.'));
  }
  const trimmed = name.trim();
  try {
    await runGit(['check-ref-format', '--branch', trimmed], cwd);
  } catch {
    throw new PanelError(tr(`Недопустимое имя ветки: "${trimmed}"`, `Invalid branch name: "${trimmed}"`));
  }
  return trimmed;
}

module.exports = { VISIBLE, requireReady, loadReadyState, requireOrigin, requireNoChanges, fetchOrigin, checkBranchName };
