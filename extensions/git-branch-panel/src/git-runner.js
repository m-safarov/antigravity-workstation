'use strict';

// Runs the real git executable, the same program Git Bash uses: reads in the
// background, changes visibly in the GitHub terminal (see git-terminal.js).
const childProcess = require('child_process');
const fs = require('fs');
const path = require('path');
const { stripAnsi } = require('./shell');

// In the terminal a push may wait for a Git Credential Manager sign-in and a
// commit for its hooks, so visible commands get more time.
const TIMEOUTS = { local: 30000, network: 120000, visibleLocal: 120000, visibleNetwork: 300000 };
const NETWORK_COMMANDS = new Set(['push', 'fetch', 'pull', 'ls-remote']);

let gitPath = 'git';
let log = () => {};
// (args, cwd, timeout) => output, or null when the terminal cannot run it.
let terminal = null;

function findGitExecutable(configured) {
  const candidates = [
    ...(Array.isArray(configured) ? configured : [configured]),
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Git', 'cmd', 'git.exe'),
  ];
  return candidates.find(candidate => typeof candidate === 'string' && candidate && fs.existsSync(candidate)) || 'git';
}

function configureGit(options) {
  if (options.executable) gitPath = options.executable;
  if (options.log) log = options.log;
  if ('terminal' in options) terminal = options.terminal;
}

class GitError extends Error {
  constructor(message, details) {
    super(message);
    this.name = 'GitError';
    this.args = details.args;
    this.stderr = details.stderr;
    this.timedOut = details.timedOut;
    this.notFound = details.notFound;
  }
}

function timeoutFor(args, visible = false) {
  const network = NETWORK_COMMANDS.has(args[0]);
  if (visible) return network ? TIMEOUTS.visibleNetwork : TIMEOUTS.visibleLocal;
  return network ? TIMEOUTS.network : TIMEOUTS.local;
}

// Progress lines end in carriage returns and colour codes; keep the text a
// terminal would finally show.
function cleanOutput(text) {
  return stripAnsi(text)
    .split('\n')
    .map(line => line.split('\r').filter(Boolean).pop() || '')
    .join('\n')
    .trim();
}

function toGitError(args, error, stdout, stderr, timeout) {
  const output = cleanOutput(stderr) || cleanOutput(stdout);
  const timedOut = Boolean(error.killed) && error.code !== 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER';
  const notFound = error.code === 'ENOENT';
  let message = output || error.message;
  if (timedOut) message = `git ${args[0]}: no answer within ${Math.round(timeout / 1000)} s`;
  if (notFound) message = `git was not found (${gitPath})`;
  return new GitError(message, { args, stderr: output, timedOut, notFound });
}

// options.visible runs a command that changes the repository in the editor's
// terminal, where the user sees it and Git Credential Manager can ask for a
// sign-in. Without shell integration it runs in the background as before.
async function runGit(args, cwd, options = {}) {
  if (options.visible && terminal) {
    const output = await terminal(args, cwd, timeoutFor(args, true));
    if (output !== null) return output;
    log(`git ${args.join(' ')} (background: the terminal could not run it)`);
  }
  return runInBackground(args, cwd, options);
}

// options.raw keeps stdout untouched (needed for -z output); options.env adds
// environment variables for this one command.
function runInBackground(args, cwd, options) {
  const timeout = options.timeout || timeoutFor(args);
  // Without a terminal, a username prompt would wait until the timeout.
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', ...options.env };
  return new Promise((resolve, reject) => {
    childProcess.execFile(gitPath, args, { cwd, env, encoding: 'utf8', timeout, windowsHide: true, maxBuffer: 32 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (!error) {
          resolve(options.raw ? stdout : String(stdout).trim());
          return;
        }
        const gitError = toGitError(args, error, stdout, stderr, timeout);
        log(`git ${args.join(' ')} => ${gitError.message}`);
        reject(gitError);
      });
  });
}

module.exports = { runGit, configureGit, findGitExecutable, cleanOutput, GitError };
