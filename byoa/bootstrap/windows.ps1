# A local, inspectable bootstrap. It downloads only a pinned official Node runtime.
# The connector itself must already be in the same extracted release ZIP.
[CmdletBinding()]
param([string]$Api)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Test-CompatibleNodeVersion {
    param([string]$Version)
    if ($Version -notmatch '^v?(\d+)\.(\d+)\.(\d+)$') { return $false }
    $major = [int]$Matches[1]
    $minor = [int]$Matches[2]
    return ($major -eq 24 -or ($major -eq 22 -and $minor -ge 16) -or ($major -eq 26 -and $minor -ge 3))
}

function Get-GrimoireArchitecture {
    param([string]$Architecture = $(if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }))
    switch ($Architecture.ToUpperInvariant()) {
        'AMD64' { return 'x64' }
        'ARM64' { return 'arm64' }
        default { throw 'This download supports Windows x64 and ARM64 only. Use a supported 64-bit Windows computer.' }
    }
}

function Assert-GrimoireOrigin {
    param([string]$Origin)
    $uri = $null
    if (-not [Uri]::TryCreate($Origin, [UriKind]::Absolute, [ref]$uri)) { throw 'Enter a complete Grimoire HTTPS website address.' }
    $canonical = $uri.GetLeftPart([UriPartial]::Authority)
    # Windows PowerShell's .NET Framework expands IPv6 loopback when JS URLs do not.
    $canonical = $canonical.Replace('[0000:0000:0000:0000:0000:0000:0000:0001]', '[::1]')
    $loopback = @('localhost', '127.0.0.1', '[::1]', '[0000:0000:0000:0000:0000:0000:0000:0001]') -contains $uri.Host
    if ($Origin -cne $canonical -or $uri.UserInfo -or $Origin.Contains('\') -or ($uri.Scheme -ne 'https' -and -not ($uri.Scheme -eq 'http' -and $loopback))) {
        throw 'Use only the Grimoire website origin, such as https://app.example.com, without a path, trailing slash, login, or query. HTTP is allowed only for local testing.'
    }
    return $canonical
}

function Read-GrimoireRuntimeManifest {
    param([string]$Path = (Join-Path $PSScriptRoot 'node-runtime.json'))
    $manifest = Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json
    if ($manifest.schemaVersion -ne 1 -or $manifest.version -notmatch '^24\.\d+\.\d+$') { throw 'The bundled Node runtime manifest is invalid. Download a new connector ZIP.' }
    foreach ($architecture in @('x64', 'arm64')) {
        $entry = $manifest.windows.$architecture
        if ($entry.archive -cne "node-v$($manifest.version)-win-$architecture.zip" -or $entry.sha256 -notmatch '^[a-f0-9]{64}$' -or $entry.executableSha256 -notmatch '^[a-f0-9]{64}$') {
            throw 'The bundled Node checksum manifest is invalid. Download a new connector ZIP.'
        }
    }
    return $manifest
}

function Find-CompatibleNode {
    $candidate = Get-Command node.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $candidate) { return $null }
    try {
        $version = (& $candidate.Source --version 2>$null | Out-String).Trim()
        if ($LASTEXITCODE -eq 0 -and (Test-CompatibleNodeVersion $version)) { return $candidate.Source }
    } catch { }
    return $null
}

function Assert-ContainedPath {
    param([string]$Root, [string]$Path)
    $rootPath = [IO.Path]::GetFullPath($Root).TrimEnd('\', '/')
    $childPath = [IO.Path]::GetFullPath($Path)
    if (-not $childPath.StartsWith($rootPath + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'The installer refused a path outside its private runtime directory.'
    }
    return $childPath
}

function Assert-NoReparsePath {
    param([string]$Path)
    $current = [IO.Path]::GetFullPath($Path)
    while ($current) {
        if (Test-Path -LiteralPath $current) {
            if ((Get-Item -LiteralPath $current -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) {
                throw 'The installer refuses symbolic links and junctions in its private runtime path.'
            }
        }
        $parent = [IO.Directory]::GetParent($current)
        if (-not $parent) { break }
        $current = $parent.FullName
    }
}

function New-PrivateDirectory {
    param([string]$Path)
    Assert-NoReparsePath $Path
    [void][IO.Directory]::CreateDirectory($Path)
    $owner = [Security.Principal.WindowsIdentity]::GetCurrent().User
    $acl = New-Object Security.AccessControl.DirectorySecurity
    $acl.SetOwner($owner)
    $acl.SetAccessRuleProtection($true, $false)
    $rule = New-Object Security.AccessControl.FileSystemAccessRule($owner, 'FullControl', 'ContainerInherit, ObjectInherit', 'None', 'Allow')
    $acl.AddAccessRule($rule)
    Set-Acl -LiteralPath $Path -AclObject $acl
}

function Remove-PrivateChild {
    param([string]$Root, [string]$Path)
    $target = Assert-ContainedPath $Root $Path
    Assert-NoReparsePath $target
    if (Test-Path -LiteralPath $target) {
        foreach ($item in @(Get-ChildItem -LiteralPath $target -Recurse -Force -ErrorAction Stop)) {
            if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'The installer refused cleanup of a linked file.' }
        }
        Remove-Item -LiteralPath $target -Recurse -Force
    }
}

function Receive-OfficialNodeArchive {
    param([Uri]$Uri, [string]$Destination)
    if ($Uri.Scheme -ne 'https' -or $Uri.Host -ne 'nodejs.org' -or $Uri.UserInfo -or $Uri.Query -or $Uri.Fragment) { throw 'Only pinned official Node.js downloads are allowed.' }
    Add-Type -AssemblyName System.Net.Http
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    $handler = New-Object Net.Http.HttpClientHandler
    $handler.AllowAutoRedirect = $false
    $client = New-Object Net.Http.HttpClient($handler)
    $client.Timeout = [TimeSpan]::FromSeconds(180)
    $response = $null
    $inputStream = $null
    $outputStream = $null
    $cancellation = New-Object Threading.CancellationTokenSource
    $cancellation.CancelAfter(180000)
    try {
        $response = $client.GetAsync($Uri, [Net.Http.HttpCompletionOption]::ResponseHeadersRead).GetAwaiter().GetResult()
        if (-not $response.IsSuccessStatusCode) { throw 'The official Node.js download did not succeed.' }
        if ($response.Content.Headers.ContentLength -gt 157286400) { throw 'The Node.js archive exceeds the permitted download size.' }
        $inputStream = $response.Content.ReadAsStreamAsync().GetAwaiter().GetResult()
        $outputStream = [IO.File]::Open($Destination, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
        $buffer = New-Object byte[] 65536
        $total = 0L
        while (($count = $inputStream.ReadAsync($buffer, 0, $buffer.Length, $cancellation.Token).GetAwaiter().GetResult()) -gt 0) {
            $total += $count
            if ($total -gt 157286400) { throw 'The Node.js download exceeded its size limit.' }
            $outputStream.Write($buffer, 0, $count)
        }
        $outputStream.Flush($true)
    } finally {
        if ($outputStream) { $outputStream.Dispose() }
        if ($inputStream) { $inputStream.Dispose() }
        if ($response) { $response.Dispose() }
        $cancellation.Dispose()
        $client.Dispose()
        $handler.Dispose()
    }
}

function Expand-VerifiedNodeArchive {
    param([string]$Archive, [string]$Destination, [string]$TopDirectory)
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    [void][IO.Directory]::CreateDirectory($Destination)
    $zip = [IO.Compression.ZipFile]::OpenRead($Archive)
    try {
        $total = 0L
        if ($zip.Entries.Count -gt 20000) { throw 'The Node.js archive has too many entries.' }
        foreach ($entry in $zip.Entries) {
            $name = $entry.FullName.Replace('\', '/')
            if (-not $name.StartsWith($TopDirectory + '/', [StringComparison]::Ordinal) -or $name.Contains(':') -or @($name.Split('/')) -contains '..' -or (($entry.ExternalAttributes -shr 16) -band 0xF000) -eq 0xA000) {
                throw 'The Node.js archive contains an unexpected or unsafe path.'
            }
            $target = Assert-ContainedPath $Destination (Join-Path $Destination $name)
            $total += $entry.Length
            if ($total -gt 524288000) { throw 'The expanded Node.js archive exceeds its size limit.' }
            if ($name.EndsWith('/')) { [void][IO.Directory]::CreateDirectory($target); continue }
            [void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($target))
            [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $target, $false)
        }
    } finally { $zip.Dispose() }
}

function Install-GrimoireNode {
    param(
        [Parameter(Mandatory = $true)]$Manifest,
        [Parameter(Mandatory = $true)][string]$Architecture,
        [Parameter(Mandatory = $true)][string]$RuntimeRoot,
        [scriptblock]$Consent = { param($message) (Read-Host $message) -ceq 'INSTALL' },
        [scriptblock]$Download = { param($uri, $target) Receive-OfficialNodeArchive $uri $target },
        [scriptblock]$CheckVersion = { param($executable, $version) (& $executable --version) -ceq "v$version" },
        [scriptblock]$RetryDelay = { Start-Sleep -Seconds 2 }
    )
    if (@('x64', 'arm64') -notcontains $Architecture) { throw 'Unsupported Windows architecture. Use x64 or ARM64.' }
    $entry = $Manifest.windows.$Architecture
    $topDirectory = "node-v$($Manifest.version)-win-$Architecture"
    $installed = Assert-ContainedPath $RuntimeRoot (Join-Path $RuntimeRoot $topDirectory)
    $node = Join-Path $installed 'node.exe'
    Assert-NoReparsePath $node
    if (Test-Path -LiteralPath $node -PathType Leaf) {
        if ((Get-FileHash -LiteralPath $node -Algorithm SHA256).Hash.ToLowerInvariant() -ceq $entry.executableSha256 -and (& $CheckVersion $node $Manifest.version)) { return $node }
        Write-Warning 'The existing private Node runtime failed verification. A verified replacement is required.'
    }
    $url = "https://nodejs.org/dist/v$($Manifest.version)/$($entry.archive)"
    Write-Host "Grimoire needs Node.js 22.16+ (22.x), 24.x, or 26.3+ (26.x). It can download Node.js $($Manifest.version) LTS ($Architecture) from nodejs.org."
    Write-Host "Download: $url"
    Write-Host "Private installation: $installed"
    Write-Host 'This does not change the system Node version, global PATH, or install/authenticate Codex. No administrator access is needed.'
    if (-not (& $Consent 'Type INSTALL to consent to this Node.js download and private installation, or press Enter to cancel')) {
        throw 'Node.js installation cancelled. Nothing was downloaded. Install a supported Node.js yourself or run this launcher again.'
    }
    New-PrivateDirectory $RuntimeRoot
    $lock = $null
    $archive = Assert-ContainedPath $RuntimeRoot (Join-Path $RuntimeRoot ('.download-' + [Guid]::NewGuid().ToString('N') + '.zip'))
    $staging = Assert-ContainedPath $RuntimeRoot (Join-Path $RuntimeRoot ('.extract-' + [Guid]::NewGuid().ToString('N')))
    try {
        Assert-NoReparsePath (Join-Path $RuntimeRoot '.install.lock')
        try { $lock = [IO.File]::Open((Join-Path $RuntimeRoot '.install.lock'), [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None) }
        catch { throw 'Another Grimoire runtime installation is running. Wait for it to finish, then retry.' }
        for ($attempt = 1; $attempt -le 3; $attempt++) {
            try { & $Download ([Uri]$url) $archive; break }
            catch {
                Remove-PrivateChild $RuntimeRoot $archive
                if ($attempt -eq 3) { throw 'The Node.js download was interrupted or unavailable after 3 attempts. Check your internet connection and run the launcher again. No unverified file was installed.' }
                Write-Warning "Node.js download interrupted; retrying ($attempt/3)."
                & $RetryDelay
            }
        }
        if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant() -cne $entry.sha256) { throw 'Node.js checksum verification failed. Nothing was installed or executed. Retry with a fresh connector download; do not bypass verification.' }
        Expand-VerifiedNodeArchive $archive $staging $topDirectory
        $stagedNode = Join-Path (Join-Path $staging $topDirectory) 'node.exe'
        if (-not (Test-Path -LiteralPath $stagedNode -PathType Leaf) -or (Get-FileHash -LiteralPath $stagedNode -Algorithm SHA256).Hash.ToLowerInvariant() -cne $entry.executableSha256) { throw 'The extracted Node.js executable failed verification. Download a fresh connector ZIP.' }
        if (-not (& $CheckVersion $stagedNode $Manifest.version)) { throw 'The verified Node.js runtime cannot start on this computer. Check your Windows version and architecture.' }
        if (Test-Path -LiteralPath $installed) { Remove-PrivateChild $RuntimeRoot $installed }
        $source = Assert-ContainedPath $RuntimeRoot (Join-Path $staging $topDirectory)
        Assert-NoReparsePath $source
        Move-Item -LiteralPath $source -Destination $installed
        return $node
    } finally {
        try {
            Remove-PrivateChild $RuntimeRoot $archive
            Remove-PrivateChild $RuntimeRoot $staging
        } finally { if ($lock) { $lock.Dispose() } }
    }
}

function Start-GrimoireBootstrap {
    param([string]$Origin)
    if ($env:OS -ne 'Windows_NT') { throw 'This launcher is for Windows. Use the Node CLI on other platforms.' }
    $architecture = Get-GrimoireArchitecture
    $manifest = Read-GrimoireRuntimeManifest
    $connector = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\cli.mjs'))
    if (-not (Test-Path -LiteralPath $connector -PathType Leaf)) { throw 'Extract the entire connector ZIP before launching. The adjacent cli.mjs file is missing.' }
    if (-not $Origin) { $Origin = Read-Host 'Paste the Grimoire website address shown in Connect Codex' }
    $Origin = Assert-GrimoireOrigin $Origin.Trim()
    $node = Find-CompatibleNode
    if (-not $node) {
        $applicationData = [Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)
        if (-not $applicationData) { throw 'Your Windows per-user application folder is unavailable. Sign in to a normal Windows account and retry.' }
        $runtimeRoot = Join-Path $applicationData 'Grimoire\Connector\runtime'
        $node = Install-GrimoireNode -Manifest $manifest -Architecture $architecture -RuntimeRoot $runtimeRoot
    }
    Write-Host 'Checking Codex separately. Grimoire authorizes this connector; your local Codex login supplies model access.'
    Write-Host 'Keep this terminal open while tasks run. Closing it stops the connector; this launcher is not a background service.'
    & $node $connector --api $Origin --watch | Out-Host
    return $LASTEXITCODE
}

if ($MyInvocation.InvocationName -ne '.') {
    try { exit (Start-GrimoireBootstrap -Origin $Api) }
    catch { Write-Host ('Grimoire setup: ' + $_.Exception.Message) -ForegroundColor Red; exit 1 }
}
