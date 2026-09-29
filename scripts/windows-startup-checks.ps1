param(
    [ValidateSet('PrepareCatalog','Check')]
    [string]$Task = 'Check',
    [string]$ApiBinary,
    [ValidatePattern('^grimoire_startup_[a-z0-9_]+_test$')]
    [string]$CleanDatabase = 'grimoire_startup_agents_v1_test'
)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path $PSScriptRoot -Parent
$localRoot = Join-Path $projectRoot '.local'
$cleanDatabase = $CleanDatabase
$upgradeDatabase = 'grimoire_test'
$psql = Join-Path $projectRoot '.tools/pgsql/bin/psql.exe'
if (-not $ApiBinary) { $ApiBinary = Join-Path $projectRoot 'api/target/debug/grimoire-api.exe' }
if (-not (Test-Path -LiteralPath $psql)) { throw 'Native PostgreSQL 17 psql is unavailable. No database was changed.' }
$config = @{}
foreach ($line in Get-Content -LiteralPath (Join-Path $projectRoot '.env')) {
    if ($line -match '^([A-Z0-9_]+)=(.*)$') { $config[$Matches[1]] = $Matches[2] }
}
foreach ($key in @('POSTGRES_PASSWORD','INTAKE_DB_PASSWORD')) {
    if ($config[$key] -notmatch '^[a-f0-9]{64}$') { throw "Missing or invalid local generated credential: $key." }
}
$pgPort = [int]$config.PGPORT
if ($pgPort -lt 1024 -or $pgPort -gt 65535) { throw 'Invalid local PostgreSQL port.' }
New-Item -ItemType Directory -Force -Path $localRoot | Out-Null
$utf8 = [Text.UTF8Encoding]::new($false)
$runStamp = [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfffZ')
$results = [Collections.Generic.List[object]]::new()

function Run-LocalProcess([string]$File, [string[]]$Arguments, [hashtable]$Environment = @{}) {
    $info = [Diagnostics.ProcessStartInfo]::new()
    $info.FileName = $File
    $info.WorkingDirectory = $projectRoot
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    $info.StandardOutputEncoding = $utf8
    $info.StandardErrorEncoding = $utf8
    foreach ($argument in $Arguments) { $info.ArgumentList.Add($argument) }
    foreach ($name in $Environment.Keys) { $info.Environment[$name] = $Environment[$name] }
    $process = [Diagnostics.Process]::new()
    $process.StartInfo = $info
    try {
        if (-not $process.Start()) { throw 'Could not start local verification process.' }
        $stdout = $process.StandardOutput.ReadToEndAsync()
        $stderr = $process.StandardError.ReadToEndAsync()
        if (-not $process.WaitForExit(60000)) {
            $process.Kill($true)
            throw 'Local verification process exceeded its 60-second limit.'
        }
        $output = $stdout.GetAwaiter().GetResult() + $stderr.GetAwaiter().GetResult()
        foreach ($secret in @($config.POSTGRES_PASSWORD, $config.INTAKE_DB_PASSWORD)) { $output = $output.Replace($secret, '[redacted]') }
        return [pscustomobject]@{ ExitCode = $process.ExitCode; Output = $output }
    } finally { $process.Dispose() }
}
function Psql([string]$Database = 'postgres', [string]$Sql, [string]$File, [switch]$Migrator, [switch]$Runtime) {
    if ($Database -notin @('postgres', $cleanDatabase, $upgradeDatabase)) { throw 'Unexpected startup verification database.' }
    if ($Runtime -and $Migrator) { throw 'Runtime checks cannot select the migration owner.' }
    $login = if ($Runtime) { 'grimoire_intake_app' } else { 'postgres' }
    $password = if ($Runtime) { $config.INTAKE_DB_PASSWORD } else { $config.POSTGRES_PASSWORD }
    $arguments = @('-X','-q','-A','-t','-v','ON_ERROR_STOP=1','-h','127.0.0.1','-p',"$pgPort",'-U',$login,'-d',$Database)
    if ($Migrator) { $arguments += @('-c','SET ROLE grimoire_migrator;') }
    if ($Sql) { $arguments += @('-c',$Sql) }
    if ($File) { $arguments += @('-f',(Resolve-Path -LiteralPath $File).Path) }
    $result = Run-LocalProcess $psql $arguments @{ PGPASSWORD = $password; PGCLIENTENCODING = 'UTF8' }
    if ($result.ExitCode -ne 0) { throw "PostgreSQL verification command failed for $Database. $($result.Output.Trim())" }
    return $result.Output.TrimEnd([char[]]"`r`n")
}
function Record-Pass([string]$Name) {
    $results.Add([pscustomobject]@{ check = $Name; status = 'PASS' })
    Write-Host "PASS $Name"
}
function Sha256([string]$Value) { return [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($utf8.GetBytes($Value))).ToLowerInvariant() }
function Assert-Version([string]$Database) {
    $version = [int](Psql -Database $Database -Sql "SELECT current_setting('server_version_num');")
    if ($version -lt 170000 -or $version -ge 180000) { throw 'This verification requires PostgreSQL 17.' }
    Record-Pass "$Database runs PostgreSQL 17"
}
# This exact migration set is the local Windows implementation. It does not
# substitute for unavailable Mac 0035-0037/GG-53/GG-54 source or evidence.
$migrationFiles = @(
    'db/gg40/0022_grimoire_contract.sql',
    'db/gg40/0023_grimoire_review_corrections.sql',
    'db/intake/0024_intake.sql',
    'db/intake/0025_intake_history_authors.sql',
    'db/intake/0026_intake_sources.sql',
    'db/intake/0027_intake_source_objects.sql',
    'db/intake/0028_intake_scope.sql',
    'db/intake/0029_intake_agent_tasks.sql',
    'db/intake/0030_scope_chain_guard.sql',
    'db/intake/0031_worker_controls.sql',
    'db/intake/0032_synthetic_offer_comparison.sql',
    'db/intake/0033_offer_review_identity_guards.sql',
    'db/intake/0034_sourcing_authority_gate.sql',
    'db/intake/0038_windows_adaptive_plans.sql',
    'db/intake/0039_windows_approval_lockdown.sql',
    'db/intake/0040_control_surface.sql',
    'db/intake/0041_watchtower_artifact_guards.sql',
    'db/intake/0042_watchtower_task_sources.sql',
    'db/intake/0043_native_agents.sql',
    'db/intake/0044_organization_onboarding.sql',
    'db/intake/0045_handler_registration.sql',
    'db/intake/0046_public_judge_demo.sql',
    'db/intake/0047_google_identity.sql',
    'db/intake/0048_handler_profile.sql'
)
$attestationSource = Get-Content -LiteralPath (Join-Path $projectRoot 'api/src/attestation.rs') -Raw
$compiledFiles = @([regex]::Matches($attestationSource, 'migration!\("([^"]+)",\s*"([^"]+)"\)') | ForEach-Object { "db/$($_.Groups[1].Value)/$($_.Groups[2].Value)" })
if (($compiledFiles -join "`n") -cne ($migrationFiles -join "`n")) { throw 'Startup script migration list differs from Rust attestation source.' }
$developmentScript = Get-Content -LiteralPath (Join-Path $projectRoot 'scripts/dev.ps1') -Raw
$accepted = Get-Content -LiteralPath (Join-Path $projectRoot 'db/gg40/checksums.json') -Raw | ConvertFrom-Json -AsHashtable
$migrationHashes = [ordered]@{}
foreach ($relativeFile in $migrationFiles) {
    if (-not $developmentScript.Contains("'$relativeFile'")) { throw "Migration is missing from dev.ps1: $relativeFile" }
    $name = Split-Path $relativeFile -Leaf
    $migrationHashes[$name] = (Get-FileHash -LiteralPath (Join-Path $projectRoot $relativeFile) -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($accepted.ContainsKey($name) -and $accepted[$name] -cne $migrationHashes[$name]) { throw "Accepted GG-40 bytes changed: $name" }
}
Assert-Version 'postgres'

if ($Task -eq 'PrepareCatalog') {
    $exists = Psql -Sql "SELECT 1 FROM pg_database WHERE datname='$cleanDatabase';"
    if ($exists.Trim() -eq '1') { throw "$cleanDatabase already exists. Preserving it without reset or deletion. Inspect the prior run before choosing a separately reviewed cleanup." }
    $roles = Psql -Sql "SELECT count(*) FROM pg_roles WHERE rolname IN ('grimoire_migrator','grimoire_intake_app','grimoire_app','grimoire_worker');"
    if ($roles.Trim() -ne '4') { throw 'Expected local Grimoire roles are missing. Provision the local development instance with scripts/dev.ps1 first.' }
    Psql -Sql "CREATE DATABASE $cleanDatabase OWNER grimoire_migrator;" | Out-Null
    Write-Host "Created $cleanDatabase. This script retains it even if a later step fails."
    Psql -Database $cleanDatabase -Sql "REVOKE ALL ON DATABASE $cleanDatabase FROM PUBLIC; GRANT CONNECT ON DATABASE $cleanDatabase TO grimoire_intake_app;" | Out-Null
    Psql -Database $cleanDatabase -Migrator -Sql 'CREATE TABLE public.grimoire_schema_migrations (name text PRIMARY KEY, sha256 text NOT NULL, applied_at timestamptz NOT NULL DEFAULT clock_timestamp());' | Out-Null
    foreach ($relativeFile in $migrationFiles) {
        $name = Split-Path $relativeFile -Leaf
        Psql -Database $cleanDatabase -Migrator -File (Join-Path $projectRoot $relativeFile) | Out-Null
        Psql -Database $cleanDatabase -Migrator -Sql "INSERT INTO public.grimoire_schema_migrations(name,sha256) VALUES ('$name','$($migrationHashes[$name])');" | Out-Null
        Record-Pass "clean migration $name SHA-256 $($migrationHashes[$name])"
    }
    # Query text and pg_catalog search_path are identical to Rust attestation.
    # JSON transport preserves the exact function body/ACL bytes before UTF-8 hashing.
    $catalogQuery = (Get-Content -LiteralPath (Join-Path $projectRoot 'db/windows-catalog-query.sql') -Raw).Trim().TrimEnd(';')
    $rows = (Psql -Database $cleanDatabase -Sql "SET search_path=pg_catalog; SELECT coalesce(json_agg(row_to_json(material)),'[]'::json) FROM ($catalogQuery) material;") | ConvertFrom-Json
    if ($rows.Count -eq 0) { throw 'Clean catalog unexpectedly has no attestation material.' }
    $catalog = [ordered]@{}
    foreach ($row in $rows) {
        if ($catalog.Contains($row.key)) { throw "Duplicate catalog attestation key: $($row.key)" }
        $catalog[$row.key] = Sha256 $row.body
    }
    $catalogFile = Join-Path $projectRoot 'db/windows-catalog.json'
    if (Test-Path -LiteralPath $catalogFile) { Copy-Item -LiteralPath $catalogFile -Destination (Join-Path $localRoot "windows-catalog-before-$runStamp.json") }
    [IO.File]::WriteAllText($catalogFile, ($catalog | ConvertTo-Json -Depth 4) + "`n", $utf8)
    [IO.File]::WriteAllText((Join-Path $localRoot "windows-clean-migrations-$runStamp.json"), ($migrationHashes | ConvertTo-Json -Depth 4) + "`n", $utf8)
    Record-Pass "generated $($catalog.Count) clean catalog hashes from exact Windows migrations"
    Write-Host 'Review db/windows-catalog.json, compile Rust, migrate grimoire_test, then run -Task Check. No synthetic fixture was loaded into the clean startup database.'
    return
}

if (-not (Test-Path -LiteralPath $ApiBinary)) { throw 'Compiled Rust API is missing. Prepare/review the catalog and build first.' }
Assert-Version $cleanDatabase
Assert-Version $upgradeDatabase
$storage = @{}
foreach ($line in Get-Content -LiteralPath (Join-Path $localRoot 'storage.env')) {
    if ($line -match '^([A-Z0-9_]+)=(.*)$') { $storage[$Matches[1]] = $Matches[2] }
}
if (-not $storage.GRIMOIRE_S3_TEST_ACCESS_KEY -or $storage.GRIMOIRE_S3_TEST_SECRET_KEY -notmatch '^[a-f0-9]{64}$') { throw 'Synthetic test object-store credentials are unavailable.' }
$startupEnvironment = @{
    GRIMOIRE_S3_ENDPOINT = 'http://127.0.0.1:19000'
    GRIMOIRE_S3_REGION = 'us-east-1'
    GRIMOIRE_S3_BUCKET = 'grimoire-sources-test'
    GRIMOIRE_S3_ACCESS_KEY = $storage.GRIMOIRE_S3_TEST_ACCESS_KEY
    GRIMOIRE_S3_SECRET_KEY = $storage.GRIMOIRE_S3_TEST_SECRET_KEY
    GRIMOIRE_BIND = '127.0.0.1:18089'
}
function Check-Startup([string]$Database, [string]$Expected = 'WINDOWS_STARTUP_ATTESTATION_PASS') {
    if ($Database -notin @($cleanDatabase,$upgradeDatabase)) { throw 'Unexpected startup database.' }
    $startupEnvironment.DATABASE_URL = "postgres://grimoire_intake_app:$($config.INTAKE_DB_PASSWORD)@127.0.0.1:$pgPort/$Database"
    $result = Run-LocalProcess $ApiBinary @('check-startup') $startupEnvironment
    $success = $Expected -eq 'WINDOWS_STARTUP_ATTESTATION_PASS'
    if (($success -and $result.ExitCode -ne 0) -or (-not $success -and $result.ExitCode -eq 0) -or -not $result.Output.Contains($Expected)) {
        throw "Unexpected Rust startup result for $Database; expected $Expected. $($result.Output.Trim())"
    }
}
function Ledger([string]$Database) { return Psql -Database $Database -Sql 'SELECT coalesce(json_agg(row_to_json(m)),''[]''::json) FROM (SELECT name,sha256,applied_at FROM public.grimoire_schema_migrations ORDER BY name) m;' }
Check-Startup $cleanDatabase
Record-Pass 'clean PostgreSQL 17 Rust startup with least-privilege runtime'
Check-Startup $upgradeDatabase
Record-Pass 'upgraded PostgreSQL 17 Rust startup with least-privilege runtime'
Psql -Database $cleanDatabase -Runtime -File (Join-Path $projectRoot 'api/tests/windows_authority_guards.sql') | Out-Null
Record-Pass 'runtime SQL approval helpers, GUC spoofing, DDL and migrator escalation denied'

$baselineLedger = Ledger $cleanDatabase
$originalFunctionBase64 = Psql -Database $cleanDatabase -Sql "SET search_path=pg_catalog; SELECT encode(convert_to(pg_get_functiondef('app.intake_can_access()'::regprocedure),'UTF8'),'base64');"
$originalFunction = $utf8.GetString([Convert]::FromBase64String($originalFunctionBase64))
$restoreFunctionFile = Join-Path $localRoot "windows-startup-function-restore-$runStamp.sql"
[IO.File]::WriteAllText($restoreFunctionFile, $originalFunction, $utf8)
try {
    Psql -Database $cleanDatabase -Migrator -Sql 'CREATE OR REPLACE FUNCTION app.intake_can_access() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS ''SELECT true'';' | Out-Null
    if ((Ledger $cleanDatabase) -cne $baselineLedger) { throw 'Function tamper unexpectedly changed migration ledger.' }
    Check-Startup $cleanDatabase 'STARTUP_CATALOG_MISMATCH'
    Record-Pass 'same-name function replacement denied with unchanged migration ledger'
} finally {
    Psql -Database $cleanDatabase -Migrator -File $restoreFunctionFile | Out-Null
}
Check-Startup $cleanDatabase
Record-Pass 'exact original function restored and clean startup recovered'

$ledgerName = '0024_intake.sql'
try {
    Psql -Database $cleanDatabase -Migrator -Sql "UPDATE public.grimoire_schema_migrations SET sha256=repeat('0',64) WHERE name='$ledgerName';" | Out-Null
    Check-Startup $cleanDatabase 'STARTUP_MIGRATION_MISMATCH'
    Record-Pass 'migration ledger hash mismatch denied'
} finally {
    Psql -Database $cleanDatabase -Migrator -Sql "UPDATE public.grimoire_schema_migrations SET sha256='$($migrationHashes[$ledgerName])' WHERE name='$ledgerName';" | Out-Null
}
Check-Startup $cleanDatabase
Record-Pass 'migration ledger restored and clean startup recovered'

try {
    Psql -Database $cleanDatabase -Sql "GRANT CREATE ON DATABASE $cleanDatabase TO grimoire_intake_app;" | Out-Null
    Check-Startup $cleanDatabase 'STARTUP_RUNTIME_AUTHORITY'
    Record-Pass 'runtime database DDL grant denied at startup'
} finally {
    Psql -Database $cleanDatabase -Sql "REVOKE CREATE ON DATABASE $cleanDatabase FROM grimoire_intake_app;" | Out-Null
}
Check-Startup $cleanDatabase
Record-Pass 'runtime DDL grant revoked and clean startup recovered'

try {
    Psql -Database $cleanDatabase -Migrator -Sql 'GRANT EXECUTE ON FUNCTION app.record_synthetic_sourcing_authority_review(uuid,uuid,uuid,uuid,uuid,uuid,text,text,boolean) TO grimoire_intake_app;' | Out-Null
    Check-Startup $cleanDatabase 'STARTUP_CATALOG_MISMATCH'
    Record-Pass 'unverified approval helper execute grant denied at startup'
} finally {
    Psql -Database $cleanDatabase -Migrator -Sql 'REVOKE EXECUTE ON FUNCTION app.record_synthetic_sourcing_authority_review(uuid,uuid,uuid,uuid,uuid,uuid,text,text,boolean) FROM grimoire_intake_app;' | Out-Null
}
Check-Startup $cleanDatabase
try {
    Psql -Database $cleanDatabase -Migrator -Sql 'GRANT UPDATE(current_revision) ON grimoire.intake_scions TO grimoire_intake_app;' | Out-Null
    Check-Startup $cleanDatabase 'STARTUP_CATALOG_MISMATCH'
    Record-Pass 'expanded runtime column UPDATE authority denied at startup'
} finally {
    Psql -Database $cleanDatabase -Migrator -Sql 'REVOKE UPDATE(current_revision) ON grimoire.intake_scions FROM grimoire_intake_app;' | Out-Null
}
Check-Startup $cleanDatabase
Record-Pass 'column UPDATE grant revoked and clean startup recovered'
$fkTrigger = Psql -Database $cleanDatabase -Sql "SELECT json_build_object('table_identifier',format('%I.%I',n.nspname,c.relname),'trigger_identifier',format('%I',t.tgname)) FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_constraint k ON k.oid=t.tgconstraint WHERE n.nspname='grimoire' AND t.tgisinternal AND k.contype='f' AND t.tgenabled='O' ORDER BY c.relname,k.conname,t.tgtype LIMIT 1;" | ConvertFrom-Json
if (-not $fkTrigger.table_identifier -or -not $fkTrigger.trigger_identifier) { throw 'Expected enabled FK constraint trigger is unavailable.' }
try {
    # PostgreSQL requires superuser authority to alter an internal RI trigger.
    # The named clean disposable database is isolated from the harness/dev DBs.
    Psql -Database $cleanDatabase -Sql "ALTER TABLE $($fkTrigger.table_identifier) DISABLE TRIGGER $($fkTrigger.trigger_identifier);" | Out-Null
    Check-Startup $cleanDatabase 'STARTUP_CATALOG_MISMATCH'
    Record-Pass 'disabled internal FK constraint trigger denied at startup'
} finally {
    Psql -Database $cleanDatabase -Sql "ALTER TABLE $($fkTrigger.table_identifier) ENABLE TRIGGER $($fkTrigger.trigger_identifier);" | Out-Null
}
Check-Startup $cleanDatabase
Record-Pass 'internal FK trigger restored and clean startup recovered'
if ((Ledger $cleanDatabase) -cne $baselineLedger) { throw 'Final migration ledger differs from its original state.' }
Record-Pass 'approval helper ACL restored; final catalog and ledger match clean baseline'
Check-Startup $upgradeDatabase
Record-Pass 'upgraded database still starts after isolated clean-database adversarial checks'
$report = [ordered]@{ scope = 'New Windows startup verification; not GG-53/GG-54 integration'; executed_at = [DateTime]::UtcNow.ToString('o'); clean_database = $cleanDatabase; upgraded_database = $upgradeDatabase; migration_hashes = $migrationHashes; checks = @($results.ToArray()); physical_erasure_tested = $false }
$reportFile = Join-Path $localRoot "windows-startup-checks-$runStamp.json"
[IO.File]::WriteAllText($reportFile, ($report | ConvertTo-Json -Depth 8) + "`n", $utf8)
Write-Host "Windows startup verification passed: $($results.Count) checks. Report: $reportFile"
Write-Host 'Dedicated clean test database and restoration SQL retained for inspection. No source branch, applied SQL file, development data or Paperclip state was removed.'
