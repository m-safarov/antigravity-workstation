# Portable checks of scripts/install-font.ps1 that never touch the real user fonts: an installed JetBrains Mono
# is kept, a missing one is installed from the verified Aster Atelier files under Aster's names, and a damaged
# or missing file stops the script before any file is installed. The family check and the Windows font
# registration are replaced by stand-ins; the registration itself runs in the setup-checks workflow.
$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path $PSScriptRoot -Parent
$testRoot = Join-Path ([IO.Path]::GetTempPath()) ('workstation-font-stage-test-' + [guid]::NewGuid())
$utf8 = New-Object Text.UTF8Encoding $false
$powershell = (Get-Process -Id $PID).Path
$originalLocalAppData = $env:LOCALAPPDATA
$familyCheck = '$families = @((New-Object System.Drawing.Text.InstalledFontCollection).Families | ForEach-Object { $_.Name })'
$registration = '    Install-Fonts $staging'
$standIn = @'
    $fonts = Join-Path $env:LOCALAPPDATA 'Microsoft\Windows\Fonts'; [IO.Directory]::CreateDirectory($fonts) | Out-Null
    Get-ChildItem -LiteralPath $staging -Filter 'Aster-*.ttf' | ForEach-Object { [IO.File]::Copy($_.FullName, (Join-Path $fonts $_.Name)) }
'@

function New-Source([string]$Name, [string]$Families) {
    $root = Join-Path $testRoot $Name
    $fonts = Join-Path $root 'extensions\aster-appearance\fonts\jetbrainsmono'
    foreach ($folder in (Join-Path $root 'scripts'), (Join-Path $root 'config'), $fonts) { [IO.Directory]::CreateDirectory($folder) | Out-Null }
    [IO.File]::Copy((Join-Path $repoRoot 'config\font.json'), (Join-Path $root 'config\font.json'))
    Get-ChildItem -LiteralPath (Join-Path $repoRoot 'extensions\aster-appearance\fonts\jetbrainsmono') -Filter '*.ttf' |
        ForEach-Object { [IO.File]::Copy($_.FullName, (Join-Path $fonts $_.Name)) }
    $script = [IO.File]::ReadAllText((Join-Path $repoRoot 'scripts\install-font.ps1'))
    if (-not $script.Contains($familyCheck) -or -not $script.Contains($registration)) { throw 'scripts/install-font.ps1 changed; update this test' }
    $script = $script.Replace($familyCheck, '$families = @(' + $Families + ')').Replace($registration, $standIn)
    [IO.File]::WriteAllText((Join-Path $root 'scripts\install-font.ps1'), $script, $utf8)
    $root
}

function Invoke-Font([string]$Root, [string]$LocalAppData) {
    $report = Join-Path $testRoot ([guid]::NewGuid().ToString('N') + '.json')
    $env:LOCALAPPDATA = $LocalAppData
    $saved = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
    try {
        $output = & $powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File (Join-Path $Root 'scripts\install-font.ps1') `
            -ManifestPath (Join-Path $Root 'config\font.json') -ErrorReportPath $report 2>&1 | ForEach-Object { "$_" }
        $exit = $LASTEXITCODE
    } finally { $ErrorActionPreference = $saved; $env:LOCALAPPDATA = $originalLocalAppData }
    $failure = if (Test-Path -LiteralPath $report) { Get-Content -LiteralPath $report -Raw -Encoding UTF8 | ConvertFrom-Json }
    [pscustomobject]@{ Exit = $exit; Output = ($output -join "`n"); Report = $failure }
}

try {
    [IO.Directory]::CreateDirectory($testRoot) | Out-Null
    $manifest = Get-Content -LiteralPath (Join-Path $repoRoot 'config\font.json') -Raw -Encoding UTF8 | ConvertFrom-Json

    $user = Join-Path $testRoot 'User without JetBrains Mono'
    $run = Invoke-Font (New-Source 'Setup source with spaces' '') $user
    if ($run.Exit -ne 0) { throw "JetBrains Mono was not installed: $($run.Output)" }
    foreach ($file in $manifest.files) {
        $target = Join-Path $user ('Microsoft\Windows\Fonts\' + $file.name)
        if ((Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash.ToLowerInvariant() -ne $file.sha256) { throw "Installed file mismatch: $($file.name)" }
    }
    Write-Host 'PASS: the two JetBrains Mono files of Aster Atelier are verified and installed under the names Aster uses.'

    $user = Join-Path $testRoot 'User with JetBrains Mono'
    $run = Invoke-Font (New-Source 'Source for a user with JetBrains Mono' "'Segoe UI', 'JetBrains Mono'") $user
    if ($run.Exit -ne 0 -or $run.Output -notmatch 'already installed' -or (Test-Path -LiteralPath (Join-Path $user 'Microsoft'))) {
        throw "An installed JetBrains Mono must be kept as it is: $($run.Output)"
    }
    Write-Host 'PASS: an installed JetBrains Mono is kept; no second copy is added.'

    foreach ($damage in 'corrupt', 'missing') {
        $source = New-Source ('Damaged source ' + $damage) ''
        $file = Join-Path $source ('extensions\aster-appearance\fonts\jetbrainsmono\' + $manifest.files[-1].source)
        if ($damage -eq 'corrupt') { [IO.File]::WriteAllText($file, 'corrupt bundle') } else { Remove-Item -LiteralPath $file }
        $user = Join-Path $testRoot ('User for the ' + $damage + ' source')
        $run = Invoke-Font $source $user
        if ($run.Exit -eq 0 -or $run.Report.stage -ne 'Verify the JetBrains Mono files of Aster Atelier' -or
            $run.Report.message -notlike '*Bundled TTF missing or SHA-256 mismatch*' -or (Test-Path -LiteralPath (Join-Path $user 'Microsoft'))) {
            throw "A $damage font file must stop the install before any file is installed: $($run.Output)"
        }
        Write-Host "PASS: a $damage bundled font is rejected before any file is installed."
    }
} finally {
    $env:LOCALAPPDATA = $originalLocalAppData
    if (Test-Path -LiteralPath $testRoot) { Remove-Item -LiteralPath $testRoot -Recurse -Force }
}
