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
struct Task {
    id: Uuid,
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
const COLUMNS: &str = "id,scion_id,scion_revision,task_kind,adapter,status,attempt,created_at,claimed_at,completed_at,proposal_id,failure_code,input,claimed_by,lease_token,lease_until,request_sha256,timeout_seconds,dispatched_at,cancelled_at,provider_run_id,output_sha256,(claimed_at+make_interval(secs=>timeout_seconds)) AS execution_deadline";
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Create {
    task_kind: String,
    candidate_proposal: Value,
    #[serde(
        default = "default_timeout",
        skip_serializing_if = "is_default_timeout"
    )]
    timeout_seconds: i32,
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
    sqlx::query("SELECT app.intake_task_assert_input($1,$2,$3,$4)")
        .bind(task.scion_id)
        .bind(task.scion_revision)
        .bind(&task.task_kind)
        .bind(sqlx::types::Json(&task.input.0["candidate_proposal"]))
        .execute(&mut **tx)
        .await?;
    Ok(())
}
fn lease(headers: &HeaderMap, task: &Task, actor: &Actor) -> Result<(), ApiError> {
    let supplied = headers
        .get("X-Grimoire-Task-Lease")
        .and_then(|h| h.to_str().ok())
        .and_then(|s| Uuid::parse_str(s).ok());
    if task.claimed_by != Some(actor.principal_id)
        || supplied.is_none()
        || task.lease_token != supplied
        || task.lease_until.is_none_or(|v| v < Utc::now())
    {
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
    let scion = parse_id(&scion)?;
    visible(&mut tx, scion).await?;
    let task = load(&mut tx, parse_id(&id)?, true).await?;
    if task.scion_id != scion {
        return Err(ApiError::not_found());
    }
    if !actor.can_write || actor.is_agent {
        return Err(ApiError::forbidden());
    }
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
    let (mut tx, actor) = authenticate(&pool, &headers).await?;
    let scion = parse_id(&scion)?;
    visible(&mut tx, scion).await?;
    let task = load(&mut tx, parse_id(&id)?, true).await?;
    if task.scion_id != scion {
        return Err(ApiError::not_found());
    }
    if !actor.can_write || actor.is_agent {
        return Err(ApiError::forbidden());
    }
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
    lease(&headers, &task, &actor)?;
    if task.status == "cancelled" {
        tx.commit().await?;
        return Ok(Json(task).into_response());
    }
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
    let tasks=sqlx::query_as::<_,Task>(&format!("SELECT {COLUMNS} FROM grimoire.intake_agent_tasks WHERE scion_id=$1 ORDER BY created_at DESC,id LIMIT 50")).bind(id).fetch_all(&mut *tx).await?;
    tx.commit().await?;
    Ok(Json(json!({"tasks":tasks})).into_response())
}
async fn create(
    State(pool): State<PgPool>,
    headers: HeaderMap,
    Path(id): Path<String>,
    input: Result<Json<Create>, JsonRejection>,
) -> ApiResult {
    let (mut tx, actor) = authenticate(&pool, &headers).await?;
    let id = parse_id(&id)?;
    visible(&mut tx, id).await?;
    if !actor.can_write || actor.is_agent {
        return Err(ApiError::forbidden());
    }
    let input = json_input(input)?;
    let base = precondition(&headers)?;
    let key = key(&headers)?;
    if !["prepare_physical_scope", "prepare_offer_normalization"]
        .contains(&input.task_kind.as_str())
        || input.candidate_proposal["synthetic"] != true
        || !input.candidate_proposal.is_object()
        || serde_json::to_vec(&input)?.len() > 48000
        || !(30..=300).contains(&input.timeout_seconds)
    {
        return Err(ApiError::invalid(
            "Use a supported synthetic preparation task with timeout_seconds between 30 and 300.",
        ));
    }
    match input.task_kind.as_str() {
        "prepare_physical_scope" => crate::scope::validate_candidate(&input.candidate_proposal)?,
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
        .execute(&mut *tx)
        .await?;
    if let Some(old) = sqlx::query_as::<_, Task>(&format!(
        "SELECT {COLUMNS} FROM grimoire.intake_agent_tasks WHERE created_by=$1 AND request_key=$2"
    ))
    .bind(actor.principal_id)
    .bind(&key)
    .fetch_optional(&mut *tx)
    .await?
    {
        if old.request_sha256 != hash {
            return Err(ApiError(
                StatusCode::CONFLICT,
                "IDEMPOTENCY_CONFLICT",
                "The task key has different input.".into(),
            ));
        }
        tx.commit().await?;
        return Ok((StatusCode::CREATED, Json(old)).into_response());
    }
    if visible(&mut tx, id).await? != base {
        return Err(ApiError::stale());
    }
    let task_id = Uuid::new_v4();
    sqlx::query("INSERT INTO grimoire.intake_agent_tasks(id,org_id,scion_id,scion_revision,task_kind,input,created_by,request_key,request_sha256,timeout_seconds) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)").bind(task_id).bind(actor.org_id).bind(id).bind(base).bind(&input.task_kind).bind(sqlx::types::Json(json!({"candidate_proposal":input.candidate_proposal}))).bind(actor.principal_id).bind(key).bind(hash).bind(input.timeout_seconds).execute(&mut *tx).await?;
    let task = load(&mut tx, task_id, false).await?;
    tx.commit().await?;
    Ok((StatusCode::CREATED, Json(task)).into_response())
}
async fn next(State(pool): State<PgPool>, headers: HeaderMap) -> ApiResult {
    let (mut tx, actor) = authenticate(&pool, &headers).await?;
    agent(&actor)?;
    // No task input is returned until claim validates current Scion/source permissions.
    expire(&mut tx, &actor).await?;
    let id:Option<Uuid>=sqlx::query_scalar("SELECT id FROM grimoire.intake_agent_tasks WHERE status='dispatched' AND NOT EXISTS(SELECT 1 FROM grimoire.intake_agent_tasks WHERE status IN ('running','cancel_requested')) ORDER BY dispatched_at,id LIMIT 1").fetch_optional(&mut *tx).await?;
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
    let id = parse_id(&id)?;
    let task = load(&mut tx, id, true).await?;
    lease(&headers, &task, &actor)?;
    let input = json_input(input)?;
    if task.status == "completed" && task.proposal_id == Some(input.proposal_id) {
        tx.commit().await?;
        return Ok(Json(task).into_response());
    }
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
    lease(&headers, &task, &actor)?;
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
    if task.status != "running" {
        return Err(conflict());
    }
    sqlx::query("UPDATE grimoire.intake_agent_tasks SET status='failed',completed_at=clock_timestamp(),failure_code=$2 WHERE id=$1").bind(id).bind(input.failure_code).execute(&mut *tx).await?;
    let task = load(&mut tx, id, false).await?;
    tx.commit().await?;
    Ok(Json(task).into_response())
}
