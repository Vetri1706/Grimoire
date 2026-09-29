param(
    [ValidateSet('Init','Up','Down','Restart','Status','Environment','ResetTest','CorruptTestObject')]
    [string]$Task = 'Status',
    [switch]$TestDatabase,
    [switch]$ForHarness,
    [string]$Key,
    [Alias('Version')][string]$VersionId
)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path $PSScriptRoot -Parent
$localRoot = Join-Path $projectRoot '.local'
$storageFile = Join-Path $localRoot 'storage.env'
$dataRoot = Join-Path $localRoot 'minio-data'
$minio = Join-Path $projectRoot '.tools/minio/minio.exe'
$mc = Join-Path $projectRoot '.tools/minio/mc.exe'
$endpoint = 'http://127.0.0.1:19000'
$devBucket = 'grimoire-sources-dev'
$testBucket = 'grimoire-sources-test'
New-Item -ItemType Directory -Force $localRoot | Out-Null
function Assert-Exit([string]$Description) { if ($LASTEXITCODE -ne 0) { throw "$Description failed (exit $LASTEXITCODE)." } }
function New-Secret { [Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32)).ToLowerInvariant() }
if ($Task -eq 'Init') {
    if (Test-Path -LiteralPath $storageFile) { Write-Host 'Preserving existing .local/storage.env credentials.'; return }
    @(
        '# Synthetic local development only. Ignored by Git; never copy to frontend configuration.'
        'MINIO_ROOT_USER=grimoire-local-root'
        "MINIO_ROOT_PASSWORD=$(New-Secret)"
        'GRIMOIRE_S3_DEV_ACCESS_KEY=grimoire-dev-api'
        "GRIMOIRE_S3_DEV_SECRET_KEY=$(New-Secret)"
        'GRIMOIRE_S3_TEST_ACCESS_KEY=grimoire-test-api'
        "GRIMOIRE_S3_TEST_SECRET_KEY=$(New-Secret)"
        'GRIMOIRE_S3_TEST_ADMIN_ACCESS_KEY=grimoire-test-faults'
        "GRIMOIRE_S3_TEST_ADMIN_SECRET_KEY=$(New-Secret)"
    ) | Set-Content -LiteralPath $storageFile -Encoding utf8
    Write-Host 'Created ignored .local/storage.env. Existing .env unchanged.'
    return
}
if (-not (Test-Path -LiteralPath $storageFile)) { throw 'Run scripts/storage.ps1 -Task Init first.' }
$storage = @{}
foreach ($line in Get-Content -LiteralPath $storageFile) {
    if ($line -match '^([A-Z0-9_]+)=(.*)$') { $storage[$Matches[1]] = $Matches[2] }
}
foreach ($name in @('MINIO_ROOT_PASSWORD','GRIMOIRE_S3_DEV_SECRET_KEY','GRIMOIRE_S3_TEST_SECRET_KEY','GRIMOIRE_S3_TEST_ADMIN_SECRET_KEY')) {
    if ($storage[$name] -notmatch '^[a-f0-9]{64}$') { throw "Invalid generated credential $name." }
}
function Set-ApiEnvironment {
    $env:GRIMOIRE_S3_ENDPOINT = $endpoint
    $env:GRIMOIRE_S3_REGION = 'us-east-1'
    $env:GRIMOIRE_S3_BUCKET = if ($TestDatabase) { $testBucket } else { $devBucket }
    $env:GRIMOIRE_S3_ACCESS_KEY = if ($TestDatabase) { $storage.GRIMOIRE_S3_TEST_ACCESS_KEY } else { $storage.GRIMOIRE_S3_DEV_ACCESS_KEY }
    $env:GRIMOIRE_S3_SECRET_KEY = if ($TestDatabase) { $storage.GRIMOIRE_S3_TEST_SECRET_KEY } else { $storage.GRIMOIRE_S3_DEV_SECRET_KEY }
    # Do not inherit fault-injection credentials into ordinary Rust API launches.
    $env:GRIMOIRE_S3_TEST_ADMIN_ACCESS_KEY = $null
    $env:GRIMOIRE_S3_TEST_ADMIN_SECRET_KEY = $null
    if ($ForHarness) {
        if (-not $TestDatabase) { throw 'Fault credentials are available only with -TestDatabase.' }
        $env:GRIMOIRE_S3_TEST_ADMIN_ACCESS_KEY = $storage.GRIMOIRE_S3_TEST_ADMIN_ACCESS_KEY
        $env:GRIMOIRE_S3_TEST_ADMIN_SECRET_KEY = $storage.GRIMOIRE_S3_TEST_ADMIN_SECRET_KEY
        $env:GRIMOIRE_STORAGE_SCRIPT = Join-Path $PSScriptRoot 'storage.ps1'
    }
}
if ($Task -eq 'Environment') { Set-ApiEnvironment; return }
if (-not (Test-Path -LiteralPath $minio) -or -not (Test-Path -LiteralPath $mc)) { throw 'Run scripts/install-local-tools.ps1 -ObjectStore first.' }
function Invoke-Mc {
    param([Parameter(ValueFromRemainingArguments=$true)][string[]]$Arguments)
    $previousHost = $env:MC_HOST_grimoire
    $previousConfig = $env:MC_CONFIG_DIR
    try {
        $env:MC_HOST_grimoire = "http://$($storage.MINIO_ROOT_USER):$($storage.MINIO_ROOT_PASSWORD)@127.0.0.1:19000"
        $env:MC_CONFIG_DIR = Join-Path $localRoot 'mc-config'
        # Native MinIO can report live before its IAM/policy state has settled
        # after a rapid restart. These fixed administration operations are
        # idempotent; retry transient startup failures without changing access.
        for ($attempt=0; $attempt -lt 6; $attempt++) {
            $commandOutput = & $mc @Arguments 2>&1
            if ($LASTEXITCODE -eq 0) {
                $commandOutput | Write-Output
                return
            }
            if ($attempt -lt 5) { Start-Sleep -Milliseconds 500 }
        }
        throw 'MinIO administration failed after bounded startup retries. Credentials and access policies were not broadened.'
    } finally { $env:MC_HOST_grimoire = $previousHost; $env:MC_CONFIG_DIR = $previousConfig }
}
function Assert-Healthy {
    $response = Invoke-WebRequest -Uri "$endpoint/minio/health/live" -UseBasicParsing -TimeoutSec 3
    if ($response.StatusCode -ne 200) { throw 'Object store is unhealthy.' }
}
function Write-Policy([string]$Name, [string]$Bucket, [bool]$Faults) {
    $bucketActions = @('s3:GetBucketLocation','s3:GetBucketVersioning')
    $objectActions = @('s3:GetObject','s3:GetObjectVersion','s3:PutObject')
    if ($Faults) {
        $bucketActions += @('s3:ListBucket','s3:ListBucketVersions')
        $objectActions += @('s3:DeleteObject','s3:DeleteObjectVersion')
    }
    $policy = @{ Version='2012-10-17'; Statement=@(
        @{ Effect='Allow'; Action=$bucketActions; Resource=@("arn:aws:s3:::$Bucket") },
        @{ Effect='Allow'; Action=$objectActions; Resource=@("arn:aws:s3:::$Bucket/*") }
    ) }
    $policyPath = Join-Path $localRoot "$Name.json"
    $json = $policy | ConvertTo-Json -Depth 10
    [IO.File]::WriteAllText($policyPath, $json, (New-Object System.Text.UTF8Encoding($false)))
    Invoke-Mc admin policy create grimoire $Name $policyPath | Out-Null
}
function Initialize-Buckets {
    foreach ($bucket in @($devBucket,$testBucket)) {
        Invoke-Mc mb --ignore-existing "grimoire/$bucket" | Out-Null
        Invoke-Mc version enable "grimoire/$bucket" | Out-Null
        Invoke-Mc anonymous set none "grimoire/$bucket" | Out-Null
    }
    foreach ($item in @(
        @{Name='grimoire-dev-api'; Bucket=$devBucket; Key=$storage.GRIMOIRE_S3_DEV_ACCESS_KEY; Secret=$storage.GRIMOIRE_S3_DEV_SECRET_KEY; Faults=$false},
        @{Name='grimoire-test-api'; Bucket=$testBucket; Key=$storage.GRIMOIRE_S3_TEST_ACCESS_KEY; Secret=$storage.GRIMOIRE_S3_TEST_SECRET_KEY; Faults=$false},
        @{Name='grimoire-test-faults'; Bucket=$testBucket; Key=$storage.GRIMOIRE_S3_TEST_ADMIN_ACCESS_KEY; Secret=$storage.GRIMOIRE_S3_TEST_ADMIN_SECRET_KEY; Faults=$true}
    )) {
        Write-Policy $item.Name $item.Bucket $item.Faults
        Invoke-Mc admin user add grimoire $item.Key $item.Secret | Out-Null
        Invoke-Mc admin policy attach grimoire $item.Name --user $item.Key | Out-Null
    }
    Write-Host 'Private versioned dev/test buckets ready; separate runtime users have no deletion rights.'
}
function Start-Storage {
    $pidFile = Join-Path $localRoot 'minio.pid'
    $running = $false
    try { Assert-Healthy; $running = $true } catch { }
    if ($running) { Write-Host 'Object store is already running.'; Initialize-Buckets; return }
    New-Item -ItemType Directory -Force $dataRoot | Out-Null
    $variables = @('MINIO_ROOT_USER','MINIO_ROOT_PASSWORD','MINIO_BROWSER','MINIO_UPDATE','MINIO_STORAGE_CLASS_INLINE_BLOCK','MINIO_API_CORS_ALLOW_ORIGIN')
    $saved = @{}
    foreach ($name in $variables) { $saved[$name] = [Environment]::GetEnvironmentVariable($name) }
    try {
        $env:MINIO_ROOT_USER = $storage.MINIO_ROOT_USER
        $env:MINIO_ROOT_PASSWORD = $storage.MINIO_ROOT_PASSWORD
        $env:MINIO_BROWSER = 'off'
        $env:MINIO_UPDATE = 'off'
        $env:MINIO_STORAGE_CLASS_INLINE_BLOCK = '0'
        $env:MINIO_API_CORS_ALLOW_ORIGIN = 'http://127.0.0.1:19000'
        $process = Start-Process -FilePath $minio -ArgumentList @('server',"`"$dataRoot`"",'--address','127.0.0.1:19000','--console-address','127.0.0.1:19001') -WindowStyle Hidden -RedirectStandardOutput (Join-Path $localRoot 'minio.log') -RedirectStandardError (Join-Path $localRoot 'minio-error.log') -PassThru
        $process.Id | Set-Content -LiteralPath $pidFile
    } finally { foreach ($name in $variables) { [Environment]::SetEnvironmentVariable($name,$saved[$name]) } }
    for ($attempt=0; $attempt -lt 30; $attempt++) {
        try { Assert-Healthy; $running = $true } catch { }
        if ($running) { Initialize-Buckets; Write-Host "Object store listening only at $endpoint."; return }
        Start-Sleep -Milliseconds 500
    }
    throw 'Object store did not become ready. Inspect .local/minio-error.log.'
}
function Stop-Storage {
    $pidFile = Join-Path $localRoot 'minio.pid'
    if (-not (Test-Path -LiteralPath $pidFile)) { throw 'No managed object-store PID; refusing to stop an unknown process.' }
    $storagePid = [int](Get-Content -LiteralPath $pidFile -Raw).Trim()
    $process = Get-Process -Id $storagePid -ErrorAction SilentlyContinue
    if ($process) {
        if ($process.Path -ne $minio) { throw 'PID does not belong to the workspace MinIO binary.' }
        Stop-Process -Id $storagePid
        $process.WaitForExit(10000) | Out-Null
    }
    Remove-Item -LiteralPath $pidFile
    Write-Host 'Stopped managed object store; persistent data retained.'
}
switch ($Task) {
    'Up' { Start-Storage }
    'Down' { Stop-Storage }
    'Restart' { Stop-Storage; Start-Storage }
    'Status' {
        Assert-Healthy
        & $minio --version
        foreach ($bucket in @($devBucket,$testBucket)) {
            Invoke-Mc version info "grimoire/$bucket"
            Invoke-Mc anonymous get "grimoire/$bucket"
        }
        Write-Host "Endpoint: $endpoint; data: .local/minio-data; browser console disabled."
    }
    'ResetTest' {
        Assert-Healthy
        # Fixed disposable bucket only; never delete the data root or development bucket.
        if ($testBucket -ne 'grimoire-sources-test' -or $testBucket -eq $devBucket) { throw 'Unsafe reset target.' }
        Invoke-Mc rm --recursive --force --versions "grimoire/$testBucket" | Out-Null
        Invoke-Mc version enable "grimoire/$testBucket" | Out-Null
        Invoke-Mc anonymous set none "grimoire/$testBucket" | Out-Null
        Write-Host 'Reset disposable grimoire-sources-test objects/versions only. Development bucket untouched.'
    }
    'CorruptTestObject' {
        # Fault injection is deliberately outside the API. This is not an erasure or restore operation.
        if ($Key -notmatch '^[a-zA-Z0-9][a-zA-Z0-9/_.-]*$' -or $Key.Contains('..') -or $VersionId -notmatch '^[a-f0-9-]{36}$') { throw 'Invalid test object key or version.' }
        Assert-Healthy
        $stat = Invoke-Mc stat --json --version-id $VersionId "grimoire/$testBucket/$Key" | ConvertFrom-Json
        if ($stat.status -ne 'success' -or $stat.versionID -ne $VersionId) { throw 'Requested disposable object version not found.' }
        $testRoot = [IO.Path]::GetFullPath((Join-Path $dataRoot $testBucket))
        $objectPath = [IO.Path]::GetFullPath((Join-Path $testRoot $Key.Replace('/',[IO.Path]::DirectorySeparatorChar)))
        if (-not $objectPath.StartsWith($testRoot + [IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)) { throw 'Object path escapes disposable test bucket.' }
        $parts = @(Get-ChildItem -LiteralPath $objectPath -Filter 'part.1' -Recurse -File)
        # The caller must use a new unique key with exactly one stored version.
        if ($parts.Count -ne 1) { throw 'Corruption requires exactly one stored part under a unique disposable key.' }
        $target = [IO.Path]::GetFullPath($parts[0].FullName)
        if (-not $target.StartsWith($objectPath + [IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)) { throw 'Part escapes checked object path.' }
        [IO.File]::WriteAllBytes($target,[Text.Encoding]::UTF8.GetBytes('SYNTHETIC CORRUPTION FAULT'))
        Write-Host 'Corrupted one checked disposable test-object part. No development object touched.'
    }
}
