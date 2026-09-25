//! Explicit synthetic physical scope proposals, independently confirmed into GG-40.
use super::*;
use serde::{Deserialize, de::DeserializeOwned};
use serde_json::Value;
use std::collections::{BTreeSet, HashMap, HashSet};

const ROLE: &str = "synthetic_engineering_reviewer";

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Configuration {
    product_code: String,
    product_name: String,
    configuration_code: String,
    specification: Value,
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Component {
    internal_part_code: String,
    manufacturer: String,
    part_number: String,
    attributes: Value,
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Occurrence {
    path: String,
    quantity: String,
    uom: String,
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Requirement {
    code: String,
    criteria: Value,
}
#[derive(Deserialize, Serialize, Clone, Copy, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
enum LinkKind {
    Configuration,
    Component,
    Occurrence,
    Requirement,
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct EvidenceRef {
    kind: LinkKind,
    source_id: Uuid,
    source_revision: i32,
    claim_id: Uuid,
    content_sha256: String,
    start_byte: i32,
    end_byte: i32,
}
#[derive(Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "snake_case")]
enum IdentityMatch {
    Exact,
    Ambiguous,
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct ProposalInput {
    synthetic: bool,
    identity_match: IdentityMatch,
    configuration: Configuration,
    component: Component,
    occurrence: Occurrence,
    requirement: Requirement,
    case_code: String,
    case_title: String,
    source_claims: Vec<EvidenceRef>,
    unresolved_gaps: Vec<String>,
    change_summary: String,
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct ConfirmInput {
    confirm_synthetic_scope: bool,
    review_note: String,
}
#[derive(FromRow)]
struct ProposalRow {
    id: Uuid,
    scion_id: Uuid,
    scion_revision: i32,
    input: sqlx::types::Json<ProposalInput>,
    created_by: Uuid,
    created_at: DateTime<Utc>,
}
#[derive(FromRow)]
struct SourceState {
    current_revision: i32,
    scion_revision: i32,
    revoked: bool,
}
#[derive(FromRow)]
struct EvidenceRow {
    content_sha256: String,
    byte_length: i32,
    object_bucket: String,
    object_key: String,
    object_version_id: String,
    synthetic: bool,
    rights_status: String,
    permitted_use: String,
    start_byte: i32,
    end_byte: i32,
    quote: String,
}

fn invalid(message: impl Into<String>) -> ApiError {
    ApiError(
        StatusCode::UNPROCESSABLE_ENTITY,
        "INVALID_SCOPE",
        message.into(),
    )
}
fn denied() -> ApiError {
    ApiError(StatusCode::FORBIDDEN, "SCOPE_CONFIRM_DENIED", "Confirmation requires a distinct, enrolled synthetic engineering reviewer; an agent cannot confirm.".into())
}
fn bounded(text: &str, max: usize, name: &str) -> Result<(), ApiError> {
    if text.trim().is_empty() || text.chars().count() > max || text.contains('\0') {
        return Err(invalid(format!(
            "{name} requires explicit text, at most {max} characters."
        )));
    }
    Ok(())
}
fn input<T: DeserializeOwned>(body: Result<Json<T>, JsonRejection>) -> Result<T, ApiError> {
    body.map(|Json(v)| v).map_err(|_| invalid("Provide exactly the documented scope fields, including all four identity and source-claim links."))
}
pub(super) fn validate_candidate(value: &Value) -> Result<(), ApiError> {
    let proposal: ProposalInput = serde_json::from_value(value.clone()).map_err(|_| {
        invalid("A task candidate must contain exactly the documented scope proposal fields.")
    })?;
    proposal.validate()
}
impl ProposalInput {
    fn validate(&self) -> Result<(), ApiError> {
        if !self.synthetic {
            return Err(invalid(
                "Only explicitly synthetic physical scope is supported.",
            ));
        }
        for (text, name) in [
            (&self.configuration.product_code, "Product code"),
            (&self.configuration.product_name, "Product name"),
            (&self.configuration.configuration_code, "Configuration code"),
            (&self.component.internal_part_code, "Internal part code"),
            (&self.component.manufacturer, "Manufacturer identity"),
            (&self.component.part_number, "Orderable part number"),
            (&self.occurrence.path, "Exact occurrence path"),
            (&self.requirement.code, "Requirement code"),
            (&self.case_code, "Case code"),
            (&self.case_title, "Case title"),
        ] {
            bounded(text, 200, name)?;
        }
        bounded(&self.occurrence.uom, 32, "Unit of measure")?;
        bounded(&self.change_summary, 1000, "Change summary")?;
        let quantity = &self.occurrence.quantity;
        if quantity.is_empty()
            || quantity.len() > 25
            || quantity.bytes().any(|b| !b.is_ascii_digit() && b != b'.')
            || quantity.matches('.').count() > 1
            || quantity.split('.').next().unwrap_or_default().len() > 16
            || quantity.split('.').nth(1).is_some_and(|v| v.len() > 8)
            || quantity
                .parse::<f64>()
                .ok()
                .is_none_or(|v| !v.is_finite() || v <= 0.0)
        {
            return Err(invalid(
                "Quantity must be an explicit positive decimal, at most 16 integer and 8 fractional digits.",
            ));
        }
        for (value, name) in [
            (
                &self.configuration.specification,
                "Configuration specification",
            ),
            (&self.component.attributes, "Component attributes"),
            (&self.requirement.criteria, "Requirement criteria"),
        ] {
            if value.as_object().is_none_or(|o| o.is_empty()) || value.to_string().len() > 8000 {
                return Err(invalid(format!(
                    "{name} must be a nonempty explicit JSON object, at most 8000 bytes."
                )));
            }
        }
        if self.source_claims.len() != 4
            || self
                .source_claims
                .iter()
                .map(|r| r.kind)
                .collect::<HashSet<_>>()
                .len()
                != 4
        {
            return Err(invalid(
                "Exactly one configuration, component, occurrence and requirement evidence link is required.",
            ));
        }
        for r in &self.source_claims {
            if r.source_revision <= 0
                || r.start_byte < 0
                || r.end_byte <= r.start_byte
                || r.end_byte > 32000
                || r.content_sha256.len() != 64
                || r.content_sha256
                    .bytes()
                    .any(|b| !b.is_ascii_digit() && !(b'a'..=b'f').contains(&b))
            {
                return Err(invalid(
                    "Every link must pin a source revision, SHA-256 and exact nonempty UTF-8 claim interval.",
                ));
            }
        }
        if self.unresolved_gaps.len() > 50 {
            return Err(invalid("At most 50 unresolved gaps are supported."));
        }
        for gap in &self.unresolved_gaps {
            bounded(gap, 1000, "Unresolved gap")?;
        }
        Ok(())
    }
}

pub(super) fn routes() -> Router<PgPool> {
    Router::new()
        .route("/api/scions/{id}/scope", get(list))
        .route(
            "/api/scions/{id}/scope/proposals",
            axum::routing::post(create),
        )
        .route("/api/scions/{id}/scope/proposals/{proposal}", get(detail))
        .route(
            "/api/scions/{id}/scope/proposals/{proposal}/confirm",
            axum::routing::post(confirm),
        )
}

async fn lock_scion(tx: &mut Tx, id: Uuid) -> Result<i32, ApiError> {
    sqlx::query_scalar::<_, Option<i32>>("SELECT app.intake_scope_lock_scion($1)")
        .bind(id)
        .fetch_one(&mut **tx)
        .await?
        .ok_or_else(ApiError::not_found)
}
async fn load(tx: &mut Tx, id: Uuid, proposal: Uuid) -> Result<ProposalRow, ApiError> {
    sqlx::query_as("SELECT id,scion_id,scion_revision,input,created_by,created_at FROM grimoire.intake_scope_proposals WHERE scion_id=$1 AND id=$2")
        .bind(id).bind(proposal).fetch_optional(&mut **tx).await?.ok_or_else(ApiError::not_found)
}

// The caller locks Scion first on mutation. Source shared locks in UUID order
// serialize reads against revisions/revocations until this transaction commits.
async fn verify_evidence(
    tx: &mut Tx,
    scion: Uuid,
    base: i32,
    proposal: &ProposalInput,
) -> Result<(), ApiError> {
    verify_refs(tx, scion, base, &proposal.source_claims).await
}

async fn verify_refs(
    tx: &mut Tx,
    scion: Uuid,
    base: i32,
    refs: &[EvidenceRef],
) -> Result<(), ApiError> {
    verify_refs_with_current(tx, scion, base, refs, true).await
}
async fn verify_refs_with_current(
    tx: &mut Tx,
    scion: Uuid,
    base: i32,
    refs: &[EvidenceRef],
    require_current: bool,
) -> Result<(), ApiError> {
    let source_ids: BTreeSet<Uuid> = refs.iter().map(|r| r.source_id).collect();
    let mut states = HashMap::new();
    for source in source_ids {
        sqlx::query_scalar::<_, Option<i32>>("SELECT app.intake_source_read_lock($1,$2)")
            .bind(scion)
            .bind(source)
            .fetch_one(&mut **tx)
            .await?
            .ok_or_else(ApiError::not_found)?;
        let state = sqlx::query_as::<_, SourceState>("SELECT s.current_revision,s.scion_revision,EXISTS(SELECT 1 FROM grimoire.intake_source_revocations v WHERE (v.org_id,v.source_id)=(s.org_id,s.id)) AS revoked FROM grimoire.intake_sources s WHERE s.id=$1 AND s.scion_id=$2")
            .bind(source).bind(scion).fetch_optional(&mut **tx).await?.ok_or_else(ApiError::not_found)?;
        if state.revoked {
            return Err(ApiError(
                StatusCode::FORBIDDEN,
                "SOURCE_RIGHTS_DENIED",
                "A linked source has been revoked. Scope evidence cannot be read or confirmed."
                    .into(),
            ));
        }
        if state.scion_revision != base {
            return Err(ApiError(
                StatusCode::CONFLICT,
                "SCOPE_SOURCE_STALE",
                "A linked source pins another Scion revision.".into(),
            ));
        }
        states.insert(source, state);
    }
    let mut verified_bytes: HashMap<(Uuid, i32), String> = HashMap::new();
    for link in refs {
        if require_current && states[&link.source_id].current_revision != link.source_revision {
            return Err(ApiError(
                StatusCode::CONFLICT,
                "SOURCE_REVISION_STALE",
                "A linked source has a newer revision; prepare a new scope proposal.".into(),
            ));
        }
        let row = sqlx::query_as::<_, EvidenceRow>("SELECT r.content_sha256,r.byte_length,o.object_bucket,o.object_key,o.object_version_id,r.synthetic,r.rights_status,r.permitted_use,c.start_byte,c.end_byte,c.quote FROM grimoire.intake_source_revisions r JOIN grimoire.intake_source_claims c ON (c.org_id,c.source_id,c.source_revision)=(r.org_id,r.source_id,r.number) JOIN grimoire.intake_source_objects o ON (o.org_id,o.source_id,o.source_revision)=(r.org_id,r.source_id,r.number) WHERE r.source_id=$1 AND r.number=$2 AND c.id=$3")
            .bind(link.source_id).bind(link.source_revision).bind(link.claim_id).fetch_optional(&mut **tx).await?
            .ok_or_else(|| invalid("A scope claim does not belong to the exact linked source revision, or its object reference is missing."))?;
        if !row.synthetic
            || row.rights_status != "granted"
            || row.permitted_use != "scion_review"
            || row.content_sha256 != link.content_sha256
            || row.start_byte != link.start_byte
            || row.end_byte != link.end_byte
        {
            return Err(invalid(
                "The source hash, synthetic status or exact claim interval does not match.",
            ));
        }
        let cache_key = (link.source_id, link.source_revision);
        if let std::collections::hash_map::Entry::Vacant(entry) = verified_bytes.entry(cache_key) {
            entry.insert(
                storage::configured()?
                    .read_verified(
                        &row.object_bucket,
                        &row.object_key,
                        &row.object_version_id,
                        &row.content_sha256,
                        row.byte_length,
                    )
                    .await?,
            );
        }
        if verified_bytes[&cache_key].get(link.start_byte as usize..link.end_byte as usize)
            != Some(row.quote.as_str())
        {
            return Err(invalid(
                "The claim quotation does not match the verified source object's exact UTF-8 byte interval.",
            ));
        }
    }
    Ok(())
}

pub(super) async fn verify_reference(
    tx: &mut Tx,
    scion: Uuid,
    base: i32,
    reference: &Value,
) -> Result<(), ApiError> {
    let mut value = reference.clone();
    value["kind"] = json!("configuration");
    let link: EvidenceRef = serde_json::from_value(value)
        .map_err(|_| invalid("An exact source claim reference is required."))?;
    verify_refs(tx, scion, base, &[link]).await
}
pub(super) async fn verify_historical_reference(
    tx: &mut Tx,
    scion: Uuid,
    base: i32,
    reference: &Value,
) -> Result<(), ApiError> {
    let mut value = reference.clone();
    value["kind"] = json!("configuration");
    let link: EvidenceRef = serde_json::from_value(value)
        .map_err(|_| invalid("An exact source claim reference is required."))?;
    verify_refs_with_current(tx, scion, base, &[link], false).await
}

pub(super) async fn confirmed(
    tx: &mut Tx,
    scion: Uuid,
    base: i32,
    proposal: Uuid,
) -> Result<Value, ApiError> {
    if lock_scion(tx, scion).await? != base {
        return Err(ApiError::stale());
    }
    let row = load(tx, scion, proposal).await?;
    if row.scion_revision != base {
        return Err(ApiError::stale());
    }
    verify_evidence(tx, scion, base, &row.input).await?;
    sqlx::query_scalar("SELECT to_jsonb(c)-'org_id' FROM grimoire.intake_scope_confirmations c WHERE scion_id=$1 AND proposal_id=$2")
        .bind(scion).bind(proposal).fetch_optional(&mut **tx).await?.ok_or_else(|| ApiError(StatusCode::CONFLICT,"SCOPE_NOT_CONFIRMED","An exact current confirmed synthetic scope is required.".into()))
}

async fn view(tx: &mut Tx, proposal: ProposalRow) -> Result<Value, ApiError> {
    let mut blockers: Vec<String> = Vec::new();
    if visible_revision(tx, proposal.scion_id, false).await? != proposal.scion_revision {
        blockers.push("The Scion has a newer revision; prepare a new scope proposal.".into());
    }
    if proposal.input.identity_match != IdentityMatch::Exact {
        blockers.push("The physical identity match is ambiguous.".into());
    }
    if !proposal.input.unresolved_gaps.is_empty() {
        blockers.push("Unresolved scope gaps require a new complete proposal.".into());
    }
    let evidence_error = verify_evidence(
        tx,
        proposal.scion_id,
        proposal.scion_revision,
        &proposal.input,
    )
    .await
    .err();
    let redacted = evidence_error.is_some();
    if let Some(error) = evidence_error {
        blockers.push(format!("{}: {}", error.1, error.2));
    }
    let mut confirmation = sqlx::query_scalar::<_, Value>("SELECT to_jsonb(c)-'org_id' FROM grimoire.intake_scope_confirmations c WHERE proposal_id=$1")
        .bind(proposal.id).fetch_optional(&mut **tx).await?;
    if confirmation.is_none() {
        let another_confirmed: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM grimoire.intake_scope_confirmations WHERE scion_id=$1 AND proposal_id<>$2)")
            .bind(proposal.scion_id).bind(proposal.id).fetch_one(&mut **tx).await?;
        if another_confirmed {
            blockers.push(
                "Another proposal already defines this Scion's confirmed synthetic scope.".into(),
            );
        }
    }
    if let Some(value) = &mut confirmation {
        value["governed_chain"] =
            sqlx::query_scalar::<_, Value>("SELECT app.intake_scope_chain($1)")
                .bind(proposal.id)
                .fetch_one(&mut **tx)
                .await?;
    }
    if redacted && let Some(value) = &mut confirmation {
        value["review_note"] = Value::Null;
    }
    let status = if !blockers.is_empty() {
        "blocked"
    } else if confirmation.is_some() {
        "confirmed"
    } else {
        "proposed"
    };
    let reviewer_conflict: bool =
        sqlx::query_scalar("SELECT app.intake_scope_has_preparer_conflict($1,$2)")
            .bind(proposal.scion_id)
            .bind(proposal.id)
            .fetch_one(&mut **tx)
            .await?;
    let can_confirm: bool = sqlx::query_scalar("SELECT app.intake_scope_can_confirm()")
        .fetch_one(&mut **tx)
        .await?;
    Ok(
        json!({"id":proposal.id,"scion_id":proposal.scion_id,"scion_revision":proposal.scion_revision,
        "created_by":proposal.created_by,"created_at":proposal.created_at,
        "input":if redacted {Value::Null} else {serde_json::to_value(&proposal.input)?},
        "blockers":blockers,"status":status,"confirmation":confirmation,"required_role":ROLE,
        "synthetic_only":true,"content_redacted":redacted,"reviewer_conflict":reviewer_conflict,
        "can_confirm_this_proposal":can_confirm && !reviewer_conflict && blockers.is_empty() && confirmation.is_none()}),
    )
}
async fn list(State(pool): State<PgPool>, headers: HeaderMap, Path(id): Path<String>) -> ApiResult {
    let (mut tx, actor) = authenticate(&pool, &headers).await?;
    let id = parse_id(&id)?;
    visible_revision(&mut tx, id, false).await?;
    let rows = sqlx::query_as::<_, ProposalRow>("SELECT id,scion_id,scion_revision,input,created_by,created_at FROM grimoire.intake_scope_proposals WHERE scion_id=$1 ORDER BY created_at DESC,id")
        .bind(id).fetch_all(&mut *tx).await?;
    let mut proposals = Vec::new();
    for row in rows {
        proposals.push(view(&mut tx, row).await?);
    }
    tx.commit().await?;
    Ok(Json(json!({"proposals":proposals,"can_confirm":actor.can_confirm_scope,"can_propose":actor.can_propose_scope,"required_role":ROLE,"synthetic_only":true})).into_response())
}
async fn detail(
    State(pool): State<PgPool>,
    headers: HeaderMap,
    Path((id, proposal)): Path<(String, String)>,
) -> ApiResult {
    let (mut tx, _) = authenticate(&pool, &headers).await?;
    let id = parse_id(&id)?;
    visible_revision(&mut tx, id, false).await?;
    let row = load(&mut tx, id, parse_id(&proposal)?).await?;
    let body = view(&mut tx, row).await?;
    tx.commit().await?;
    Ok(Json(body).into_response())
}
fn hash<T: Serialize>(path: &str, base: i32, value: &T) -> Result<String, ApiError> {
    Ok(format!(
        "{:x}",
        Sha256::digest(
            format!("POST\n{path}\n{base}\n{}", serde_json::to_string(value)?).as_bytes()
        )
    ))
}
pub(super) async fn replay_scope(
    tx: &mut Tx,
    actor: &Actor,
    key: &str,
    hash: &str,
) -> Result<Option<Response>, ApiError> {
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))")
        .bind(format!(
            "scope:{}:{}:{key}",
            actor.org_id, actor.principal_id
        ))
        .execute(&mut **tx)
        .await?;
    let stored = sqlx::query_as::<_, StoredResponse>("SELECT request_sha256,201::smallint AS response_status,response_body,response_etag FROM grimoire.intake_scope_receipts WHERE org_id=$1 AND principal_id=$2 AND key=$3")
        .bind(actor.org_id).bind(actor.principal_id).bind(key).fetch_optional(&mut **tx).await?;
    match stored {
        None => Ok(None),
        Some(r) if r.request_sha256 != hash => Err(ApiError(
            StatusCode::CONFLICT,
            "IDEMPOTENCY_CONFLICT",
            "This key already identifies another scope request.".into(),
        )),
        Some(r) => Ok(Some(resource_response(
            StatusCode::CREATED,
            r.response_body,
            r.response_etag,
            true,
        )?)),
    }
}
pub(super) async fn store(
    tx: &mut Tx,
    actor: &Actor,
    key: &str,
    hash: &str,
    body: &str,
    revision: i32,
) -> Result<(), ApiError> {
    sqlx::query("INSERT INTO grimoire.intake_scope_receipts(org_id,principal_id,key,request_sha256,response_body,response_etag) VALUES($1,$2,$3,$4,$5,$6)")
        .bind(actor.org_id).bind(actor.principal_id).bind(key).bind(hash).bind(body).bind(etag(revision)).execute(&mut **tx).await?;
    Ok(())
}
async fn create(
    State(pool): State<PgPool>,
    headers: HeaderMap,
    Path(id): Path<String>,
    body: Result<Json<ProposalInput>, JsonRejection>,
) -> ApiResult {
    let (mut tx, actor) = authenticate(&pool, &headers).await?;
    let id = parse_id(&id)?;
    visible_revision(&mut tx, id, false).await?;
    if !actor.can_propose_scope {
        return Err(ApiError(
            StatusCode::FORBIDDEN,
            "SCOPE_PROPOSAL_DENIED",
            "Only a Handler or explicitly enrolled proposal agent can submit scope proposals."
                .into(),
        ));
    }
    let proposal = input(body)?;
    proposal.validate()?;
    let base = precondition(&headers)?;
    let key = key(&headers)?;
    let hash = hash(
        &format!("/api/scions/{id}/scope/proposals"),
        base,
        &proposal,
    )?;
    if lock_scion(&mut tx, id).await? != base {
        return Err(ApiError::stale());
    }
    let category: String = sqlx::query_scalar(
        "SELECT product_category FROM grimoire.intake_revisions WHERE scion_id=$1 AND number=$2",
    )
    .bind(id)
    .bind(base)
    .fetch_one(&mut *tx)
    .await?;
    if category != "physical" {
        return Err(invalid(
            "Only physical product drafts can propose an exact governed scope.",
        ));
    }
    verify_evidence(&mut tx, id, base, &proposal).await?;
    crate::byoa::submission(
        &mut tx,
        &actor,
        &headers,
        id,
        base,
        "prepare_physical_scope",
        &serde_json::to_value(&proposal)?,
    )
    .await?;
    if let Some(response) = replay_scope(&mut tx, &actor, &key, &hash).await? {
        tx.commit().await?;
        return Ok(response);
    }
    let proposal_id = Uuid::new_v4();
    sqlx::query("INSERT INTO grimoire.intake_scope_proposals(id,org_id,scion_id,scion_revision,input,created_by) VALUES($1,$2,$3,$4,$5,$6)")
        .bind(proposal_id).bind(actor.org_id).bind(id).bind(base).bind(sqlx::types::Json(&proposal)).bind(actor.principal_id).execute(&mut *tx).await?;
    let row = load(&mut tx, id, proposal_id).await?;
    let response = serde_json::to_string(&view(&mut tx, row).await?)?;
    store(&mut tx, &actor, &key, &hash, &response, base).await?;
    tx.commit().await?;
    resource_response(StatusCode::CREATED, response, etag(base), false)
}
async fn confirm(
    State(pool): State<PgPool>,
    headers: HeaderMap,
    Path((id, proposal_id)): Path<(String, String)>,
    body: Result<Json<ConfirmInput>, JsonRejection>,
) -> ApiResult {
    let (mut tx, actor) = authenticate(&pool, &headers).await?;
    let (id, proposal_id) = (parse_id(&id)?, parse_id(&proposal_id)?);
    visible_revision(&mut tx, id, false).await?;
    let proposal = load(&mut tx, id, proposal_id).await?;
    if !actor.can_confirm_scope || actor.is_agent || actor.principal_id == proposal.created_by {
        return Err(denied());
    }
    let preparer_conflict: bool =
        sqlx::query_scalar("SELECT app.intake_scope_has_preparer_conflict($1,$2)")
            .bind(id)
            .bind(proposal_id)
            .fetch_one(&mut *tx)
            .await?;
    if preparer_conflict {
        return Err(denied());
    }
    let request = input(body)?;
    if !request.confirm_synthetic_scope {
        return Err(invalid(
            "Explicit synthetic scope confirmation is required.",
        ));
    }
    bounded(&request.review_note, 2000, "Review rationale")?;
    let base = precondition(&headers)?;
    let key = key(&headers)?;
    let hash = hash(
        &format!("/api/scions/{id}/scope/proposals/{proposal_id}/confirm"),
        base,
        &request,
    )?;
    if lock_scion(&mut tx, id).await? != base || proposal.scion_revision != base {
        return Err(ApiError::stale());
    }
    verify_evidence(&mut tx, id, base, &proposal.input).await?;
    if let Some(response) = replay_scope(&mut tx, &actor, &key, &hash).await? {
        tx.commit().await?;
        return Ok(response);
    }
    if proposal.input.identity_match != IdentityMatch::Exact
        || !proposal.input.unresolved_gaps.is_empty()
    {
        return Err(ApiError(
            StatusCode::CONFLICT,
            "SCOPE_BLOCKED",
            "Resolve ambiguous identity and all gaps in a new proposal before confirmation.".into(),
        ));
    }
    let _: Value = sqlx::query_scalar("SELECT app.intake_scope_confirm($1,$2,$3,$4)")
        .bind(id)
        .bind(proposal_id)
        .bind(base)
        .bind(&request.review_note)
        .fetch_one(&mut *tx)
        .await?;
    let response = serde_json::to_string(&view(&mut tx, proposal).await?)?;
    store(&mut tx, &actor, &key, &hash, &response, base).await?;
    tx.commit().await?;
    resource_response(StatusCode::CREATED, response, etag(base), false)
}
