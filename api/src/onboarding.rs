use axum::{
    Json, Router,
    extract::{State, rejection::JsonRejection},
    http::{HeaderMap, HeaderValue, StatusCode, header},
    response::IntoResponse,
    routing::{get, post},
};
use chrono::{TimeDelta, Utc};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use serde_json::json;
use sha2::{Digest, Sha256};
use sqlx::{FromRow, PgPool};
use uuid::Uuid;

use crate::{Actor, ApiError, ApiResult, Tx};

const SESSION_COOKIE: &str = "grimoire_session";
const SESSION_SECONDS: i64 = 30 * 24 * 60 * 60;

#[derive(Deserialize)]
struct OwnerSetupInput {
    login_name: String,
    display_name: String,
    passphrase: String,
}

#[derive(Deserialize)]
struct LoginInput {
    login_name: String,
    passphrase: String,
}

#[derive(Deserialize)]
struct OrganizationInput {
    name: String,
}

#[derive(Deserialize)]
struct OrganizationSwitchInput {
    organization_id: String,
}

#[derive(FromRow)]
struct SessionContextRow {
    identity_id: Uuid,
    login_name: String,
    handler_display_name: String,
    installation_owner: bool,
    principal_id: Option<Uuid>,
    org_id: Option<Uuid>,
    organization_name: Option<String>,
    can_write: Option<bool>,
}

#[derive(FromRow, Serialize)]
struct OrganizationSummary {
    org_id: Uuid,
    organization_name: String,
    is_active: bool,
    joined_at: chrono::DateTime<Utc>,
}

#[derive(Serialize)]
struct HandlerIdentity {
    identity_id: Uuid,
    login_name: String,
    display_name: String,
    installation_owner: bool,
}

#[derive(Serialize)]
struct SessionState {
    handler: HandlerIdentity,
    organizations: Vec<OrganizationSummary>,
    active_organization: Option<Actor>,
}

#[derive(FromRow)]
struct OrganizationCreation {
    org_id: Uuid,
    replayed: bool,
}

pub(crate) fn routes() -> Router<PgPool> {
    Router::new()
        .route("/api/setup/status", get(setup_status))
        .route("/api/setup/owner", post(setup_owner))
        .route("/api/session/login", post(login))
        .route("/api/session", get(current_session).delete(logout))
        .route(
            "/api/session/active-organization",
            post(switch_organization),
        )
        .route("/api/organizations", post(create_organization))
}

pub(crate) fn has_session_cookie(headers: &HeaderMap) -> bool {
    session_token(headers).is_some()
}

fn session_token(headers: &HeaderMap) -> Option<&str> {
    headers
        .get_all(header::COOKIE)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .flat_map(|cookies| cookies.split(';'))
        .filter_map(|cookie| cookie.trim().split_once('='))
        .find_map(|(name, value)| {
            (name == SESSION_COOKIE
                && value.len() == 64
                && value
                    .bytes()
                    .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase()))
            .then_some(value)
        })
}

fn session_hash(headers: &HeaderMap) -> Result<String, ApiError> {
    session_token(headers)
        .map(|token| format!("{:x}", Sha256::digest(token.as_bytes())))
        .ok_or_else(ApiError::unauthorized)
}

fn new_session() -> (String, String, chrono::DateTime<Utc>) {
    let token = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
    let hash = format!("{:x}", Sha256::digest(token.as_bytes()));
    (
        token,
        hash,
        Utc::now() + TimeDelta::seconds(SESSION_SECONDS),
    )
}

fn session_cookie(token: &str) -> Result<HeaderValue, ApiError> {
    // Development is loopback HTTP, so Secure cannot be used without breaking
    // the local browser. SameSite=Strict + the write marker provide CSRF denial.
    HeaderValue::from_str(&format!(
        "{SESSION_COOKIE}={token}; Path=/api; HttpOnly; SameSite=Strict; Max-Age={SESSION_SECONDS}"
    ))
    .map_err(|_| {
        ApiError(
            StatusCode::INTERNAL_SERVER_ERROR,
            "INTERNAL_ERROR",
            "The session cookie could not be created.".into(),
        )
    })
}

fn clear_session_cookie() -> HeaderValue {
    HeaderValue::from_static("grimoire_session=; Path=/api; HttpOnly; SameSite=Strict; Max-Age=0")
}

fn parse_json<T: DeserializeOwned>(input: Result<Json<T>, JsonRejection>) -> Result<T, ApiError> {
    input.map(|Json(value)| value).map_err(|_| {
        ApiError(
            StatusCode::UNPROCESSABLE_ENTITY,
            "INVALID_REQUEST",
            "Provide a valid JSON request with the required fields.".into(),
        )
    })
}

fn normalize_login(value: &str) -> Result<String, ApiError> {
    let value = value.trim().to_ascii_lowercase();
    let valid = (3..=64).contains(&value.len())
        && value
            .as_bytes()
            .first()
            .is_some_and(u8::is_ascii_alphanumeric)
        && value.bytes().all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || b"._-".contains(&byte)
        });
    if valid {
        Ok(value)
    } else {
        Err(ApiError(
            StatusCode::UNPROCESSABLE_ENTITY,
            "INVALID_LOGIN_NAME",
            "Use 3–64 letters, numbers, dots, underscores, or hyphens; begin with a letter or number.".into(),
        ))
    }
}

fn validate_display_name(value: &str) -> Result<String, ApiError> {
    let value = value.trim();
    if !value.is_empty() && value.chars().count() <= 120 {
        Ok(value.to_owned())
    } else {
        Err(ApiError(
            StatusCode::UNPROCESSABLE_ENTITY,
            "INVALID_DISPLAY_NAME",
            "Handler name must contain 1–120 characters.".into(),
        ))
    }
}

fn validate_passphrase(value: &str) -> Result<(), ApiError> {
    if (12..=72).contains(&value.len()) && value.is_ascii() {
        Ok(())
    } else {
        Err(ApiError(
            StatusCode::UNPROCESSABLE_ENTITY,
            "INVALID_PASSPHRASE",
            "Use an ASCII passphrase containing 12–72 characters.".into(),
        ))
    }
}

fn validate_organization_name(value: &str) -> Result<String, ApiError> {
    let value = value.trim();
    if !value.is_empty() && value.chars().count() <= 160 {
        Ok(value.to_owned())
    } else {
        Err(ApiError(
            StatusCode::UNPROCESSABLE_ENTITY,
            "INVALID_ORGANIZATION_NAME",
            "Organization name must contain 1–160 characters.".into(),
        ))
    }
}

async fn setup_status(State(pool): State<PgPool>) -> ApiResult {
    let required: bool = sqlx::query_scalar("SELECT app.intake_installation_setup_required()")
        .fetch_one(&pool)
        .await?;
    Ok(Json(json!({"setup_required":required})).into_response())
}

async fn setup_owner(
    State(pool): State<PgPool>,
    headers: HeaderMap,
    input: Result<Json<OwnerSetupInput>, JsonRejection>,
) -> ApiResult {
    // Setup is deliberately one-time and unauthenticated. Existing sessions,
    // agents, and seeded bearer identities cannot act as the installation owner.
    if headers.contains_key(header::AUTHORIZATION) {
        return Err(ApiError(
            StatusCode::FORBIDDEN,
            "INSTALLATION_SETUP_IDENTITY_DENIED",
            "Installation-owner setup cannot be invoked with a seeded or agent bearer identity.".into(),
        ));
    }
    let input = parse_json(input)?;
    let login = normalize_login(&input.login_name)?;
    let display = validate_display_name(&input.display_name)?;
    validate_passphrase(&input.passphrase)?;
    let (token, hash, expiry) = new_session();
    let mut tx = pool.begin().await?;
    let _: Uuid = sqlx::query_scalar("SELECT app.intake_setup_owner($1,$2,$3,$4,$5)")
        .bind(login)
        .bind(display)
        .bind(input.passphrase)
        .bind(&hash)
        .bind(expiry)
        .fetch_one(&mut *tx)
        .await?;
    tx.commit().await?;
    let state = load_session_state(&pool, &hash).await?;
    state_response(
        StatusCode::CREATED,
        state,
        Some(session_cookie(&token)?),
        false,
    )
}

async fn login(
    State(pool): State<PgPool>,
    input: Result<Json<LoginInput>, JsonRejection>,
) -> ApiResult {
    let input = parse_json(input)?;
    let login = normalize_login(&input.login_name)?;
    validate_passphrase(&input.passphrase)?;
    let (token, hash, expiry) = new_session();
    let mut tx = pool.begin().await?;
    let identity: Option<Uuid> = sqlx::query_scalar("SELECT app.intake_login($1,$2,$3,$4)")
        .bind(login)
        .bind(input.passphrase)
        .bind(&hash)
        .bind(expiry)
        .fetch_one(&mut *tx)
        .await?;
    if identity.is_none() {
        return Err(ApiError::unauthorized());
    }
    tx.commit().await?;
    let state = load_session_state(&pool, &hash).await?;
    state_response(StatusCode::OK, state, Some(session_cookie(&token)?), false)
}

async fn current_session(State(pool): State<PgPool>, headers: HeaderMap) -> ApiResult {
    let hash = session_hash(&headers)?;
    Ok(Json(load_session_state(&pool, &hash).await?).into_response())
}

async fn logout(State(pool): State<PgPool>, headers: HeaderMap) -> ApiResult {
    if let Ok(hash) = session_hash(&headers) {
        let _: bool = sqlx::query_scalar("SELECT app.intake_revoke_session($1)")
            .bind(hash)
            .fetch_one(&pool)
            .await?;
    }
    let mut response = StatusCode::NO_CONTENT.into_response();
    response
        .headers_mut()
        .insert(header::SET_COOKIE, clear_session_cookie());
    Ok(response)
}

async fn switch_organization(
    State(pool): State<PgPool>,
    headers: HeaderMap,
    input: Result<Json<OrganizationSwitchInput>, JsonRejection>,
) -> ApiResult {
    let hash = session_hash(&headers)?;
    let input = parse_json(input)?;
    let wanted = Uuid::parse_str(&input.organization_id).map_err(|_| {
        ApiError(
            StatusCode::NOT_FOUND,
            "ORGANIZATION_NOT_FOUND",
            "Organization not found.".into(),
        )
    })?;
    let switched: bool = sqlx::query_scalar("SELECT app.intake_switch_organization($1,$2)")
        .bind(&hash)
        .bind(wanted)
        .fetch_one(&pool)
        .await?;
    if !switched {
        return Err(ApiError(
            StatusCode::NOT_FOUND,
            "ORGANIZATION_NOT_FOUND",
            "Organization not found.".into(),
        ));
    }
    Ok(Json(load_session_state(&pool, &hash).await?).into_response())
}

async fn create_organization(
    State(pool): State<PgPool>,
    headers: HeaderMap,
    input: Result<Json<OrganizationInput>, JsonRejection>,
) -> ApiResult {
    let hash = session_hash(&headers)?;
    let input = parse_json(input)?;
    let name = validate_organization_name(&input.name)?;
    let key = crate::key(&headers)?;
    let request_hash = format!(
        "{:x}",
        Sha256::digest(format!("POST\n/api/organizations\n{name}").as_bytes())
    );
    let mut tx = pool.begin().await?;
    let created = sqlx::query_as::<_, OrganizationCreation>(
        "SELECT * FROM app.intake_create_organization($1,$2,$3,$4)",
    )
    .bind(&hash)
    .bind(key)
    .bind(request_hash)
    .bind(name)
    .fetch_one(&mut *tx)
    .await?;
    tx.commit().await?;
    let state = load_session_state(&pool, &hash).await?;
    let mut response = state_response(StatusCode::CREATED, state, None, created.replayed)?;
    response.headers_mut().insert(
        header::LOCATION,
        HeaderValue::from_str(&format!("/api/organizations/{}", created.org_id)).map_err(|_| {
            ApiError(
                StatusCode::INTERNAL_SERVER_ERROR,
                "INTERNAL_ERROR",
                "The organization location could not be encoded.".into(),
            )
        })?,
    );
    Ok(response)
}

fn state_response(
    status: StatusCode,
    state: SessionState,
    cookie: Option<HeaderValue>,
    replayed: bool,
) -> ApiResult {
    let mut response = (status, Json(state)).into_response();
    if let Some(cookie) = cookie {
        response.headers_mut().insert(header::SET_COOKIE, cookie);
    }
    if replayed {
        response
            .headers_mut()
            .insert("Idempotency-Replayed", HeaderValue::from_static("true"));
    }
    Ok(response)
}

async fn load_session_state(pool: &PgPool, hash: &str) -> Result<SessionState, ApiError> {
    let mut tx = pool.begin().await?;
    let row =
        sqlx::query_as::<_, SessionContextRow>("SELECT * FROM app.intake_session_context($1)")
            .bind(hash)
            .fetch_optional(&mut *tx)
            .await?
            .ok_or_else(ApiError::unauthorized)?;
    let organizations = sqlx::query_as::<_, OrganizationSummary>(
        "SELECT * FROM app.intake_session_organizations($1)",
    )
    .bind(hash)
    .fetch_all(&mut *tx)
    .await?;
    let active_organization = active_actor(&mut tx, &row).await?;
    tx.commit().await?;
    Ok(SessionState {
        handler: HandlerIdentity {
            identity_id: row.identity_id,
            login_name: row.login_name,
            display_name: row.handler_display_name,
            installation_owner: row.installation_owner,
        },
        organizations,
        active_organization,
    })
}

async fn active_actor(tx: &mut Tx, row: &SessionContextRow) -> Result<Option<Actor>, ApiError> {
    let (Some(principal_id), Some(org_id), Some(organization_name)) =
        (row.principal_id, row.org_id, row.organization_name.clone())
    else {
        return Ok(None);
    };
    sqlx::query("SELECT set_config('app.current_org_id',$1,true),set_config('app.current_principal_id',$2,true),set_config('app.request_id',$3,true),set_config('statement_timeout','10000',true),set_config('lock_timeout','5000',true)")
        .bind(org_id.to_string())
        .bind(principal_id.to_string())
        .bind(Uuid::new_v4().to_string())
        .execute(&mut **tx)
        .await?;
    let capabilities: (bool, bool, bool) = sqlx::query_as(
        "SELECT app.intake_scope_can_confirm(),app.intake_scope_can_propose(),app.intake_scope_is_agent()",
    )
    .fetch_one(&mut **tx)
    .await?;
    Ok(Some(Actor {
        principal_id,
        org_id,
        display_name: row.handler_display_name.clone(),
        organization_name,
        can_write: row.can_write.unwrap_or(false),
        can_confirm_scope: capabilities.0,
        can_propose_scope: capabilities.1,
        is_agent: capabilities.2,
    }))
}

pub(crate) async fn authenticate_session(
    pool: &PgPool,
    headers: &HeaderMap,
) -> Result<(Tx, Actor), ApiError> {
    let hash = session_hash(headers)?;
    let mut tx = pool.begin().await?;
    let mut actor = sqlx::query_as::<_, Actor>("SELECT * FROM app.intake_session_authenticate($1)")
        .bind(hash)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or_else(|| {
            ApiError(
                StatusCode::CONFLICT,
                "ACTIVE_ORGANIZATION_REQUIRED",
                "Create or select an organization before opening its workspace.".into(),
            )
        })?;
    sqlx::query("SELECT set_config('app.current_org_id',$1,true),set_config('app.current_principal_id',$2,true),set_config('app.request_id',$3,true),set_config('statement_timeout','10000',true),set_config('lock_timeout','5000',true)")
        .bind(actor.org_id.to_string())
        .bind(actor.principal_id.to_string())
        .bind(Uuid::new_v4().to_string())
        .execute(&mut *tx)
        .await?;
    let capabilities: (bool, bool, bool) = sqlx::query_as(
        "SELECT app.intake_scope_can_confirm(),app.intake_scope_can_propose(),app.intake_scope_is_agent()",
    )
    .fetch_one(&mut *tx)
    .await?;
    actor.can_confirm_scope = capabilities.0;
    actor.can_propose_scope = capabilities.1;
    actor.is_agent = capabilities.2;
    if actor.is_agent {
        actor.can_write = false;
    }
    Ok((tx, actor))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn session_cookie_requires_exact_lowercase_token() {
        let mut headers = HeaderMap::new();
        headers.insert(
            header::COOKIE,
            HeaderValue::from_static("other=x; grimoire_session=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"),
        );
        assert!(has_session_cookie(&headers));
        headers.insert(
            header::COOKIE,
            HeaderValue::from_static(
                "grimoire_session=ABCDEF0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
            ),
        );
        assert!(!has_session_cookie(&headers));
    }

    #[test]
    fn login_names_are_canonical_and_bounded() {
        assert_eq!(
            normalize_login("  Owner.One ").ok().as_deref(),
            Some("owner.one")
        );
        assert!(normalize_login("-owner").is_err());
        assert!(normalize_login("ab").is_err());
    }
}
