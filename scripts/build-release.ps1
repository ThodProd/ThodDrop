param(
    [string]$HubRoot = (Join-Path $PSScriptRoot '../../..'),
    [string]$OutputDirectory = (Join-Path $PSScriptRoot '../dist-release/rust')
)
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$manifestPath = Join-Path $root 'hub/manifest.json'
$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
$packageScript = Join-Path $HubRoot 'scripts/package-module.ps1'
if (!(Test-Path -LiteralPath $packageScript -PathType Leaf)) {
    throw 'Укажите путь к ThodHUB в параметре -HubRoot.'
}
$cargo = Get-Command cargo -ErrorAction SilentlyContinue
if (!$cargo) { $cargo = Get-Command (Join-Path ([Environment]::GetFolderPath('UserProfile')) '.cargo/bin/cargo.exe') }
Push-Location $root
try {
    $metadata = & $cargo.Source metadata --no-deps --locked --format-version 1 | ConvertFrom-Json
    if ($LASTEXITCODE -or $metadata.packages[0].version -ne $manifest.version) { throw 'Версии Cargo и ThodHUB не совпадают.' }
    & $cargo.Source build --locked --release
    if ($LASTEXITCODE) { throw 'Сборка Rust завершилась с ошибкой.' }
} finally {
    Pop-Location
}

$stage = Join-Path $root ('target/package-' + $manifest.version + '-' + [Guid]::NewGuid().ToString('N'))
$ui = New-Item -ItemType Directory -Path (Join-Path $stage 'ui') -Force
$worker = New-Item -ItemType Directory -Path (Join-Path $stage 'worker') -Force
Copy-Item -LiteralPath $manifestPath -Destination (Join-Path $stage 'manifest.json')
Copy-Item -LiteralPath (Join-Path $metadata.target_directory 'release/thoddrop.exe') -Destination (Join-Path $worker.FullName 'ThodDrop.exe')
Copy-Item -LiteralPath (Join-Path $root 'web/desktop.html') -Destination (Join-Path $ui.FullName 'index.html')
foreach ($asset in @('style.css', 'common.js', 'desktop.js', 'icon-192.png')) {
    Copy-Item -LiteralPath (Join-Path $root "web/$asset") -Destination $ui.FullName
}
Copy-Item -LiteralPath (Join-Path $root 'sdk/thodhub.js') -Destination $ui.FullName
Copy-Item -LiteralPath (Join-Path $root 'LICENSE'), (Join-Path $root 'NOTICE') -Destination $stage
& $packageScript -PackageDirectory $stage -Repository 'ThodProd/ThodDrop' -OutputDirectory $OutputDirectory `
    -Notes 'Исправлена отмена подключения. Код приглашения для ПК виден на ведущем компьютере и обновляется отдельной кнопкой.'
