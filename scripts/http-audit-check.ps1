param(
    [string]$LogPath = '.local/adaptive-http-audit-offers.log',
    [ValidateSet('native','docker')][string]$Mode
)
$ErrorActionPreference = 'Stop'
$projectPath = Split-Path $PSScriptRoot -Parent
Set-Location -LiteralPath $projectPath
$localConfig = @{}
foreach ($line in Get-Content -LiteralPath '.env') {
    if ($line -match '^([A-Z_]+)=(.*)$') { $localConfig[$Matches[1]] = $Matches[2] }
}
if (-not $Mode) { $Mode = $localConfig.GRIMOIRE_DB_MODE }
if ($Mode -notin @('native','docker')) { throw 'Specify the existing native or docker database mode.' }
$marker = Select-String -LiteralPath $LogPath -Pattern '^HTTP_AUDIT_EXPECTATION ' | Select-Object -Last 1
if (-not $marker) { throw 'Run the real Go offer harness first; its exact HTTP audit expectation is absent.' }
$expected = ($marker.Line -replace '^HTTP_AUDIT_EXPECTATION ','') | ConvertFrom-Json
foreach ($key in @('offer_revision_id','offer_line_id','actor_id')) {
    if ($expected.$key -notmatch '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$') { throw "Invalid audit expectation: $key" }
}
if ($expected.input_sha256 -notmatch '^[a-f0-9]{64}$' -or
    $expected.endpoint_scope -notmatch '^POST /api/scions/[a-f0-9-]{36}/offers$' -or
    $expected.effective_role -ne 'procurement_preparer') { throw 'Invalid real HTTP path/hash/role expectation.' }
$sqlArgs = @('-X','-U','postgres','-d','grimoire_test','-v','ON_ERROR_STOP=1')
foreach ($key in @('offer_revision_id','offer_line_id','actor_id','input_sha256','endpoint_scope','effective_role')) {
    $sqlArgs += @('-v',"${key}=$($expected.$key)")
}
$sqlArgs += @('-c','SET ROLE grimoire_migrator;')
$previousPassword = $env:PGPASSWORD
$previousEncoding = $env:PGCLIENTENCODING
try {
    $env:PGPASSWORD = $localConfig.POSTGRES_PASSWORD
    $env:PGCLIENTENCODING = 'UTF8'
    if ($Mode -eq 'docker') {
        $sqlArgs += @('-f','/workspace/api/tests/http_audit_guards.sql')
        & docker compose exec -T -e "PGPASSWORD=$($localConfig.POSTGRES_PASSWORD)" db psql @sqlArgs
    } else {
        $port = [int]$localConfig.PGPORT
        if ($port -lt 1024 -or $port -gt 65535) { throw 'Invalid local PostgreSQL port.' }
        $sqlArgs += @('-h','127.0.0.1','-p',"$port",'-f',(Join-Path $projectPath 'api/tests/http_audit_guards.sql'))
        & (Join-Path $projectPath '.tools/pgsql/bin/psql.exe') @sqlArgs
    }
    if ($LASTEXITCODE -ne 0) { throw "Real HTTP audit verification failed (exit $LASTEXITCODE)." }
} finally {
    $env:PGPASSWORD = $previousPassword
    $env:PGCLIENTENCODING = $previousEncoding
}
Write-Host 'Verified real HTTP audit provenance in disposable grimoire_test; no rows changed.'
