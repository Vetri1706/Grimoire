param([switch]$Go, [switch]$Postgres, [switch]$ObjectStore)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path $PSScriptRoot -Parent
Set-Location -LiteralPath $projectRoot
New-Item -ItemType Directory -Force '.tools' | Out-Null
if (-not $Go -and -not $Postgres -and -not $ObjectStore) { throw 'Choose -Go, -Postgres, and/or -ObjectStore. These install workspace-local binaries only.' }
function Install-Archive([string]$Url, [string]$Sha256, [string]$Archive, [string]$Executable) {
    if (Test-Path -LiteralPath $Executable) { Write-Host "$Executable already present."; return }
    if (-not (Test-Path -LiteralPath $Archive)) { Invoke-WebRequest -Uri $Url -OutFile $Archive -TimeoutSec 300 }
    $actual = (Get-FileHash -LiteralPath $Archive -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actual -ne $Sha256) { throw "Archive checksum mismatch: $Archive" }
    Expand-Archive -LiteralPath $Archive -DestinationPath '.tools' -Force
    if (-not (Test-Path -LiteralPath $Executable)) { throw "Expected executable missing: $Executable" }
    Write-Host "Verified and installed $Executable"
}
if ($Go) {
    # Checksum published at https://go.dev/dl/?mode=json (Go 1.27.1).
    Install-Archive 'https://go.dev/dl/go1.27.1.windows-amd64.zip' 'a3911b5e0e1b1053f25ed0675f4c1c6aad1e2bfcf253df2b9be4caabd2edd95d' '.tools/go.zip' '.tools/go/bin/go.exe'
    & '.tools/go/bin/go.exe' version
}
if ($Postgres) {
    # Official EDB binary archive; SHA256 in EDB/edb-installers issue 706.
    Install-Archive 'https://get.enterprisedb.com/postgresql/postgresql-17.11-4-windows-x64-binaries.zip' 'b9424ee7bc60b52450ff910a3630225df32e633f3cb29c1d126d9299d59aea28' '.tools/pg17.zip' '.tools/pgsql/bin/postgres.exe'
    & '.tools/pgsql/bin/postgres.exe' --version
}
if ($ObjectStore) {
    # Official community sources, pinned commits. Historical binary URLs now return HTTP 410.
    $goCommand = if (Get-Command go -ErrorAction SilentlyContinue) { (Get-Command go).Source } else { Join-Path $projectRoot '.tools/go/bin/go.exe' }
    if (-not (Test-Path -LiteralPath $goCommand)) { throw 'Run this script with -Go first.' }
    $previousGoBin = $env:GOBIN
    try {
        $env:GOBIN = Join-Path $projectRoot '.tools/minio'
        New-Item -ItemType Directory -Force $env:GOBIN | Out-Null
        & $goCommand install github.com/minio/minio@9e49d5e7a648f00e26f2246f4dc28e6b07f8c84a
        if ($LASTEXITCODE -ne 0) { throw 'Official MinIO source build failed.' }
        & $goCommand install github.com/minio/mc@7394ce0dd2a80935aded936b09fa12cbb3cb8096
        if ($LASTEXITCODE -ne 0) { throw 'Official MinIO client source build failed.' }
        & (Join-Path $env:GOBIN 'minio.exe') --version
        & (Join-Path $env:GOBIN 'mc.exe') --version
    } finally { $env:GOBIN = $previousGoBin }
}
