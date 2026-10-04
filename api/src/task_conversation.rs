//! Persisted Handler messages and actual native follow-up runs. No chat-only agent state.
use super::*;
use serde::Deserialize;
use serde_json::Value;

pub fn routes() -> Router<PgPool> {
    Router::new()
        .route(
            "/api/scions/{scion}/agent-tasks/{task}/conversation",
            get(conversation),
        )
        .route(
            "/api/scions/{scion}/agent-tasks/{task}/messages",
            axum::routing::post(send),
        )
}
pub(super) fn capable(headers: &HeaderMap) -> bool {
    let mut values = headers.get_all("X-Grimoire-Task-Messages").iter();
    values.next().and_then(|v| v.to_str().ok()) == Some("1") && values.next().is_none()
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct MessageInput {
    body: String,
    intent: String,
    #[serde(default)]
    agent_id: Option<Uuid>,
    #[serde(default)]
    worker_connection_id: Option<Uuid>,
    #[serde(default)]
    public_web_consent: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    search_provider: Option<String>,
}
impl MessageInput {
    fn validate(&self) -> Result<(), ApiError> {
        if self.body.trim().is_empty()
            || self.body.chars().count() > 4000
            || self.body.contains('\0')
            || !matches!(self.intent.as_str(), "note" | "follow_up")
            || self
                .search_provider
                .as_deref()
                .is_some_and(|value| value != "serpapi")
            || (self.intent == "note"
                && (self.agent_id.is_some()
                    || self.worker_connection_id.is_some()
                    || self.public_web_consent
                    || self.search_provider.is_some()))
        {
            return Err(ApiError::invalid(
                "Use a task note or follow-up message of 1–4,000 characters. Notes cannot authorize agent work.",
            ));
        }
        Ok(())
    }
}
fn followup_search_provider(
    requested: Option<String>,
    previous: Option<String>,
) -> Result<Option<String>, ApiError> {
    if previous.as_deref() == Some("serpapi") && requested.as_deref() != Some("serpapi") {
        return Err(ApiError::invalid(
            "Explicitly select SerpApi and consent to its search usage again for this follow-up.",
        ));
    }
    Ok(requested)
}
fn conflict(code: &'static str, message: &str) -> ApiError {
    ApiError(StatusCode::CONFLICT, code, message.into())
}
async fn root(tx: &mut Tx, scion: Uuid, task: Uuid) -> Result<Uuid, ApiError> {
    sqlx::query_scalar("SELECT COALESCE(f.thread_task_id,t.id) FROM grimoire.intake_agent_tasks t LEFT JOIN grimoire.intake_task_followups f ON (f.org_id,f.agent_task_id)=(t.org_id,t.id) WHERE t.scion_id=$1 AND t.id=$2")
        .bind(scion).bind(task).fetch_optional(&mut **tx).await?.ok_or_else(ApiError::not_found)
}
async fn revision(tx: &mut Tx, scion: Uuid) -> Result<i32, ApiError> {
    sqlx::query_scalar("SELECT current_revision FROM grimoire.intake_scions WHERE id=$1")
        .bind(scion)
        .fetch_optional(&mut **tx)
        .await?
        .ok_or_else(ApiError::not_found)
}
async fn ids(tx: &mut Tx, root: Uuid) -> Result<Vec<Uuid>, ApiError> {
    Ok(sqlx::query_scalar("SELECT id FROM grimoire.intake_agent_tasks WHERE id=$1 OR id IN(SELECT agent_task_id FROM grimoire.intake_task_followups WHERE thread_task_id=$1) ORDER BY created_at,id").bind(root).fetch_all(&mut **tx).await?)
}
async fn message(tx: &mut Tx, id: Uuid) -> Result<Value, ApiError> {
    sqlx::query_scalar("SELECT jsonb_build_object('id',m.id,'body',m.body,'intent',m.intent,'author_principal_id',m.author_principal_id,'author_name',m.author_name,'created_at',m.created_at,'task_id',f.agent_task_id) FROM grimoire.intake_task_messages m LEFT JOIN grimoire.intake_task_followups f ON (f.org_id,f.message_id)=(m.org_id,m.id) WHERE m.id=$1")
        .bind(id).fetch_optional(&mut **tx).await?.ok_or_else(ApiError::not_found)
}
async fn blocked(tx: &mut Tx, root: Uuid) -> Result<bool, ApiError> {
    Ok(
        sqlx::query_scalar("SELECT app.intake_conversation_blocked($1)")
            .bind(root)
            .fetch_one(&mut **tx)
            .await?,
    )
}
async fn lock_evidence(tx: &mut Tx, tasks: &[Uuid]) -> Result<(), ApiError> {
    let sources: Vec<(Uuid, Uuid)> = sqlx::query_as("SELECT DISTINCT scion_id,source_id FROM grimoire.intake_watch_dependencies WHERE node_kind='agent_task' AND node_id=ANY($1) AND source_id IS NOT NULL ORDER BY source_id,scion_id")
        .bind(tasks).fetch_all(&mut **tx).await?;
    for (scion, source) in sources {
        sqlx::query("SELECT app.intake_source_read_lock($1,$2)")
            .bind(scion)
            .bind(source)
            .execute(&mut **tx)
            .await?;
    }
    for task in tasks {
        sqlx::query("SELECT app.intake_research_lock_captures($1,NULL)")
            .bind(task)
            .execute(&mut **tx)
            .await?;
    }
    Ok(())
}
async fn availability(
    tx: &mut Tx,
    root: Uuid,
    scion: Uuid,
) -> Result<Option<&'static str>, ApiError> {
    let kind: String =
        sqlx::query_scalar("SELECT task_kind FROM grimoire.intake_agent_tasks WHERE id=$1")
            .bind(root)
            .fetch_one(&mut **tx)
            .await?;
    let digital:bool=sqlx::query_scalar("SELECT r.product_category='digital' FROM grimoire.intake_scions s JOIN grimoire.intake_revisions r ON (r.org_id,r.scion_id,r.number)=(s.org_id,s.id,s.current_revision) WHERE s.id=$1").bind(scion).fetch_one(&mut **tx).await?;
    if kind != "research_public_web" && (kind != "prepare_capability_plan" || !digital) {
        return Ok(Some(
            "This task supports notes. Use its existing workflow controls to prepare physical work.",
        ));
    }
    if blocked(tx, root).await? {
        return Ok(Some(
            "A source used in this thread was withdrawn. Create fresh work from authorized inputs.",
        ));
    }
    let active:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM grimoire.intake_agent_tasks WHERE status IN ('queued','dispatched','running','cancel_requested') AND (id=$1 OR id IN(SELECT agent_task_id FROM grimoire.intake_task_followups WHERE thread_task_id=$1)))").bind(root).fetch_one(&mut **tx).await?;
    Ok(active.then_some("Wait for the active task to finish, or cancel it, before requesting a follow-up. You can save a note now."))
}
async fn conversation(
    State(pool): State<PgPool>,
    headers: HeaderMap,
    Path((scion, task)): Path<(String, String)>,
) -> ApiResult {
    let (mut tx, actor) = authenticate(&pool, &headers).await?;
    let scion = parse_id(&scion)?;
    let root = root(&mut tx, scion, parse_id(&task)?).await?;
    let tasks = ids(&mut tx, root).await?;
    // Serialize sourced reply visibility with source/receipt withdrawal. Never copy the
    // reply into a second table that could bypass the original artifact's guards.
    lock_evidence(&mut tx, &tasks).await?;
    let current = revision(&mut tx, scion).await?;
    let hidden_thread = blocked(&mut tx, root).await?;
    let message_ids:Vec<Uuid>=sqlx::query_scalar("SELECT id FROM grimoire.intake_task_messages WHERE thread_task_id=$1 ORDER BY created_at,id LIMIT 200").bind(root).fetch_all(&mut *tx).await?;
    let mut messages = Vec::new();
    for id in message_ids {
        messages.push(message(&mut tx, id).await?);
    }
    let responses:Vec<Value>=sqlx::query_scalar("SELECT jsonb_build_object('task_id',t.id,'agent_id',b.agent_id,'agent_name',b.snapshot->>'name','status',t.status,'created_at',t.created_at,'completed_at',t.completed_at,'scion_revision',t.scion_revision,'preparation_note',CASE WHEN NOT $3 AND NOT COALESCE(w.blocked,false) AND NOT COALESCE(w.stale,false) AND t.scion_revision=$2 THEN t.preparation_note END,'proposal_id',CASE WHEN NOT $3 AND NOT COALESCE(w.blocked,false) AND NOT COALESCE(w.stale,false) AND t.scion_revision=$2 THEN t.proposal_id END,'task_kind',t.task_kind,'provider_run_id',t.provider_run_id,'stale',t.scion_revision<>$2 OR COALESCE(w.stale,false),'blocked',$3 OR COALESCE(w.blocked,false),'content_hidden',$3 OR COALESCE(w.blocked,false) OR COALESCE(w.stale,false) OR t.scion_revision<>$2) FROM grimoire.intake_agent_tasks t LEFT JOIN grimoire.intake_task_agent_bindings b ON (b.org_id,b.task_id)=(t.org_id,t.id) LEFT JOIN grimoire.intake_watch_node_states w ON (w.org_id,w.node_kind,w.node_id)=(t.org_id,'agent_task',t.id) WHERE t.id=ANY($1) ORDER BY t.created_at,t.id")
        .bind(&tasks).bind(current).bind(hidden_thread).fetch_all(&mut *tx).await?;
    let reason = if !actor.can_prepare_workspace || actor.is_agent {
        Some("Only a Handler can send task follow-ups.")
    } else {
        availability(&mut tx, root, scion).await?
    };
    let latest = tasks.last().copied().unwrap_or(root);
    tx.commit().await?;
    Ok(Json(json!({"thread_task_id":root,"current_task_id":latest,"task_ids":tasks,"current_revision":current,"messages":messages,"responses":responses,"follow_up_available":reason.is_none(),"follow_up_reason":reason})).into_response())
}
async fn send(
    State(pool): State<PgPool>,
    headers: HeaderMap,
    Path((scion, task)): Path<(String, String)>,
    body: Result<Json<MessageInput>, JsonRejection>,
) -> ApiResult {
    let Json(input) = body.map_err(|_| ApiError::invalid("Use the task message fields."))?;
    input.validate()?;
    let base = precondition(&headers)?;
    let key = key(&headers)?;
    let (mut tx, actor) = authenticate(&pool, &headers).await?;
    if actor.is_agent || !actor.can_prepare_workspace {
        return Err(ApiError::forbidden());
    }
    crate::agents::lock_org(&mut tx, &actor).await?;
    let scion = parse_id(&scion)?;
    let root = root(&mut tx, scion, parse_id(&task)?).await?;
    let hash = format!(
        "{:x}",
        Sha256::digest(format!(
            "{scion}\n{root}\n{base}\n{}",
            serde_json::to_string(&input)?
        ))
    );
    let existing:Option<(Uuid,String)>=sqlx::query_as("SELECT id,request_sha256 FROM grimoire.intake_task_messages WHERE author_principal_id=$1 AND request_key=$2").bind(actor.principal_id).bind(&key).fetch_optional(&mut *tx).await?;
    if let Some((id, old_hash)) = existing {
        if hash != old_hash {
            return Err(conflict(
                "IDEMPOTENCY_CONFLICT",
                "That message receipt belongs to different text or work. Keep your draft and send it with a new request.",
            ));
        }
        let response = receipt(&mut tx, root, id).await?;
        tx.commit().await?;
        return Ok(Json(response).into_response());
    }
    sqlx::query("SELECT app.intake_scope_lock_scion($1)")
        .bind(scion)
        .execute(&mut *tx)
        .await?;
    if revision(&mut tx, scion).await? != base {
        return Err(ApiError::stale());
    }
    let count: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM grimoire.intake_task_messages WHERE thread_task_id=$1",
    )
    .bind(root)
    .fetch_one(&mut *tx)
    .await?;
    if count >= 200 {
        return Err(ApiError::invalid(
            "This bounded thread has 200 messages. Start a new task to continue.",
        ));
    }
    if input.intent == "follow_up"
        && let Some(reason) = availability(&mut tx, root, scion).await?
    {
        return Err(conflict("TASK_FOLLOWUP_UNAVAILABLE", reason));
    }
    let message_id = Uuid::new_v4();
    sqlx::query("INSERT INTO grimoire.intake_task_messages(id,org_id,scion_id,scion_revision,thread_task_id,author_principal_id,author_name,body,intent,request_key,request_sha256) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)").bind(message_id).bind(actor.org_id).bind(scion).bind(base).bind(root).bind(actor.principal_id).bind(&actor.display_name).bind(&input.body).bind(&input.intent).bind(key).bind(hash).execute(&mut *tx).await?;
    if input.intent == "follow_up" {
        let parent = *ids(&mut tx, root)
            .await?
            .last()
            .ok_or_else(ApiError::not_found)?;
        let (kind,mut timeout,original_agent):(String,i32,Option<Uuid>)=sqlx::query_as("SELECT t.task_kind,t.timeout_seconds,b.agent_id FROM grimoire.intake_agent_tasks t LEFT JOIN grimoire.intake_task_agent_bindings b ON (b.org_id,b.task_id)=(t.org_id,t.id) WHERE t.id=$1").bind(parent).fetch_one(&mut *tx).await?;
        let agent = input.agent_id.or(original_agent);
        if let Some(agent) = agent {
            let bound:Option<i32>=sqlx::query_scalar("SELECT (r.config->>'timeout_seconds')::int FROM grimoire.intake_managed_entities e JOIN grimoire.intake_managed_revisions r ON (r.org_id,r.entity_id,r.number)=(e.org_id,e.id,e.current_revision) WHERE e.id=$1 AND e.kind='agent'").bind(agent).fetch_optional(&mut *tx).await?;
            timeout = timeout.min(bound.ok_or_else(ApiError::not_found)?);
        }
        let candidate = if kind == "research_public_web" {
            if !input.public_web_consent || input.worker_connection_id.is_none() {
                return Err(ApiError::invalid(
                    "Explicit public-brief consent and a selected research computer are required for every research follow-up.",
                ));
            }
            let previous_provider: Option<String> = sqlx::query_scalar("SELECT input->'candidate_proposal'->>'search_provider' FROM grimoire.intake_agent_tasks WHERE id=$1")
                .bind(parent).fetch_one(&mut *tx).await?;
            let mut candidate = json!({"synthetic":false,"objective":input.body,"consent":true,"policy_version":crate::research::POLICY,"worker_connection_id":input.worker_connection_id});
            if let Some(provider) =
                followup_search_provider(input.search_provider, previous_provider)?
            {
                candidate["search_provider"] = json!(provider);
            }
            candidate
        } else {
            if input.public_web_consent
                || input.worker_connection_id.is_some()
                || input.search_provider.is_some()
            {
                return Err(ApiError::invalid(
                    "Planning follow-ups do not authorize public web research.",
                ));
            }
            json!({"synthetic":true})
        };
        let child = crate::byoa::enqueue(
            &mut tx,
            &actor,
            scion,
            base,
            &format!("task-message:{message_id}"),
            crate::byoa::Create {
                task_kind: kind,
                candidate_proposal: candidate,
                agent_id: agent,
                timeout_seconds: timeout,
            },
        )
        .await?;
        sqlx::query("INSERT INTO grimoire.intake_task_followups(org_id,thread_task_id,parent_task_id,message_id,agent_task_id) VALUES($1,$2,$3,$4,$5)").bind(actor.org_id).bind(root).bind(parent).bind(message_id).bind(child.id).execute(&mut *tx).await?;
        sqlx::query("UPDATE grimoire.intake_agent_tasks SET status='dispatched',dispatched_at=clock_timestamp() WHERE id=$1").bind(child.id).execute(&mut *tx).await?;
    }
    let response = receipt(&mut tx, root, message_id).await?;
    tx.commit().await?;
    Ok((StatusCode::CREATED, Json(response)).into_response())
}
async fn receipt(tx: &mut Tx, root: Uuid, id: Uuid) -> Result<Value, ApiError> {
    let message = message(tx, id).await?;
    let status:Option<String>=sqlx::query_scalar("SELECT t.status FROM grimoire.intake_task_followups f JOIN grimoire.intake_agent_tasks t ON (t.org_id,t.id)=(f.org_id,f.agent_task_id) WHERE f.message_id=$1").bind(id).fetch_optional(&mut **tx).await?;
    Ok(
        json!({"thread_task_id":root,"task_id":message["task_id"],"task_status":status,"message":message}),
    )
}
pub(super) async fn claim_message(
    tx: &mut Tx,
    headers: &HeaderMap,
    task: Uuid,
) -> Result<Value, ApiError> {
    let row:Option<(Uuid,Uuid,String,Uuid)>=sqlx::query_as("SELECT m.id,m.thread_task_id,m.body,f.parent_task_id FROM grimoire.intake_task_followups f JOIN grimoire.intake_task_messages m ON (m.org_id,m.id)=(f.org_id,f.message_id) WHERE f.agent_task_id=$1").bind(task).fetch_optional(&mut **tx).await?;
    let Some((id, root, body, parent)) = row else {
        return Ok(Value::Null);
    };
    if !capable(headers) {
        return Err(conflict(
            "WORKER_UPGRADE_REQUIRED",
            "Update the local worker to receive task messages before starting this follow-up.",
        ));
    }
    let tasks = ids(tx, root).await?;
    lock_evidence(tx, &tasks).await?;
    if blocked(tx, root).await? {
        return Err(ApiError(
            StatusCode::FORBIDDEN,
            "SOURCE_RIGHTS_DENIED",
            "A source used by this thread was withdrawn. Stop this follow-up.".into(),
        ));
    }
    sqlx::query("SELECT set_config('app.task_messages_protocol','1',true)")
        .execute(&mut **tx)
        .await?;
    // Only a current, authorized planning artifact is prior context. Research
    // uses the newly consented public brief alone, never a private transcript.
    let prior:Option<Value>=sqlx::query_scalar("SELECT jsonb_build_object('task_id',p.id,'proposal_id',p.proposal_id,'preparation_note',p.preparation_note,'result',r.input) FROM grimoire.intake_agent_tasks t JOIN grimoire.intake_scions s ON (s.org_id,s.id)=(t.org_id,t.scion_id) JOIN grimoire.intake_agent_tasks p ON p.id=$2 AND p.org_id=t.org_id JOIN grimoire.intake_capability_plans r ON (r.org_id,r.id)=(p.org_id,p.proposal_id) WHERE t.id=$1 AND t.task_kind='prepare_capability_plan' AND p.status='completed' AND p.scion_revision=s.current_revision AND t.scion_revision=s.current_revision AND NOT EXISTS(SELECT 1 FROM grimoire.intake_watch_node_states w WHERE w.org_id=t.org_id AND w.node_kind='agent_task' AND w.node_id=p.id AND (w.stale OR w.blocked))").bind(task).bind(parent).fetch_optional(&mut **tx).await?;
    let omitted = prior.as_ref().is_some_and(|v| v.to_string().len() > 24000);
    Ok(
        json!({"id":id,"thread_task_id":root,"body":body,"prior_result":if omitted{None}else{prior},"context_omitted":omitted}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn messages_are_bounded_and_notes_cannot_authorize_work() {
        let mut input = MessageInput {
            body: "Question about this task".into(),
            intent: "note".into(),
            agent_id: None,
            worker_connection_id: None,
            public_web_consent: false,
            search_provider: None,
        };
        assert!(input.validate().is_ok());
        input.public_web_consent = true;
        assert!(input.validate().is_err());
        input.public_web_consent = false;
        input.body = " ".repeat(5);
        assert!(input.validate().is_err());
        input.body = "é".repeat(4000);
        assert!(input.validate().is_ok());
        input.body.push('x');
        assert!(input.validate().is_err());
    }
    #[test]
    fn worker_message_capability_is_unambiguous() {
        let mut h = HeaderMap::new();
        assert!(!capable(&h));
        h.insert("X-Grimoire-Task-Messages", HeaderValue::from_static("1"));
        assert!(capable(&h));
        h.append("X-Grimoire-Task-Messages", HeaderValue::from_static("1"));
        assert!(!capable(&h));
    }
    #[test]
    fn serpapi_followups_require_fresh_explicit_provider_selection() {
        assert!(followup_search_provider(None, Some("serpapi".into())).is_err());
        assert!(
            followup_search_provider(Some("serpapi".into()), Some("serpapi".into()))
                .is_ok_and(|provider| provider.as_deref() == Some("serpapi"))
        );
        assert!(matches!(followup_search_provider(None, None), Ok(None)));
        assert!(
            followup_search_provider(Some("serpapi".into()), None)
                .is_ok_and(|provider| provider.as_deref() == Some("serpapi"))
        );
    }
}
