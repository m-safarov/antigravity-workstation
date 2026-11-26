'use strict';

// Every commit in a GitHub repository carries the person who makes it: the
// GitHub account signed in to the editor, with that account's private noreply
// address, so GitHub shows the person's profile and a push never publishes a
// personal email (GitHub error GH007). The repository owner is the author only
// when the owner is the one signed in; a collaborator is never written down as
// the owner. Without a signed-in account the person who last signed in for
// this repository is used, otherwise git's own user.name and user.email, and
// those only with a GitHub address: a Google account's Gmail would show a grey
// name instead of the person. The identity goes into the repository's own
// config; the global git config is never changed, and a project without a
// GitHub origin is never written to.
const { runGit } = require('./git-runner');
const { parseGitHubRemote } = require('./git-state');

const SIGN_IN_SCOPES = ['read:user', 'user:email'];
// A silent lookup only finds a session created with exactly these scopes,
// so the sets used by the editor's own GitHub features are tried as well.
const KNOWN_SCOPE_SETS = [
  SIGN_IN_SCOPES,
  ['repo', 'workflow', 'user:email', 'read:user'],
  ['user:email'],
  ['read:user'],
  // Created by "Connect to GitHub" to make a new repository.
  ['repo'],
];
const MEMORY_KEY = 'workstationGithubPanel.repositoryAuthors';
// Before 1.9.3 the owner's public profile became the author of every clone
// and was remembered under this key, also on a collaborator's computer.
const LEGACY_MEMORY_KEY = 'workstationGithubPanel.repositoryIdentities';

// GitHub's private addresses: 12345+login@… and, for accounts from before
// 2017, login@…. Each one belongs to exactly one GitHub account.
const GITHUB_NOREPLY = /^(?:\d+\+)?[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?@users\.noreply\.github\.com$/i;

const sameLogin = (left, right) => String(left || '').toLowerCase() === String(right || '').toLowerCase();

function noreplyEmail(id, login) {
  return `${id}+${login}@users.noreply.github.com`;
}

// True for an address that always shows its GitHub account on a commit. Any
// other address shows the account only if its owner added it on GitHub.
function isGitHubEmail(email) {
  return GITHUB_NOREPLY.test(String(email || '').trim());
}

// The editor's GitHub session reports the login as the account label and the
// numeric user id as the account id.
function identityFromSession(session) {
  const login = String(session?.account?.label || '');
  const id = String(session?.account?.id || '');
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(login) || !/^\d+$/.test(id)) return null;
  return { login, id, name: login, email: noreplyEmail(id, login) };
}

async function findSignedInIdentity(authentication) {
  if (!authentication?.getSession) return null;
  for (const scopes of KNOWN_SCOPE_SETS) {
    try {
      const identity = identityFromSession(await authentication.getSession('github', scopes, { silent: true }));
      if (identity) return identity;
    } catch {
      return null;
    }
  }
  return null;
}

// The identity plain `git commit` would use: local config first, then global.
async function hasGitIdentity(cwd) {
  const read = key => runGit(['config', '--get', key], cwd).catch(() => '');
  return Boolean(await read('user.name')) && Boolean(await read('user.email'));
}

// The name and address plain `git commit` would use; '' for what is not set.
async function readGitIdentity(cwd) {
  const read = key => runGit(['config', '--get', key], cwd).catch(() => '');
  return { name: await read('user.name'), email: await read('user.email') };
}

async function readLocalIdentity(cwd) {
  const read = key => runGit(['config', '--local', '--get', key], cwd).catch(() => '');
  return { name: await read('user.name'), email: await read('user.email') };
}

// Returns true when the repository config had to be changed.
async function writeLocalIdentity(cwd, identity) {
  const current = await readLocalIdentity(cwd);
  if (current.name === identity.name && current.email === identity.email) return false;
  await runGit(['config', '--local', 'user.name', identity.name], cwd);
  await runGit(['config', '--local', 'user.email', identity.email], cwd);
  return true;
}

// Finds the person who commits in a repository root and remembers them
// together with the owner of its origin, so a project keeps its author while
// the editor is signed out and an origin that moved to another owner never
// keeps the previous person.
class RepositoryIdentities {
  constructor(authentication, memory) {
    this.authentication = authentication;
    this.memory = memory;
    this.signedIn = undefined;
    this.guessCleanups = new Map();
  }

  forgetSession() {
    this.signedIn = undefined;
  }

  async currentAccount() {
    if (this.signedIn === undefined) this.signedIn = await findSignedInIdentity(this.authentication);
    return this.signedIn;
  }

  async signIn() {
    if (!this.authentication?.getSession) return null;
    const session = await this.authentication.getSession('github', SIGN_IN_SCOPES, { createIfNone: true });
    this.signedIn = identityFromSession(session);
    return this.signedIn;
  }

  remembered(root, owner) {
    const saved = this.memory?.get(MEMORY_KEY, {}) || {};
    const entry = saved[root];
    if (!entry || !sameLogin(entry.owner, owner)) return null;
    return identityFromSession({ account: { label: entry.login, id: entry.id } });
  }

  async remember(root, owner, identity) {
    const saved = { ...this.memory?.get(MEMORY_KEY, {}) };
    const entry = saved[root];
    if (entry?.login === identity.login && entry?.id === identity.id && entry?.owner === owner) return;
    saved[root] = { login: identity.login, id: identity.id, owner };
    await this.memory?.update(MEMORY_KEY, saved);
  }

  // The author for a repository on github.com, or null when git's own
  // identity stays in use. source: 'owner' when the person owns the
  // repository, 'account' for anyone else signed in (a collaborator or a
  // member of the organisation).
  async forRepository(root, remote) {
    const owner = parseGitHubRemote(remote)?.owner;
    if (!owner) return null;
    const person = await this.currentAccount() || this.remembered(root, owner);
    if (!person) return null;
    await this.remember(root, owner, person);
    return { ...person, source: sameLogin(person.login, owner) ? 'owner' : 'account' };
  }

  // Removes the owner identity that an earlier version wrote into this
  // repository's config by guessing, so the owner is not the author of
  // someone else's commits. Only that exact identity is removed; any other
  // local identity stays. Calls for one repository that overlap (activation,
  // refresh and a commit) share one run. Resolves true when the repository
  // config changed.
  removeOwnerGuess(cwd, root, remote) {
    if (!this.guessCleanups.has(root)) {
      this.guessCleanups.set(root, this.cleanOwnerGuess(cwd, root, remote).finally(() => this.guessCleanups.delete(root)));
    }
    return this.guessCleanups.get(root);
  }

  async cleanOwnerGuess(cwd, root, remote) {
    const entry = this.memory?.get(LEGACY_MEMORY_KEY, {})?.[root];
    if (!entry) return false;
    const owner = parseGitHubRemote(remote)?.owner;
    const guess = owner && sameLogin(entry.owner, owner) && sameLogin(entry.login, owner)
      ? identityFromSession({ account: { label: entry.login, id: entry.id } })
      : null;
    const local = guess ? await readLocalIdentity(cwd) : null;
    const guessed = Boolean(guess) && local.name === guess.name && local.email === guess.email;
    if (guessed) {
      await runGit(['config', '--local', '--unset', 'user.name'], cwd);
      await runGit(['config', '--local', '--unset', 'user.email'], cwd);
    }
    // The entry goes only after the config is clean, so a failed run is retried.
    const rest = { ...this.memory?.get(LEGACY_MEMORY_KEY, {}) };
    delete rest[root];
    await this.memory?.update(LEGACY_MEMORY_KEY, rest);
    return guessed;
  }
}

module.exports = {
  identityFromSession,
  isGitHubEmail,
  writeLocalIdentity,
  hasGitIdentity,
  readGitIdentity,
  RepositoryIdentities,
};
