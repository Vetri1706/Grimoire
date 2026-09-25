param([switch]$QueueCodex,[switch]$WrongPart)
$ErrorActionPreference='Stop'
$projectRoot=Split-Path $PSScriptRoot -Parent
Set-Location -LiteralPath $projectRoot
$config=@{}
foreach($line in Get-Content -LiteralPath '.env'){if($line -match '^([A-Z_]+)=(.*)$'){$config[$Matches[1]]=$Matches[2]}}
$api='http://127.0.0.1:8080'
$run=[Guid]::NewGuid().ToString('N').Substring(0,12)
function Invoke-OfferApi([string]$Method,[string]$Path,$Body,[string]$Key,[string]$Match,[switch]$Reviewer){
 $token=if($Reviewer){$config.GRIMOIRE_TOKEN_REVIEWER_A}else{$config.GRIMOIRE_TOKEN_A}
 $headers=@{Authorization="Bearer $token"}
 if($Key){$headers['Idempotency-Key']="synthetic-offers-$run-$Key"}
 if($Match){$headers['If-Match']=$Match}
 $requestArgs=@{Method=$Method;Uri="$api$Path";Headers=$headers;TimeoutSec=30}
 if($null -ne $Body){$requestArgs.ContentType='application/json; charset=utf-8';$requestArgs.Body=[Text.Encoding]::UTF8.GetBytes(($Body|ConvertTo-Json -Depth 40 -Compress))}
 Invoke-RestMethod @requestArgs
}
# This creates a NEW synthetic case. Previous accepted demonstrations stay intact.
& (Join-Path $PSScriptRoot 'seed-synthetic-scope.ps1') -ReceiptName 'layer4-scope.json' | Out-Null
if($LASTEXITCODE -and $LASTEXITCODE -ne 0){throw 'Synthetic scope setup failed'}
$scope=Get-Content -LiteralPath '.local/layer4-scope.json' -Raw|ConvertFrom-Json
$path="/api/scions/$($scope.scion_id)"
$null=Invoke-OfferApi POST "$path/scope/proposals/$($scope.proposal_id)/confirm" @{confirm_synthetic_scope=$true;review_note='Enrolled synthetic engineering test role confirms this fictional identity chain. No real reviewer qualification or sourcing approval is claimed.'} 'confirm-scope' '"1"' -Reviewer
$offers=@();$sourceIds=@()
foreach($side in @('A','B')){
 $price=if($side -eq 'A'){'12.50'}else{'11.75'}
 $part=if($WrongPart -and $side -eq 'B'){'SYN-WRONG-PART'}else{'SYN-PART-001'}
 $offer=@{synthetic=$true;scion_revision=1;scope_proposal_id=$scope.proposal_id
  supplier=@{legal_name="Synthetic Supplier $side";jurisdiction='SYNTHETIC-US-DE';registration_ref="SYN-$side-$run";site_code="SYN-SITE-$side";country_code='US';account_ref="SYN-ACCOUNT-$side-$run"}
  offer_ref="SYN-QUOTE-$side-$run";identity_match='exact';offered_manufacturer='Synthetic manufacturer';offered_part_number=$part
  quantity='2';uom='EA';unit_price=$price;currency='USD';destination='Synthetic test lab';incoterm='EXW';payment_terms='Synthetic net 30'
  quoted_at='2026-09-26T00:00:00Z';valid_from='2026-09-26T00:00:00Z';valid_until='2026-10-26T00:00:00Z';lead_time_days=$(if($side -eq 'A'){7}else{10})
  change_summary='Handler enters a fictional quote for local comparison testing. No supplier was contacted.'}
 $quote=$offer|ConvertTo-Json -Depth 20 -Compress
 $prefix="SYNTHETIC QUOTE — no real supplier offer.`n";$text=$prefix+$quote+"`n"
 $src=Invoke-OfferApi POST "$path/sources" @{title="SYNTHETIC — Supplier $side quote";origin='Authored local synthetic fixture';owner='Synthetic local test owner';synthetic=$true;source_text=$text;rights_status='granted';permission_basis='Synthetic test author permits local review';permitted_use='scion_review';change_summary='Initial fictional commercial terms'} "source-$side" '"1"'
 $sourcePath="$path/sources/$($src.source_id)"
 $start=[Text.Encoding]::UTF8.GetByteCount($prefix);$end=$start+[Text.Encoding]::UTF8.GetByteCount($quote)
 $null=Invoke-OfferApi POST "$sourcePath/revisions/1/claims" @{statement=$quote;locator=@{start_byte=$start;end_byte=$end;quote=$quote}} "claim-$side" ''
 $claims=Invoke-OfferApi GET "$sourcePath/revisions/1/claims" $null '' ''
 $hash=[Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($text))).ToLowerInvariant()
 $offer.source=@{source_id=$src.source_id;source_revision=1;claim_id=$claims.claims[0].id;content_sha256=$hash;start_byte=$start;end_byte=$end}
 $offers+=Invoke-OfferApi POST "$path/offers" $offer "offer-$side" '"1"'
 $sourceIds+=$src.source_id
}
$candidate=@{synthetic=$true;scope_proposal_id=$scope.proposal_id;offer_revision_ids=@($offers|ForEach-Object{$_.revision.id})
 basis=@{quantity='2';uom='EA';currency='USD';destination='Synthetic test lab';incoterm='EXW';payment_terms='Synthetic net 30';as_of='2026-09-26T00:00:00Z';valid_from='2026-09-26T00:00:00Z';valid_until='2026-10-01T00:00:00Z'}
 change_summary='Prepare the exact synthetic alternatives for independent normalization review. No commercial approval.'}
$result=@{scion_id=$scope.scion_id;scope_proposal_id=$scope.proposal_id;synthetic=$true;url="http://127.0.0.1:5173/#/scions/$($scope.scion_id)";offers=$offers;source_ids=$sourceIds;candidate_proposal=$candidate}
if($QueueCodex){
 $task=Invoke-OfferApi POST "$path/agent-tasks" @{task_kind='prepare_offer_normalization';candidate_proposal=$candidate;timeout_seconds=120} 'codex-normalization' '"1"'
 $null=Invoke-OfferApi POST "$path/agent-tasks/$($task.id)/dispatch" $null '' '"1"'
 $result.task_id=$task.id
}else{
 $comparison=Invoke-OfferApi POST "$path/comparisons/proposals" $candidate 'comparison' '"1"'
 $result.comparison_id=$comparison.id
}
$receiptName=if($WrongPart){'layer4-exclusion-demo.json'}else{'layer4-demo.json'}
$result|ConvertTo-Json -Depth 40|Set-Content -LiteralPath (Join-Path '.local' $receiptName) -Encoding utf8
$result|Select-Object scion_id,url,task_id,comparison_id,synthetic|ConvertTo-Json
