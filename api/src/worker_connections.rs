//! Local Codex device pairing. Only the CLI sees the issued worker credential;
//! browser consent is session-bound and never grants human approval authority.
use super::*;
use serde::Deserialize;
use serde_json::Value;

const POLICY_VERSION: &str = "codex-synthetic-v1";

#[derive(Default, Deserialize)]
#[serde(deny_unknown_fields)]
struct StartInput {
    device_name: Option<String>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PollInput {
    device_secret: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ConsentInput {
    organization_id: Uuid,
    consent: bool,
    policy_version: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RevokeInput {
    organization_id: Uuid,
}

pub(super) fn routes() -> Router<PgPool> {
    Router::new()
        .route("/api/worker-connections", get(list))
        .route(
            "/api/worker-connections/pairings",
            axum::routing::post(start),
        )
        .route(
            "/api/worker-connections/pairings/poll",
            axum::routing::post(poll),
        )
        .route("/api/worker-connections/pairings/{code}", get(review))
        .route(
            "/api/worker-connections/pairings/{code}/approve",
            axum::routing::post(approve),
        )
        .route(
            "/api/worker-connections/{id}/revoke",
            axum::routing::post(revoke),
        )
}

fn input<T>(value: Result<Json<T>, JsonRejection>) -> Result<T, ApiError> {
    value
        .map(|Json(body)| body)
        .map_err(|_| ApiError::invalid("Use the bounded worker connection fields."))
}

fn user_code(code: &str) -> Result<&str, ApiError> {
    if code.len() == 16
        && code
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'A'..=b'F').contains(&b))
    {
        Ok(code)
    } else {
        Err(not_found())
    }
}

fn secret_valid(secret: &str) -> bool {
    secret.len() == 64
        && secret
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn not_found() -> ApiError {
    ApiError(
        StatusCode::NOT_FOUND,
        "WORKER_CONNECTION_NOT_FOUND",
        "Worker connection or pairing is unavailable.".into(),
    )
}

fn organization_changed() -> ApiError {
    ApiError(
        StatusCode::CONFLICT,
        "ACTIVE_ORGANIZATION_CHANGED",
        "The active organization changed. Reload the workspace before continuing.".into(),
    )
}

fn mounted_organization(headers: &HeaderMap) -> Result<Uuid, ApiError> {
    let mut values = headers.get_all("X-Grimoire-Organization").iter();
    let organization = values
        .next()
        .and_then(|v| v.to_str().ok())
        .and_then(|v| Uuid::parse_str(v).ok());
    if values.next().is_some() {
        return Err(organization_changed());
    }
    organization.ok_or_else(organization_changed)
}

// Keep a worker/seeded bearer from consenting as a human even if it is supplied
// alongside a browser cookie. The established cookie parser rejects ambiguity.
fn human_session(headers: &HeaderMap, mutation: bool) -> Result<String, ApiError> {
    if headers.contains_key(header::AUTHORIZATION) || !onboarding::has_session_cookie(headers) {
        return Err(ApiError::unauthorized());
    }
    if mutation {
        let mut markers = headers.get_all("X-Grimoire-CSRF").iter();
        if markers.next().and_then(|v| v.to_str().ok()) != Some("1") || markers.next().is_some() {
            return Err(ApiError::csrf());
        }
    }
    let token = headers
        .get_all(header::COOKIE)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|value| value.split(';'))
        .filter_map(|value| value.trim().split_once('='))
        .find_map(|(name, value)| (name == "grimoire_session").then_some(value))
        .ok_or_else(ApiError::unauthorized)?;
    Ok(format!("{:x}", Sha256::digest(token.as_bytes())))
}

fn outcome(value: Value, success: StatusCode) -> ApiResult {
    match value.get("status").and_then(Value::as_str) {
        Some("not_found") => Err(not_found()),
        Some("unauthorized") => Err(ApiError::unauthorized()),
        Some("organization_changed") => Err(organization_changed()),
        Some("consent_required") => Err(ApiError(
            StatusCode::UNPROCESSABLE_ENTITY,
            "WORKER_CONSENT_REQUIRED",
            "Review and explicitly consent to the current synthetic Codex policy.".into(),
        )),
        Some("connection_limit") => Err(ApiError(
            StatusCode::CONFLICT,
            "WORKER_CONNECTION_LIMIT",
            "Revoke an unused connection before pairing another worker.".into(),
        )),
        Some("rate_limited") => {
            let mut response = ApiError(
                StatusCode::TOO_MANY_REQUESTS,
                "WORKER_PAIRING_RATE_LIMIT",
                "Wait before trying this pairing operation again.".into(),
            )
            .into_response();
            response
                .headers_mut()
                .insert(header::RETRY_AFTER, HeaderValue::from_static("3"));
            Ok(response)
        }
        _ => Ok((success, Json(value)).into_response()),
    }
}

async fn start(
    State(pool): State<PgPool>,
    body: Result<Json<StartInput>, JsonRejection>,
) -> ApiResult {
    let body = input(body)?;
    let name = body
        .device_name
        .as_deref()
        .unwrap_or("Local Codex worker")
        .trim();
    if name.is_empty() || name.chars().count() > 80 || name.chars().any(char::is_control) {
        return Err(ApiError::invalid(
            "Device name must contain 1–80 visible characters.",
        ));
    }
    let value: Value = sqlx::query_scalar("SELECT app.intake_start_worker_pairing($1)")
        .bind(name)
        .fetch_one(&pool)
        .await?;
    outcome(value, StatusCode::CREATED)
}

async fn poll(
    State(pool): State<PgPool>,
    body: Result<Json<PollInput>, JsonRejection>,
) -> ApiResult {
    let body = input(body)?;
    if !secret_valid(&body.device_secret) {
        return Err(not_found());
    }
    let value: Value = sqlx::query_scalar("SELECT app.intake_poll_worker_pairing($1)")
        .bind(body.device_secret)
        .fetch_one(&pool)
        .await?;
    outcome(value, StatusCode::OK)
}

async fn review(
    State(pool): State<PgPool>,
    headers: HeaderMap,
    Path(code): Path<String>,
) -> ApiResult {
    let session = human_session(&headers, false)?;
    let organization = mounted_organization(&headers)?;
    let value: Value = sqlx::query_scalar("SELECT app.intake_review_worker_pairing($1,$2,$3)")
        .bind(session)
        .bind(user_code(&code)?)
        .bind(organization)
        .fetch_one(&pool)
        .await?;
    outcome(value, StatusCode::OK)
}

async fn approve(
    State(pool): State<PgPool>,
    headers: HeaderMap,
    Path(code): Path<String>,
    body: Result<Json<ConsentInput>, JsonRejection>,
) -> ApiResult {
    let session = human_session(&headers, true)?;
    let body = input(body)?;
    if mounted_organization(&headers)? != body.organization_id {
        return Err(organization_changed());
    }
    if !body.consent || body.policy_version != POLICY_VERSION {
        return outcome(json!({"status":"consent_required"}), StatusCode::OK);
    }
    let value: Value =
        sqlx::query_scalar("SELECT app.intake_approve_worker_pairing($1,$2,$3,$4,$5)")
            .bind(session)
            .bind(user_code(&code)?)
            .bind(body.organization_id)
            .bind(body.consent)
            .bind(body.policy_version)
            .fetch_one(&pool)
            .await?;
    outcome(value, StatusCode::OK)
}

async fn list(State(pool): State<PgPool>, headers: HeaderMap) -> ApiResult {
    human_session(&headers, false)?;
    let (mut tx, actor) = authenticate(&pool, &headers).await?;
    if !actor.can_manage_workspace || actor.is_agent {
        return Err(ApiError::forbidden());
    }
    // Busy is evidence of a live claim by this computer, never inferred from a
    // dispatched task or an agent's saved configuration. A stale heartbeat wins
    // over an outstanding lease so an offline process is not shown as working.
    let connections: Vec<Value> = sqlx::query_scalar("SELECT jsonb_build_object('connection_id',c.id,'organization_id',c.org_id,'device_name',c.device_name,'adapter',c.adapter,'policy_version',c.policy_version,'content_class',c.content_class,'approved_at',c.approved_at,'created_at',c.created_at,'revoked_at',c.revoked_at,'last_seen',p.last_seen,'status',CASE WHEN c.revoked_at IS NOT NULL THEN 'revoked' WHEN p.last_seen IS NULL OR p.last_seen<=clock_timestamp()-interval '15 seconds' THEN 'disconnected' WHEN task.id IS NOT NULL THEN 'busy' ELSE 'connected' END,'active_task',CASE WHEN c.revoked_at IS NULL AND p.last_seen>clock_timestamp()-interval '15 seconds' AND task.id IS NOT NULL THEN jsonb_build_object('id',task.id,'scion_id',task.scion_id,'task_kind',task.task_kind,'status',task.status,'claimed_at',task.claimed_at,'timeout_seconds',task.timeout_seconds,'lease_until',task.lease_until) END) FROM grimoire.intake_worker_connections c LEFT JOIN grimoire.intake_worker_presence p ON (p.org_id,p.principal_id)=(c.org_id,c.principal_id) LEFT JOIN LATERAL (SELECT id,scion_id,task_kind,status,claimed_at,timeout_seconds,lease_until FROM grimoire.intake_agent_tasks WHERE org_id=c.org_id AND claimed_by=c.principal_id AND status IN ('running','cancel_requested') AND lease_until>clock_timestamp() AND claimed_at+make_interval(secs=>timeout_seconds)>clock_timestamp() ORDER BY claimed_at DESC,id LIMIT 1) task ON true ORDER BY c.created_at DESC,c.id LIMIT 100")
        .fetch_all(&mut *tx).await?;
    tx.commit().await?;
    Ok(Json(json!({"connections":connections})).into_response())
}

async fn revoke(
    State(pool): State<PgPool>,
    headers: HeaderMap,
    Path(id): Path<String>,
    body: Result<Json<RevokeInput>, JsonRejection>,
) -> ApiResult {
    let session = human_session(&headers, true)?;
    let body = input(body)?;
    if mounted_organization(&headers)? != body.organization_id {
        return Err(organization_changed());
    }
    let id = Uuid::parse_str(&id).map_err(|_| not_found())?;
    let value: Value = sqlx::query_scalar("SELECT app.intake_revoke_worker_connection($1,$2,$3)")
        .bind(session)
        .bind(id)
        .bind(body.organization_id)
        .fetch_one(&pool)
        .await?;
    outcome(value, StatusCode::OK)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn pairing_proofs_and_user_codes_are_strict_and_distinct() {
        assert!(secret_valid(&"a".repeat(64)));
        for value in [
            "a".repeat(63),
            "A".repeat(64),
            format!("{} ", "a".repeat(64)),
        ] {
            assert!(!secret_valid(&value));
        }
        assert!(user_code("0123456789ABCDEF").is_ok());
        assert!(user_code("0123456789abcdef").is_err());
        assert!(user_code("0123456789ABCDE").is_err());
    }
    #[test]
    fn consent_requires_one_human_session_and_csrf_marker() {
        let mut headers = HeaderMap::new();
        headers.insert(
            header::COOKIE,
            HeaderValue::from_str(&format!("grimoire_session={}", "a".repeat(64))).unwrap(),
        );
        assert!(human_session(&headers, false).is_ok());
        assert!(human_session(&headers, true).is_err());
        headers.insert("X-Grimoire-CSRF", HeaderValue::from_static("1"));
        assert!(human_session(&headers, true).is_ok());
        headers.insert(
            header::AUTHORIZATION,
            HeaderValue::from_static("Bearer agent"),
        );
        assert!(human_session(&headers, true).is_err());
        headers.remove(header::AUTHORIZATION);
        headers.append(
            header::COOKIE,
            HeaderValue::from_str(&format!("grimoire_session={}", "b".repeat(64))).unwrap(),
        );
        assert!(human_session(&headers, false).is_err());
    }
    #[test]
    fn pairing_payload_cannot_set_runtime_or_human_authority() {
        assert!(serde_json::from_value::<StartInput>(json!({"device_name":"Laptop"})).is_ok());
        for key in [
            "executable",
            "adapter",
            "can_approve",
            "organization_id",
            "credential",
        ] {
            let mut value = json!({"device_name":"Laptop"});
            value[key] = json!("forbidden");
            assert!(serde_json::from_value::<StartInput>(value).is_err());
        }
        assert!(
            serde_json::from_value::<ConsentInput>(
                json!({"organization_id":Uuid::new_v4(),"consent":true})
            )
            .is_err()
        );
    }
    #[test]
    fn mounted_organization_must_be_one_unambiguous_identifier() {
        let mut headers = HeaderMap::new();
        assert!(mounted_organization(&headers).is_err());
        let id = Uuid::new_v4();
        headers.insert(
            "X-Grimoire-Organization",
            HeaderValue::from_str(&id.to_string()).unwrap(),
        );
        assert_eq!(mounted_organization(&headers).ok(), Some(id));
        headers.append(
            "X-Grimoire-Organization",
            HeaderValue::from_str(&id.to_string()).unwrap(),
        );
        assert!(mounted_organization(&headers).is_err());
    }
}
