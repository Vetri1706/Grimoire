use super::*;
use serde_json::Value;

pub(super) fn routes() -> Router<PgPool> {
    Router::new().route("/api/workspace", get(read))
}

async fn read(State(pool): State<PgPool>, headers: HeaderMap) -> ApiResult {
    let (mut tx, actor) = authenticate(&pool, &headers).await?;
    let query = format!(
        "SELECT {REVISION_COLUMNS} FROM grimoire.intake_scions scion JOIN grimoire.intake_revisions r ON (r.org_id,r.scion_id,r.number)=(scion.org_id,scion.id,scion.current_revision) ORDER BY scion.updated_at DESC,scion.id"
    );
    let scions: Vec<Scion> = sqlx::query_as::<_, RevisionRow>(&query)
        .fetch_all(&mut *tx)
        .await?
        .into_iter()
        .map(RevisionRow::into_scion)
        .collect();
    let proposals: Vec<Value> = sqlx::query_scalar(
        "WITH proposals AS (
          SELECT id,org_id,scion_id,scion_revision,created_at,'capability_proposal'::text AS kind,'Capability plan'::text AS title FROM grimoire.intake_capability_plans
          UNION ALL SELECT id,org_id,scion_id,scion_revision,created_at,'comparison','Evidence comparison' FROM grimoire.intake_evidence_comparisons
          UNION ALL SELECT id,org_id,scion_id,scion_revision,created_at,'scope','Physical scope' FROM grimoire.intake_scope_proposals
          UNION ALL SELECT id,org_id,scion_id,scion_revision,created_at,'offers','Offer normalization' FROM grimoire.intake_comparison_proposals
        ) SELECT jsonb_build_object('id',proposal.id,'scion_id',proposal.scion_id,'scion_revision',proposal.scion_revision,'kind',proposal.kind,'title',proposal.title,'created_at',proposal.created_at,
          'status',CASE WHEN state.blocked THEN 'blocked' WHEN state.stale OR proposal.scion_revision<>scion.current_revision THEN 'stale' WHEN proposal.kind IN ('scope','offers') THEN 'inspect' ELSE 'proposed' END)
        FROM proposals proposal JOIN grimoire.intake_scions scion ON (scion.org_id,scion.id)=(proposal.org_id,proposal.scion_id)
        LEFT JOIN grimoire.intake_watch_node_states state ON (state.org_id,state.node_kind,state.node_id)=(proposal.org_id,proposal.kind,proposal.id)
        ORDER BY proposal.created_at DESC,proposal.id LIMIT 300"
    ).fetch_all(&mut *tx).await?;
    let tasks: Vec<Value> = sqlx::query_scalar(
        "SELECT jsonb_build_object('id',task.id,'scion_id',task.scion_id,'scion_revision',task.scion_revision,'task_kind',task.task_kind,'status',task.status,'created_at',task.created_at,'proposal_id',task.proposal_id,
          'blocked',COALESCE(state.blocked,false),'stale',COALESCE(state.stale,false) OR task.scion_revision<>scion.current_revision)
         FROM grimoire.intake_agent_tasks task JOIN grimoire.intake_scions scion ON (scion.org_id,scion.id)=(task.org_id,task.scion_id)
         LEFT JOIN grimoire.intake_watch_node_states state ON (state.org_id,state.node_kind,state.node_id)=(task.org_id,'agent_task',task.id)
         ORDER BY task.created_at DESC,task.id LIMIT 300"
    ).fetch_all(&mut *tx).await?;
    let reviews: Vec<Value> = sqlx::query_scalar("SELECT jsonb_build_object('id',id,'scion_id',scion_id,'event_id',event_id,'status',status,'reason',reason,'created_at',created_at) FROM grimoire.intake_watch_reviews ORDER BY created_at DESC,id LIMIT 300")
        .fetch_all(&mut *tx).await?;
    let events: Vec<Value> = sqlx::query_scalar("SELECT jsonb_build_object('id',id,'scion_id',scion_id,'kind',kind,'summary',summary,'recorded_at',recorded_at,'event_key',event_key) FROM grimoire.intake_watch_events ORDER BY recorded_at DESC,id LIMIT 300")
        .fetch_all(&mut *tx).await?;
    let watches: Vec<Value> = sqlx::query_scalar("SELECT jsonb_build_object('id',id,'scion_id',scion_id,'kind',kind,'last_successful_check',last_successful_check,'last_event_at',last_event_at,'status',CASE WHEN last_successful_check IS NULL THEN 'pending' WHEN clock_timestamp()-last_successful_check>interval '10 seconds' THEN 'delayed' ELSE 'healthy' END) FROM grimoire.intake_watches ORDER BY scion_id,kind")
        .fetch_all(&mut *tx).await?;
    let connectors = if let Some(scion) = scions.first() {
        let candidate: Value = sqlx::query_scalar("SELECT app.intake_capability_candidate($1,$2)")
            .bind(scion.id)
            .bind(scion.current_revision)
            .fetch_one(&mut *tx)
            .await?;
        candidate["connectors"].clone()
    } else {
        json!([])
    };
    let agents = agents::records(&mut tx, "agent").await?;
    let skills = agents::records(&mut tx, "skill").await?;
    let agent_runtime = agents::runtime(&mut tx).await?;
    tx.commit().await?;
    Ok(Json(json!({"org_id":actor.org_id,"generated_at":Utc::now(),"scions":scions,"proposals":proposals,"tasks":tasks,"reviews":reviews,"events":events,"watches":watches,"connectors":connectors,"agents":agents,"skills":skills,"agent_runtime":agent_runtime,"collection_limit":300})).into_response())
}
