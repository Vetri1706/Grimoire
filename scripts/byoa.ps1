param([ValidateSet('Check','Once','Watch','Start','Stop','Status')][string]$Mode='Watch')
$ErrorActionPreference='Stop'
$projectRoot=Split-Path $PSScriptRoot -Parent
$bridgePath=Join-Path $projectRoot 'byoa/bridge.mjs'
$workerRoot=Join-Path $projectRoot '.local/byoa'
$workerFile=Join-Path $workerRoot 'worker.json'
function Get-ManagedWorker {
    if (-not (Test-Path -LiteralPath $workerFile)) { return $null }
    $record=Get-Content -LiteralPath $workerFile -Raw | ConvertFrom-Json
    $worker=Get-Process -Id ([int]$record.pid) -ErrorAction SilentlyContinue
    if (-not $worker) { return $null }
    $details=Get-CimInstance Win32_Process -Filter "ProcessId = $([int]$record.pid)"
    if ($worker.Path -ne $record.executable -or $worker.StartTime.ToUniversalTime().Ticks -ne [long]$record.start_ticks -or
        $details.CommandLine -ne $record.command_line -or
        -not $details.CommandLine.Contains($bridgePath,[StringComparison]::OrdinalIgnoreCase) -or
        $details.CommandLine -notmatch '--watch(?:\s|$)') {
        throw 'Worker identity mismatch. Refusing to manage this PID.'
    }
    return $worker
}
if ($Mode -in @('Status','Stop')) {
    $worker=Get-ManagedWorker
    if (-not $worker) { Write-Output 'BYOA worker is not running. This is not a provider login check.'; return }
    if ($Mode -eq 'Status') {
        Write-Output "BYOA local worker is running (PID $($worker.Id)). Provider login and task success are separate checks."
        return
    }
    # Refuse to interrupt a live model child; stopping it mid-task would leave an
    # orphaned provider run and incomplete lease. No unrelated process is killed.
    $consoleHost=[IO.Path]::GetFullPath((Join-Path $env:SystemRoot 'system32/conhost.exe'))
    $children=@(Get-CimInstance Win32_Process -Filter "ParentProcessId = $($worker.Id)")
    $activeChildren=@($children | Where-Object {
        # Windows may attach its console helper even to a hidden idle worker.
        # Exempt only the verified system binary; unknown paths fail closed.
        -not ($_.Name -eq 'conhost.exe' -and $_.ExecutablePath -and
            [IO.Path]::GetFullPath($_.ExecutablePath).Equals($consoleHost,[StringComparison]::OrdinalIgnoreCase))
    })
    if ($activeChildren.Count -gt 0) { throw 'The managed worker has an active child task. Wait for its terminal result before stopping.' }
    Stop-Process -Id $worker.Id
    $worker.WaitForExit(10000) | Out-Null
    Remove-Item -LiteralPath $workerFile
    Write-Output 'Stopped the verified BYOA worker. Provider login and stored task/proposal records were preserved.'
    return
}
$agentToken=$null
$configFile=Join-Path $projectRoot '.env'
if (Test-Path -LiteralPath $configFile) {
    foreach ($line in Get-Content -LiteralPath $configFile) {
        if ($line -match '^GRIMOIRE_TOKEN_AGENT_A=([a-f0-9]{64})$') { $agentToken=$Matches[1] }
    }
}
if (-not $agentToken -and $Mode -ne 'Check') { throw 'Local proposal-only agent enrollment is required. Run the documented migration/provisioning step.' }
$node=(Get-Command node.exe -ErrorAction Stop).Source
$processInfo=[Diagnostics.ProcessStartInfo]::new($node)
$processInfo.UseShellExecute=$false
$processInfo.CreateNoWindow=$true
$processInfo.RedirectStandardOutput=$true
$processInfo.RedirectStandardError=$true
$processInfo.WorkingDirectory=$projectRoot
$processInfo.ArgumentList.Add($bridgePath)
$processInfo.ArgumentList.Add('--'+$Mode.ToLowerInvariant())
$processInfo.Environment.Clear()
foreach ($name in @('SystemRoot','WINDIR','PATH','PATHEXT','USERPROFILE','APPDATA','LOCALAPPDATA','TEMP','TMP','HOMEDRIVE','HOMEPATH','HOME','CODEX_HOME')) {
    $value=[Environment]::GetEnvironmentVariable($name)
    if ($value) { $processInfo.Environment[$name]=$value }
}
if ($agentToken) { $processInfo.Environment['GRIMOIRE_TOKEN_AGENT_A']=$agentToken }
foreach ($name in @('GRIMOIRE_API_URL','GRIMOIRE_CODEX_BIN')) {
    $value=[Environment]::GetEnvironmentVariable($name)
    if ($value) { $processInfo.Environment[$name]=$value }
}
if ($Mode -eq 'Start') {
    $existing=Get-ManagedWorker
    if ($existing) { Write-Output "BYOA local worker is already running (PID $($existing.Id))."; return }
    New-Item -ItemType Directory -Force $workerRoot | Out-Null
    $original=@{}
    foreach ($entry in [Environment]::GetEnvironmentVariables('Process').GetEnumerator()) { $original[$entry.Key]=$entry.Value }
    try {
        # Start-Process owns redirected file handles after this launcher exits.
        # Temporarily sanitize only this process environment, then restore it.
        foreach ($name in $original.Keys) { [Environment]::SetEnvironmentVariable($name,$null,'Process') }
        foreach ($entry in $processInfo.Environment.GetEnumerator()) { [Environment]::SetEnvironmentVariable($entry.Key,$entry.Value,'Process') }
        $worker=Start-Process -FilePath $node -ArgumentList @("`"$bridgePath`"",'--watch') -WorkingDirectory $projectRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $workerRoot 'worker-output.log') -RedirectStandardError (Join-Path $workerRoot 'worker-error.log') -PassThru
    } finally {
        foreach ($name in @([Environment]::GetEnvironmentVariables('Process').Keys)) { [Environment]::SetEnvironmentVariable($name,$null,'Process') }
        foreach ($entry in $original.GetEnumerator()) { [Environment]::SetEnvironmentVariable($entry.Key,$entry.Value,'Process') }
    }
    $details=Get-CimInstance Win32_Process -Filter "ProcessId = $($worker.Id)"
    if (-not $details) { throw 'The BYOA worker exited during startup. Inspect its local error log.' }
    @{pid=$worker.Id;started_at=$worker.StartTime.ToUniversalTime().ToString('o');start_ticks=$worker.StartTime.ToUniversalTime().Ticks;executable=$worker.Path;command_line=$details.CommandLine} | ConvertTo-Json | Set-Content -LiteralPath $workerFile -Encoding utf8
    Write-Output "Started hidden BYOA local worker (PID $($worker.Id)). Task results determine execution success."
    return
}
$process=[Diagnostics.Process]::Start($processInfo)
$standardOutput=$process.StandardOutput.BaseStream.CopyToAsync([Console]::OpenStandardOutput())
$standardError=$process.StandardError.BaseStream.CopyToAsync([Console]::OpenStandardError())
$process.WaitForExit()
$standardOutput.GetAwaiter().GetResult() | Out-Null
$standardError.GetAwaiter().GetResult() | Out-Null
if ($process.ExitCode -ne 0) { throw "BYOA bridge exited with code $($process.ExitCode)." }
