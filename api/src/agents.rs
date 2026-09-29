use super::*;
use axum::routing::post;
use serde::Deserialize;
use serde_json::Value;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct AgentConfig {
    name: String,
    role: String,
    title: String,
    instructions: String,
    capabilities: String,
    reports_to: Option<Uuid>,
    adapter: String,
    timeout_seconds: i32,
    skill_ids: Vec<Uuid>,
    paused: bool,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SkillConfig {
    name: String,
    description: String,
    instructions: String,
}

pub(super) fn routes() -> Router<PgPool> {
    Router::new()
        .route("/api/agents", get(list_agents).post(create_agent))
        .route("/api/agents/{id}", get(detail).put(update_agent))
        .route("/api/agents/{id}/tasks/{task}", post(assign))
        .route("/api/skills", get(list_skills).post(create_skill))
        .route("/api/skills/{id}", axum::routing::put(update_skill))
}

fn valid_text(value: &str, maximum: usize, required: bool) -> bool {
    value.len() <= maximum && !value.contains('\0') && (!required || !value.trim().is_empty())
}

fn validate(kind: &str, value: &Value) -> Result<(), ApiError> {
    let valid = if kind == "agent" {
        let config: AgentConfig = serde_json::from_value(value.clone())
            .map_err(|_| ApiError::invalid("Use the bounded native agent configuration fields."))?;
        let _ = (config.reports_to, config.paused);
        valid_text(&config.name, 100, true)
            && valid_text(&config.role, 100, true)
            && valid_text(&config.title, 160, false)
            && valid_text(&config.capabilities, 2000, false)
            && valid_text(&config.instructions, 12000, false)
            && config.adapter == "codex_cli"
            && (30..=300).contains(&config.timeout_seconds)
            && config.skill_ids.len() <= 8
            && config
                .skill_ids
                .iter()
                .collect::<std::collections::HashSet<_>>()
                .len()
                == config.skill_ids.len()
    } else {
        let config: SkillConfig = serde_json::from_value(value.clone()).map_err(|_| {
            ApiError::invalid("Use name, description and instructions for a native skill.")
        })?;
        valid_text(&config.name, 100, true)
            && valid_text(&config.description, 2000, false)
            && valid_text(&config.instructions, 12000, true)
    };
    if valid {
        Ok(())
    } else {
        Err(ApiError::invalid(
            "Configuration exceeds a bound or requests an unsupported runtime. Use at most eight unique skills and a 30–300 second task limit.",
        ))
    }
}

pub(super) async fn lock_org(tx: &mut Tx, actor: &Actor) -> Result<(), ApiError> {
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))")
        .bind(format!("agent-org:{}", actor.org_id))
        .execute(&mut **tx)
        .await?;
    Ok(())
}

pub(super) async fn worker_seen(tx: &mut Tx, headers: &HeaderMap) -> Result<(), ApiError> {
    if protocol(headers) {
        sqlx::query("SELECT app.intake_worker_seen()")
            .execute(&mut **tx)
            .await?;
    }
    Ok(())
}

pub(super) fn protocol(headers: &HeaderMap) -> bool {
    headers
        .get("X-Grimoire-Worker-Protocol")
        .and_then(|value| value.to_str().ok())
        == Some("2")
}

pub(super) async fn records(tx: &mut Tx, kind: &str) -> Result<Vec<Value>, ApiError> {
    Ok(sqlx::query_scalar("SELECT jsonb_build_object('id',entity.id,'kind',entity.kind,'revision',entity.current_revision,'config',revision.config,'created_at',entity.created_at,'updated_at',entity.updated_at,'status',CASE WHEN entity.kind='skill' THEN 'available' WHEN (revision.config->>'paused')::boolean THEN 'paused' WHEN EXISTS(SELECT 1 FROM grimoire.intake_task_agent_bindings binding JOIN grimoire.intake_agent_tasks task ON (task.org_id,task.id)=(binding.org_id,binding.task_id) WHERE binding.agent_id=entity.id AND task.status IN ('running','cancel_requested')) THEN 'running' ELSE 'idle' END) FROM grimoire.intake_managed_entities entity JOIN grimoire.intake_managed_revisions revision ON (revision.org_id,revision.entity_id,revision.number)=(entity.org_id,entity.id,entity.current_revision) WHERE entity.kind=$1 ORDER BY entity.created_at,entity.id")
        .bind(kind).fetch_all(&mut **tx).await?)
}

pub(super) async fn runtime(tx: &mut Tx) -> Result<Value, ApiError> {
    let last_seen: Option<DateTime<Utc>> = sqlx::query_scalar(
        "SELECT max(last_seen) FROM grimoire.intake_worker_presence WHERE protocol=2",
    )
    .fetch_one(&mut **tx)
    .await?;
    let connected = last_seen
        .is_some_and(|checked| Utc::now().signed_duration_since(checked).num_seconds() <= 15);
    Ok(
        json!({"backend":"grimoire","status":if connected {"connected"} else {"disconnected"},"last_seen":last_seen,"adapter":"codex_cli","protocol":2,"concurrency":1,"costs_available":false}),
    )
}

async fn list_agents(State(pool): State<PgPool>, headers: HeaderMap) -> ApiResult {
    let (mut tx, _) = authenticate(&pool, &headers).await?;
    let agents = records(&mut tx, "agent").await?;
    let runtime = runtime(&mut tx).await?;
    tx.commit().await?;
    Ok(Json(json!({"agents":agents,"runtime":runtime})).into_response())
}
async fn list_skills(State(pool): State<PgPool>, headers: HeaderMap) -> ApiResult {
    let (mut tx, _) = authenticate(&pool, &headers).await?;
    let skills = records(&mut tx, "skill").await?;
    tx.commit().await?;
    Ok(Json(json!({"skills":skills})).into_response())
}
async fn detail(
    State(pool): State<PgPool>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> ApiResult {
    let (mut tx, _) = authenticate(&pool, &headers).await?;
    let id = parse_id(&id)?;
    let agent = records(&mut tx, "agent")
        .await?
        .into_iter()
        .find(|value| value["id"] == id.to_string())
        .ok_or_else(ApiError::not_found)?;
    let tasks: Vec<Value> = sqlx::query_scalar("SELECT jsonb_build_object('id',task.id,'scion_id',task.scion_id,'scion_revision',task.scion_revision,'task_kind',task.task_kind,'status',task.status,'created_at',task.created_at,'claimed_at',task.claimed_at,'completed_at',task.completed_at,'timeout_seconds',task.timeout_seconds,'proposal_id',task.proposal_id,'failure_code',task.failure_code,'provider_run_id',task.provider_run_id,'output_sha256',task.output_sha256,'agent_revision',binding.agent_revision,'stale',COALESCE(state.stale,false) OR task.scion_revision<>scion.current_revision,'blocked',COALESCE(state.blocked,false)) FROM grimoire.intake_task_agent_bindings binding JOIN grimoire.intake_agent_tasks task ON (task.org_id,task.id)=(binding.org_id,binding.task_id) JOIN grimoire.intake_scions scion ON (scion.org_id,scion.id)=(task.org_id,task.scion_id) LEFT JOIN grimoire.intake_watch_node_states state ON (state.org_id,state.node_kind,state.node_id)=(task.org_id,'agent_task',task.id) WHERE binding.agent_id=$1 ORDER BY task.created_at DESC,task.id LIMIT 100")
        .bind(id).fetch_all(&mut *tx).await?;
    let revisions: Vec<Value> = sqlx::query_scalar("SELECT jsonb_build_object('revision',number,'config',config,'created_at',created_at,'created_by',created_by) FROM grimoire.intake_managed_revisions WHERE entity_id=$1 ORDER BY number DESC LIMIT 100").bind(id).fetch_all(&mut *tx).await?;
    let events: Vec<Value> = sqlx::query_scalar("SELECT jsonb_build_object('id',event.id,'task_id',event.task_id,'status',event.status,'recorded_at',event.recorded_at,'attempt',event.attempt) FROM grimoire.intake_agent_task_events event JOIN grimoire.intake_task_agent_bindings binding ON (binding.org_id,binding.task_id)=(event.org_id,event.task_id) WHERE binding.agent_id=$1 ORDER BY event.recorded_at DESC,event.id LIMIT 100").bind(id).fetch_all(&mut *tx).await?;
    let runtime = runtime(&mut tx).await?;
    tx.commit().await?;
    Ok(Json(json!({"agent":agent,"tasks":tasks,"revisions":revisions,"events":events,"runtime":runtime})).into_response())
}

async fn save(
    pool: PgPool,
    headers: HeaderMap,
    kind: &str,
    id: Option<String>,
    input: Result<Json<Value>, JsonRejection>,
) -> ApiResult {
    let (mut tx, actor) = authenticate(&pool, &headers).await?;
    if !actor.can_manage_workspace || actor.is_agent {
        return Err(ApiError::forbidden());
    }
    let value = input
        .map_err(|_| ApiError::invalid("A JSON configuration is required."))?
        .0;
    validate(kind, &value)?;
    let id = id.as_deref().map(parse_id).transpose()?;
    let expected = if id.is_some() {
        precondition(&headers)?
    } else {
        0
    };
    let result: Value = sqlx::query_scalar("SELECT app.intake_save_managed($1,$2,$3,$4,$5)")
        .bind(kind)
        .bind(id)
        .bind(expected)
        .bind(value)
        .bind(key(&headers)?)
        .fetch_one(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok((
        if id.is_some() {
            StatusCode::OK
        } else {
            StatusCode::CREATED
        },
        Json(result),
    )
        .into_response())
}
async fn create_agent(
    State(pool): State<PgPool>,
    headers: HeaderMap,
    input: Result<Json<Value>, JsonRejection>,
) -> ApiResult {
    save(pool, headers, "agent", None, input).await
}
async fn update_agent(
    State(pool): State<PgPool>,
    headers: HeaderMap,
    Path(id): Path<String>,
    input: Result<Json<Value>, JsonRejection>,
) -> ApiResult {
    save(pool, headers, "agent", Some(id), input).await
}
async fn create_skill(
    State(pool): State<PgPool>,
    headers: HeaderMap,
    input: Result<Json<Value>, JsonRejection>,
) -> ApiResult {
    save(pool, headers, "skill", None, input).await
}
async fn update_skill(
    State(pool): State<PgPool>,
    headers: HeaderMap,
    Path(id): Path<String>,
    input: Result<Json<Value>, JsonRejection>,
) -> ApiResult {
    save(pool, headers, "skill", Some(id), input).await
}
async fn assign(
    State(pool): State<PgPool>,
    headers: HeaderMap,
    Path((id, task)): Path<(String, String)>,
) -> ApiResult {
    let (mut tx, actor) = authenticate(&pool, &headers).await?;
    if !actor.can_write || actor.is_agent {
        return Err(ApiError::forbidden());
    }
    sqlx::query("SELECT app.intake_bind_agent_task($1,$2)")
        .bind(parse_id(&task)?)
        .bind(parse_id(&id)?)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(Json(json!({"assigned":true,"task_id":task,"agent_id":id})).into_response())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn profiles_cannot_grant_authority_or_run_arbitrary_adapters() {
        let mut config = json!({"name":"Planner","role":"planner","title":"","instructions":"","capabilities":"","reports_to":null,"adapter":"codex_cli","timeout_seconds":120,"skill_ids":[],"paused":false});
        assert!(validate("agent", &config).is_ok());
        config["can_approve"] = json!(true);
        assert!(validate("agent", &config).is_err());
        config.as_object_mut().unwrap().remove("can_approve");
        config["adapter"] = json!("shell");
        assert!(validate("agent", &config).is_err());
    }
    #[test]
    fn skills_require_bounded_instruction_text() {
        assert!(validate("skill", &json!({"name":"Evidence review","description":"","instructions":"Keep gaps explicit."})).is_ok());
        assert!(
            validate(
                "skill",
                &json!({"name":"Evidence review","description":"","instructions":""})
            )
            .is_err()
        );
    }
}
