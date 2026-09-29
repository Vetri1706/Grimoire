param([ValidateSet('Setup','Complete','Revise','Revoke','Replay')][string]$Task='Setup')
$ErrorActionPreference='Stop'
$root=Split-Path $PSScriptRoot -Parent
$stateFile=Join-Path $root '.local/os-browser-demo.json'
$config=@{}
foreach($line in Get-Content -LiteralPath (Join-Path $root '.env')) {
    if($line -match '^([A-Z0-9_]+)=(.*)$') { $config[$Matches[1]]=$Matches[2] }
}
function Call-Api([string]$Method,[string]$Path,$Body=$null,[string]$Match='', [switch]$Agent, [hashtable]$Extra=@{}, [string]$Key='') {
    $token=if($Agent){$config.GRIMOIRE_TOKEN_AGENT_A}else{$config.GRIMOIRE_TOKEN_A}
    $headers=@{Authorization="Bearer $token"}
    if($Method -ne 'GET') { $headers['Idempotency-Key']=if($Key){$Key}else{[guid]::NewGuid().ToString()} }
    if($Match) { $headers['If-Match']=$Match }
    foreach($name in $Extra.Keys){$headers[$name]=$Extra[$name]}
    $arguments=@{Method=$Method;Uri="http://127.0.0.1:8080/api$Path";Headers=$headers;TimeoutSec=15}
    if($null -ne $Body){$arguments.Body=($Body|ConvertTo-Json -Depth 20 -Compress);$arguments.ContentType='application/json; charset=utf-8'}
    Invoke-RestMethod @arguments
}
function Save-State { [IO.File]::WriteAllText($stateFile,($state|ConvertTo-Json -Depth 20),[Text.UTF8Encoding]::new($false)) }
if($Task -eq 'Setup') {
    if(Test-Path -LiteralPath $stateFile){throw 'Preserving the existing OS browser fixture; use its remaining test steps.'}
    $draft=@{name='SYNTHETIC - OS browser verification (protocol, not LLM)';product_description='A synthetic workshop website with editable class pages and an enquiry form. No provider has been researched.';product_category='digital';decision=$null;requirements=$null;questions=$null;change_summary='Synthetic browser acceptance fixture, not an actual Codex run'}
    $scion=Call-Api POST '/scions' $draft
    $state=@{scion_id=$scion.id;draft=$draft;revision=1;synthetic=$true};Save-State
    $path="/scions/$($state.scion_id)"
    $statement='OS_BROWSER_PRIVATE_NOTE: a synthetic Handler wants to edit class pages; no implementation is verified.'
    $source=Call-Api POST "$path/sources" @{title='SYNTHETIC internal browser note';origin='synthetic://os-browser-acceptance';owner='Synthetic Handler';synthetic=$true;source_text=$statement;rights_status='granted';permission_basis='Handler-authored synthetic browser test';permitted_use='scion_review';change_summary='Synthetic test content'} '"1"'
    $state.source_id=$source.source_id;Save-State
    Call-Api POST "$path/sources/$($source.source_id)/revisions/1/claims" @{statement=$statement;locator=@{start_byte=0;end_byte=[Text.Encoding]::UTF8.GetByteCount($statement);quote=$statement}} | Out-Null
    $claims=Call-Api GET "$path/sources/$($source.source_id)/revisions/1/claims"
    $taskRecord=Call-Api POST "$path/agent-tasks" @{task_kind='prepare_capability_plan';candidate_proposal=@{synthetic=$true};timeout_seconds=300} '"1"'
    $state.task_id=$taskRecord.id;Save-State
    Call-Api POST "$path/agent-tasks/$($taskRecord.id)/dispatch" $null '"1"' | Out-Null
    $claim=Call-Api POST "/agent/tasks/$($taskRecord.id)/claim" -Agent
    $state.lease=$claim.lease_token;Save-State
    $capabilities=Call-Api GET "$path/capabilities"
    $plan=Call-Api POST "$path/capability-plans" @{
        synthetic=$true;summary='SYNTHETIC protocol proposal for browser acceptance; not a model result.'
        capabilities=@(@{key='editing';title='Editable website pages';reason='The Handler requests page editing.';evidence_needed=@('Authorized evidence for editing');connector_ids=@('handler_intake','scion_sources')})
        unresolved_gaps=@($capabilities.unresolved_gaps);change_summary='Synthetic protocol fixture, no LLM invoked'
    } '"1"' -Agent -Extra @{'X-Grimoire-Task-Id'=$taskRecord.id;'X-Grimoire-Task-Lease'=$claim.lease_token}
    $state.plan_id=$plan.id;Save-State
    $comparison=Call-Api POST "$path/evidence-comparisons" @{
        synthetic=$true;plan_id=$plan.id;alternatives=@(
            @{label='Synthetic approach A';criteria=@(@{capability_key='editing';claim_ids=@($claims.claims[0].id)})},
            @{label='Synthetic approach B';criteria=@(@{capability_key='editing';claim_ids=@()})})
        unresolved_gaps=@('Synthetic claims are not verified evidence.');change_summary='Browser revocation check'
    } '"1"'
    $state.comparison_id=$comparison.id;Save-State
    Write-Output "Synthetic protocol fixture ready: http://127.0.0.1:5180/#/scions/$($state.scion_id). Run Complete within the five-minute test lease."
    return
}
$state=Get-Content -LiteralPath $stateFile -Raw|ConvertFrom-Json -AsHashtable
$path="/scions/$($state.scion_id)"
if($Task -eq 'Complete') {
    Call-Api POST "/agent/tasks/$($state.task_id)/result" @{proposal_id=$state.plan_id;provider_run_id='synthetic-browser-protocol-no-model';output_sha256=('7'*64);preparation_note='Synthetic protocol output, not a Codex or Paperclip run.'} -Agent -Extra @{'X-Grimoire-Task-Lease'=$state.lease} | Out-Null
    $state.completed=$true;Save-State
} elseif($Task -eq 'Revise') {
    $state.draft.change_summary='Browser verification: changed intake revision makes the plan stale'
    Call-Api POST "$path/revisions" $state.draft '"1"' -Key 'os-browser-revision-2' | Out-Null
    $state.revision=2;Save-State
} elseif($Task -in @('Revoke','Replay')) {
    Call-Api POST "$path/sources/$($state.source_id)/revoke" @{reason='Synthetic browser acceptance: permission withdrawn while case remains open.'} '"1"' -Key 'os-browser-source-revoke' | Out-Null
    $state.revoked=$true;Save-State
}
Write-Output "$Task applied to the synthetic OS browser fixture. No approval was created."
