#requires -Version 5.1
<#
.SYNOPSIS
Read-only Lightsail plan by default; create a new host only with -Apply.
.DESCRIPTION
Discovers the current Ubuntu 24.04 image and IPv4 Linux bundle in the selected
region. Never updates, replaces, or deletes an existing instance/static IP.
Does not install the application, upload secrets, create keys, or send email.
An AWS budget is an alert, not a spending cap. Stopped Lightsail hosts still bill.
.EXAMPLE
./lightsail.ps1 -Region ap-south-1 -SshCidr 203.0.113.10/32 -KeyPairName grimoire
.EXAMPLE
./lightsail.ps1 -Region ap-south-1 -SshCidr 203.0.113.10/32 -KeyPairName grimoire -ExpectedAccountId 123456789012 -Apply -WhatIf
#>
[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'Medium')]
param(
    [Parameter(Mandatory)][ValidatePattern('^[a-z]{2}(?:-[a-z]+)+-\d$')][string]$Region,
    [Parameter(Mandatory)][string]$SshCidr,
    [ValidatePattern('^[A-Za-z0-9][A-Za-z0-9_-]{1,60}[A-Za-z0-9]$')][string]$Name = 'grimoire-demo',
    [ValidateNotNullOrEmpty()][string]$Profile = 'default',
    [string]$KeyPairName,
    [ValidatePattern('^(?:\d{12})?$')][string]$ExpectedAccountId = '',
    [ValidateSet(1, 2)][int]$MemoryGb = 2,
    [ValidateRange(1, 12)][decimal]$MaxBundleMonthlyUsd = 12,
    [string]$AvailabilityZone,
    [switch]$Apply
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$aws = (Get-Command aws -CommandType Application -ErrorAction Stop).Source
$sshAddress = $null
if ($SshCidr -notmatch '^(\d{1,3}(?:\.\d{1,3}){3})/32$' -or
    -not [System.Net.IPAddress]::TryParse($Matches[1], [ref]$sshAddress) -or
    $sshAddress.AddressFamily -ne [System.Net.Sockets.AddressFamily]::InterNetwork -or
    [System.Net.IPAddress]::IsLoopback($sshAddress) -or
    $sshAddress.ToString() -ne $Matches[1] -or $Matches[1] -eq '0.0.0.0') {
    throw 'SshCidr must be your single public IPv4 address followed by /32; broad SSH ranges are not accepted.'
}
if ($Apply -and (-not $ExpectedAccountId -or -not $KeyPairName)) {
    throw '-Apply requires -ExpectedAccountId and an existing regional -KeyPairName. First inspect the read-only plan.'
}

function Invoke-AwsJson([string[]]$Arguments) {
    # Argument arrays avoid shell interpolation; AWS credentials remain in its profile.
    $output = & $aws @Arguments --profile $Profile --region $Region --output json --no-cli-pager --no-cli-auto-prompt
    if ($LASTEXITCODE -ne 0) { throw "AWS command failed: $($Arguments[0]) $($Arguments[1]). No automatic cleanup will run." }
    if ($output) { return ($output -join "`n" | ConvertFrom-Json) }
}

function Wait-AwsOperations($Response) {
    # Lightsail returns `operation` for some commands (including firewall
    # updates), and `operations` for others. Avoid missing-property access under
    # StrictMode, but never treat an absent/empty receipt as successful work.
    if ($null -eq $Response) { throw 'Lightsail returned no operation receipt. Inspect AWS before continuing.' }
    $operations = @(
        foreach ($name in @('operations', 'operation')) {
            $property = $Response.PSObject.Properties[$name]
            if ($null -ne $property) {
                foreach ($item in @($property.Value)) {
                    if ($null -ne $item) { $item }
                }
            }
        }
    )
    if ($operations.Count -eq 0) { throw 'Lightsail returned no operation receipt. Inspect AWS before continuing.' }
    $operationIds = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    foreach ($operation in $operations) {
        $idProperty = $operation.PSObject.Properties['id']
        if ($null -eq $idProperty -or [string]::IsNullOrWhiteSpace([string]$idProperty.Value)) {
            throw 'Lightsail returned an operation without an ID. Inspect AWS before continuing.'
        }
        [void]$operationIds.Add([string]$idProperty.Value)
    }
    foreach ($operationId in $operationIds) {
        $deadline = [DateTimeOffset]::UtcNow.AddMinutes(5)
        do {
            $current = (Invoke-AwsJson @('lightsail', 'get-operation', '--operation-id', $operationId)).operation
            if ($current.status -in @('Failed', 'NotStarted') -and $current.isTerminal) {
                throw "Lightsail operation $operationId failed. Inspect the operation in AWS before continuing."
            }
            if ($current.status -in @('Succeeded', 'Completed')) { break }
            if ([DateTimeOffset]::UtcNow -ge $deadline) {
                throw "Timed out waiting for operation $operationId. The resource may still be provisioning; inspect AWS before retrying."
            }
            Start-Sleep -Seconds 5
        } while ($true)
    }
}

$identity = Invoke-AwsJson @('sts', 'get-caller-identity')
if ($ExpectedAccountId -and $identity.Account -ne $ExpectedAccountId) {
    throw 'The selected AWS profile belongs to a different account than ExpectedAccountId.'
}
$regions = Invoke-AwsJson @('lightsail', 'get-regions', '--include-availability-zones')
$selectedRegion = @($regions.regions | Where-Object name -eq $Region)
if ($selectedRegion.Count -ne 1) { throw 'The selected region is not available for Lightsail.' }
$zones = @($selectedRegion[0].availabilityZones | Select-Object -ExpandProperty zoneName | Sort-Object)
if (-not $AvailabilityZone) { $AvailabilityZone = $zones | Select-Object -First 1 }
if ($AvailabilityZone -notin $zones) { throw 'AvailabilityZone is not a Lightsail zone in the selected region.' }

$blueprints = Invoke-AwsJson @('lightsail', 'get-blueprints', '--no-include-inactive')
$blueprint = $blueprints.blueprints | Where-Object {
    $_.isActive -and $_.platform -eq 'LINUX_UNIX' -and $_.type -eq 'os' -and
    $_.name -match 'Ubuntu' -and ($_.version -match '^24\.04(?:\D|$)' -or $_.blueprintId -match 'ubuntu_24_04')
} | Sort-Object blueprintId -Descending | Select-Object -First 1
if (-not $blueprint) { throw 'No active Ubuntu 24.04 OS blueprint found; inspect current AWS offerings rather than substituting an image.' }

$bundles = Invoke-AwsJson @('lightsail', 'get-bundles', '--no-include-inactive')
$bundle = $bundles.bundles | Where-Object {
    $_.isActive -and $_.supportedPlatforms -contains 'LINUX_UNIX' -and
    $_.ramSizeInGb -eq $MemoryGb -and $_.cpuCount -eq 2 -and
    $_.publicIpv4AddressCount -ge 1 -and $_.power -ge $blueprint.minPower
} | Sort-Object price, bundleId | Select-Object -First 1
if (-not $bundle) { throw "No active 2-vCPU / $MemoryGb-GB Linux IPv4 bundle found. No resources created." }
if ([decimal]$bundle.price -gt $MaxBundleMonthlyUsd) {
    throw "Discovered bundle costs USD $($bundle.price)/month, above the explicit USD $MaxBundleMonthlyUsd bundle ceiling. No resources created."
}

$staticIpName = "$Name-ip"
$instances = Invoke-AwsJson @('lightsail', 'get-instances')
$ips = Invoke-AwsJson @('lightsail', 'get-static-ips')
if (@($instances.instances | Where-Object name -eq $Name).Count -or
    @($ips.staticIps | Where-Object name -eq $staticIpName).Count) {
    throw "Instance '$Name' or static IP '$staticIpName' already exists. This create-only script will not change it. Inspect any prior partial deployment."
}
if ($KeyPairName) {
    $keys = Invoke-AwsJson @('lightsail', 'get-key-pairs')
    if (-not @($keys.keyPairs | Where-Object name -eq $KeyPairName).Count) {
        throw 'KeyPairName does not exist in the selected region. Import or create the operator SSH key separately; do not commit a private key.'
    }
}

$plan = [ordered]@{
    mode = 'PLAN'; account = $identity.Account; profile = $Profile; region = $Region
    availabilityZone = $AvailabilityZone; instanceName = $Name; staticIpName = $staticIpName
    blueprintId = $blueprint.blueprintId; bundleId = $bundle.bundleId
    memoryGb = $bundle.ramSizeInGb; vcpus = $bundle.cpuCount; diskGb = $bundle.diskSizeInGb
    transferAllowanceGb = $bundle.transferPerMonthInGb; bundleMonthlyUsd = $bundle.price
    bundleCeilingUsd = $MaxBundleMonthlyUsd; ipType = 'ipv4'; existingKeyPair = $KeyPairName
    publicTcpPorts = @(80, 443); ssh = $SshCidr; automaticSnapshots = $false
    notes = @('Bundle ceiling excludes snapshots, traffic overages, domain, taxes and model usage.',
        'Budget alerts do not stop spending. Stopped instances and retained snapshots still incur charges.',
        'Build application images off-host. No application credentials or source data are uploaded by this script.')
}
$plan | ConvertTo-Json -Depth 5
if (-not $Apply) {
    Write-Host 'Read-only plan complete. No AWS resources were created. Use -Apply with ExpectedAccountId and KeyPairName only after reviewing this target.'
    return
}
if (-not $PSCmdlet.ShouldProcess("AWS account $($identity.Account), $Region, $Name", "Create Lightsail instance at USD $($bundle.price)/month, attach static IPv4, restrict firewall")) { return }

# Only public metadata is written to temporary CLI request files. No user data,
# private key, account credentials, database password or application secret is sent.
$requestDirectory = Join-Path ([IO.Path]::GetTempPath()) "grimoire-lightsail-$([Guid]::NewGuid())"
[IO.Directory]::CreateDirectory($requestDirectory) | Out-Null
$created = $false
try {
    $createPath = Join-Path $requestDirectory 'create.json'
    $portsPath = Join-Path $requestDirectory 'ports.json'
    [ordered]@{
        instanceNames = @($Name); availabilityZone = $AvailabilityZone
        blueprintId = $blueprint.blueprintId; bundleId = $bundle.bundleId
        keyPairName = $KeyPairName; ipAddressType = 'ipv4'
        tags = @(@{key = 'Project'; value = 'Grimoire'}, @{key = 'Purpose'; value = 'judge-demo'})
    } | ConvertTo-Json -Depth 5 | ForEach-Object { [IO.File]::WriteAllText($createPath, $_, [Text.UTF8Encoding]::new($false)) }
    $creation = Invoke-AwsJson @('lightsail', 'create-instances', '--cli-input-json', "file://$createPath")
    $created = $true
    Wait-AwsOperations $creation

    [ordered]@{
        instanceName = $Name
        portInfos = @(
            @{fromPort = 22; toPort = 22; protocol = 'tcp'; cidrs = @($SshCidr); ipv6Cidrs = @() },
            @{fromPort = 80; toPort = 80; protocol = 'tcp'; cidrs = @('0.0.0.0/0'); ipv6Cidrs = @() },
            @{fromPort = 443; toPort = 443; protocol = 'tcp'; cidrs = @('0.0.0.0/0'); ipv6Cidrs = @() }
        )
    } | ConvertTo-Json -Depth 6 | ForEach-Object { [IO.File]::WriteAllText($portsPath, $_, [Text.UTF8Encoding]::new($false)) }
    Wait-AwsOperations (Invoke-AwsJson @('lightsail', 'put-instance-public-ports', '--cli-input-json', "file://$portsPath"))
    $ports = (Invoke-AwsJson @('lightsail', 'get-instance-port-states', '--instance-name', $Name)).portStates
    $expectedPorts = @{ 22 = $SshCidr; 80 = '0.0.0.0/0'; 443 = '0.0.0.0/0' }
    $openPorts = @($ports | Where-Object state -eq 'open')
    if ($openPorts.Count -ne 3) { throw 'Firewall verification failed: expected exactly three public TCP rules.' }
    foreach ($port in $openPorts) {
        if ($port.protocol -ne 'tcp' -or $port.fromPort -ne $port.toPort -or
            -not $expectedPorts.ContainsKey([int]$port.fromPort) -or
            @($port.cidrs).Count -ne 1 -or $port.cidrs[0] -ne $expectedPorts[[int]$port.fromPort] -or
            @($port.PSObject.Properties | Where-Object Name -eq 'ipv6Cidrs' | ForEach-Object Value).Count -or
            @($port.PSObject.Properties | Where-Object Name -eq 'cidrListAliases' | ForEach-Object Value).Count) {
            throw 'Firewall verification failed: unexpected protocol, port or address range. Inspect the new instance before deploying.'
        }
    }
    Wait-AwsOperations (Invoke-AwsJson @('lightsail', 'allocate-static-ip', '--static-ip-name', $staticIpName))
    Wait-AwsOperations (Invoke-AwsJson @('lightsail', 'attach-static-ip', '--static-ip-name', $staticIpName, '--instance-name', $Name))
    $instance = (Invoke-AwsJson @('lightsail', 'get-instance', '--instance-name', $Name)).instance
    $ip = (Invoke-AwsJson @('lightsail', 'get-static-ip', '--static-ip-name', $staticIpName)).staticIp
    if ($ip.attachedTo -ne $Name -or -not $ip.isAttached -or $instance.publicIpAddress -ne $ip.ipAddress) {
        throw 'Static IP attachment did not verify. Inspect AWS before using this address.'
    }
    [ordered]@{
        mode = 'CREATED'; account = $identity.Account; region = $Region; instance = $Name
        staticIpv4 = $ip.ipAddress; sshUser = 'ubuntu'; sshKeyPair = $KeyPairName
        next = 'Configure DNS and follow deploy/aws/README.md. This is a host, not a deployed or verified application.'
    } | ConvertTo-Json
} catch {
    if ($created) {
        Write-Warning "A new instance may exist and incur charges. Inspect '$Name' and '$staticIpName' in $Region. No automatic rollback or resource deletion was performed."
    }
    throw
} finally {
    # Delete only the two known temporary files; never recursively delete a computed directory.
    foreach ($file in @('create.json', 'ports.json')) {
        $path = Join-Path $requestDirectory $file
        if (Test-Path -LiteralPath $path) { Remove-Item -LiteralPath $path -Force }
    }
    [IO.Directory]::Delete($requestDirectory, $false)
}
