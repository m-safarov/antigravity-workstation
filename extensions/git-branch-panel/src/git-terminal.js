'use strict';

// The GitHub terminal: panel commands that change the repository run here,
// visibly, exactly as if they were typed in Git Bash. Each command is awaited
// through shell integration, so the panel gets its exit code and output.
// Without shell integration run() resolves null and git runs in the background.
const fs = require('fs');
const path = require('path');
const { GitError, cleanOutput } = require('./git-runner');
const { commandLine, sameDirectory, waitForShellIntegration, waitForEnd, collectOutput } = require('./shell');
const { tr } = require('./text');

const NAME = 'GitHub';
const CD_TIMEOUT_MS = 10000;
const OUTPUT_LIMIT = 64 * 1024;
const OUTPUT_GRACE_MS = 500;
const CTRL_C = '\x03';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// Bash reports exit codes; an unknown one counts as success unless git
// printed an error.
const succeeded = result => result.exitCode === 0 ||
  (result.exitCode === undefined && !result.timedOut && !result.closed && !/^(fatal|error):/m.test(result.output));

const interrupted = result => result.exitCode > 128 && !result.timedOut && !/^(fatal|error):/m.test(result.output);

class GitTerminal {
  constructor(vscode, gitPath) {
    this.vscode = vscode;
    this.gitPath = gitPath;
    this.terminal = null;
    // The command running in the terminal, also one the user typed there.
    this.running = null;
    const { window } = vscode;
    this.listeners = [
      window.onDidCloseTerminal?.(closed => { if (closed === this.terminal) this.terminal = this.running = null; }),
      window.onDidStartTerminalShellExecution?.(event => { if (event.terminal === this.terminal) this.running = event.execution; }),
      window.onDidEndTerminalShellExecution?.(event => { if (event.execution === this.running) this.running = null; }),
    ].filter(Boolean);
  }

  dispose() {
    this.listeners.forEach(listener => listener.dispose());
  }

  // Git Bash on Windows (the profile from settings, else the one next to
  // git.exe); elsewhere the user's shell when it is bash or zsh. null means
  // no shell that understands the bash quoting.
  shell() {
    if (process.platform !== 'win32') {
      const shellPath = this.vscode.env?.shell || '';
      return /(^|\/)(ba|z)?sh$/.test(shellPath) ? { shellPath } : null;
    }
    const profile = this.vscode.workspace.getConfiguration('terminal.integrated').get('profiles.windows')?.['Git Bash'];
    const candidates = [profile?.path].flat();
    if (path.isAbsolute(this.gitPath || '')) candidates.push(path.join(path.dirname(path.dirname(this.gitPath)), 'bin', 'bash.exe'));
    const shellPath = candidates.find(file => typeof file === 'string' && fs.existsSync(file));
    return shellPath ? { shellPath, shellArgs: profile?.args || ['--login', '-i'] } : null;
  }

  // Shell integration of the terminal, in cwd and free for a command, or null.
  async ready(cwd) {
    const { window, ThemeIcon } = this.vscode;
    if (!this.terminal) {
      const shell = window.createTerminal && this.shell();
      if (!shell) return null;
      this.terminal = window.createTerminal({ name: NAME, cwd, iconPath: new ThemeIcon('github'), ...shell });
      await waitForShellIntegration(window, this.terminal);
    }
    const terminal = this.terminal;
    const integration = terminal?.shellIntegration;
    if (!integration || this.running) return null;
    terminal.show(true);
    if (sameDirectory(integration.cwd?.fsPath, cwd)) return integration;
    const moved = await this.execute(terminal, integration, commandLine(['cd', cwd.replace(/\\/g, '/')]), CD_TIMEOUT_MS);
    return succeeded(moved) ? integration : null;
  }

  // Resolves with what git printed, or null when the terminal cannot run the
  // command. A failed command rejects with a GitError, like the background runner.
  async run(args, cwd, timeout) {
    const integration = await this.ready(cwd);
    if (!integration) return null;
    const result = await this.execute(this.terminal, integration, commandLine(['git', ...args]), timeout);
    if (succeeded(result)) return result.output;
    // Stopped by a signal (130 = Ctrl+C, e.g. while Git Bash was still starting)
    // before git printed an error: git did not answer, so it runs in the background.
    if (interrupted(result)) return null;
    let message = result.output || `git ${args[0]}: exit code ${result.exitCode}`;
    if (result.timedOut) message = `git ${args[0]}: no answer within ${Math.round(timeout / 1000)} s`;
    if (result.closed) message = tr('Терминал GitHub закрыт до конца команды.', 'The GitHub terminal was closed before the command finished.');
    throw new GitError(message, { args, stderr: result.closed ? '' : result.output, timedOut: result.timedOut });
  }

  async execute(terminal, integration, line, timeout) {
    const execution = integration.executeCommand(line);
    this.running = execution;
    const output = collectOutput(execution, OUTPUT_LIMIT);
    const end = await waitForEnd(this.vscode.window, terminal, execution, timeout);
    // A command that does not finish is stopped, so the terminal is free again.
    if (end.timedOut) terminal.sendText(CTRL_C, false);
    await Promise.race([output.done, delay(OUTPUT_GRACE_MS)]);
    return { ...end, output: cleanOutput(output.text()) };
  }
}

module.exports = { GitTerminal };
