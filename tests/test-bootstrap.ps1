# Runs scripts/bootstrap.ps1 end to end against a local Git fixture: both README modes,
# source refresh, stale-launcher hand-off, IDE/terminal pauses, IDE 2.6.0 check, failures and repair hand-off.
param()
$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path $PSScriptRoot -Parent
$bootstrap = Join-Path $repoRoot 'scripts\bootstrap.ps1'
$version = (Get-Content -LiteralPath (Join-Path $repoRoot 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json).version
$git = (Get-Command git.exe -ErrorAction Stop).Source
$testRoot = Join-Path ([IO.Path]::GetTempPath()) ('workstation-bootstrap-test-' + [guid]::NewGuid().ToString('N'))
$fixture = Join-Path $testRoot 'fixture'
$remote = Join-Path $testRoot 'remote.git'
$download = Join-Path $testRoot 'Download root with spaces'
$utf8 = New-Object Text.UTF8Encoding $false
$passed = 0

function Invoke-Quiet([string[]]$Arguments) {
    $saved = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
    try { $output = & $git @Arguments 2>&1 | ForEach-Object { "$_" } } finally { $ErrorActionPreference = $saved }
    if ($LASTEXITCODE -ne 0) { throw "git $($Arguments -join ' ') failed: $output" }
    ($output -join "`n").Trim()
}
function Write-Fixture([string]$Relative, [string]$Text) {
    $file = Join-Path $fixture $Relative
    [IO.Directory]::CreateDirectory((Split-Path $file -Parent)) | Out-Null
    [IO.File]::WriteAllText($file, $Text, $utf8)
}
function Publish-Fixture([string]$Message) {
    $null = Invoke-Quiet @('-C', $fixture, 'add', '-A')
    $null = Invoke-Quiet @('-C', $fixture, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', $Message)
    $null = Invoke-Quiet @('-C', $fixture, 'push', '--quiet', '--force', $remote, 'HEAD:refs/heads/main')
    Invoke-Quiet @('-C', $fixture, 'rev-parse', 'HEAD')
}
function New-Ide([string]$Version) {
    # A fake installation: executable, product metadata and an initialized native profile.
    $root = Join-Path $testRoot ('IDE ' + $Version + ' with spaces')
    [IO.Directory]::CreateDirectory((Join-Path $root 'resources\app')) | Out-Null
    [IO.File]::WriteAllText((Join-Path $root 'Antigravity IDE.exe'), 'fixture', $utf8)
    [IO.File]::WriteAllText((Join-Path $root 'resources\app\product.json'), ('{"ideVersion":"' + $Version + '","nameShort":"Antigravity IDE"}'), $utf8)
    $root
}
function Invoke-Scenario([string]$Name, [string]$Mode = '', [string]$Fail = '', [string]$Launcher = $bootstrap, [switch]$IdeOpen, [switch]$OtherSession, [switch]$StandaloneOpen, [string]$Ide = $ide260, [string]$AppData = $appData, [string]$Terminal = 'none') {
    $log = Join-Path $testRoot ($Name + '.calls')
    $result = Join-Path $testRoot ($Name + '.result.json')
    $wrapper = Join-Path $testRoot 'wrapper.ps1'
    [IO.File]::WriteAllText($wrapper, @'
param([string]$Launcher, [string]$Remote, [string]$Download, [string]$Log, [string]$Fail, [string]$Mode, [string]$Result, [string]$IdeOpen, [string]$Ide, [string]$AppData, [string]$Terminal)
if ($Fail -eq 'none') { $Fail = '' }
if ($Mode -eq 'none') { $Mode = '' }
Remove-Item Env:TERM_PROGRAM, Env:VSCODE_PID, Env:VSCODE_INJECTION -ErrorAction SilentlyContinue
if ($Terminal -ne 'none') { $env:TERM_PROGRAM = $Terminal }
$env:ANTIGRAVITY_INSTALL_DIR = $Ide
$env:APPDATA = $AppData
$env:WORKSTATION_BOOTSTRAP_TEST_LOG = $Log
$env:WORKSTATION_BOOTSTRAP_TEST_FAIL = $Fail
$env:LOCALAPPDATA = Split-Path $Download -Parent
function Get-Process {
    # 'yes': Antigravity IDE in this Windows session; 'other': only in another user's session;
    # 'standalone': only the separate Antigravity.exe app is running.
    param([string[]]$Name, [object]$ErrorAction)
    $session = [Diagnostics.Process]::GetCurrentProcess().SessionId
    if ($IdeOpen -eq 'yes' -and ($Name -contains 'Antigravity IDE')) { [pscustomobject]@{ ProcessName = 'Antigravity IDE'; Id = 4242; SessionId = $session; Path = 'C:\Fixture IDE\Antigravity IDE.exe' } }
    if ($IdeOpen -eq 'other' -and ($Name -contains 'Antigravity IDE')) { [pscustomobject]@{ ProcessName = 'Antigravity IDE'; Id = 4343; SessionId = $session + 1; Path = $null } }
    if ($IdeOpen -eq 'standalone' -and ($Name -contains 'Antigravity')) { [pscustomobject]@{ ProcessName = 'Antigravity'; Id = 2632; SessionId = $session; Path = 'C:\Users\Fixture\AppData\Local\Programs\antigravity\Antigravity.exe' } }
}
# An interactive window answers N, so a scenario never waits for a keyboard.
function Read-Host { param([string]$Prompt) 'n' }
function Start-Sleep { param([int]$Seconds, [int]$Milliseconds) }
function Start-Process {
    # The fixture IDE: its first start creates the native profile database.
    param([string]$FilePath, [switch]$PassThru)
    Add-Content -LiteralPath $Log -Value (@{ command = 'start-ide'; args = @($FilePath) } | ConvertTo-Json -Compress) -Encoding UTF8
    $database = Join-Path $env:APPDATA 'Antigravity IDE\User\globalStorage\state.vscdb'
    [IO.Directory]::CreateDirectory((Split-Path $database -Parent)) | Out-Null
    [IO.File]::WriteAllText($database, 'new profile')
    [pscustomobject]@{ Id = 0 }
}
function Set-Clipboard { param([string]$Value) throw 'fixture clipboard unavailable' }
function Get-FileHash { throw 'fixture optional hash cmdlet unavailable' }
$switches = @{}
if ($Mode) { $switches[$Mode] = $true }
& $Launcher -Name 'povilitel' -DownloadRoot $Download -SourceUrl $Remote -ResultFile $Result @switches
exit $LASTEXITCODE
'@, $utf8)
    $saved = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
    $output = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $wrapper -Launcher $Launcher -Remote $remote -Download $download -Log $log -Fail $(if ($Fail) { $Fail } else { 'none' }) -Mode $(if ($Mode) { $Mode } else { 'none' }) -Result $result -IdeOpen $(if ($IdeOpen) { 'yes' } elseif ($OtherSession) { 'other' } elseif ($StandaloneOpen) { 'standalone' } else { 'no' }) -Ide $Ide -AppData $AppData -Terminal $Terminal 2>&1 | ForEach-Object { "$_" }
    $exit = $LASTEXITCODE
    $ErrorActionPreference = $saved
    $calls = @(if (Test-Path -LiteralPath $log) { Get-Content -LiteralPath $log -Encoding UTF8 | ForEach-Object { $_ | ConvertFrom-Json } })
    $summary = if (Test-Path -LiteralPath $result) { Get-Content -LiteralPath $result -Raw -Encoding UTF8 | ConvertFrom-Json }
    [pscustomobject]@{ Exit = $exit; Output = ($output -join "`n"); Calls = $calls; Result = $summary }
}
function Assert-True([bool]$Condition, [string]$Message, [object]$Run) {
    if (-not $Condition) { if ($Run) { Write-Host $Run.Output }; throw $Message }
    $script:passed++
}

try {
    [IO.Directory]::CreateDirectory($fixture) | Out-Null
    $tokens = $null; $parseErrors = $null
    $ast = [Management.Automation.Language.Parser]::ParseFile($bootstrap, [ref]$tokens, [ref]$parseErrors)
    $pathFunction = $ast.EndBlock.Statements | Where-Object { $_ -is [Management.Automation.Language.FunctionDefinitionAst] -and $_.Name -eq 'Update-SessionPath' }
    . ([scriptblock]::Create($pathFunction.Extent.Text))
    $savedPath = $env:Path
    $selectedTools = Join-Path $testRoot 'selected runtime'
    try {
        $env:Path = $selectedTools + ';' + $savedPath
        Update-SessionPath
        $afterFirst = $env:Path
        Assert-True ($afterFirst.StartsWith($selectedTools + ';')) 'Refreshing PATH must preserve the selected runtime ahead of older system tools'
        Update-SessionPath
        Assert-True ($env:Path -eq $afterFirst) 'Repeated PATH refreshes across bootstrap re-entry must deduplicate instead of bloating PATH'
        Update-SessionPath -AfterInstall
        $firstMachine = @(([Environment]::GetEnvironmentVariable('Path', 'Machine') -split ';') | ForEach-Object { $_.Trim() } | Where-Object { $_ })[0]
        $selectedIndex = $env:Path.IndexOf($selectedTools, [StringComparison]::OrdinalIgnoreCase)
        Assert-True ($env:Path.StartsWith($firstMachine + ';', [StringComparison]::OrdinalIgnoreCase) -and $selectedIndex -gt 0) 'After prerequisite installation the refreshed installed tool paths must take precedence'
    } finally { $env:Path = $savedPath }

    # Test-ReadyToRun on its own: it names the blocking processes, and only an interactive Y closes them.
    $readyFunctions = @($ast.EndBlock.Statements | Where-Object { $_ -is [Management.Automation.Language.FunctionDefinitionAst] -and
        @('Test-ReadyToRun', 'Stop-Ide', 'Write-Box', 'Write-Ok') -contains $_.Name })
    Assert-True ($readyFunctions.Count -eq 4) 'Bootstrap must define Test-ReadyToRun, Stop-Ide, Write-Box and Write-Ok'
    $cases = @(
        @{ Name = 'Y closes the IDE the normal way'; Open = $true; Interactive = $true; Answer = 'Y'; Closes = $true; Ready = $true; Asked = 1; Stopped = $false },
        @{ Name = 'Y on a Russian layout stops an IDE that ignores the close request'; Open = $true; Interactive = $true; Answer = [string][char]0x043D; Closes = $false; Ready = $true; Asked = 1; Stopped = $true },
        @{ Name = 'N keeps the IDE and pauses'; Open = $true; Interactive = $true; Answer = 'n'; Closes = $true; Ready = $false; Asked = 1; Stopped = $false },
        @{ Name = 'a window that cannot answer pauses without asking'; Open = $true; Interactive = $false; Answer = 'Y'; Closes = $true; Ready = $false; Asked = 0; Stopped = $false },
        @{ Name = 'a closed IDE needs no question'; Open = $false; Interactive = $true; Answer = 'n'; Closes = $true; Ready = $true; Asked = 0; Stopped = $false })
    foreach ($case in $cases) {
        $probe = @{ Open = $case.Open; Interactive = $case.Interactive; Answer = $case.Answer; Closes = $case.Closes; Asked = 0; Stopped = 0
            Lines = New-Object Collections.Generic.List[string] }
        $savedTerminal = @($env:TERM_PROGRAM, $env:VSCODE_PID, $env:VSCODE_INJECTION)
        Remove-Item Env:TERM_PROGRAM, Env:VSCODE_PID, Env:VSCODE_INJECTION -ErrorAction SilentlyContinue
        try {
            $ready = @(& {
                foreach ($function in $readyFunctions) { . ([scriptblock]::Create($function.Extent.Text)) }
                $CloseQuestion = 'Close? (Y/N)'
                $fake = [pscustomobject]@{ ProcessName = 'Antigravity IDE'; Id = 4242; Path = 'C:\Fixture IDE\Antigravity IDE.exe' }
                $fake | Add-Member -MemberType ScriptMethod -Name CloseMainWindow -Value { if ($probe.Closes) { $probe.Open = $false }; $true }
                function Get-IdeProcesses { if ($probe.Open) { $fake } }
                function Test-InteractiveHost { $probe.Interactive }
                function Read-Host { param([string]$Prompt) $probe.Asked = $probe.Asked + 1; $probe.Answer }
                function Stop-Process { param([Parameter(ValueFromPipeline = $true)][object]$InputObject, [switch]$Force) process { $probe.Stopped = $probe.Stopped + 1; $probe.Open = $false } }
                function Start-Sleep { param([int]$Seconds, [int]$Milliseconds) [Threading.Thread]::Sleep(50) }
                function Write-Line { param([string]$Text, [string]$Color) $probe.Lines.Add($Text) }
                Test-ReadyToRun
            })
        } finally { $env:TERM_PROGRAM = $savedTerminal[0]; $env:VSCODE_PID = $savedTerminal[1]; $env:VSCODE_INJECTION = $savedTerminal[2] }
        $text = $probe.Lines -join "`n"
        Assert-True ($ready.Count -eq 1 -and $ready[0] -eq $case.Ready) "Test-ReadyToRun ($($case.Name)) must return only $($case.Ready); got: $($ready -join ', '); $text"
        Assert-True ($probe.Asked -eq $case.Asked -and ($probe.Stopped -gt 0) -eq $case.Stopped) "Test-ReadyToRun ($($case.Name)) asked $($probe.Asked) and stopped $($probe.Stopped); $text"
        if ($case.Open) {
            Assert-True ($text -match 'PID 4242  C:\\Fixture IDE\\Antigravity IDE\.exe') "Test-ReadyToRun ($($case.Name)) must name the process, PID and path; $text"
            Assert-True (($text -match 'PAUSED: Antigravity is still running') -ne $case.Ready) "Test-ReadyToRun ($($case.Name)) pauses exactly when it does not continue; $text"
        }
    }
    # Get-GitBash and Get-GitExecutable: respect GIT_BASH_PATH and resolve git.exe beside bash.exe when not on PATH.
    $gitFunctions = @($ast.EndBlock.Statements | Where-Object { $_ -is [Management.Automation.Language.FunctionDefinitionAst] -and
        @('Get-GitBash', 'Get-GitExecutable') -contains $_.Name })
    Assert-True ($gitFunctions.Count -eq 2) 'Bootstrap must define Get-GitBash and Get-GitExecutable'
    $fakeGitRoot = Join-Path $testRoot 'Custom Git Root'
    $fakeGitBash = Join-Path $fakeGitRoot 'bin\bash.exe'
    $fakeGitExe = Join-Path $fakeGitRoot 'cmd\git.exe'
    [IO.Directory]::CreateDirectory((Split-Path $fakeGitBash -Parent)) | Out-Null
    [IO.Directory]::CreateDirectory((Split-Path $fakeGitExe -Parent)) | Out-Null
    [IO.File]::WriteAllText($fakeGitBash, 'fixture', $utf8)
    [IO.File]::WriteAllText($fakeGitExe, 'fixture', $utf8)
    $savedGitBash = $env:GIT_BASH_PATH
    try {
        $env:GIT_BASH_PATH = $fakeGitBash
        $resolvedGit = & {
            foreach ($function in $gitFunctions) { . ([scriptblock]::Create($function.Extent.Text)) }
            function Get-Command { param([string]$Name, [switch]$All, [string]$CommandType, [object]$ErrorAction) $null }
            $bash = Get-GitBash
            [pscustomobject]@{ Bash = $bash; Git = (Get-GitExecutable $bash) }
        }
        Assert-True ($resolvedGit.Bash -eq $fakeGitBash) "Get-GitBash must honor GIT_BASH_PATH; got: $($resolvedGit.Bash)"
        Assert-True ($resolvedGit.Git -eq $fakeGitExe) "Get-GitExecutable must find cmd\git.exe beside Git Bash when PATH omits git.exe; got: $($resolvedGit.Git)"
    } finally {
        if ($null -eq $savedGitBash) { Remove-Item Env:GIT_BASH_PATH -ErrorAction SilentlyContinue } else { $env:GIT_BASH_PATH = $savedGitBash }
    }
    $ide260 = New-Ide '2.6.0'
    $ide255 = New-Ide '2.5.5'
    $ide270 = New-Ide '2.7.0'
    $ide280 = New-Ide '2.8.0'
    $ide290 = New-Ide '2.9.0'
    $ide300 = New-Ide '3.0.0'
    $missingIde = Join-Path $testRoot 'Missing IDE Folder'
    $appData = Join-Path $testRoot 'AppData Roaming'
    $emptyAppData = Join-Path $testRoot 'AppData never started'
    [IO.Directory]::CreateDirectory((Join-Path $appData 'Antigravity IDE\User\globalStorage')) | Out-Null
    [IO.Directory]::CreateDirectory($emptyAppData) | Out-Null
    [IO.File]::WriteAllText((Join-Path $appData 'Antigravity IDE\User\globalStorage\state.vscdb'), 'fixture', $utf8)
    $null = Invoke-Quiet @('init', '--quiet', '--bare', $remote)
    $null = Invoke-Quiet @('init', '--quiet', $fixture)
    Write-Fixture 'package.json' ('{"name":"antigravity-workstation-setup","version":"' + $version + '"}')
    Write-Fixture 'bin/workstation-setup.js' @'
const fs = require('fs');
fs.appendFileSync(process.env.WORKSTATION_BOOTSTRAP_TEST_LOG, JSON.stringify({ command: process.argv[2], args: process.argv.slice(3), entry: process.argv[1], ide: process.env.ANTIGRAVITY_INSTALL_DIR, gitBash: process.env.GIT_BASH_PATH }) + '\n');
if (process.env.WORKSTATION_BOOTSTRAP_TEST_FAIL === process.argv[2]) {
  console.error('Setup incomplete: fixture ' + process.argv[2] + ' failure: \u041e\u0448\u0438\u0431\u043a\u0430 \u2717');
  process.exit(7);
}
if (process.argv[2] === 'full-reset') {
  // The fixture reset removes the native profile, like the real one moves the whole AppData folder.
  fs.rmSync(require('path').join(process.env.APPDATA, 'Antigravity IDE', 'User', 'globalStorage', 'state.vscdb'), { force: true });
  console.log('Full reset backup: ' + require('path').join(process.env.APPDATA, 'fixture-full-reset-backup'));
}
console.log('fixture ' + process.argv[2] + ' ok: \u0413\u043e\u0442\u043e\u0432\u043e');
'@
    Write-Fixture 'scripts/queue-repair-chat.cjs' @'
const fs = require('fs'), path = require('path');
if (process.argv[2] === '--doctor-passed') { console.log(JSON.stringify({ state: 'idle' })); process.exit(0); }
const report = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));
if (report.exitCode !== 7 || !report.failure.includes('fixture')) process.exit(1);
const requestFile = path.join(path.dirname(process.argv[3]), 'request.json');
fs.writeFileSync(requestFile, JSON.stringify(report));
console.log(JSON.stringify({ queued: true, requestFile, prompt: 'Fixture repair task for ' + (process.argv[4] || 'full') }));
'@
    Write-Fixture 'scripts/bootstrap.ps1' ([IO.File]::ReadAllText($bootstrap))
    $first = Publish-Fixture 'first'

    $run = Invoke-Scenario 'install'
    Assert-True ($run.Exit -eq 0 -and $run.Calls.Count -eq 2 -and $run.Calls[0].command -eq 'install' -and $run.Calls[1].command -eq 'doctor') 'Command 2 must install and then run Doctor' $run
    Assert-True ($run.Calls[0].args -notcontains '--clean-extensions' -and $run.Calls[0].args -notcontains '--reset-profile' -and $run.Calls[0].args -contains 'povilitel') 'Command 2 must keep other extensions and forward the name' $run
    Assert-True ($run.Calls[0].args -contains '--apply-profile') 'Command 2 must set every profile value again, not keep values of older setups' $run
    Assert-True ($run.Calls[0].args -contains '--quiet-completion' -and $run.Calls[0].args -contains '--auto-approve' -and $run.Calls[0].args -contains '--allow-portable-fallback') 'Command 2 must turn AI suggestions off, let the agent work without asking and enable future IDE fallback' $run
    Assert-True ($run.Calls[0].ide -eq $ide260 -and $run.Calls[1].ide -eq $ide260) 'Install and Doctor must use the checked IDE 2.6.0 folder' $run
    Assert-True ($run.Calls[0].gitBash -and (Test-Path -LiteralPath $run.Calls[0].gitBash -PathType Leaf) -and $run.Calls[1].gitBash -eq $run.Calls[0].gitBash) 'Install and Doctor must receive the verified Git Bash path' $run
    Assert-True ($run.Output -match [regex]::Escape($first) -and $run.Result.state -eq 'stages-complete') 'Command 2 must report the synced commit and result' $run
    Assert-True ($run.Output.Contains("fixture install ok: $([char]0x0413)")) 'UTF-8 installer output must reach the console intact' $run
    $source = Join-Path $download 'm-safarov-antigravity-workstation\source'
    Assert-True ((Test-Path -LiteralPath (Join-Path $source 'bin\workstation-setup.js')) -and -not (Test-Path -LiteralPath (Join-Path $source '.git'))) 'The source tree must contain only repository files' $run
    $leftoverStaging = @(Get-ChildItem -LiteralPath (Join-Path $download 'm-safarov-antigravity-workstation') -Directory -Filter 'staging-*' -ErrorAction SilentlyContinue)
    Assert-True ($leftoverStaging.Count -eq 0) 'Successful install must remove temporary staging directories' $run
    Assert-True ($run.Output -match 'MANCHO SETING ANTIGRAVITI') 'Installer output must show the MANCHO SETING ANTIGRAVITI title' $run

    $run = Invoke-Scenario 'clean' 'CleanExtensions'
    Assert-True ($run.Exit -eq 0 -and ((@($run.Calls | ForEach-Object { $_.command })) -join ',') -eq 'full-reset,start-ide,install,doctor') 'Command 1 must reset, start the IDE once, install and run Doctor' $run
    Assert-True ($run.Calls[0].args -contains '--confirm-full-reset' -and $run.Calls[1].args[0] -eq (Join-Path $ide260 'Antigravity IDE.exe')) 'Command 1 must confirm the reset and start the checked IDE 2.6.0' $run
    foreach ($flag in '--clean-extensions', '--reset-profile', '--quiet-completion', '--auto-approve') {
        Assert-True ($run.Calls[2].args -contains $flag) "Command 1 must forward $flag" $run
    }
    Assert-True ($run.Calls[2].args -notcontains '--apply-profile') 'Command 1 starts from an empty profile and needs no apply-profile' $run
    Assert-True ($run.Result.resetBackup -eq (Join-Path $appData 'fixture-full-reset-backup') -and $run.Output -match 'sign in again' -and $run.Output -match 'NOTICE: Existing Antigravity profile detected' -and $run.Output -match '\[1/6\]' -and $run.Output -match '\[6/6\]') 'Command 1 must report the reset notice, reset backup, the sign-in and six steps' $run
    Assert-True (Test-Path -LiteralPath (Join-Path $appData 'Antigravity IDE\User\globalStorage\state.vscdb')) 'Command 1 must leave a new native profile for the AI-off step' $run

    $freshAppData = Join-Path $testRoot 'AppData new computer'
    [IO.Directory]::CreateDirectory($freshAppData) | Out-Null
    $run = Invoke-Scenario 'clean-new-computer' 'CleanExtensions' -AppData $freshAppData
    Assert-True ($run.Exit -eq 0 -and $run.Calls.Count -eq 4 -and $run.Calls[1].command -eq 'start-ide') 'Command 1 must work on an IDE that was never opened' $run

    $run = Invoke-Scenario 'reset-fail' 'CleanExtensions' 'full-reset'
    Assert-True ($run.Exit -eq 7 -and $run.Calls.Count -eq 1 -and $run.Result.state -eq 'failed' -and $run.Output -match 'Stage: Full reset') 'A failed reset must stop before the IDE start and the install' $run

    foreach ($mode in 'CleanExtensions', '') {
        $run = Invoke-Scenario ('open-' + $mode) $mode -IdeOpen
        Assert-True ($run.Exit -eq 3 -and $run.Calls.Count -eq 0 -and $run.Result.state -eq 'paused' -and $run.Output -match 'PAUSED: Antigravity is still running') 'Both commands must pause without changes while the IDE is open' $run
        Assert-True ($run.Output -match 'Antigravity IDE  PID 4242  C:\\Fixture IDE\\Antigravity IDE\.exe') 'The pause must name the blocking process, its PID and path' $run
        $standalone = Invoke-Scenario ('standalone-' + $mode) $mode -StandaloneOpen
        Assert-True ($standalone.Exit -eq 0 -and $standalone.Calls.Count -ge 2) 'Standalone Antigravity.exe must not block or pause either command' $standalone
    }
    $run = Invoke-Scenario 'other-session' -OtherSession
    Assert-True ($run.Exit -eq 0 -and $run.Calls.Count -eq 2 -and $run.Calls[0].command -eq 'install') 'Antigravity of another Windows session must not block this user' $run
    $run = Invoke-Scenario 'ide-terminal' -Terminal 'vscode'
    Assert-True ($run.Exit -eq 3 -and $run.Calls.Count -eq 0 -and $run.Output -match 'terminal of an editor') 'An editor terminal must pause and point to Windows PowerShell' $run
    $run = Invoke-Scenario 'missing-ide' -Ide $missingIde
    Assert-True ($run.Exit -eq 4 -and $run.Calls.Count -eq 0 -and $run.Result.state -eq 'ide-not-ready' -and $run.Output -match 'Antigravity IDE is not installed' -and $run.Output -match 'stable/2\.9\.0-') 'Missing IDE must stop with the official 2.9.0 download' $run
    $run = Invoke-Scenario 'old-ide' -Ide $ide255
    Assert-True ($run.Exit -eq 0 -and $run.Calls.Count -ge 1 -and $run.Calls[0].ide -eq $ide255 -and $run.Output -match 'recognized older version' -and $run.Calls[0].args -contains '--allow-portable-fallback') 'Older recognized IDE 2.5.5 must be accepted with automatic fallback' $run
    $run = Invoke-Scenario 'ide-270' -Ide $ide270
    Assert-True ($run.Exit -eq 0 -and $run.Calls.Count -ge 1 -and $run.Calls[0].ide -eq $ide270) 'IDE 2.7.0 must be accepted like 2.6.0' $run
    $run = Invoke-Scenario 'ide-280' -Ide $ide280
    Assert-True ($run.Exit -eq 0 -and $run.Calls.Count -ge 1 -and $run.Calls[0].ide -eq $ide280) 'IDE 2.8.0 must be accepted like 2.7.0 and 2.6.0' $run
    $run = Invoke-Scenario 'ide-290' -Ide $ide290
    Assert-True ($run.Exit -eq 0 -and $run.Calls.Count -ge 1 -and $run.Calls[0].ide -eq $ide290 -and $run.Output -match '2\.9\.0 \(tested\)') 'IDE 2.9.0 must be accepted as tested' $run
    $run = Invoke-Scenario 'ide-300' -Ide $ide300
    Assert-True ($run.Exit -eq 0 -and $run.Calls.Count -ge 1 -and $run.Calls[0].ide -eq $ide300 -and $run.Output -match 'newer/unlisted version' -and $run.Calls[0].args -contains '--allow-portable-fallback') 'Future unlisted IDE 3.0.0 must be accepted with automatic schema/portable compatibility' $run
    $run = Invoke-Scenario 'never-started' -AppData $emptyAppData
    Assert-True ($run.Exit -eq 4 -and $run.Calls.Count -eq 0 -and $run.Output -match 'never been started') 'An IDE that was never opened must stop before any change' $run

    Write-Fixture 'extra/new-file.txt' 'second'
    $second = Publish-Fixture 'second'
    $leftover = Join-Path $source 'leftover.tmp'
    [IO.File]::WriteAllText($leftover, 'stale')
    $run = Invoke-Scenario 'update'
    Assert-True ($run.Exit -eq 0 -and $run.Output -match [regex]::Escape($second) -and (Test-Path -LiteralPath (Join-Path $source 'extra\new-file.txt'))) 'Updates must fetch the newest commit' $run
    Assert-True (-not (Test-Path -LiteralPath $leftover)) 'Updates must remove files that are not in the newest commit' $run

    $stale = Join-Path $testRoot 'stale-launcher.ps1'
    [IO.File]::WriteAllText($stale, ([IO.File]::ReadAllText($bootstrap) + "`n# older web copy`n"), $utf8)
    $run = Invoke-Scenario 'stale' '' '' $stale
    Assert-True ($run.Exit -eq 0 -and $run.Output -match 'Running the newest bootstrap' -and $run.Calls.Count -eq 2 -and $run.Result.state -eq 'stages-complete') 'A stale launcher must hand off to the newest bootstrap once' $run

    $run = Invoke-Scenario 'install-fail' '' 'install'
    Assert-True ($run.Exit -eq 2 -and $run.Calls.Count -eq 1 -and $run.Result.state -eq 'repair-pending' -and $run.Output -match 'Fixture repair task for full') 'An incomplete install must queue one repair task and skip Doctor' $run
    Assert-True ($run.Output -match 'BEGIN SETUP REPAIR TASK' -and $run.Output -match 'Repair text file:') 'Repair text must reach a file and the terminal without a clipboard' $run
    $report = Get-Content -LiteralPath (Join-Path $download 'm-safarov-antigravity-workstation\logs\setup-failure.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    Assert-True ($report.sourceCommit -eq $second -and $report.stage -eq 'install' -and $report.failure.Contains([string][char]0x2717)) 'The failure report must keep the commit and the Unicode error' $run

    $run = Invoke-Scenario 'doctor-fail' '' 'doctor'
    Assert-True ($run.Exit -eq 2 -and $run.Calls.Count -eq 2 -and $run.Calls[1].command -eq 'doctor') 'A Doctor failure must queue a repair task' $run

    $saved = $remote
    $remote = Join-Path $testRoot 'missing.git'
    $run = Invoke-Scenario 'offline'
    $remote = $saved
    Assert-True ($run.Exit -eq 1 -and $run.Calls.Count -eq 0 -and $run.Output -match '\[SETUP FAILED\] Stage: Download the newest setup' -and $run.Result.state -eq 'failed') 'A download failure must stop before any setup change' $run

    $dry = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $bootstrap -DryRun 2>&1 | ForEach-Object { "$_" }
    Assert-True ($LASTEXITCODE -eq 0 -and ($dry -join "`n") -match 'DRY-RUN') 'Dry run must succeed without downloading' $null

    $dry = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $bootstrap -DryRun -CleanExtensions 2>&1 | ForEach-Object { "$_" }
    Assert-True ($LASTEXITCODE -eq 0 -and ($dry -join "`n") -match 'move every Antigravity setting, sign-in and chat into a backup') 'Command 1 dry run must describe the full reset' $null

    Write-Host "PASS: $passed bootstrap checks (commands 1/2, full reset, IDE open, editor terminal, IDE 2.6.0, update, stale launcher, failures, offline, dry run)"
} finally {
    if ((Split-Path $testRoot -Leaf) -match '^workstation-bootstrap-test-[a-f0-9]{32}$') {
        $node = (Get-Command node.exe -ErrorAction SilentlyContinue).Source
        if ($node) { & $node -e "require('fs').rmSync(process.argv[1],{recursive:true,force:true,maxRetries:3})" $testRoot }
    }
}
