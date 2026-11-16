# Installs fonts for the current Windows user, without administrator rights or a download,
# through extensions/aster-appearance/install-font.ps1.
#  -ManifestPath config\font.json: JetBrains Mono, the editor and terminal font, from the variable TTFs that
#    Aster Atelier ships (extensions/aster-appearance/fonts/jetbrainsmono; Windows 10 1709+ renders them).
#    A JetBrains Mono that is already installed - the 16 static TTFs of setup 3.10 and older, the same files
#    added by Aster Atelier or a personal copy - is kept, so the family never appears twice.
#  -Stage <folder>: the verified Aster-*.ttf files lib/font.js staged for the other Aster Atelier families.
# The files keep the names Aster Atelier gives them in %LOCALAPPDATA%\Microsoft\Windows\Fonts and HKCU.
param([string]$ManifestPath = '', [string]$Stage = '', [string]$ErrorReportPath = '')

$ErrorActionPreference = 'Stop'
$step = 'Start'
$staging = $null
$root = Split-Path $PSScriptRoot -Parent

function Get-Sha256([string]$File) {
    $stream = [IO.File]::OpenRead($File)
    $algorithm = [Security.Cryptography.SHA256]::Create()
    try { -join ($algorithm.ComputeHash($stream) | ForEach-Object { $_.ToString('x2') }) }
    finally { $algorithm.Dispose(); $stream.Dispose() }
}

# One installer for every Aster-*.ttf: Aster Atelier's own script, which rolls
# back on failure and never recreates the per-user Fonts registry key.
function Install-Fonts([string]$Directory) {
    $script:step = 'Install and register fonts'
    & (Join-Path $root 'extensions\aster-appearance\install-font.ps1') -Stage $Directory
}

try {
    if ($Stage) { Install-Fonts $Stage; exit 0 }
    if (-not $ManifestPath) { throw 'Pass -ManifestPath or -Stage' }
    $step = 'Read font manifest'
    $manifest = Get-Content -LiteralPath $ManifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
    $files = @($manifest.files)
    if ($manifest.family -ne 'JetBrains Mono' -or $manifest.source -ne 'extensions/aster-appearance/fonts/jetbrainsmono' -or $files.Count -ne 2) {
        throw 'Invalid font manifest'
    }
    foreach ($file in $files) {
        if ($file.source -notmatch '^JetBrainsMono(-Italic)?\[wght\]\.ttf$' -or $file.sha256 -notmatch '^[a-f0-9]{64}$' -or
            $file.name -cne ('Aster-jetbrainsmono-' + $file.sha256.Substring(0, 12) + '.ttf')) { throw 'Invalid font filename/hash' }
    }
    $step = 'Check installed font families'
    Add-Type -AssemblyName System.Drawing
    $families = @((New-Object System.Drawing.Text.InstalledFontCollection).Families | ForEach-Object { $_.Name })
    if ($families -contains $manifest.family) {
        Write-Host '  JetBrains Mono is already installed for this Windows user; kept as it is.'
        exit 0
    }

    $step = 'Verify the JetBrains Mono files of Aster Atelier'
    $staging = Join-Path ([IO.Path]::GetTempPath()) ('workstation-font-' + [guid]::NewGuid().ToString('N'))
    [IO.Directory]::CreateDirectory($staging) | Out-Null
    foreach ($file in $files) {
        $source = Join-Path (Join-Path $root $manifest.source) $file.source
        if (-not (Test-Path -LiteralPath $source -PathType Leaf) -or (Get-Sha256 $source) -ne $file.sha256) {
            throw "Bundled TTF missing or SHA-256 mismatch: $($file.source). Download a fresh copy of setup."
        }
        [IO.File]::Copy($source, (Join-Path $staging $file.name), $false)
    }
    Install-Fonts $staging
    Write-Host '  JetBrains Mono ready for the current Windows user (the files of Aster Atelier).'
    exit 0
} catch {
    $fontError = $_
    if ($ErrorReportPath) {
        try {
            $report = @{ stage = $step; message = $fontError.Exception.Message } | ConvertTo-Json -Compress
            [IO.File]::WriteAllText($ErrorReportPath, $report, [Text.UTF8Encoding]::new($false))
        } catch { Write-Warning 'Could not save font error details; see the error below.' }
    }
    Write-Error ("Font stage '{0}' failed: {1}" -f $step, $fontError.Exception.Message) -ErrorAction Continue
    exit 1
} finally {
    if ($staging -and (Test-Path -LiteralPath $staging)) { Remove-Item -LiteralPath $staging -Recurse -Force -ErrorAction SilentlyContinue }
}
