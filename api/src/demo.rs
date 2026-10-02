//! Public access is limited to the operator-published synthetic registry. This
//! module never authenticates a visitor, accepts an organization, or grants a
//! session, bearer credential, task lease, or write capability.
use super::*;

const DEMO_ORG: Uuid = Uuid::from_u128(0xd3400000000040008000000000000001);
const DEMO_READER: Uuid = Uuid::from_u128(0xd3400000000040008000000000000002);

#[derive(FromRow)]
struct Scenario {
    slug: String,
    scion_id: Uuid,
}

pub(super) fn routes() -> Router<PgPool> {
    Router::new()
        .route("/api/demo", get(manifest))
        .route("/api/demo/{slug}", get(scenario))
        .layer(axum::middleware::from_fn(no_store))
}

async fn no_store(request: Request<Body>, next: Next) -> Response {
    let mut response = next.run(request).await;
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

fn label(slug: &str) -> Option<(&'static str, &'static str)> {
    match slug {
        "current" => Some((
            "A completed draft still needs a Handler",
            "Synthetic protocol fixture: a completed proposal task grants no approval. Internal evidence is available; the external connector and Handler decision remain missing.",
        )),
        "revised" => Some((
            "A revision makes the proposal stale",
            "The synthetic Scion was revised through the regular API. Watchtower persisted the stale dependency and required review.",
        )),
        "revoked" => Some((
            "Revoked evidence blocks dependent work",
            "The synthetic source permission was revoked through the regular API. Its content is hidden and dependent work is blocked.",
        )),
        _ => None,
    }
}

fn unavailable() -> ApiError {
    ApiError(
        StatusCode::SERVICE_UNAVAILABLE,
        "DEMO_NOT_CONFIGURED",
        "The public synthetic judge workspace is not configured. No demo state has been invented."
            .into(),
    )
}

async fn begin(pool: &PgPool) -> Result<(Tx, Vec<Scenario>), ApiError> {
    let mut tx = pool.begin().await?;
    // One consistent database snapshot is required because read-only
    // transactions cannot acquire the authenticated reader's row locks.
    sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY")
        .execute(&mut *tx)
        .await?;
    sqlx::query("SELECT set_config('app.current_org_id',$1,true),set_config('app.current_principal_id',$2,true),set_config('statement_timeout','10000',true),set_config('lock_timeout','5000',true)")
        .bind(DEMO_ORG.to_string()).bind(DEMO_READER.to_string()).execute(&mut *tx).await?;
    let scenarios = sqlx::query_as::<_, Scenario>(
        "SELECT slug,scion_id FROM app.intake_public_demo_scenarios()",
    )
    .fetch_all(&mut *tx)
    .await?;
    if scenarios.len() != 3 {
        return Err(unavailable());
    }
    Ok((tx, scenarios))
}

async fn manifest(State(pool): State<PgPool>) -> ApiResult {
    let (tx, scenarios) = begin(&pool).await?;
    let scenarios: Vec<_> = scenarios
        .into_iter()
        .filter_map(|scenario| {
            label(&scenario.slug).map(|(title, description)| {
                json!({"slug":scenario.slug,"title":title,"description":description,"scion_id":scenario.scion_id})
            })
        })
        .collect();
    tx.commit().await?;
    Ok(Json(json!({
        "synthetic":true,"read_only":true,
        "title":"Grimoire synthetic judge workspace",
        "description":"Persisted synthetic examples of Grimoire's core review workflow. Task results were seeded through the protocol; no Codex provider or Paperclip run was executed. No personal accounts, provider credentials, or private workspaces are shared.",
        "scenarios":scenarios
    })).into_response())
}

async fn scenario(State(pool): State<PgPool>, Path(slug): Path<String>) -> ApiResult {
    if label(&slug).is_none() {
        return Err(ApiError(
            StatusCode::NOT_FOUND,
            "DEMO_SCENARIO_NOT_FOUND",
            "Public demo scenario not found.".into(),
        ));
    }
    let (mut tx, scenarios) = begin(&pool).await?;
    let scenario = scenarios
        .into_iter()
        .find(|scenario| scenario.slug == slug)
        .ok_or_else(unavailable)?;
    let actor = Actor {
        principal_id: DEMO_READER,
        org_id: DEMO_ORG,
        display_name: "Public synthetic demo reader".into(),
        organization_name: "Grimoire public synthetic judge workspace".into(),
        can_write: false,
        can_manage_workspace: false,
        can_prepare_workspace: false,
        can_confirm_scope: false,
        can_propose_scope: false,
        is_agent: false,
    };
    let mut body = control_surface::snapshot(&mut tx, &actor, scenario.scion_id).await?;
    body["synthetic"] = json!(true);
    body["read_only"] = json!(true);
    // Node selection is local inspection. No action advertised by the public
    // projection can be executed, including future workspace action kinds.
    for node in body["nodes"].as_array_mut().into_iter().flatten() {
        node["safe_next_action"]["enabled"] = json!(false);
    }
    tx.commit().await?;
    Ok(Json(body).into_response())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn demo_accepts_only_named_scenarios_and_no_private_identifiers() {
        assert!(label("current").is_some());
        assert!(label("revised").is_some());
        assert!(label("revoked").is_some());
        for slug in ["", "Current", "../scions", "all", &DEMO_ORG.to_string()] {
            assert!(label(slug).is_none());
        }
    }

    #[test]
    fn demo_unavailability_is_explicit_and_creates_no_success_response() {
        assert_eq!(unavailable().0, StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(unavailable().1, "DEMO_NOT_CONFIGURED");
    }
}
