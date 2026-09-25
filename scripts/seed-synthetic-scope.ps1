param([switch]$QueueCodex,[ValidateSet('layer3-demo.json','layer3-browser-probe.json','layer4-scope.json')][string]$ReceiptName='layer3-demo.json')
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path $PSScriptRoot -Parent
Set-Location -LiteralPath $projectRoot
$config = @{}
foreach ($line in Get-Content -LiteralPath '.env') {
    if ($line -match '^([A-Z_]+)=(.*)$') { $config[$Matches[1]] = $Matches[2] }
}
$api = 'http://127.0.0.1:8080'
$run = [Guid]::NewGuid().ToString('N').Substring(0,12)
function Invoke-Api([string]$Method,[string]$Path,$Body,[string]$Key,[string]$Match) {
    $headers = @{Authorization="Bearer $($config.GRIMOIRE_TOKEN_A)"}
    if ($Key) { $headers['Idempotency-Key'] = "synthetic-scope-${run}-$Key" }
    if ($Match) { $headers['If-Match'] = $Match }
    $requestArgs = @{Method=$Method;Uri="$api$Path";Headers=$headers;TimeoutSec=30}
    if ($null -ne $Body) { $requestArgs['ContentType']='application/json; charset=utf-8';$requestArgs['Body']=[Text.Encoding]::UTF8.GetBytes(($Body|ConvertTo-Json -Depth 30 -Compress)) }
    Invoke-RestMethod @requestArgs
}
$draft = Invoke-Api POST '/api/scions' @{
    name=$(if ($ReceiptName -eq 'layer3-browser-probe.json') {'SYNTHETIC — scope revocation browser probe'} elseif ($ReceiptName -eq 'layer4-scope.json') {'SYNTHETIC — two supplier offers'} else {'SYNTHETIC — physical scope review'});product_description='A fictional enclosure used only to exercise exact product identity review.'
    product_category='physical';decision='Review the exact synthetic configuration, BOM occurrence, component and requirement identities.'
    requirements=@('Synthetic target enclosure width 120 mm');questions=@();change_summary='Create a synthetic Layer 3 demonstration; no real supplier or engineering evidence'
} 'create' ''
$path = "/api/scions/$($draft.id)"
$candidate = @{
    synthetic=$true;identity_match='exact';configuration=@{product_code="SYN-DEMO-P-$run";product_name='Synthetic enclosure';configuration_code='SYN-CFG-A';specification=@{enclosure='Synthetic controlled enclosure'}}
    component=@{internal_part_code="SYN-DEMO-C-$run";manufacturer='Synthetic manufacturer';part_number='SYN-PART-001';attributes=@{material='synthetic aluminum'}}
    occurrence=@{path='/synthetic/enclosure[1]';quantity='1';uom='EA'}
    requirement=@{code='SYN-WIDTH-001';criteria=@{target_width_mm=120}}
    case_code="SYN-DEMO-CASE-$run";case_title='Synthetic exact enclosure scope';unresolved_gaps=@()
    change_summary='Explicit synthetic identities proposed for separate engineering scope review';source_claims=@()
}
$statements = @{
    configuration="Configuration: product SYN-DEMO-P-$run, Synthetic enclosure, configuration SYN-CFG-A; specification Synthetic controlled enclosure."
    component="Component: SYN-DEMO-C-$run, manufacturer Synthetic manufacturer, part SYN-PART-001; material synthetic aluminum."
    occurrence='Exact BOM occurrence: /synthetic/enclosure[1], quantity 1, unit EA, using the explicit synthetic configuration and component.'
    requirement='Requirement: SYN-WIDTH-001, target_width_mm = 120 for this exact enclosure occurrence.'
}
$sources = @()
foreach ($kind in @('configuration','component','occurrence','requirement')) {
    $prefix="SYNTHETIC TEST SOURCE — not manufacturer evidence.`n"
    $quote=$statements[$kind];$text=$prefix+$quote+"`n"
    $receipt=Invoke-Api POST "$path/sources" @{
        title="SYNTHETIC — $kind identity";origin='Local synthetic test fixture authored for Layer 3';owner='Synthetic local test owner';synthetic=$true
        source_text=$text;rights_status='granted';permission_basis='Synthetic test author permits local review';permitted_use='scion_review';change_summary='Initial explicit synthetic identity statement'
    } "source-$kind" '"1"'
    $sourcePath="$path/sources/$($receipt.source_id)"
    $start=[Text.Encoding]::UTF8.GetByteCount($prefix);$end=$start+[Text.Encoding]::UTF8.GetByteCount($quote)
    $null=Invoke-Api POST "$sourcePath/revisions/1/claims" @{statement=$quote;locator=@{start_byte=$start;end_byte=$end;quote=$quote}} "claim-$kind" ''
    $claims=Invoke-Api GET "$sourcePath/revisions/1/claims" $null '' ''
    $hash=[Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($text))).ToLowerInvariant()
    $candidate.source_claims+=@{kind=$kind;source_id=$receipt.source_id;source_revision=1;claim_id=$claims.claims[0].id;content_sha256=$hash;start_byte=$start;end_byte=$end}
    $sources+=@{kind=$kind;source_id=$receipt.source_id;claim_id=$claims.claims[0].id;sha256=$hash}
}
$result=@{scion_id=$draft.id;url="http://127.0.0.1:5173/#/scions/$($draft.id)";candidate_proposal=$candidate;sources=$sources;synthetic=$true}
if ($QueueCodex) {
    $task=Invoke-Api POST "$path/agent-tasks" @{task_kind='prepare_physical_scope';candidate_proposal=$candidate} 'codex-task' '"1"'
    $null=Invoke-Api POST "$path/agent-tasks/$($task.id)/dispatch" $null '' '"1"'
    $result.task_id=$task.id
} else {
    $proposal=Invoke-Api POST "$path/scope/proposals" $candidate 'proposal' '"1"'
    $result.proposal_id=$proposal.id
}
New-Item -ItemType Directory -Force '.local' | Out-Null
$result|ConvertTo-Json -Depth 30|Set-Content -LiteralPath (Join-Path '.local' $ReceiptName) -Encoding utf8
Write-Output ($result|Select-Object scion_id,url,task_id,proposal_id,synthetic|ConvertTo-Json)
