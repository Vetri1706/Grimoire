[CmdletBinding()]
param([switch]$LiveDownload)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'windows.ps1')

function Assert-Test {
    param([bool]$Condition, [string]$Message)
    if (-not $Condition) { throw "FAILED: $Message" }
    Write-Host "PASS: $Message"
}

function Assert-Throws {
    param([scriptblock]$Action, [string]$Pattern, [string]$Message)
    $thrown = $false
    try { & $Action | Out-Null }
    catch {
        $thrown = $true
        if ($_.Exception.Message -notmatch $Pattern) { throw "FAILED: $Message (unexpected error: $($_.Exception.Message))" }
    }
    Assert-Test $thrown $Message
}

$repository = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$testParent = Join-Path $repository '.local\bootstrap-tests'
$testRoot = Join-Path $testParent ([Guid]::NewGuid().ToString('N'))
[void][IO.Directory]::CreateDirectory($testRoot)
try {
    Assert-Test (Test-CompatibleNodeVersion 'v22.16.0') 'minimum Node 22.16 is compatible'
    Assert-Test (Test-CompatibleNodeVersion 'v24.21.0') 'Node 24 LTS is compatible'
    Assert-Test (Test-CompatibleNodeVersion 'v26.3.0') 'installed Node 26.3 is compatible'
    foreach ($version in @('v20.20.0', 'v22.15.0', 'v23.0.0', 'v25.0.0', 'v26.0.0', 'v26.2.0', 'v27.0.0', 'v24.0.0-rc.1', '24.1', 'garbage')) {
        Assert-Test (-not (Test-CompatibleNodeVersion $version)) "unsupported Node version rejected: $version"
    }
    Assert-Test ((Get-GrimoireArchitecture 'AMD64') -eq 'x64') 'x64 architecture detection'
    Assert-Test ((Get-GrimoireArchitecture 'ARM64') -eq 'arm64') 'ARM64 architecture detection'
    Assert-Throws { Get-GrimoireArchitecture 'x86' } 'supports Windows x64 and ARM64' 'unsupported architecture rejected'
    foreach ($origin in @('https://example.com', 'https://example.com:8443', 'http://127.0.0.1:8082', 'http://localhost:8082', 'http://[::1]:8082')) {
        Assert-Test ((Assert-GrimoireOrigin $origin) -ceq $origin) "allowed website origin: $origin"
    }
    foreach ($origin in @('http://example.com', 'https://example.com/', 'https://example.com/path', 'https://user@example.com', 'https://example.com?x=1', 'https://example.com#x', 'http://127.1:8082', 'http://localhost.example.com', 'https://example.com\evil', 'https://example.com:443')) {
        Assert-Throws { Assert-GrimoireOrigin $origin } 'website origin|HTTPS website' "unsafe/noncanonical origin rejected: $origin"
    }
    $manifest = Read-GrimoireRuntimeManifest
    Assert-Test ($manifest.version -ceq '24.21.0' -and $manifest.source -ceq 'https://nodejs.org/dist/v24.21.0/SHASUMS256.txt') 'official LTS version and checksum source are pinned'
    Assert-Throws { Assert-ContainedPath $testRoot (Join-Path $testRoot '..\outside') } 'outside its private' 'cleanup cannot escape runtime directory'
    Assert-Throws { Assert-ContainedPath $testRoot $testRoot } 'outside its private' 'cleanup cannot delete runtime root'

    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $fixtureDirectory = Join-Path $testRoot 'fixture'
    $fixtureTop = 'node-v24.21.0-win-x64'
    $fixtureNode = Join-Path (Join-Path $fixtureDirectory $fixtureTop) 'node.exe'
    [void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($fixtureNode))
    [IO.File]::WriteAllText($fixtureNode, 'Test fixture only; never executable.')
    $fixtureZip = Join-Path $testRoot 'fixture.zip'
    [IO.Compression.ZipFile]::CreateFromDirectory($fixtureDirectory, $fixtureZip)
    $fixtureManifest = $manifest | ConvertTo-Json -Depth 10 | ConvertFrom-Json
    $fixtureManifest.windows.x64.sha256 = (Get-FileHash -LiteralPath $fixtureZip -Algorithm SHA256).Hash.ToLowerInvariant()
    $fixtureManifest.windows.x64.executableSha256 = (Get-FileHash -LiteralPath $fixtureNode -Algorithm SHA256).Hash.ToLowerInvariant()
    $download = { param($uri, $target) [IO.File]::Copy($fixtureZip, $target) }
    $checkVersion = { param($exe, $version) $script:versionChecks++; return $true }
    $script:versionChecks = 0
    $declinedRoot = Join-Path $testRoot 'declined'
    Assert-Throws { Install-GrimoireNode $fixtureManifest 'x64' $declinedRoot -Consent { $false } -Download { throw 'DOWNLOAD MUST NOT RUN' } } 'installation cancelled' 'download requires explicit installation consent'
    Assert-Test (-not (Test-Path -LiteralPath $declinedRoot)) 'declining consent leaves no installation directory'

    $installedRoot = Join-Path $testRoot 'installed'
    $installed = Install-GrimoireNode $fixtureManifest 'x64' $installedRoot -Consent { $true } -Download $download -CheckVersion $checkVersion
    Assert-Test (Test-Path -LiteralPath $installed) 'verified fixture installs in private per-user-shaped directory'
    Assert-Test ($script:versionChecks -eq 1) 'only checksum-verified executable reaches version check'
    $acl = Get-Acl -LiteralPath $installedRoot
    Assert-Test $acl.AreAccessRulesProtected 'private runtime directory disables inherited permissions'
    $again = Install-GrimoireNode $fixtureManifest 'x64' $installedRoot -Consent { throw 'CONSENT MUST NOT RUN' } -Download { throw 'DOWNLOAD MUST NOT RUN' } -CheckVersion $checkVersion
    Assert-Test ($again -ceq $installed) 'verified private runtime is reused on restart without another download'
    Assert-Test (@(Get-ChildItem -LiteralPath $installedRoot -Force | Where-Object { $_.Name -like '.download-*' -or $_.Name -like '.extract-*' }).Count -eq 0) 'completed download and staging files are cleaned up'

    $script:attempts = 0
    $retryDownload = {
        param($uri, $target)
        $script:attempts++
        if ($script:attempts -lt 3) { [IO.File]::WriteAllText($target, 'partial'); throw 'Simulated network interruption' }
        [IO.File]::Copy($fixtureZip, $target)
    }
    $recovered = Install-GrimoireNode $fixtureManifest 'x64' (Join-Path $testRoot 'retry') -Consent { $true } -Download $retryDownload -CheckVersion $checkVersion -RetryDelay { }
    Assert-Test ($script:attempts -eq 3 -and (Test-Path -LiteralPath $recovered)) 'interrupted download retries fresh bytes and recovers safely'
    $brokenRoot = Join-Path $testRoot 'network-failure'
    Assert-Throws { Install-GrimoireNode $fixtureManifest 'x64' $brokenRoot -Consent { $true } -Download { param($uri, $target) [IO.File]::WriteAllText($target, 'partial'); throw 'offline' } -RetryDelay { } } 'after 3 attempts' 'repeated download failure reports actionable retry guidance'
    Assert-Test (@(Get-ChildItem -LiteralPath $brokenRoot -Force | Where-Object { $_.Name -like '.download-*' -or $_.Name -like '.extract-*' }).Count -eq 0) 'failed download removes partial files'

    $script:versionChecks = 0
    $badRoot = Join-Path $testRoot 'bad-checksum'
    Assert-Throws { Install-GrimoireNode $fixtureManifest 'x64' $badRoot -Consent { $true } -Download { param($uri, $target) [IO.File]::WriteAllText($target, 'corrupted archive') } -CheckVersion $checkVersion } 'checksum verification failed' 'corrupted archive is rejected before extraction or execution'
    Assert-Test ($script:versionChecks -eq 0) 'checksum failure never executes downloaded bytes'

    $maliciousZip = Join-Path $testRoot 'traversal.zip'
    $zip = [IO.Compression.ZipFile]::Open($maliciousZip, [IO.Compression.ZipArchiveMode]::Create)
    try { [void]$zip.CreateEntry('node-v24.21.0-win-x64/../../escape.txt') } finally { $zip.Dispose() }
    Assert-Throws { Expand-VerifiedNodeArchive $maliciousZip (Join-Path $testRoot 'traversal') $fixtureTop } 'unsafe path' 'archive path traversal is rejected'
    Assert-Test (-not (Test-Path -LiteralPath (Join-Path $testRoot 'escape.txt'))) 'unsafe archive cannot write outside staging'

    if ($LiveDownload) {
        $liveRoot = Join-Path $testRoot 'official-live'
        $liveNode = Install-GrimoireNode $manifest (Get-GrimoireArchitecture) $liveRoot -Consent { $true }
        Assert-Test ((& $liveNode --version) -ceq 'v24.21.0') 'real official archive downloads, verifies, extracts and runs in isolated workspace'
    }
    Write-Host 'Windows bootstrap tests passed. Global PATH, system Node and Codex credentials were untouched.'
} finally { Remove-PrivateChild $testParent $testRoot }
