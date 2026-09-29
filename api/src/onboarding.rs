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
use std::sync::OnceLock;
use uuid::Uuid;

use crate::{Actor, ApiError, ApiResult, Tx};

const SESSION_COOKIE: &str = "grimoire_session";
const GOOGLE_CHALLENGE_COOKIE: &str = "grimoire_google_challenge";
const SESSION_SECONDS: i64 = 30 * 24 * 60 * 60;
const GOOGLE_CHALLENGE_SECONDS: i64 = 5 * 60;
static COOKIE_SECURE: OnceLock<bool> = OnceLock::new();

pub(crate) fn initialize() -> Result<(), &'static str> {
    let configured = match std::env::var("GRIMOIRE_COOKIE_SECURE") {
        Ok(value) => Some(value),
        Err(std::env::VarError::NotPresent) => None,
        Err(std::env::VarError::NotUnicode(_)) => {
            return Err("GRIMOIRE_COOKIE_SECURE must be true or false; use true behind HTTPS.");
        }
    };
    let secure = parse_cookie_security(configured.as_deref())?;
    COOKIE_SECURE
        .set(secure)
        .map_err(|_| "Handler session configuration has already been initialized.")
}

fn parse_cookie_security(value: Option<&str>) -> Result<bool, &'static str> {
    match value {
        None | Some("false") => Ok(false),
        Some("true") => Ok(true),
        _ => Err("GRIMOIRE_COOKIE_SECURE must be true or false; use true behind HTTPS."),
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RegistrationInput {
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
#[serde(deny_unknown_fields)]
struct ProfileInput {
    display_name: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct GoogleLoginInput {
    credential: String,
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
        .route("/api/session/signup", post(signup))
        .route("/api/session/login", post(login))
        .route("/api/session/google/config", get(google_config))
        .route("/api/session/google/challenge", post(google_challenge))
        .route("/api/session/google", post(google_login))
        .route("/api/session", get(current_session).delete(logout))
        .route("/api/session/profile", post(update_profile))
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
    cookie_token(headers, SESSION_COOKIE)
}

fn cookie_token<'a>(headers: &'a HeaderMap, wanted_name: &str) -> Option<&'a str> {
    let mut values = headers
        .get_all(header::COOKIE)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .flat_map(|cookies| cookies.split(';'))
        .filter_map(|cookie| cookie.trim().split_once('='))
        .filter_map(|(name, value)| (name == wanted_name).then_some(value));
    let value = values.next()?;
    (values.next().is_none()
        && value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase()))
    .then_some(value)
}

fn session_hash(headers: &HeaderMap) -> Result<String, ApiError> {
    session_token(headers)
        .map(|token| format!("{:x}", Sha256::digest(token.as_bytes())))
        .ok_or_else(ApiError::unauthorized)
}

fn new_session() -> (String, String, chrono::DateTime<Utc>) {
    let (token, hash) = new_opaque_token();
    (
        token,
        hash,
        Utc::now() + TimeDelta::seconds(SESSION_SECONDS),
    )
}

fn new_opaque_token() -> (String, String) {
    let token = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
    let hash = format!("{:x}", Sha256::digest(token.as_bytes()));
    (token, hash)
}

fn session_cookie(token: &str) -> Result<HeaderValue, ApiError> {
    make_session_cookie(
        token,
        SESSION_SECONDS,
        *COOKIE_SECURE.get().unwrap_or(&false),
    )
}

fn make_session_cookie(token: &str, seconds: i64, secure: bool) -> Result<HeaderValue, ApiError> {
    make_cookie(SESSION_COOKIE, token, seconds, secure)
}

fn make_cookie(
    name: &str,
    token: &str,
    seconds: i64,
    secure: bool,
) -> Result<HeaderValue, ApiError> {
    // HTTPS is an explicit deployment setting, never inferred from caller-controlled
    // Forwarded headers. Local loopback HTTP keeps the default false.
    let secure_attribute = if secure { "; Secure" } else { "" };
    HeaderValue::from_str(&format!(
        "{name}={token}; Path=/api; HttpOnly; SameSite=Strict; Max-Age={seconds}{secure_attribute}"
    ))
    .map_err(|_| {
        ApiError(
            StatusCode::INTERNAL_SERVER_ERROR,
            "INTERNAL_ERROR",
            "The session cookie could not be created.".into(),
        )
    })
}

fn clear_session_cookie() -> Result<HeaderValue, ApiError> {
    make_session_cookie("", 0, *COOKIE_SECURE.get().unwrap_or(&false))
}

fn google_challenge_cookie(token: &str, seconds: i64) -> Result<HeaderValue, ApiError> {
    make_cookie(
        GOOGLE_CHALLENGE_COOKIE,
        token,
        seconds,
        *COOKIE_SECURE.get().unwrap_or(&false),
    )
}

fn google_challenge_hash(headers: &HeaderMap) -> Option<String> {
    cookie_token(headers, GOOGLE_CHALLENGE_COOKIE)
        .map(|token| format!("{:x}", Sha256::digest(token.as_bytes())))
}

fn require_google_browser(headers: &HeaderMap) -> Result<(), ApiError> {
    require_browser_request(headers)?;
    if headers.contains_key(header::AUTHORIZATION) {
        return Err(ApiError(
            StatusCode::FORBIDDEN,
            "GOOGLE_SIGN_IN_IDENTITY_DENIED",
            "Google sign-in cannot be invoked with a seeded or agent bearer identity.".into(),
        ));
    }
    Ok(())
}

fn require_google_configuration() -> Result<&'static str, ApiError> {
    crate::google_identity::client_id().ok_or_else(|| {
        ApiError(
            StatusCode::SERVICE_UNAVAILABLE,
            "GOOGLE_SIGN_IN_UNAVAILABLE",
            "Google sign-in is not configured for this installation.".into(),
        )
    })
}

fn invalid_google_challenge() -> ApiError {
    ApiError(
        StatusCode::UNAUTHORIZED,
        "GOOGLE_CHALLENGE_EXPIRED",
        "Start Google sign-in again. The browser challenge is missing, expired, or already used."
            .into(),
    )
}

fn require_browser_request(headers: &HeaderMap) -> Result<(), ApiError> {
    let mut markers = headers.get_all("X-Grimoire-CSRF").iter();
    if markers.next().and_then(|value| value.to_str().ok()) == Some("1") && markers.next().is_none()
    {
        Ok(())
    } else {
        Err(ApiError::csrf())
    }
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
    if !value.is_empty() && value.chars().count() <= 120 && !value.contains('\0') {
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
    if (12..=72).contains(&value.len()) && value.is_ascii() && !value.contains('\0') {
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
    input: Result<Json<RegistrationInput>, JsonRejection>,
) -> ApiResult {
    require_browser_request(&headers)?;
    // Setup is deliberately one-time and unauthenticated. A stale browser
    // cookie is harmless because PostgreSQL's singleton setup row remains the
    // authority; agents and seeded bearer identities are rejected explicitly.
    if headers.contains_key(header::AUTHORIZATION) {
        return Err(ApiError(
            StatusCode::FORBIDDEN,
            "INSTALLATION_SETUP_IDENTITY_DENIED",
            "Installation-owner setup cannot be invoked with a seeded or agent bearer identity."
                .into(),
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

async fn signup(
    State(pool): State<PgPool>,
    headers: HeaderMap,
    input: Result<Json<RegistrationInput>, JsonRejection>,
) -> ApiResult {
    require_browser_request(&headers)?;
    if headers.contains_key(header::AUTHORIZATION) {
        return Err(ApiError(
            StatusCode::FORBIDDEN,
            "HANDLER_REGISTRATION_IDENTITY_DENIED",
            "Handler signup cannot be invoked with a seeded or agent bearer identity.".into(),
        ));
    }
    let input = parse_json(input)?;
    let login = normalize_login(&input.login_name)?;
    let display = validate_display_name(&input.display_name)?;
    validate_passphrase(&input.passphrase)?;
    let (token, hash, expiry) = new_session();
    let mut tx = pool.begin().await?;
    let _: Uuid = sqlx::query_scalar("SELECT app.intake_register_handler($1,$2,$3,$4,$5)")
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
    headers: HeaderMap,
    input: Result<Json<LoginInput>, JsonRejection>,
) -> ApiResult {
    require_browser_request(&headers)?;
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

async fn google_config() -> ApiResult {
    let client_id = crate::google_identity::client_id();
    Ok(Json(json!({"enabled":client_id.is_some(),"client_id":client_id})).into_response())
}

async fn google_challenge(State(pool): State<PgPool>, headers: HeaderMap) -> ApiResult {
    require_google_browser(&headers)?;
    let client_id = require_google_configuration()?;
    let (cookie, cookie_hash) = new_opaque_token();
    let (nonce, nonce_hash) = new_opaque_token();
    let expiry = Utc::now() + TimeDelta::seconds(GOOGLE_CHALLENGE_SECONDS);
    let created: bool =
        sqlx::query_scalar("SELECT app.intake_google_challenge_create($1,$2,$3,$4)")
            .bind(cookie_hash)
            .bind(nonce_hash)
            .bind(expiry)
            .bind(google_challenge_hash(&headers))
            .fetch_one(&pool)
            .await?;
    if !created {
        return Err(ApiError(
            StatusCode::TOO_MANY_REQUESTS,
            "GOOGLE_SIGN_IN_BUSY",
            "Google sign-in is temporarily busy. Try again shortly.".into(),
        ));
    }
    let mut response = Json(json!({
        "client_id":client_id,"nonce":nonce,"expires_at":expiry,
    }))
    .into_response();
    response.headers_mut().insert(
        header::SET_COOKIE,
        google_challenge_cookie(&cookie, GOOGLE_CHALLENGE_SECONDS)?,
    );
    Ok(response)
}

async fn google_login(
    State(pool): State<PgPool>,
    headers: HeaderMap,
    input: Result<Json<GoogleLoginInput>, JsonRejection>,
) -> ApiResult {
    require_google_browser(&headers)?;
    require_google_configuration()?;
    let input = parse_json(input)?;
    let challenge_hash = google_challenge_hash(&headers).ok_or_else(invalid_google_challenge)?;
    let nonce_hash: Option<String> =
        sqlx::query_scalar("SELECT app.intake_google_challenge_nonce($1)")
            .bind(&challenge_hash)
            .fetch_one(&pool)
            .await?;
    let nonce_hash = nonce_hash.ok_or_else(invalid_google_challenge)?;
    // Only the verified Google subject crosses this boundary. Email, caller
    // identity IDs, organization IDs, and client-provided profile data do not.
    let verified = crate::google_identity::verify(&input.credential, &nonce_hash).await?;
    let display = validate_display_name(&verified.display_name)?;
    let (token, hash, expiry) = new_session();
    // The single definer call atomically consumes the challenge and creates or
    // resumes its subject's identity/session. Concurrent callbacks cannot replay.
    let identity: Option<Uuid> =
        sqlx::query_scalar("SELECT app.intake_google_login($1,$2,$3,$4,$5,$6)")
            .bind(challenge_hash)
            .bind(nonce_hash)
            .bind(verified.subject)
            .bind(display)
            .bind(&hash)
            .bind(expiry)
            .fetch_one(&pool)
            .await?;
    if identity.is_none() {
        return Err(invalid_google_challenge());
    }
    let state = load_session_state(&pool, &hash).await?;
    let mut response = state_response(StatusCode::OK, state, Some(session_cookie(&token)?), false)?;
    response
        .headers_mut()
        .append(header::SET_COOKIE, google_challenge_cookie("", 0)?);
    Ok(response)
}

async fn logout(State(pool): State<PgPool>, headers: HeaderMap) -> ApiResult {
    require_browser_request(&headers)?;
    if let Ok(hash) = session_hash(&headers) {
        let _: bool = sqlx::query_scalar("SELECT app.intake_revoke_session($1)")
            .bind(hash)
            .fetch_one(&pool)
            .await?;
    }
    if let Some(hash) = google_challenge_hash(&headers) {
        let _: bool = sqlx::query_scalar("SELECT app.intake_google_challenge_revoke($1)")
            .bind(hash)
            .fetch_one(&pool)
            .await?;
    }
    let mut response = StatusCode::NO_CONTENT.into_response();
    response
        .headers_mut()
        .insert(header::SET_COOKIE, clear_session_cookie()?);
    response
        .headers_mut()
        .append(header::SET_COOKIE, google_challenge_cookie("", 0)?);
    Ok(response)
}

async fn update_profile(
    State(pool): State<PgPool>,
    headers: HeaderMap,
    input: Result<Json<ProfileInput>, JsonRejection>,
) -> ApiResult {
    require_browser_request(&headers)?;
    // This is a self-service Handler action. A bearer credential must never
    // become authority to edit a human identity, even with a browser cookie.
    if headers.contains_key(header::AUTHORIZATION) {
        return Err(ApiError::unauthorized());
    }
    let hash = session_hash(&headers)?;
    let display = validate_display_name(&parse_json(input)?.display_name)?;
    let mut tx = pool.begin().await?;
    let changed: bool = sqlx::query_scalar("SELECT app.intake_update_handler_profile($1,$2)")
        .bind(&hash)
        .bind(display)
        .fetch_one(&mut *tx)
        .await?;
    if !changed {
        return Err(ApiError::unauthorized());
    }
    tx.commit().await?;
    Ok(Json(load_session_state(&pool, &hash).await?).into_response())
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
    let mut tx = pool.begin().await?;
    require_session(&mut tx, &hash).await?;
    let switched: bool = sqlx::query_scalar("SELECT app.intake_switch_organization($1,$2)")
        .bind(&hash)
        .bind(wanted)
        .fetch_one(&mut *tx)
        .await?;
    if !switched {
        return Err(ApiError(
            StatusCode::NOT_FOUND,
            "ORGANIZATION_NOT_FOUND",
            "Organization not found.".into(),
        ));
    }
    tx.commit().await?;
    Ok(Json(load_session_state(&pool, &hash).await?).into_response())
}

#[cfg(test)]
#[path = "onboarding_profile_tests.rs"]
mod profile_tests;

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
    require_session(&mut tx, &hash).await?;
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

async fn require_session(tx: &mut Tx, hash: &str) -> Result<(), ApiError> {
    let valid: bool =
        sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM app.intake_session_context($1))")
            .bind(hash)
            .fetch_one(&mut **tx)
            .await?;
    if valid {
        Ok(())
    } else {
        Err(ApiError::unauthorized())
    }
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
    let capabilities: (bool, bool, bool, bool, bool) = sqlx::query_as(
        "SELECT app.intake_scope_can_confirm(),app.intake_scope_can_propose(),app.intake_scope_is_agent(),app.intake_can_write(),app.intake_can_manage_workspace()",
    )
    .fetch_one(&mut **tx)
    .await?;
    Ok(Some(Actor {
        principal_id,
        org_id,
        display_name: row.handler_display_name.clone(),
        organization_name,
        can_write: capabilities.3 && !capabilities.2,
        can_manage_workspace: capabilities.4 && !capabilities.2,
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
    let row =
        sqlx::query_as::<_, SessionContextRow>("SELECT * FROM app.intake_session_context($1)")
            .bind(hash)
            .fetch_optional(&mut *tx)
            .await?
            .ok_or_else(ApiError::unauthorized)?;
    let actor = active_actor(&mut tx, &row).await?.ok_or_else(|| {
        ApiError(
            StatusCode::CONFLICT,
            "ACTIVE_ORGANIZATION_REQUIRED",
            "Create or select an organization before opening its workspace.".into(),
        )
    })?;
    validate_organization(headers, actor.org_id)?;
    Ok((tx, actor))
}

fn validate_organization(headers: &HeaderMap, active_org: Uuid) -> Result<(), ApiError> {
    let mut values = headers.get_all("X-Grimoire-Organization").iter();
    let expected = values
        .next()
        .and_then(|value| value.to_str().ok())
        .and_then(|value| Uuid::parse_str(value).ok());
    if expected == Some(active_org) && values.next().is_none() {
        Ok(())
    } else {
        Err(ApiError(
            StatusCode::CONFLICT,
            "ACTIVE_ORGANIZATION_CHANGED",
            "The active organization changed. Reload the workspace before continuing.".into(),
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pre_session_writes_require_one_browser_marker() {
        let mut headers = HeaderMap::new();
        assert_eq!(
            require_browser_request(&headers).unwrap_err().1,
            "SESSION_REQUEST_DENIED"
        );
        headers.insert("X-Grimoire-CSRF", HeaderValue::from_static("1"));
        assert!(require_browser_request(&headers).is_ok());
        headers.append("X-Grimoire-CSRF", HeaderValue::from_static("1"));
        assert!(require_browser_request(&headers).is_err());
    }

    #[test]
    fn explicit_https_policy_applies_to_set_and_clear_cookies() {
        assert_eq!(parse_cookie_security(None), Ok(false));
        assert_eq!(parse_cookie_security(Some("false")), Ok(false));
        assert_eq!(parse_cookie_security(Some("true")), Ok(true));
        assert!(parse_cookie_security(Some("tru")).is_err());
        for seconds in [SESSION_SECONDS, 0] {
            let secure = make_session_cookie("opaque", seconds, true).ok().unwrap();
            let local = make_session_cookie("opaque", seconds, false).ok().unwrap();
            assert!(secure.to_str().unwrap().ends_with("; Secure"));
            assert!(
                secure
                    .to_str()
                    .unwrap()
                    .contains("HttpOnly; SameSite=Strict")
            );
            assert!(!local.to_str().unwrap().contains("Secure"));
        }
    }

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
    fn google_challenge_cookie_is_independent_and_unambiguous() {
        let token = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
        let mut headers = HeaderMap::new();
        headers.insert(
            header::COOKIE,
            HeaderValue::from_str(&format!("{SESSION_COOKIE}={token}")).unwrap(),
        );
        assert!(google_challenge_hash(&headers).is_none());
        headers.append(
            header::COOKIE,
            HeaderValue::from_str(&format!("{GOOGLE_CHALLENGE_COOKIE}={token}")).unwrap(),
        );
        assert!(google_challenge_hash(&headers).is_some());
        headers.append(
            header::COOKIE,
            HeaderValue::from_str(&format!("{GOOGLE_CHALLENGE_COOKIE}=invalid")).unwrap(),
        );
        assert!(google_challenge_hash(&headers).is_none());
        for seconds in [GOOGLE_CHALLENGE_SECONDS, 0] {
            let cookie = make_cookie(GOOGLE_CHALLENGE_COOKIE, token, seconds, true)
                .ok()
                .unwrap();
            let cookie = cookie.to_str().unwrap();
            assert!(cookie.starts_with("grimoire_google_challenge="));
            assert!(cookie.contains("Path=/api; HttpOnly; SameSite=Strict"));
            assert!(cookie.ends_with("; Secure"));
        }
    }

    #[test]
    fn google_sign_in_accepts_only_browser_credentials() {
        let mut headers = HeaderMap::new();
        assert!(require_google_browser(&headers).is_err());
        headers.insert("X-Grimoire-CSRF", HeaderValue::from_static("1"));
        assert!(require_google_browser(&headers).is_ok());
        headers.insert(
            header::AUTHORIZATION,
            HeaderValue::from_static("Bearer seed"),
        );
        assert_eq!(
            require_google_browser(&headers).unwrap_err().1,
            "GOOGLE_SIGN_IN_IDENTITY_DENIED"
        );
        assert!(
            serde_json::from_value::<GoogleLoginInput>(json!({
                "credential":"signed-jwt", "organization_id":Uuid::new_v4(),
            }))
            .is_err()
        );
        assert!(
            serde_json::from_value::<GoogleLoginInput>(json!({
                "credential":"signed-jwt", "email":"claimed@example.invalid",
            }))
            .is_err()
        );
    }

    #[test]
    fn login_names_are_canonical_and_bounded() {
        assert_eq!(
            normalize_login("  Owner.One ").ok().as_deref(),
            Some("owner.one")
        );
        assert!(normalize_login("-owner").is_err());
        assert!(normalize_login("ab").is_err());
        assert!(validate_display_name("Synthetic\0Handler").is_err());
        assert!(validate_passphrase("synthetic\0passphrase").is_err());
    }

    #[test]
    fn workspace_request_must_pin_the_canonical_active_organization() {
        let active = Uuid::new_v4();
        let foreign = Uuid::new_v4();
        let mut headers = HeaderMap::new();
        assert_eq!(
            validate_organization(&headers, active).unwrap_err().1,
            "ACTIVE_ORGANIZATION_CHANGED"
        );
        headers.insert(
            "X-Grimoire-Organization",
            HeaderValue::from_str(&foreign.to_string()).unwrap(),
        );
        assert!(validate_organization(&headers, active).is_err());
        headers.insert(
            "X-Grimoire-Organization",
            HeaderValue::from_str(&active.to_string()).unwrap(),
        );
        assert!(validate_organization(&headers, active).is_ok());
        headers.append(
            "X-Grimoire-Organization",
            HeaderValue::from_str(&foreign.to_string()).unwrap(),
        );
        assert!(validate_organization(&headers, active).is_err());
    }
}
