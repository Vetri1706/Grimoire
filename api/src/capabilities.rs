//! Adaptive preparation is an immutable agent proposal, never reviewer authority.
//! The only connectors here are implemented local API paths; no provider catalog
//! or external evidence is invented when those paths have no authorized content.
use super::*;
use serde::{Deserialize, de::DeserializeOwned};
use serde_json::Value;
use std::collections::BTreeSet;

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Capability {
    key: String,
    title: String,
    reason: String,
    evidence_needed: Vec<String>,
    connector_ids: Vec<String>,
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct PlanInput {
    synthetic: bool,
    summary: String,
    capabilities: Vec<Capability>,
    unresolved_gaps: Vec<String>,
    change_summary: String,
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Criterion {
    capability_key: String,
    claim_ids: Vec<Uuid>,
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Alternative {
    label: String,
    criteria: Vec<Criterion>,
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct ComparisonInput {
    synthetic: bool,
    plan_id: Uuid,
    alternatives: Vec<Alternative>,
    unresolved_gaps: Vec<String>,
    change_summary: String,
}
#[derive(FromRow)]
struct PlanRow {
    id: Uuid,
    scion_id: Uuid,
    scion_revision: i32,
    agent_task_id: Uuid,
    input: sqlx::types::Json<Value>,
    created_at: DateTime<Utc>,
    created_by: Uuid,
    request_sha256: String,
}
#[derive(FromRow)]
struct ComparisonRow {
    id: Uuid,
    scion_id: Uuid,
    scion_revision: i32,
    plan_id: Uuid,
    input: sqlx::types::Json<Value>,
    created_at: DateTime<Utc>,
    created_by: Uuid,
    request_sha256: String,
}
#[derive(FromRow)]
struct Claim {
    id: Uuid,
    source_id: Uuid,
    source_revision: i32,
    statement: String,
    quote: String,
    start_byte: i32,
    end_byte: i32,
    content_sha256: String,
    byte_length: i32,
    storage_backend: Option<String>,
    object_bucket: Option<String>,
    object_key: Option<String>,
    object_version_id: Option<String>,
}
const PLAN_COLUMNS: &str =
    "id,scion_id,scion_revision,agent_task_id,input,created_at,created_by,request_sha256";
const COMPARISON_COLUMNS: &str =
    "id,scion_id,scion_revision,plan_id,input,created_at,created_by,request_sha256";

pub(super) fn routes() -> Router<PgPool> {
    Router::new()
        .route("/api/scions/{id}/capabilities", get(list))
        .route(
            "/api/scions/{id}/capability-plans",
            axum::routing::post(create_plan),
        )
        .route(
            "/api/scions/{id}/evidence-comparisons",
            axum::routing::post(create_comparison),
        )
}
fn invalid(message: impl Into<String>) -> ApiError {
    ApiError(
        StatusCode::UNPROCESSABLE_ENTITY,
        "INVALID_CAPABILITY_PLAN",
        message.into(),
    )
}
fn parse<T: DeserializeOwned>(body: Result<Json<T>, JsonRejection>) -> Result<T, ApiError> {
    body.map(|Json(v)| v)
        .map_err(|_| invalid("Use only the documented typed adaptive proposal fields."))
}
fn bounded(value: &str, max: usize) -> Result<(), ApiError> {
    if value.trim().is_empty() || value.chars().count() > max || value.contains('\0') {
        Err(invalid(
            "Proposal text must be nonempty, bounded and contain no null character.",
        ))
    } else {
        Ok(())
    }
}
fn strings(values: &[String], max: usize) -> Result<(), ApiError> {
    if values.len() > max {
        return Err(invalid("Too many proposal items."));
    }
    for value in values {
        bounded(value, 2000)?;
    }
    Ok(())
}
impl PlanInput {
    fn validate(&self) -> Result<(), ApiError> {
        if !self.synthetic || !(1..=12).contains(&self.capabilities.len()) {
            return Err(invalid(
                "A synthetic proposal with one to twelve capabilities is required.",
            ));
        }
        bounded(&self.summary, 4000)?;
        bounded(&self.change_summary, 1000)?;
        strings(&self.unresolved_gaps, 40)?;
        let mut keys = BTreeSet::new();
        for capability in &self.capabilities {
            bounded(&capability.key, 80)?;
            if !capability
                .key
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_')
                || !keys.insert(&capability.key)
            {
                return Err(invalid(
                    "Capability keys must be unique lowercase identifiers.",
                ));
            }
            bounded(&capability.title, 200)?;
            bounded(&capability.reason, 2000)?;
            strings(&capability.evidence_needed, 20)?;
            if capability.evidence_needed.is_empty()
                || capability.connector_ids.len() > 2
                || capability
                    .connector_ids
                    .iter()
                    .any(|v| !["handler_intake", "scion_sources"].contains(&v.as_str()))
            {
                return Err(invalid(
                    "Declare missing evidence and only implemented connector IDs: handler_intake and scion_sources.",
                ));
            }
        }
        if serde_json::to_vec(self)?.len() > 48000 {
            return Err(invalid("Proposal exceeds the bounded task result size."));
        }
        Ok(())
    }
}
impl ComparisonInput {
    fn validate(&self) -> Result<(), ApiError> {
        if !self.synthetic || !(2..=6).contains(&self.alternatives.len()) {
            return Err(invalid(
                "Provide two to six explicitly synthetic Handler-labelled alternatives.",
            ));
        }
        bounded(&self.change_summary, 1000)?;
        strings(&self.unresolved_gaps, 40)?;
        let mut labels = BTreeSet::new();
        for alternative in &self.alternatives {
            bounded(&alternative.label, 200)?;
            if !labels.insert(alternative.label.trim().to_lowercase())
                || !(1..=12).contains(&alternative.criteria.len())
            {
                return Err(invalid(
                    "Use unique alternative labels and one to twelve capability criteria.",
                ));
            }
            let mut keys = BTreeSet::new();
            for criterion in &alternative.criteria {
                bounded(&criterion.capability_key, 80)?;
                if !keys.insert(&criterion.capability_key)
                    || criterion.claim_ids.len() > 12
                    || criterion.claim_ids.iter().collect::<BTreeSet<_>>().len()
                        != criterion.claim_ids.len()
                {
                    return Err(invalid(
                        "Criteria and exact claim references must be unique and bounded.",
                    ));
                }
            }
        }
        if serde_json::to_vec(self)?.len() > 32000 {
            return Err(invalid("Comparison exceeds its bounded draft size."));
        }
        Ok(())
    }
    fn claim_ids(&self) -> BTreeSet<Uuid> {
        self.alternatives
            .iter()
            .flat_map(|v| &v.criteria)
            .flat_map(|v| &v.claim_ids)
            .copied()
            .collect()
    }
}
pub(super) async fn task_candidate(
    tx: &mut Tx,
    scion: Uuid,
    revision: i32,
) -> Result<Value, ApiError> {
    Ok(
        sqlx::query_scalar("SELECT app.intake_capability_candidate($1,$2)")
            .bind(scion)
            .bind(revision)
            .fetch_one(&mut **tx)
            .await?,
    )
}
async fn current(tx: &mut Tx, scion: Uuid) -> Result<i32, ApiError> {
    sqlx::query_scalar("SELECT current_revision FROM grimoire.intake_scions WHERE id=$1")
        .bind(scion)
        .fetch_optional(&mut **tx)
        .await?
        .ok_or_else(ApiError::not_found)
}
fn plan_json(row: &PlanRow, revision: i32) -> Value {
    let active = row.scion_revision == revision;
    json!({"id":row.id,"scion_id":row.scion_id,"scion_revision":row.scion_revision,"agent_task_id":row.agent_task_id,"status":if active {"current"} else {"stale"},"input":if active {Some(&row.input.0)} else {None},"created_at":row.created_at,"created_by":row.created_by,"authority":"agent_proposal","verification_status":"unverified","approval_available":false})
}
async fn load_plan(tx: &mut Tx, scion: Uuid, id: Uuid) -> Result<PlanRow, ApiError> {
    sqlx::query_as(&format!(
        "SELECT {PLAN_COLUMNS} FROM grimoire.intake_capability_plans WHERE scion_id=$1 AND id=$2"
    ))
    .bind(scion)
    .bind(id)
    .fetch_optional(&mut **tx)
    .await?
    .ok_or_else(ApiError::not_found)
}
async fn verified_claim(
    tx: &mut Tx,
    scion: Uuid,
    revision: i32,
    id: Uuid,
) -> Result<Value, ApiError> {
    // SQL takes the same source share lock as source display; revocation and
    // source revisions serialize against this transaction. The current source,
    // Scion revision and organization are all checked before loading text.
    sqlx::query("SELECT app.intake_capability_assert_claim($1,$2,$3)")
        .bind(scion)
        .bind(revision)
        .bind(id)
        .execute(&mut **tx)
        .await?;
    let claim = sqlx::query_as::<_, Claim>("SELECT c.id,c.source_id,c.source_revision,c.statement,c.quote,c.start_byte,c.end_byte,r.content_sha256,r.byte_length,o.storage_backend,o.object_bucket,o.object_key,o.object_version_id FROM grimoire.intake_source_claims c JOIN grimoire.intake_source_revisions r ON (r.org_id,r.source_id,r.number)=(c.org_id,c.source_id,c.source_revision) LEFT JOIN grimoire.intake_source_objects o ON (o.org_id,o.source_id,o.source_revision)=(c.org_id,c.source_id,c.source_revision) WHERE c.id=$1").bind(id).fetch_optional(&mut **tx).await?.ok_or_else(ApiError::not_found)?;
    if claim.storage_backend.as_deref() != Some("s3") {
        return Err(storage::migration_required());
    }
    let bytes = storage::configured()?
        .read_verified(
            claim.object_bucket.as_deref().unwrap_or_default(),
            claim.object_key.as_deref().unwrap_or_default(),
            claim.object_version_id.as_deref().unwrap_or_default(),
            &claim.content_sha256,
            claim.byte_length,
        )
        .await?;
    if claim.start_byte < 0
        || claim.end_byte <= claim.start_byte
        || bytes.get(claim.start_byte as usize..claim.end_byte as usize)
            != Some(claim.quote.as_str())
    {
        return Err(ApiError(
            StatusCode::SERVICE_UNAVAILABLE,
            "SOURCE_INTEGRITY_FAILED",
            "The exact claim locator failed byte verification.".into(),
        ));
    }
    Ok(
        json!({"id":claim.id,"source_id":claim.source_id,"source_revision":claim.source_revision,"statement":claim.statement,"locator":{"start_byte":claim.start_byte,"end_byte":claim.end_byte,"quote":claim.quote},"content_sha256":claim.content_sha256,"content_hash_verified":true,"authority":"handler_entered","verification_status":"unverified"}),
    )
}
async fn comparison_json(
    tx: &mut Tx,
    row: &ComparisonRow,
    revision: i32,
) -> Result<Value, ApiError> {
    let input: ComparisonInput = serde_json::from_value(row.input.0.clone())?;
    let mut evidence = Vec::new();
    let mut blocked = None;
    let dependency: Option<(bool, bool)> = sqlx::query_as("SELECT stale,blocked FROM grimoire.intake_watch_node_states WHERE node_kind='comparison' AND node_id=$1")
        .bind(row.id).fetch_optional(&mut **tx).await?;
    if let Some((stale, denied)) = dependency {
        if denied {
            blocked = Some("SOURCE_RIGHTS_DENIED".to_string());
        } else if stale {
            blocked = Some("STALE_DEPENDENCY".to_string());
        }
    }
    if row.scion_revision != revision {
        blocked.get_or_insert_with(|| "STALE_REVISION".to_string());
    }
    // Use a savepoint for a permission failure: an expected PostgreSQL denial
    // must not abort the remaining list response or leak old quoted content.
    if blocked.is_none() {
        sqlx::query("SAVEPOINT adaptive_read")
            .execute(&mut **tx)
            .await?;
        for id in input.claim_ids() {
            match verified_claim(tx, row.scion_id, revision, id).await {
                Ok(claim) => evidence.push(claim),
                Err(error) => {
                    blocked = Some(error.1.to_string());
                    break;
                }
            }
        }
        if blocked.is_some() {
            sqlx::query("ROLLBACK TO SAVEPOINT adaptive_read")
                .execute(&mut **tx)
                .await?;
        }
        sqlx::query("RELEASE SAVEPOINT adaptive_read")
            .execute(&mut **tx)
            .await?;
    }
    let mut gaps = vec!["Claims are Handler-entered and unverified; this comparison authorizes no sourcing decision.".to_string()];
    if blocked.is_none() {
        let plan = load_plan(tx, row.scion_id, row.plan_id).await?;
        if let Some(required_gaps) = plan.input.0["unresolved_gaps"].as_array() {
            gaps.extend(
                required_gaps
                    .iter()
                    .filter_map(|value| value.as_str().map(String::from)),
            );
        }
        gaps.extend(input.unresolved_gaps.clone());
        for alternative in &input.alternatives {
            for criterion in &alternative.criteria {
                if criterion.claim_ids.is_empty() {
                    gaps.push(format!(
                        "{} / {}: no authorized evidence linked.",
                        alternative.label, criterion.capability_key
                    ));
                }
            }
        }
    } else {
        evidence.clear();
        gaps.push(
            "Comparison content is withheld because an exact input is stale or unavailable.".into(),
        );
    }
    Ok(
        json!({"id":row.id,"scion_id":row.scion_id,"scion_revision":row.scion_revision,"plan_id":row.plan_id,"status":if blocked.is_none() {"reviewable"} else {"blocked"},"input":if blocked.is_none() {Some(&row.input.0)} else {None},"evidence":evidence,"unresolved_gaps":gaps,"blocked_reason":blocked,"created_by":row.created_by,"created_at":row.created_at,"authority":"handler_draft","verification_status":"unverified","approval_available":false}),
    )
}
async fn list(State(pool): State<PgPool>, headers: HeaderMap, Path(id): Path<String>) -> ApiResult {
    let (mut tx, _) = authenticate(&pool, &headers).await?;
    let id = parse_id(&id)?;
    let revision = current(&mut tx, id).await?;
    let body = snapshot(&mut tx, id, revision).await?;
    tx.commit().await?;
    Ok(Json(body).into_response())
}

pub(super) async fn snapshot(tx: &mut Tx, id: Uuid, revision: i32) -> Result<Value, ApiError> {
    let candidate = task_candidate(tx, id, revision).await?;
    // Lock the current source set before checking derivative state. A revocation
    // committed while these locks were pending is visible to the next statement.
    let source_ids: Vec<Uuid> =
        sqlx::query_scalar("SELECT id FROM grimoire.intake_sources WHERE scion_id=$1 ORDER BY id")
            .bind(id)
            .fetch_all(&mut **tx)
            .await?;
    for source in source_ids {
        sqlx::query("SELECT app.intake_source_read_lock($1,$2)")
            .bind(id)
            .bind(source)
            .execute(&mut **tx)
            .await?;
    }
    let plans: Vec<PlanRow> = sqlx::query_as(&format!("SELECT {PLAN_COLUMNS} FROM grimoire.intake_capability_plans WHERE scion_id=$1 ORDER BY created_at DESC,id LIMIT 100")).bind(id).fetch_all(&mut **tx).await?;
    let rows: Vec<ComparisonRow> = sqlx::query_as(&format!("SELECT {COMPARISON_COLUMNS} FROM grimoire.intake_evidence_comparisons WHERE scion_id=$1 ORDER BY created_at DESC,id LIMIT 100")).bind(id).fetch_all(&mut **tx).await?;
    let mut plan_values = Vec::new();
    for plan in plans {
        let mut value = plan_json(&plan, revision);
        let state: Option<(bool,bool,Option<String>)> = sqlx::query_as("SELECT stale,blocked,reason FROM grimoire.intake_watch_node_states WHERE node_kind='capability_proposal' AND node_id=$1")
            .bind(plan.id).fetch_optional(&mut **tx).await?;
        if let Some((stale, blocked, reason)) = state
            && (stale || blocked)
        {
            value["status"] = json!(if blocked { "blocked" } else { "stale" });
            value["input"] = Value::Null;
            value["blocked_reason"] = json!(reason);
        }
        plan_values.push(value);
    }
    let mut comparisons = Vec::new();
    for row in rows {
        comparisons.push(comparison_json(tx, &row, revision).await?);
    }
    Ok(
        json!({"scion_revision":revision,"connectors":candidate["connectors"],"external_connectors_available":false,"unresolved_gaps":candidate["unresolved_gaps"],"plans":plan_values,"comparisons":comparisons,"approval_available":false}),
    )
}
fn request_hash<T: Serialize>(
    scion: Uuid,
    revision: i32,
    kind: &str,
    input: &T,
) -> Result<String, ApiError> {
    Ok(format!(
        "{:x}",
        Sha256::digest(format!(
            "{scion}\n{revision}\n{kind}\n{}",
            serde_json::to_string(input)?
        ))
    ))
}
async fn lock_request(tx: &mut Tx, actor: &Actor, kind: &str, key: &str) -> Result<(), ApiError> {
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))")
        .bind(format!(
            "adaptive:{kind}:{}:{}:{key}",
            actor.org_id, actor.principal_id
        ))
        .execute(&mut **tx)
        .await?;
    Ok(())
}
fn retry_hash(actual: &str, expected: &str) -> Result<(), ApiError> {
    if actual == expected {
        Ok(())
    } else {
        Err(ApiError(
            StatusCode::CONFLICT,
            "IDEMPOTENCY_CONFLICT",
            "The idempotency key has different adaptive input.".into(),
        ))
    }
}
fn created_response(body: Value, replayed: bool) -> Response {
    let mut response = (StatusCode::CREATED, Json(body)).into_response();
    if replayed {
        response
            .headers_mut()
            .insert("Idempotency-Replayed", HeaderValue::from_static("true"));
    }
    response
}
async fn create_plan(
    State(pool): State<PgPool>,
    headers: HeaderMap,
    Path(id): Path<String>,
    body: Result<Json<PlanInput>, JsonRejection>,
) -> ApiResult {
    let (mut tx, actor) = authenticate(&pool, &headers).await?;
    let id = parse_id(&id)?;
    let revision = current(&mut tx, id).await?;
    if !actor.is_agent || !actor.can_propose_scope || actor.can_write || actor.can_confirm_scope {
        return Err(ApiError::forbidden());
    }
    let base = precondition(&headers)?;
    if revision != base {
        return Err(ApiError::stale());
    }
    let input = parse(body)?;
    input.validate()?;
    let candidate = task_candidate(&mut tx, id, base).await?;
    if candidate["unresolved_gaps"].as_array().is_none_or(|gaps| {
        gaps.iter().any(|gap| {
            gap.as_str()
                .is_none_or(|gap| !input.unresolved_gaps.iter().any(|value| value == gap))
        })
    }) {
        return Err(invalid(
            "The proposal must retain every server-recorded evidence gap.",
        ));
    }
    let value = serde_json::to_value(&input)?;
    crate::byoa::submission(
        &mut tx,
        &actor,
        &headers,
        id,
        base,
        "prepare_capability_plan",
        &value,
    )
    .await?;
    let request_key = key(&headers)?;
    // Idempotent replay is tied to the same leased task, not merely an equal
    // proposed body submitted later under a different agent task.
    let task_id = headers
        .get("X-Grimoire-Task-Id")
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default();
    let hash = request_hash(id, base, &format!("plan:{task_id}"), &input)?;
    lock_request(&mut tx, &actor, "plan", &request_key).await?;
    let existing: Option<PlanRow> = sqlx::query_as(&format!("SELECT {PLAN_COLUMNS} FROM grimoire.intake_capability_plans WHERE created_by=$1 AND request_key=$2")).bind(actor.principal_id).bind(&request_key).fetch_optional(&mut *tx).await?;
    let replayed = existing.is_some();
    let row = if let Some(existing) = existing {
        retry_hash(&existing.request_sha256, &hash)?;
        existing
    } else {
        sqlx::query_as(&format!("INSERT INTO grimoire.intake_capability_plans(id,org_id,scion_id,scion_revision,input,created_by,request_key,request_sha256,agent_task_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,nullif(current_setting('app.agent_task_id',true),'')::uuid) RETURNING {PLAN_COLUMNS}"))
            .bind(Uuid::new_v4()).bind(actor.org_id).bind(id).bind(base).bind(sqlx::types::Json(value)).bind(actor.principal_id).bind(request_key).bind(hash).fetch_one(&mut *tx).await?
    };
    let response = plan_json(&row, revision);
    tx.commit().await?;
    Ok(created_response(response, replayed))
}
async fn create_comparison(
    State(pool): State<PgPool>,
    headers: HeaderMap,
    Path(id): Path<String>,
    body: Result<Json<ComparisonInput>, JsonRejection>,
) -> ApiResult {
    let (mut tx, actor) = authenticate(&pool, &headers).await?;
    let id = parse_id(&id)?;
    let revision = current(&mut tx, id).await?;
    if !actor.can_write || actor.is_agent {
        return Err(ApiError::forbidden());
    }
    let base = precondition(&headers)?;
    if revision != base {
        return Err(ApiError::stale());
    }
    let input = parse(body)?;
    input.validate()?;
    let plan = load_plan(&mut tx, id, input.plan_id).await?;
    if plan.scion_revision != revision {
        return Err(ApiError(
            StatusCode::CONFLICT,
            "CAPABILITY_INPUT_STALE",
            "The capability plan is bound to an older Scion revision.".into(),
        ));
    }
    let typed_plan: PlanInput = serde_json::from_value(plan.input.0.clone())?;
    let allowed: BTreeSet<_> = typed_plan
        .capabilities
        .iter()
        .map(|v| v.key.as_str())
        .collect();
    if input
        .alternatives
        .iter()
        .flat_map(|v| &v.criteria)
        .any(|v| !allowed.contains(v.capability_key.as_str()))
    {
        return Err(invalid(
            "Every comparison criterion must name an exact capability in this plan.",
        ));
    }
    for claim in input.claim_ids() {
        verified_claim(&mut tx, id, base, claim).await?;
    }
    let request_key = key(&headers)?;
    let hash = request_hash(id, base, "comparison", &input)?;
    lock_request(&mut tx, &actor, "comparison", &request_key).await?;
    let existing: Option<ComparisonRow> = sqlx::query_as(&format!("SELECT {COMPARISON_COLUMNS} FROM grimoire.intake_evidence_comparisons WHERE created_by=$1 AND request_key=$2")).bind(actor.principal_id).bind(&request_key).fetch_optional(&mut *tx).await?;
    let replayed = existing.is_some();
    let row = if let Some(existing) = existing {
        retry_hash(&existing.request_sha256, &hash)?;
        existing
    } else {
        sqlx::query_as(&format!("INSERT INTO grimoire.intake_evidence_comparisons(id,org_id,scion_id,scion_revision,plan_id,input,created_by,request_key,request_sha256) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING {COMPARISON_COLUMNS}"))
            .bind(Uuid::new_v4()).bind(actor.org_id).bind(id).bind(base).bind(input.plan_id).bind(sqlx::types::Json(serde_json::to_value(&input)?)).bind(actor.principal_id).bind(request_key).bind(hash).fetch_one(&mut *tx).await?
    };
    let response = comparison_json(&mut tx, &row, revision).await?;
    tx.commit().await?;
    Ok(created_response(response, replayed))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn plan() -> PlanInput {
        serde_json::from_value(json!({"synthetic":true,"summary":"Website accessibility preparation","capabilities":[{"key":"accessibility","title":"Accessibility","reason":"Handler requested an accessible website","evidence_needed":["Keyboard audit evidence"],"connector_ids":["handler_intake","scion_sources"]}],"unresolved_gaps":["No independently verified evidence"],"change_summary":"Agent preparation"})).unwrap()
    }
    #[test]
    fn plan_does_not_accept_invented_connectors_or_empty_evidence_needs() {
        let mut proposal = plan();
        assert!(proposal.validate().is_ok());
        proposal.capabilities[0]
            .connector_ids
            .push("invented_web_search".into());
        assert!(proposal.validate().is_err());
        proposal.capabilities[0].connector_ids.clear();
        proposal.capabilities[0].evidence_needed.clear();
        assert!(proposal.validate().is_err());
    }
    #[test]
    fn proposal_cannot_smuggle_confirmation_fields() {
        let mut proposal = serde_json::to_value(plan()).unwrap();
        proposal["approved"] = json!(true);
        assert!(serde_json::from_value::<PlanInput>(proposal).is_err());
    }
    #[test]
    fn comparison_requires_distinct_handler_labels() {
        let mut comparison: ComparisonInput = serde_json::from_value(json!({"synthetic":true,"plan_id":Uuid::new_v4(),"alternatives":[{"label":"Option A","criteria":[{"capability_key":"accessibility","claim_ids":[]}]},{"label":"Option B","criteria":[{"capability_key":"accessibility","claim_ids":[]}]}],"unresolved_gaps":[],"change_summary":"Review missing evidence"})).unwrap();
        assert!(comparison.validate().is_ok());
        comparison.alternatives[1].label = " option a ".into();
        assert!(comparison.validate().is_err());
    }
}
