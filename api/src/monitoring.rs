//! Persisted Scion-revision reactions. Live proposal currentness checks remain
//! separate and continue to fail closed even if persisted monitoring is absent.
use super::*;
use serde_json::Value;

const REACTION_JSON: &str = "jsonb_build_object(\
  'transition_id',t.id,\
  'proposal_kind',t.proposal_kind,\
  'proposal_id',t.proposal_id,\
  'proposal_scion_revision',t.proposal_scion_revision,\
  'superseded_by_revision',t.superseded_by_revision,\
  'reason',t.reason,\
  'recorded_at',t.recorded_at,\
  'review_task',jsonb_build_object(\
    'id',w.id,'task_kind',w.task_kind,'status',w.status,\
    'required_for_revision',w.required_for_revision,'created_at',w.created_at))";

pub(super) fn routes() -> Router<PgPool> {
    Router::new().route("/api/scions/{id}/revision-reviews", get(list))
}

pub(super) async fn latest_reaction(
    tx: &mut Tx,
    proposal_kind: &str,
    proposal_id: Uuid,
) -> Result<Option<Value>, ApiError> {
    sqlx::query_scalar(&format!(
        "SELECT {REACTION_JSON} FROM grimoire.intake_proposal_stale_transitions t \
         JOIN grimoire.intake_proposal_review_tasks w ON (w.org_id,w.transition_id)=(t.org_id,t.id) \
         WHERE t.proposal_kind=$1 AND t.proposal_id=$2 \
         ORDER BY t.superseded_by_revision DESC,t.id DESC LIMIT 1"
    ))
    .bind(proposal_kind)
    .bind(proposal_id)
    .fetch_optional(&mut **tx)
    .await
    .map_err(ApiError::from)
}

async fn list(State(pool): State<PgPool>, headers: HeaderMap, Path(id): Path<String>) -> ApiResult {
    let (mut tx, _) = authenticate(&pool, &headers).await?;
    let id = parse_id(&id)?;
    visible_revision(&mut tx, id, false).await?;
    let items: Vec<Value> = sqlx::query_scalar(&format!(
        "SELECT {REACTION_JSON} FROM grimoire.intake_proposal_stale_transitions t \
         JOIN grimoire.intake_proposal_review_tasks w ON (w.org_id,w.transition_id)=(t.org_id,t.id) \
         WHERE t.scion_id=$1 \
         ORDER BY t.superseded_by_revision DESC,t.recorded_at,t.id"
    ))
    .bind(id)
    .fetch_all(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(Json(json!({"items":items})).into_response())
}
