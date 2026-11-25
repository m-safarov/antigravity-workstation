import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const bootstrapPath = path.join(repoRoot, 'scripts', 'bootstrap.ps1');
const cliPath = path.join(repoRoot, 'bin', 'workstation-setup.js');

function createZipArchive(sourceDir, zipFile) {
  if (process.platform !== 'win32') return false;
  const ps = [
    'Add-Type -AssemblyName System.IO.Compression.FileSystem',
    `[IO.Compression.ZipFile]::CreateFromDirectory('${sourceDir.replaceAll("'", "''")}', '${zipFile.replaceAll("'", "''")}', [IO.Compression.CompressionLevel]::Fastest, $true)`,
  ].join('; ');
  execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', ps], { stdio: 'pipe' });
  return true;
}

function makeFakeFixtureDir(rootDir, version = '3.15.0', markerText = 'valid-v1') {
  const pkgDir = path.join(rootDir, 'antigravity-workstation-fixture');
  fs.mkdirSync(path.join(pkgDir, 'bin'), { recursive: true });
  fs.mkdirSync(path.join(pkgDir, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({
    name: 'antigravity-workstation-setup',
    version,
  }));
  fs.writeFileSync(path.join(pkgDir, 'marker.txt'), markerText);
  fs.writeFileSync(path.join(pkgDir, 'bin', 'workstation-setup.js'), [
    'const fs = require("node:fs");',
    'if (process.env.WORKSTATION_PROGRESS_LOG) fs.appendFileSync(process.env.WORKSTATION_PROGRESS_LOG, process.argv.slice(2).join(" ") + "\\n");',
    'console.log("fixture-run-ok " + process.argv[2]);',
  ].join('\n'));
  fs.writeFileSync(path.join(pkgDir, 'scripts', 'queue-repair-chat.cjs'), 'console.log(JSON.stringify({state:"idle"}));\n');
  fs.writeFileSync(path.join(pkgDir, 'scripts', 'bootstrap.ps1'), fs.readFileSync(bootstrapPath, 'utf8'));
  return pkgDir;
}

function makeFakeIde(rootDir) {
  const ideDir = path.join(rootDir, 'IDE 2.9.0 (Кириллица и пробелы)');
  fs.mkdirSync(path.join(ideDir, 'resources', 'app'), { recursive: true });
  fs.writeFileSync(path.join(ideDir, 'Antigravity IDE.exe'), 'fixture');
  fs.writeFileSync(path.join(ideDir, 'resources', 'app', 'product.json'), JSON.stringify({
    ideVersion: '2.9.0',
    nameShort: 'Antigravity IDE',
  }));
  const appData = path.join(rootDir, 'AppData Тест');
  fs.mkdirSync(path.join(appData, 'Antigravity IDE', 'User', 'globalStorage'), { recursive: true });
  fs.writeFileSync(path.join(appData, 'Antigravity IDE', 'User', 'globalStorage', 'state.vscdb'), 'fixture');
  return { ideDir, appData };
}

test('bootstrap.ps1 is strictly 7-bit ASCII and defines branded banner + staging/progress helpers', () => {
  const text = fs.readFileSync(bootstrapPath, 'utf8');
  assert.equal(/[^\x00-\x7f]/.test(text), false, 'bootstrap.ps1 must stay strictly 7-bit ASCII for PowerShell 5.1');
  assert.match(text, /MANCHO SETING ANTIGRAVITI/);
  for (const fn of ['Show-Banner', 'Invoke-StreamDownload', 'Resolve-PinnedRevision', 'New-StagingDirectory', 'Remove-OwnedStaging', 'Expand-VerifiedArchive', 'Promote-StagedTree']) {
    assert.ok(text.includes('function ' + fn), 'missing helper function ' + fn);
  }
});

test('Show-Banner renders wide ASCII art on wide TTY, single-line on narrow/NO_COLOR/CI/redirected, and omits on Reentry', { skip: process.platform !== 'win32' }, () => {
  const probe = `
    $tokens = $null; $errors = $null
    $ast = [Management.Automation.Language.Parser]::ParseFile('${bootstrapPath.replaceAll("'", "''")}', [ref]$tokens, [ref]$errors)
    if ($errors.Count) { throw ($errors[0].Message) }
    $fns = @($ast.EndBlock.Statements | Where-Object { $_ -is [Management.Automation.Language.FunctionDefinitionAst] -and @('Test-ColorAllowed','Get-TerminalWidth','Test-WideBannerAllowed','Show-Banner') -contains $_.Name })
    function RunCase([bool]$color, [int]$width, [bool]$reentry) {
      $lines = New-Object Collections.Generic.List[string]
      $Reentry = $reentry
      foreach ($f in $fns) { . ([scriptblock]::Create($f.Extent.Text)) }
      function Test-ColorAllowed { $color }
      function Get-TerminalWidth { $width }
      function Write-Line([string]$Text, [string]$Color = 'Gray') { $lines.Add($Text) }
      Show-Banner '2 - Install or update' 'Windows build 26100, AMD64'
      return ($lines -join "\`n")
    }
    $out = [ordered]@{
      wide = RunCase $true 100 $false
      narrow = RunCase $true 60 $false
      noColor = RunCase $false 120 $false
      reentry = RunCase $true 120 $true
    }
    $out | ConvertTo-Json -Compress
  `;
  const raw = execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', probe], { encoding: 'utf8' });
  const res = JSON.parse(raw.trim());
  assert.match(res.wide, /MANCHO SETING ANTIGRAVITI/);
  assert.ok(res.wide.split('\n').length >= 10, 'wide banner must include ASCII art block');
  assert.equal(res.wide.split('MANCHO SETING ANTIGRAVITI').length, 2, 'title printed once');
  assert.match(res.narrow, /^MANCHO SETING ANTIGRAVITI\nMode 2/);
  assert.ok(res.narrow.split('\n').length <= 3, 'narrow terminal gets compact single-line title');
  assert.match(res.noColor, /^MANCHO SETING ANTIGRAVITI\nMode 2/);
  assert.equal(res.reentry, '', 'Reentry must not print banner a second time');
});

test('bootstrap.ps1 streams known/unknown Content-Length archives, retries transient 503, fast-fails 404, rejects corrupt ZIP, handles Cyrillic+spaces paths and cleans staging', { skip: process.platform !== 'win32' }, async t => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'workstation-progress-Тест '));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const pkgDir = makeFakeFixtureDir(tmp, '3.15.0', 'good-release');
  const zipFile = path.join(tmp, 'good.zip');
  createZipArchive(pkgDir, zipFile);
  const zipBytes = fs.readFileSync(zipFile);
  const { ideDir, appData } = makeFakeIde(tmp);
  const downloadRoot = path.join(tmp, 'Загрузки setup with spaces');
  const callLog = path.join(tmp, 'calls.log');

  let flakyCalls = 0;
  let notFoundCalls = 0;
  const server = http.createServer((req, res) => {
    if (req.url === '/good-known.zip') {
      res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Length': String(zipBytes.length) });
      res.end(zipBytes);
      return;
    }
    if (req.url === '/good-unknown.zip') {
      res.writeHead(200, { 'Content-Type': 'application/zip', 'Transfer-Encoding': 'chunked' });
      const mid = Math.floor(zipBytes.length / 2);
      res.write(zipBytes.subarray(0, mid));
      setTimeout(() => { res.end(zipBytes.subarray(mid)); }, 250);
      return;
    }
    if (req.url === '/flaky.zip') {
      flakyCalls++;
      if (flakyCalls === 1) {
        res.writeHead(503, { 'Content-Type': 'text/plain' });
        res.end('temporary outage');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Length': String(zipBytes.length) });
      res.end(zipBytes);
      return;
    }
    if (req.url === '/missing.zip') {
      notFoundCalls++;
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('not found');
      return;
    }
    if (req.url === '/corrupt.zip') {
      const bad = Buffer.from('not-a-valid-zip-archive-at-all');
      res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Length': String(bad.length) });
      res.end(bad);
      return;
    }
    res.writeHead(404); res.end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const port = server.address().port;

  function runArchiveScenario(urlPath, pinned = '1'.repeat(40)) {
    const wrapper = path.join(tmp, 'run.ps1');
    fs.writeFileSync(wrapper, '\uFEFF' + [
      'Remove-Item Env:TERM_PROGRAM, Env:VSCODE_PID, Env:VSCODE_INJECTION -ErrorAction SilentlyContinue',
      `$env:ANTIGRAVITY_INSTALL_DIR = '${ideDir.replaceAll("'", "''")}'`,
      `$env:APPDATA = '${appData.replaceAll("'", "''")}'`,
      `$env:LOCALAPPDATA = '${tmp.replaceAll("'", "''")}'`,
      `$env:WORKSTATION_PROGRESS_LOG = '${callLog.replaceAll("'", "''")}'`,
      'function Get-Process { param([string[]]$Name, [object]$ErrorAction) }',
      'function Start-Sleep { param([int]$Seconds, [int]$Milliseconds) }',
      'function Set-Clipboard { param([string]$Value) throw "no clipboard" }',
      `& '${bootstrapPath.replaceAll("'", "''")}' -DownloadRoot '${downloadRoot.replaceAll("'", "''")}' -ArchiveUrl 'http://127.0.0.1:${port}${urlPath}' -PinnedCommit '${pinned}'`,
      'exit $LASTEXITCODE',
    ].join('\r\n'));
    return new Promise((resolve, reject) => {
      const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', wrapper], { windowsHide: true });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', chunk => { stdout += chunk.toString('utf8'); });
      child.stderr.on('data', chunk => { stderr += chunk.toString('utf8'); });
      const timer = setTimeout(() => { child.kill(); reject(new Error('Scenario timed out: ' + urlPath)); }, 60000);
      child.on('error', err => { clearTimeout(timer); reject(err); });
      child.on('close', status => { clearTimeout(timer); resolve({ status, stdout, stderr }); });
    });
  }

  // 1. Known Content-Length: progress + 100% completion + clean staging + Cyrillic/spaces path
  const r1 = await runArchiveScenario('/good-known.zip', 'a'.repeat(40));
  const out1 = (r1.stdout || '') + (r1.stderr || '');
  assert.equal(r1.status, 0, out1);
  assert.match(out1, /MANCHO SETING ANTIGRAVITI/);
  assert.match(out1, /Download complete \(100%\)/);
  assert.match(out1, /DONE\s+Setup complete/);
  const baseDir = path.join(downloadRoot, 'm-safarov-antigravity-workstation');
  assert.equal(fs.readFileSync(path.join(baseDir, 'source', 'marker.txt'), 'utf8'), 'good-release');
  assert.deepEqual(fs.readdirSync(baseDir).filter(n => n.startsWith('staging-') || n.endsWith('.zip')), []);

  // 2. Unknown Content-Length (chunked): real bytes/elapsed, NEVER invents percentage
  const r2 = await runArchiveScenario('/good-unknown.zip', 'b'.repeat(40));
  const out2 = (r2.stdout || '') + (r2.stderr || '');
  assert.equal(r2.status, 0, out2);
  assert.match(out2, /Downloading .*elapsed/);
  assert.doesNotMatch(out2, /Download complete \(100%\)/, 'Unknown Content-Length must not invent 100%');
  assert.match(out2, /Download complete: /);

  // 3. Transient 503 retries cleanly and succeeds
  const r3 = await runArchiveScenario('/flaky.zip', 'c'.repeat(40));
  const out3 = (r3.stdout || '') + (r3.stderr || '');
  assert.equal(r3.status, 0, out3);
  assert.equal(flakyCalls, 2);
  assert.match(out3, /Retry 1\/3 .*HTTP 503/);

  // 4. Permanent 404 stops on attempt 1 without retry and preserves prior source + cleans staging
  const r4 = await runArchiveScenario('/missing.zip', 'd'.repeat(40));
  const out4 = (r4.stdout || '') + (r4.stderr || '');
  assert.notEqual(r4.status, 0);
  assert.equal(notFoundCalls, 1, 'Permanent HTTP 404 must not retry');
  assert.match(out4, /Permanent download error.*HTTP 404/);
  assert.equal(fs.readFileSync(path.join(baseDir, 'source', 'marker.txt'), 'utf8'), 'good-release');
  assert.deepEqual(fs.readdirSync(baseDir).filter(n => n.startsWith('staging-') || n.endsWith('.zip')), []);

  // 5. Corrupt archive rejected inside staging; last working state preserved; staging removed
  const r5 = await runArchiveScenario('/corrupt.zip', 'e'.repeat(40));
  assert.notEqual(r5.status, 0);
  assert.equal(fs.readFileSync(path.join(baseDir, 'source', 'marker.txt'), 'utf8'), 'good-release', 'Corrupt archive must not overwrite working source');
  assert.deepEqual(fs.readdirSync(baseDir).filter(n => n.startsWith('staging-') || n.endsWith('.zip')), [], 'Failed staging must be cleaned');
});

test('bin/workstation-setup.js --json emits pure valid JSON on stdout for doctor and install dry-run', { skip: process.platform !== 'win32' }, t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'workstation-json-purity-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const env = {
    ...process.env,
    USERPROFILE: home,
    APPDATA: path.join(home, 'AppData', 'Roaming'),
    LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
  };
  const docRun = spawnSync(process.execPath, [cliPath, 'doctor', '--json'], { encoding: 'utf8', env });
  const docJson = JSON.parse(docRun.stdout);
  assert.equal(typeof docJson.ok, 'boolean');
  assert.ok(Array.isArray(docJson.checks));

  const instRun = spawnSync(process.execPath, [cliPath, 'install', '--dry-run', '--skip-extensions', '--skip-font', '--skip-agent-browser', '--skip-permissions', '--json'], { encoding: 'utf8', env });
  const instJson = JSON.parse(instRun.stdout);
  assert.equal(instJson.dryRun, true);
  assert.equal(typeof instJson.success, 'boolean');
});
