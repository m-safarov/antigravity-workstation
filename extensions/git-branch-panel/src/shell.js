'use strict';

// Commands the extension types into an integrated terminal: bash quoting,
// colour-code removal and the editor's shell integration API (VS Code 1.93+).

const SHELL_INTEGRATION_WAIT_MS = 3000;

// CSI (colours, cursor moves), OSC (titles, shell integration marks) and the
// remaining two-byte escape sequences.
const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
const ESCAPES = new RegExp(`${ESC}\\[[0-?]*[ -/]*[@-~]|${ESC}\\][^${BEL}${ESC}]*(?:${BEL}|${ESC}\\\\)|${ESC}[@-Z\\\\-_]`, 'g');
const CONTROL_CHAR = new RegExp(`[${String.fromCharCode(0)}-${String.fromCharCode(31)}${String.fromCharCode(127)}]`);
const ESCAPE_QUOTE_CHAR = new RegExp(`[\\\\'!${String.fromCharCode(0)}-${String.fromCharCode(31)}${String.fromCharCode(127)}]`, 'g');

function stripAnsi(text) {
  return String(text || '').replace(ESCAPES, '');
}

const NAMED_ESCAPES = { '\\': '\\\\', '\n': '\\n', '\r': '\\r', '\t': '\\t' };
const escapeChar = char => NAMED_ESCAPES[char] || '\\x' + char.charCodeAt(0).toString(16).padStart(2, '0');

// One bash argument. Plain words stay as typed; anything else is single
// quoted, so $, `, " and ! are never expanded. Text with line breaks uses
// $'…' to keep the command on one line; quotes and ! are written as \xHH
// there, so no part of the text can end the quoting.
function quoteArg(value) {
  const text = String(value);
  if (/^[\w@%+=:,./-]+$/.test(text)) return text;
  if (!CONTROL_CHAR.test(text)) return `'${text.replace(/'/g, `'\\''`)}'`;
  return `$'${text.replace(ESCAPE_QUOTE_CHAR, escapeChar)}'`;
}

// Git Bash turns arguments that start with / into Windows paths before a
// native program such as git.exe sees them; MSYS_NO_PATHCONV keeps them.
function commandLine(args, platform = process.platform) {
  const line = args.map(quoteArg).join(' ');
  return platform === 'win32' && args.some(arg => String(arg).startsWith('/')) ? 'MSYS_NO_PATHCONV=1 ' + line : line;
}

// On Windows, D:\x, d:/x and Git Bash's /d/x are the same folder on any drive.
function sameDirectory(left, right, platform = process.platform) {
  const normal = value => {
    const text = String(value || '').replace(/\\/g, '/').replace(/\/+$/, '');
    return platform === 'win32' ? text.replace(/^\/([a-z])(?=\/|$)/i, '$1:').toLowerCase() : text;
  };
  return Boolean(left) && normal(left) === normal(right);
}

// Resolves with the terminal's shell integration, or null when the shell
// does not report it within the wait (it then runs commands without it).
function waitForShellIntegration(window, terminal, timeout = SHELL_INTEGRATION_WAIT_MS) {
  if (terminal.shellIntegration || !window.onDidChangeTerminalShellIntegration) return Promise.resolve(terminal.shellIntegration || null);
  return new Promise(resolve => {
    const finish = value => {
      clearTimeout(timer);
      listener.dispose();
      resolve(value || null);
    };
    const listener = window.onDidChangeTerminalShellIntegration(event => {
      if (event.terminal === terminal) finish(event.shellIntegration);
    });
    const timer = setTimeout(() => finish(terminal.shellIntegration), timeout);
  });
}

// Resolves with { exitCode } when the command ends, { closed: true } when the
// terminal is closed first and { timedOut: true } after timeout ms.
function waitForEnd(window, terminal, execution, timeout) {
  return new Promise(resolve => {
    const finish = value => {
      clearTimeout(timer);
      listeners.forEach(listener => listener.dispose());
      resolve(value);
    };
    const listeners = [
      window.onDidEndTerminalShellExecution(event => { if (event.execution === execution) finish({ exitCode: event.exitCode }); }),
      window.onDidCloseTerminal(closed => { if (closed === terminal) finish({ closed: true }); }),
    ];
    const timer = setTimeout(() => finish({ timedOut: true }), timeout);
  });
}

// Reads what a command prints, keeping the last `limit` characters.
// onText receives the kept text after every chunk.
function collectOutput(execution, limit, onText = () => {}) {
  let text = '';
  const done = (async () => {
    try {
      for await (const data of execution.read()) {
        text = (text + data).slice(-limit);
        onText(text);
      }
    } catch {}
  })();
  return { done, text: () => text };
}

module.exports = { stripAnsi, quoteArg, commandLine, sameDirectory, waitForShellIntegration, waitForEnd, collectOutput, SHELL_INTEGRATION_WAIT_MS };
