use crate::{Actor, ApiResult, Tx, authenticate, error::ApiError, key, parse_id, precondition};
use axum::{
    Json, Router,
    extract::{Path, State, rejection::JsonRejection},
    http::{HeaderMap, StatusCode},
    response::IntoResponse,
    routing::{get, post},
};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sqlx::{FromRow, PgPool};
use uuid::Uuid;

pub fn routes() -> Router<PgPool> {
    Router::new()
        .route("/api/scions/{id}/agent-tasks", get(list).post(create))
        .route(
            "/api/scions/{id}/agent-tasks/{task}/dispatch",
            post(dispatch),
        )
        .route("/api/scions/{id}/agent-tasks/{task}/cancel", post(cancel))
        .route("/api/scions/{id}/agent-tasks/{task}/events", get(events))
        .route("/api/agent/tasks/next", get(next))
        .route("/api/agent/tasks/{id}/claim", post(claim))
        .route("/api/agent/tasks/{id}/control", get(control))
        .route("/api/agent/tasks/{id}/cancelled", post(cancelled))
        .route("/api/agent/tasks/{id}/result", post(result))
        .route("/api/agent/tasks/{id}/fail", post(fail))
}
#[derive(FromRow, Serialize)]
pub(super) struct Task {
    pub(super) id: Uuid,
    agent_id: Option<Uuid>,
    agent_revision: Option<i32>,
    scion_id: Uuid,
    scion_revision: i32,
    task_kind: String,
    adapter: String,
    status: String,
    attempt: i32,
    created_at: DateTime<Utc>,
    claimed_at: Option<DateTime<Utc>>,
    completed_at: Option<DateTime<Utc>>,
    proposal_id: Option<Uuid>,
    failure_code: Option<String>,
    timeout_seconds: i32,
    dispatched_at: Option<DateTime<Utc>>,
    cancelled_at: Option<DateTime<Utc>>,
    provider_run_id: Option<String>,
    output_sha256: Option<String>,
    #[serde(skip_serializing)]
    input: sqlx::types::Json<Value>,
    #[serde(skip_serializing)]
    claimed_by: Option<Uuid>,
    #[serde(skip_serializing)]
    lease_token: Option<Uuid>,
    lease_until: Option<DateTime<Utc>>,
    execution_deadline: Option<DateTime<Utc>>,
    #[serde(skip_serializing)]
    request_sha256: String,
}
const COLUMNS: &str = "id,(SELECT agent_id FROM grimoire.intake_task_agent_bindings WHERE task_id=intake_agent_tasks.id) AS agent_id,(SELECT agent_revision FROM grimoire.intake_task_agent_bindings WHERE task_id=intake_agent_tasks.id) AS agent_revision,scion_id,scion_revision,task_kind,adapter,status,attempt,created_at,claimed_at,completed_at,proposal_id,failure_code,input,claimed_by,lease_token,lease_until,request_sha256,timeout_seconds,dispatched_at,cancelled_at,provider_run_id,output_sha256,(claimed_at+make_interval(secs=>timeout_seconds)) AS execution_deadline";
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Create {
    pub(super) task_kind: String,
    pub(super) candidate_proposal: Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(super) agent_id: Option<Uuid>,
    #[serde(
        default = "default_timeout",
        skip_serializing_if = "is_default_timeout"
    )]
    pub(super) timeout_seconds: i32,
}
fn default_timeout() -> i32 {
    240
}
fn is_default_timeout(value: &i32) -> bool {
    *value == default_timeout()
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ResultInput {
    proposal_id: Uuid,
    provider_run_id: Option<String>,
    output_sha256: String,
    preparation_note: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct FailInput {
    failure_code: String,
}
fn json_input<T>(input: Result<Json<T>, JsonRejection>) -> Result<T, ApiError> {
    input
        .map(|Json(v)| v)
        .map_err(|_| ApiError::invalid("A valid typed agent-task request is required."))
}
fn conflict() -> ApiError {
    ApiError(
        StatusCode::CONFLICT,
        "AGENT_TASK_CONFLICT",
        "The task is already claimed or the lease is no longer current.".into(),
    )
}
fn agent(actor: &Actor) -> Result<(), ApiError> {
    if !actor.is_agent || !actor.can_propose_scope || actor.can_write || actor.can_confirm_scope {
        Err(ApiError::forbidden())
    } else {
        Ok(())
    }
}
async fn visible(tx: &mut Tx, id: Uuid) -> Result<i32, ApiError> {
    sqlx::query_scalar("SELECT current_revision FROM grimoire.intake_scions WHERE id=$1")
        .bind(id)
        .fetch_optional(&mut **tx)
        .await?
        .ok_or_else(ApiError::not_found)
}
// The database also enforces this predicate in task RLS, task transitions and
// immutable agent assignment. Workspace preparation does not confer physical
// scope, supplier-offer or approval authority.
pub(super) async fn authorize_preparation(
    tx: &mut Tx,
    scion: Uuid,
    revision: i32,
    kind: &str,
) -> Result<(), ApiError> {
    let allowed: bool = sqlx::query_scalar("SELECT app.intake_can_control_preparation($1,$2,$3)")
        .bind(scion)
        .bind(revision)
        .bind(kind)
        .fetch_one(&mut **tx)
        .await?;
    if allowed {
        Ok(())
    } else {
        Err(ApiError::forbidden())
    }
}
async fn load(tx: &mut Tx, id: Uuid, lock: bool) -> Result<Task, ApiError> {
    sqlx::query_as::<_, Task>(&format!(
        "SELECT {COLUMNS} FROM grimoire.intake_agent_tasks WHERE id=$1{}",
        if lock { " FOR UPDATE" } else { "" }
    ))
    .bind(id)
    .fetch_optional(&mut **tx)
    .await?
    .ok_or_else(ApiError::not_found)
}
async fn eligible(tx: &mut Tx, task: &Task) -> Result<(), ApiError> {
    let thread_blocked:bool=sqlx::query_scalar("SELECT COALESCE((SELECT app.intake_conversation_blocked(thread_task_id) FROM grimoire.intake_task_followups WHERE agent_task_id=$1),false)").bind(task.id).fetch_one(&mut **tx).await?;
    if thread_blocked {
        return Err(ApiError(
            StatusCode::FORBIDDEN,
            "SOURCE_RIGHTS_DENIED",
            "A source used by this conversation was withdrawn; stop this follow-up.".into(),
        ));
    }

    sqlx::query("SELECT app.intake_assert_managed_task($1)")
        .bind(task.id)
        .execute(&mut **tx)
        .await?;
    sqlx::query("SELECT app.intake_task_assert_input($1,$2,$3,$4)")
        .bind(task.scion_id)
        .bind(task.scion_revision)
        .bind(&task.task_kind)
        .bind(sqlx::types::Json(&task.input.0["candidate_proposal"]))
        .execute(&mut **tx)
        .await?;
    let dependency: Option<(bool, bool)> = sqlx::query_as("SELECT stale,blocked FROM grimoire.intake_watch_node_states WHERE node_kind='agent_task' AND node_id=$1")
        .bind(task.id).fetch_optional(&mut **tx).await?;
    if let Some((stale, blocked)) = dependency {
        if blocked {
            return Err(ApiError(StatusCode::FORBIDDEN, "SOURCE_RIGHTS_DENIED", "Dependent source permission was revoked. Stop preparation and request human review.".into()));
        }
        if stale {
            return Err(ApiError(
                StatusCode::CONFLICT,
                "CAPABILITY_INPUT_STALE",
                "A watched task input changed. Prepare new work from current authorized inputs."
                    .into(),
            ));
        }
    }
    Ok(())
}
fn lease_identity(headers: &HeaderMap, task: &Task, actor: &Actor) -> Result<(), ApiError> {
    let supplied = headers
        .get("X-Grimoire-Task-Lease")
        .and_then(|h| h.to_str().ok())
        .and_then(|s| Uuid::parse_str(s).ok());
    if task.claimed_by != Some(actor.principal_id)
        || supplied.is_none()
        || task.lease_token != supplied
    {
        return Err(conflict());
    }
    Ok(())
}
fn lease(headers: &HeaderMap, task: &Task, actor: &Actor) -> Result<(), ApiError> {
    lease_identity(headers, task, actor)?;
    if task.lease_until.is_none_or(|v| v < Utc::now()) {
        return Err(conflict());
    }
    Ok(())
}
// Agent proposal routes call this before replay or insertion. The database also
// enforces the lease through its proposal trigger; cancellation locks the same row.
pub(super) async fn submission(
    tx: &mut Tx,
    actor: &Actor,
    headers: &HeaderMap,
    scion: Uuid,
    revision: i32,
    kind: &str,
    candidate: &Value,
) -> Result<(), ApiError> {
    if !actor.is_agent {
        return Ok(());
    }
    agent(actor)?;
    crate::agents::lock_org(tx, actor).await?;
    let task = headers
        .get("X-Grimoire-Task-Id")
        .and_then(|h| h.to_str().ok())
        .and_then(|s| Uuid::parse_str(s).ok())
        .ok_or_else(conflict)?;
    let token = headers
        .get("X-Grimoire-Task-Lease")
        .and_then(|h| h.to_str().ok())
        .and_then(|s| Uuid::parse_str(s).ok())
        .ok_or_else(conflict)?;
    sqlx::query("SELECT app.intake_task_assert_submission($1,$2,$3,$4,$5,$6)")
        .bind(task)
        .bind(token)
        .bind(scion)
        .bind(revision)
        .bind(kind)
        .bind(sqlx::types::Json(candidate))
        .execute(&mut **tx)
        .await?;
    sqlx::query(
        "SELECT set_config('app.agent_task_id',$1,true),set_config('app.agent_task_lease',$2,true)",
    )
    .bind(task.to_string())
    .bind(token.to_string())
    .execute(&mut **tx)
    .await?;
    Ok(())
}
async fn expire(tx: &mut Tx, actor: &Actor) -> Result<(), ApiError> {
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))")
        .bind(format!("agent-org:{}", actor.org_id))
        .execute(&mut **tx)
        .await?;
    sqlx::query("UPDATE grimoire.intake_agent_tasks SET status='failed',failure_code='LEASE_EXPIRED',completed_at=clock_timestamp() WHERE status IN ('running','cancel_requested') AND lease_until<clock_timestamp()")
        .execute(&mut **tx).await?;
    Ok(())
}
async fn dispatch(
    State(pool): State<PgPool>,
    headers: HeaderMap,
    Path((scion, id)): Path<(String, String)>,
) -> ApiResult {
    let (mut tx, actor) = authenticate(&pool, &headers).await?;
    crate::agents::lock_org(&mut tx, &actor).await?;
    let scion = parse_id(&scion)?;
    visible(&mut tx, scion).await?;
    let task = load(&mut tx, parse_id(&id)?, true).await?;
    if task.scion_id != scion {
        return Err(ApiError::not_found());
    }
    authorize_preparation(&mut tx, task.scion_id, task.scion_revision, &task.task_kind).await?;
    if precondition(&headers)? != task.scion_revision {
        return Err(ApiError::stale());
    }
    if task.status == "dispatched" {
        tx.commit().await?;
        return Ok(Json(task).into_response());
    }
    if task.status != "queued" {
        return Err(conflict());
    }
    eligible(&mut tx, &task).await?;
    sqlx::query("UPDATE grimoire.intake_agent_tasks SET status='dispatched',dispatched_at=clock_timestamp() WHERE id=$1").bind(task.id).execute(&mut *tx).await?;
    let task = load(&mut tx, task.id, false).await?;
    tx.commit().await?;
    Ok(Json(task).into_response())
}
async fn cancel(
    State(pool): State<PgPool>,
    headers: HeaderMap,
    Path((scion, id)): Path<(String, String)>,
) -> ApiResult {
    let (mut tx, _) = authenticate(&pool, &headers).await?;
    let scion = parse_id(&scion)?;
    visible(&mut tx, scion).await?;
    let task = load(&mut tx, parse_id(&id)?, true).await?;
    if task.scion_id != scion {
        return Err(ApiError::not_found());
    }
    authorize_preparation(&mut tx, task.scion_id, task.scion_revision, &task.task_kind).await?;
    match task.status.as_str() {
        "queued" | "dispatched" => {
            sqlx::query("UPDATE grimoire.intake_agent_tasks SET status='cancelled',cancelled_at=clock_timestamp(),completed_at=clock_timestamp() WHERE id=$1").bind(task.id).execute(&mut *tx).await?;
        }
        "running" => {
            sqlx::query(
                "UPDATE grimoire.intake_agent_tasks SET status='cancel_requested' WHERE id=$1",
            )
            .bind(task.id)
            .execute(&mut *tx)
            .await?;
        }
        "cancel_requested" | "cancelled" => {}
        _ => return Err(conflict()),
    }
    let task = load(&mut tx, task.id, false).await?;
    let status = if task.status == "cancel_requested" {
        StatusCode::ACCEPTED
    } else {
        StatusCode::OK
    };
    tx.commit().await?;
    Ok((status, Json(task)).into_response())
}
async fn control(
    State(pool): State<PgPool>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> ApiResult {
    let (mut tx, actor) = authenticate(&pool, &headers).await?;
    agent(&actor)?;
    crate::agents::worker_seen(&mut tx, &headers).await?;
    let task = load(&mut tx, parse_id(&id)?, false).await?;
    lease(&headers, &task, &actor)?;
    let expired = task.execution_deadline.is_none_or(|v| v <= Utc::now());
    let proceed = task.status == "running" && !expired;
    if proceed {
        eligible(&mut tx, &task).await?;
    }
    tx.commit().await?;
    Ok(Json(json!({"task_id":task.id,"status":task.status,"continue":proceed,"stop_reason":if expired {Some("execution_timeout")} else {None},"scion_revision":task.scion_revision,"execution_deadline":task.execution_deadline,"lease_until":task.lease_until})).into_response())
}
async fn cancelled(
    State(pool): State<PgPool>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> ApiResult {
    let (mut tx, actor) = authenticate(&pool, &headers).await?;
    agent(&actor)?;
    let task = load(&mut tx, parse_id(&id)?, true).await?;
    lease_identity(&headers, &task, &actor)?;
    if task.status == "cancelled" {
        tx.commit().await?;
        return Ok(Json(task).into_response());
    }
    lease(&headers, &task, &actor)?;
    if task.status != "cancel_requested" {
        return Err(conflict());
    }
    sqlx::query("UPDATE grimoire.intake_agent_tasks SET status='cancelled',cancelled_at=clock_timestamp(),completed_at=clock_timestamp() WHERE id=$1").bind(task.id).execute(&mut *tx).await?;
    let task = load(&mut tx, task.id, false).await?;
    tx.commit().await?;
    Ok(Json(task).into_response())
}
async fn events(
    State(pool): State<PgPool>,
    headers: HeaderMap,
    Path((scion, id)): Path<(String, String)>,
) -> ApiResult {
    let (mut tx, _) = authenticate(&pool, &headers).await?;
    let scion = parse_id(&scion)?;
    visible(&mut tx, scion).await?;
    let task = load(&mut tx, parse_id(&id)?, false).await?;
    if task.scion_id != scion {
        return Err(ApiError::not_found());
    }
    let events:Vec<Value>=sqlx::query_scalar("SELECT jsonb_build_object('id',id,'status',status,'attempt',attempt,'principal_id',principal_id,'recorded_at',recorded_at,'details',details) FROM grimoire.intake_agent_task_events WHERE task_id=$1 ORDER BY recorded_at,id LIMIT 100").bind(task.id).fetch_all(&mut *tx).await?;
    tx.commit().await?;
    Ok(Json(json!({"events":events})).into_response())
}
async fn list(State(pool): State<PgPool>, headers: HeaderMap, Path(id): Path<String>) -> ApiResult {
    let (mut tx, _) = authenticate(&pool, &headers).await?;
    let id = parse_id(&id)?;
    visible(&mut tx, id).await?;
    let tasks = control_snapshot(&mut tx, id).await?;
    tx.commit().await?;
    Ok(Json(json!({"tasks":tasks})).into_response())
}
pub(super) async fn control_snapshot(tx: &mut Tx, id: Uuid) -> Result<Vec<Value>, ApiError> {
    let tasks = sqlx::query_as::<_, Task>(&format!("SELECT {COLUMNS} FROM grimoire.intake_agent_tasks WHERE scion_id=$1 ORDER BY created_at DESC,id LIMIT 100"))
        .bind(id).fetch_all(&mut **tx).await?;
    tasks
        .into_iter()
        .map(|task| serde_json::to_value(task).map_err(ApiError::from))
        .collect()
}
async fn create(
    State(pool): State<PgPool>,
    headers: HeaderMap,
    Path(id): Path<String>,
    input: Result<Json<Create>, JsonRejection>,
) -> ApiResult {
    let (mut tx, actor) = authenticate(&pool, &headers).await?;
    let id = parse_id(&id)?;
    let input = json_input(input)?;
    let task = enqueue(
        &mut tx,
        &actor,
        id,
        precondition(&headers)?,
        &key(&headers)?,
        input,
    )
    .await?;
    tx.commit().await?;
    Ok((StatusCode::CREATED, Json(task)).into_response())
}
// Shared enqueue path keeps conversation follow-ups under the same validation,
// immutable inputs, organization lock and agent binding as ordinary tasks.
pub(super) async fn enqueue(
    tx: &mut Tx,
    actor: &Actor,
    id: Uuid,
    base: i32,
    key: &str,
    mut input: Create,
) -> Result<Task, ApiError> {
    visible(tx, id).await?;
    if !actor.can_prepare_workspace || actor.is_agent {
        return Err(ApiError::forbidden());
    }
    crate::agents::lock_org(tx, actor).await?;
    if ![
        "prepare_physical_scope",
        "prepare_offer_normalization",
        "prepare_capability_plan",
        "research_public_web",
    ]
    .contains(&input.task_kind.as_str())
        || (input.task_kind != "research_public_web"
            && input.candidate_proposal["synthetic"] != true)
        || !input.candidate_proposal.is_object()
        || serde_json::to_vec(&input)?.len() > 48000
        || !(30..=300).contains(&input.timeout_seconds)
    {
        return Err(ApiError::invalid(
            "Use a supported preparation task with timeout_seconds between 30 and 300.",
        ));
    }
    authorize_preparation(tx, id, base, &input.task_kind).await?;
    match input.task_kind.as_str() {
        "research_public_web" => crate::research::validate_candidate(&input.candidate_proposal)?,
        "prepare_physical_scope" => crate::scope::validate_candidate(&input.candidate_proposal)?,
        "prepare_capability_plan" => {
            if input.candidate_proposal != json!({"synthetic":true}) {
                return Err(ApiError::invalid(
                    "Capability preparation accepts only {synthetic:true}; intake, connector registry and mandatory gaps are pinned by the server.",
                ));
            }
        }
        _ => crate::offers::validate_candidate(&input.candidate_proposal)?,
    }
    let hash = format!(
        "{:x}",
        Sha256::digest(format!("{id}\n{base}\n{}", serde_json::to_string(&input)?))
    );
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))")
        .bind(format!(
            "agent-task:{}:{}:{key}",
            actor.org_id, actor.principal_id
        ))
        .execute(&mut **tx)
        .await?;
    if let Some(old) = sqlx::query_as::<_, Task>(&format!(
        "SELECT {COLUMNS} FROM grimoire.intake_agent_tasks WHERE created_by=$1 AND request_key=$2"
    ))
    .bind(actor.principal_id)
    .bind(key)
    .fetch_optional(&mut **tx)
    .await?
    {
        if old.request_sha256 != hash {
            return Err(ApiError(
                StatusCode::CONFLICT,
                "IDEMPOTENCY_CONFLICT",
                "The task key has different input.".into(),
            ));
        }
        return Ok(old);
    }
    if visible(tx, id).await? != base {
        return Err(ApiError::stale());
    }
    if input.task_kind == "prepare_capability_plan" {
        input.candidate_proposal = crate::capabilities::task_candidate(tx, id, base).await?;
        if input.candidate_proposal["intake"]["product_description"]
            .as_str()
            .is_none_or(|text| text.trim().is_empty())
        {
            return Err(ApiError::invalid(
                "Enter a product description in a new Scion revision before asking an agent to prepare capabilities.",
            ));
        }
        if serde_json::to_vec(&input)?.len() > 48000 {
            return Err(ApiError::invalid(
                "The pinned intake is too large for this bounded agent task. Save a more focused intake revision before preparation.",
            ));
        }
    }
    let task_id = Uuid::new_v4();
    sqlx::query("INSERT INTO grimoire.intake_agent_tasks(id,org_id,scion_id,scion_revision,task_kind,input,created_by,request_key,request_sha256,timeout_seconds) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)").bind(task_id).bind(actor.org_id).bind(id).bind(base).bind(&input.task_kind).bind(sqlx::types::Json(json!({"candidate_proposal":input.candidate_proposal}))).bind(actor.principal_id).bind(key).bind(hash).bind(input.timeout_seconds).execute(&mut **tx).await?;
    if let Some(agent_id) = input.agent_id {
        sqlx::query("SELECT app.intake_bind_agent_task($1,$2)")
            .bind(task_id)
            .bind(agent_id)
            .execute(&mut **tx)
            .await?;
    }
    load(tx, task_id, false).await
}

async fn next(State(pool): State<PgPool>, headers: HeaderMap) -> ApiResult {
    let (mut tx, actor) = authenticate(&pool, &headers).await?;
    agent(&actor)?;
    // No task input is returned until claim validates current Scion/source permissions.
    expire(&mut tx, &actor).await?;
    crate::agents::worker_seen(&mut tx, &headers).await?;
    let id:Option<Uuid>=sqlx::query_scalar("SELECT task.id FROM grimoire.intake_agent_tasks task LEFT JOIN grimoire.intake_task_agent_bindings binding ON (binding.org_id,binding.task_id)=(task.org_id,task.id) LEFT JOIN grimoire.intake_managed_entities entity ON (entity.org_id,entity.id)=(binding.org_id,binding.agent_id) LEFT JOIN grimoire.intake_managed_revisions revision ON (revision.org_id,revision.entity_id,revision.number)=(entity.org_id,entity.id,entity.current_revision) WHERE task.status='dispatched' AND ($3 OR NOT EXISTS(SELECT 1 FROM grimoire.intake_task_followups f WHERE f.agent_task_id=task.id)) AND (task.task_kind<>'research_public_web' OR ($2 AND app.intake_research_connection(task.input->'candidate_proposal',true))) AND (binding.task_id IS NULL OR ($1 AND NOT (revision.config->>'paused')::boolean)) AND NOT EXISTS(SELECT 1 FROM grimoire.intake_agent_tasks WHERE status IN ('running','cancel_requested')) ORDER BY task.dispatched_at,task.id LIMIT 1").bind(crate::agents::protocol(&headers)).bind(crate::research::capable(&headers)).bind(crate::task_conversation::capable(&headers)).fetch_optional(&mut *tx).await?;
    tx.commit().await?;
    Ok(Json(json!({"task":id.map(|id|json!({"id":id}))})).into_response())
}
async fn claim(
    State(pool): State<PgPool>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> ApiResult {
    let (mut tx, actor) = authenticate(&pool, &headers).await?;
    agent(&actor)?;
    let id = parse_id(&id)?;
    expire(&mut tx, &actor).await?;
    let task = load(&mut tx, id, true).await?;
    if task.status != "dispatched" {
        return Err(conflict());
    }
    if task.task_kind == "research_public_web" {
        let permitted: bool = sqlx::query_scalar("SELECT app.intake_research_connection($1,true)")
            .bind(sqlx::types::Json(&task.input.0["candidate_proposal"]))
            .fetch_one(&mut *tx)
            .await?;
        if !crate::research::capable(&headers)
            || !permitted
            || (task.input.0["candidate_proposal"]["search_provider"] == "serpapi"
                && !crate::research::serpapi_capable(&headers))
        {
            return Err(ApiError(StatusCode::FORBIDDEN,"RESEARCH_WORKER_REQUIRED","This task requires the explicitly selected computer running the updated public research worker.".into()));
        }
    }
    let task_message = crate::task_conversation::claim_message(&mut tx, &headers, task.id).await?;
    let profile: Option<Value> = sqlx::query_scalar(
        "SELECT snapshot FROM grimoire.intake_task_agent_bindings WHERE task_id=$1",
    )
    .bind(task.id)
    .fetch_optional(&mut *tx)
    .await?;
    if profile.is_some() && !crate::agents::protocol(&headers) {
        return Err(ApiError(
            StatusCode::CONFLICT,
            "WORKER_UPGRADE_REQUIRED",
            "Native agent tasks require Grimoire worker protocol 2.".into(),
        ));
    }
    if let Err(error) = eligible(&mut tx, &task).await {
        tx.rollback().await?;
        // A SQL permission error aborts its transaction. Preserve a content-free
        // failure in a new scoped transaction so later valid jobs can proceed.
        let (mut disposition, _) = authenticate(&pool, &headers).await?;
        sqlx::query("UPDATE grimoire.intake_agent_tasks SET status='failed',completed_at=clock_timestamp(),failure_code='INPUT_UNAVAILABLE' WHERE id=$1 AND status='dispatched'").bind(id).execute(&mut *disposition).await?;
        disposition.commit().await?;
        return Err(error);
    }
    sqlx::query("UPDATE grimoire.intake_agent_tasks SET status='running',attempt=attempt+1,claimed_by=$2,claimed_at=clock_timestamp(),lease_token=$3,lease_until=clock_timestamp()+make_interval(secs=>timeout_seconds+30) WHERE id=$1").bind(id).bind(actor.principal_id).bind(Uuid::new_v4()).execute(&mut *tx).await?;
    let task = load(&mut tx, id, false).await?;
    let mut result = serde_json::to_value(&task)?;
    result["input"] = task.input.0;
    result["lease_token"] = json!(task.lease_token);
    result["agent_profile"] = json!(profile);
    result["task_message"] = task_message;
    tx.commit().await?;
    Ok(Json(result).into_response())
}
async fn result(
    State(pool): State<PgPool>,
    headers: HeaderMap,
    Path(id): Path<String>,
    input: Result<Json<ResultInput>, JsonRejection>,
) -> ApiResult {
    let (mut tx, actor) = authenticate(&pool, &headers).await?;
    agent(&actor)?;
    crate::agents::lock_org(&mut tx, &actor).await?;
    let id = parse_id(&id)?;
    let task = load(&mut tx, id, true).await?;
    lease_identity(&headers, &task, &actor)?;
    let input = json_input(input)?;
    if task.status == "completed" {
        // A lost success response may be recovered after the execution lease
        // expires. This acknowledges the exact immutable receipt only; it never
        // extends a lease, changes a result or re-executes provider work.
        let note: Option<String> = sqlx::query_scalar(
            "SELECT preparation_note FROM grimoire.intake_agent_tasks WHERE id=$1",
        )
        .bind(task.id)
        .fetch_one(&mut *tx)
        .await?;
        if task.proposal_id != Some(input.proposal_id)
            || task.provider_run_id != input.provider_run_id
            || task.output_sha256.as_deref() != Some(input.output_sha256.as_str())
            || note.as_deref() != Some(input.preparation_note.as_str())
        {
            return Err(conflict());
        }
        tx.commit().await?;
        return Ok(Json(task).into_response());
    }
    lease(&headers, &task, &actor)?;
    if task.status != "running" {
        return Err(conflict());
    }
    if input.output_sha256.len() != 64
        || !input
            .output_sha256
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        || input.preparation_note.trim().is_empty()
        || input.preparation_note.len() > 2000
        || input
            .provider_run_id
            .as_ref()
            .is_some_and(|v| v.len() > 100)
    {
        return Err(ApiError::invalid("Invalid bounded agent result metadata."));
    }
    eligible(&mut tx, &task).await?;
    sqlx::query("UPDATE grimoire.intake_agent_tasks SET status='completed',completed_at=clock_timestamp(),proposal_id=$2,provider_run_id=$3,output_sha256=$4,preparation_note=$5 WHERE id=$1").bind(id).bind(input.proposal_id).bind(input.provider_run_id).bind(input.output_sha256).bind(input.preparation_note).execute(&mut *tx).await?;
    let task = load(&mut tx, id, false).await?;
    tx.commit().await?;
    Ok(Json(task).into_response())
}
async fn fail(
    State(pool): State<PgPool>,
    headers: HeaderMap,
    Path(id): Path<String>,
    input: Result<Json<FailInput>, JsonRejection>,
) -> ApiResult {
    let (mut tx, actor) = authenticate(&pool, &headers).await?;
    agent(&actor)?;
    let id = parse_id(&id)?;
    let task = load(&mut tx, id, true).await?;
    lease_identity(&headers, &task, &actor)?;
    let input = json_input(input)?;
    if input.failure_code.is_empty()
        || input.failure_code.len() > 100
        || !input
            .failure_code
            .bytes()
            .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit() || b == b'_')
    {
        return Err(ApiError::invalid("A bounded failure code is required."));
    }
    if task.status == "failed" && task.failure_code.as_deref() == Some(&input.failure_code) {
        tx.commit().await?;
        return Ok(Json(task).into_response());
    }
    lease(&headers, &task, &actor)?;
    if task.status != "running" {
        return Err(conflict());
    }
    sqlx::query("UPDATE grimoire.intake_agent_tasks SET status='failed',completed_at=clock_timestamp(),failure_code=$2 WHERE id=$1").bind(id).bind(input.failure_code).execute(&mut *tx).await?;
    let task = load(&mut tx, id, false).await?;
    tx.commit().await?;
    Ok(Json(task).into_response())
}
