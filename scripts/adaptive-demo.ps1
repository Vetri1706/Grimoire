param([ValidateSet('Intake','Evidence','Revoke')][string]$Task='Intake')
$ErrorActionPreference='Stop'
$root=Split-Path $PSScriptRoot -Parent
$stateFile=Join-Path $root '.local/adaptive-demo.json'
$config=@{}
foreach($line in Get-Content -LiteralPath (Join-Path $root '.env')) {
    if($line -match '^([A-Z0-9_]+)=(.*)$') { $config[$Matches[1]]=$Matches[2] }
}
$token=$config.GRIMOIRE_TOKEN_A
if($token -notmatch '^[a-f0-9]{64}$') { throw 'Local Handler A enrollment is required.' }
function Call-Api([string]$Method,[string]$Path,$Body=$null,[string]$Match='') {
    $headers=@{Authorization="Bearer $token"}
    if($Method -ne 'GET') { $headers['Idempotency-Key']=[guid]::NewGuid().ToString() }
    if($Match) { $headers['If-Match']=$Match }
    $args=@{Method=$Method;Uri="http://127.0.0.1:8080/api$Path";Headers=$headers;TimeoutSec=30}
    if($null -ne $Body) { $args.Body=($Body|ConvertTo-Json -Depth 15 -Compress);$args.ContentType='application/json; charset=utf-8' }
    Invoke-RestMethod @args
}
function Save-State($State) { [IO.File]::WriteAllText($stateFile,($State|ConvertTo-Json -Depth 12),[Text.UTF8Encoding]::new($false)) }
if($Task -eq 'Intake') {
    if(Test-Path -LiteralPath $stateFile) { throw 'A demo record already exists; preserving it. Inspect .local/adaptive-demo.json.' }
    $scion=Call-Api POST '/scions' @{
        name='Synthetic workshop website - adaptive Scion'
        product_description='I need a website for a synthetic community pottery workshop. Visitors should read class descriptions, request a place, and contact the organiser. I want to update the pages myself. No provider has been researched; budget, privacy requirements and booking rules are still unknown.'
        product_category='digital';decision=$null;requirements=$null;questions=$null
        change_summary='Handler free-text description for the synthetic Windows adaptive demonstration'
    }
    $state=@{scion_id=$scion.id;revision=1;created_at=[DateTime]::UtcNow.ToString('o');synthetic=$true}
    Save-State $state
    $taskRecord=Call-Api POST "/scions/$($scion.id)/agent-tasks" @{task_kind='prepare_capability_plan';candidate_proposal=@{synthetic=$true};timeout_seconds=240} '"1"'
    $state.task_id=$taskRecord.id;Save-State $state
    Call-Api POST "/scions/$($scion.id)/agent-tasks/$($taskRecord.id)/dispatch" $null '"1"' | Out-Null
    Write-Output "Synthetic Scion $($scion.id), revision 1; task $($taskRecord.id) dispatched. Run scripts/byoa.ps1 -Mode Once using the existing local Codex login, then -Task Evidence."
    return
}
if(-not(Test-Path -LiteralPath $stateFile)) { throw 'Create the synthetic intake first.' }
$state=Get-Content -LiteralPath $stateFile -Raw|ConvertFrom-Json -AsHashtable
$path="/scions/$($state.scion_id)"
if($Task -eq 'Revoke') {
    if(-not $state.source_ids -or $state.revoked) { throw 'Evidence is missing or this demonstration source is already revoked.' }
    Call-Api POST "$path/sources/$($state.source_ids[0])/revoke" @{reason='Synthetic browser check: permission withdrawn while the comparison tab is already open.'} '"1"' | Out-Null
    $state.revoked=$true;Save-State $state
    Write-Output 'Synthetic source permission revoked. The open comparison must hide its derived content after its next access check.'
    return
}
if($state.comparison_id) { throw 'The demonstration comparison is already recorded; preserving it.' }
$adaptive=Call-Api GET "$path/capabilities"
$plan=@($adaptive.plans|Where-Object {$_.agent_task_id -eq $state.task_id -and $_.status -eq 'current' -and $_.input})[0]
if(-not $plan) { throw 'The dispatched Codex task has not produced a current plan. Inspect its actual result; no synthetic model output is substituted.' }
$capability=$plan.input.capabilities[0]
$sources=@();$claims=@();$alternatives=@()
foreach($label in @('A','B')) {
    $statement="Synthetic approach $label proposes investigating '$($capability.title)'; this note does not demonstrate a working capability."
    $prefix="SYNTHETIC HANDLER-AUTHORED NOTE. No provider listing, independent evidence, or offer.`n"
    $source=Call-Api POST "$path/sources" @{
        title="Synthetic website approach $label";origin="synthetic://windows-adaptive-demo/$label";owner='Synthetic local Handler A';synthetic=$true
        source_text="$prefix$statement`n";rights_status='granted';permission_basis='Handler-authored synthetic demonstration text';permitted_use='scion_review';change_summary='Explicitly synthetic text for locator and review testing'
    } '"1"'
    $sources+=,$source.source_id
    $start=[Text.Encoding]::UTF8.GetByteCount($prefix)
    Call-Api POST "$path/sources/$($source.source_id)/revisions/1/claims" @{
        statement=$statement;locator=@{start_byte=$start;end_byte=$start+[Text.Encoding]::UTF8.GetByteCount($statement);quote=$statement}
    } | Out-Null
    $detail=Call-Api GET "$path/sources/$($source.source_id)/revisions/1/claims"
    $claim=$detail.claims[0];$claims+=,$claim.id
    $criteria=@($plan.input.capabilities|ForEach-Object {@{capability_key=$_.key;claim_ids=@(if($_.key -eq $capability.key){$claim.id})}})
    $alternatives+=,@{label="Synthetic approach $label (Handler label, not a provider)";criteria=$criteria}
}
$comparison=Call-Api POST "$path/evidence-comparisons" @{
    synthetic=$true;plan_id=$plan.id;alternatives=$alternatives
    unresolved_gaps=@('These Handler-authored notes do not establish capability support. Independent authorized evidence and human review remain absent.','No external connector or provider research was used.')
    change_summary='Synthetic review draft demonstrating exact source claims and explicit empty criteria'
} '"1"'
$state.plan_id=$plan.id;$state.source_ids=$sources;$state.claim_ids=$claims;$state.comparison_id=$comparison.id;Save-State $state
Write-Output "Synthetic Codex plan $($plan.id) and comparison $($comparison.id) recorded. Open http://127.0.0.1:5180/#/scions/$($state.scion_id) and select Capability plan."
