mod byoa;
mod domain;
mod error;
mod offers;
mod scope;
mod sources;
mod storage;

use axum::{
    Json, Router,
    extract::{DefaultBodyLimit, Path, State, rejection::JsonRejection},
    http::{HeaderMap, HeaderValue, StatusCode, header},
    response::{IntoResponse, Response},
    routing::get,
};
use chrono::{DateTime, Utc};
use domain::{Category, Intake, Revision, Scion};
use error::ApiError;
use serde::Serialize;
use serde_json::json;
use sha2::{Digest, Sha256};
use sqlx::{FromRow, PgPool, Postgres, Transaction, postgres::PgPoolOptions};
use std::{net::SocketAddr, time::Duration};
use uuid::Uuid;

type Tx = Transaction<'static, Postgres>;
type ApiResult = Result<Response, ApiError>;

#[derive(FromRow, Serialize)]
struct Actor {
    principal_id: Uuid,
    org_id: Uuid,
    display_name: String,
    organization_name: String,
    can_write: bool,
    #[sqlx(default)]
    can_confirm_scope: bool,
    #[sqlx(default)]
    can_propose_scope: bool,
    #[sqlx(default)]
    is_agent: bool,
}

#[derive(FromRow, Serialize)]
struct DatabaseIdentity {
    name: String,
    server_version: String,
    server_version_num: i32,
    runtime_role: String,
}

// Current directory metadata stays outside immutable revision snapshots and
// idempotency receipts. A later directory rename may change these labels only.
#[derive(FromRow, Serialize)]
struct HistoryAuthor {
    principal_id: Uuid,
    display_name: String,
}

#[derive(FromRow)]
struct RevisionRow {
    scion_id: Uuid,
    number: i32,
    name: String,
    product_description: Option<String>,
    product_category: String,
    decision: Option<String>,
    requirements: Option<sqlx::types::Json<Vec<String>>>,
    questions: Option<sqlx::types::Json<Vec<String>>>,
    change_summary: String,
    created_at: DateTime<Utc>,
    created_by: Uuid,
}

impl RevisionRow {
    fn into_revision(self) -> Revision {
        Revision {
            number: self.number,
            intake: Intake {
                name: self.name,
                product_description: self.product_description,
                product_category: match self.product_category.as_str() {
                    "physical" => Category::Physical,
                    "digital" => Category::Digital,
                    _ => Category::Unspecified,
                },
                decision: self.decision,
                requirements: self.requirements.map(|v| v.0),
                questions: self.questions.map(|v| v.0),
                change_summary: self.change_summary,
            },
            created_at: self.created_at,
            created_by: self.created_by,
        }
    }
    fn into_scion(self) -> Scion {
        Scion::from_revision(self.scion_id, self.into_revision())
    }
}

const REVISION_COLUMNS: &str = "r.scion_id,r.number,r.name,r.product_description,r.product_category,r.decision,r.requirements,r.questions,r.change_summary,r.created_at,r.created_by";
const IDENTITY_SQL: &str = "SELECT current_database()::text AS name,current_setting('server_version') AS server_version,current_setting('server_version_num')::integer AS server_version_num,current_user::text AS runtime_role";

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "grimoire_api=info".into()),
        )
        .init();
    let database_url = std::env::var("DATABASE_URL")
        .map_err(|_| "DATABASE_URL is required; use the dedicated grimoire_intake_app login.")?;
    storage::initialize()?;
    let bind: SocketAddr = std::env::var("GRIMOIRE_BIND")
        .unwrap_or_else(|_| "127.0.0.1:8080".into())
        .parse()?;
    if !bind.ip().is_loopback() {
        return Err("Layer 1 development API must bind to a loopback address.".into());
    }
    let pool = PgPoolOptions::new()
        .max_connections(12)
        .acquire_timeout(Duration::from_secs(5))
        .connect(&database_url)
        .await?;
    let identity = sqlx::query_as::<_, DatabaseIdentity>(IDENTITY_SQL)
        .fetch_one(&pool)
        .await?;
    if !(170000..180000).contains(&identity.server_version_num) {
        return Err("Grimoire Layer 1 requires PostgreSQL 17.".into());
    }
    if std::env::args().nth(1).as_deref() == Some("externalize-sources") {
        return storage::externalize(&pool)
            .await
            .map_err(|error| format!("{}: {}", error.1, error.2).into());
    }
    let unsafe_role: bool = sqlx::query_scalar("SELECT rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb FROM pg_roles WHERE rolname=current_user").fetch_one(&pool).await?;
    if identity.runtime_role != "grimoire_intake_app" || unsafe_role {
        return Err("API requires the unprivileged grimoire_intake_app runtime login.".into());
    }
    let owns_tables: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='grimoire' AND c.relowner=(SELECT oid FROM pg_roles WHERE rolname=current_user))").fetch_one(&pool).await?;
    if owns_tables {
        return Err("The API runtime must not own Grimoire tables.".into());
    }
    let migrated: bool =
        sqlx::query_scalar("SELECT to_regclass('grimoire.intake_revisions') IS NOT NULL AND to_regprocedure('app.intake_history_authors(uuid)') IS NOT NULL AND to_regclass('grimoire.intake_source_objects') IS NOT NULL AND to_regprocedure('app.intake_source_read_lock(uuid,uuid)') IS NOT NULL AND to_regclass('grimoire.intake_agent_tasks') IS NOT NULL AND to_regprocedure('app.intake_scope_has_preparer_conflict(uuid,uuid)') IS NOT NULL AND to_regclass('grimoire.intake_offer_submissions') IS NOT NULL")
            .fetch_one(&pool)
            .await?;
    if !migrated {
        return Err("Apply unchanged migrations 0022 through 0030, then additive worker/offer migrations 0031 and 0032 before starting the API.".into());
    }
    let app = Router::new()
        .route("/api/health", get(health))
        .route("/api/me", get(me))
        .route("/api/scions", get(list_scions).post(create_scion))
        .route("/api/scions/{id}", get(get_scion))
        .route(
            "/api/scions/{id}/revisions",
            get(history).post(create_revision),
        )
        .route("/api/scions/{id}/revisions/{number}", get(get_revision))
        .merge(sources::routes())
        .merge(scope::routes())
        .merge(offers::routes())
        .merge(byoa::routes())
        .fallback(|| async {
            ApiError(
                StatusCode::NOT_FOUND,
                "ROUTE_NOT_FOUND",
                "Route not found.".into(),
            )
        })
        .method_not_allowed_fallback(|| async {
            ApiError(
                StatusCode::METHOD_NOT_ALLOWED,
                "METHOD_NOT_ALLOWED",
                "This endpoint does not support that method.".into(),
            )
        })
        .layer(DefaultBodyLimit::max(256 * 1024))
        .layer(axum::middleware::map_response(security_headers))
        .with_state(pool);
    let listener = tokio::net::TcpListener::bind(bind).await?;
    tracing::info!(address=%bind,database=%identity.name,"Grimoire intake API ready");
    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown())
        .await?;
    Ok(())
}

async fn shutdown() {
    let _ = tokio::signal::ctrl_c().await;
}

async fn security_headers(mut response: Response) -> Response {
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response.headers_mut().insert(
        "X-Content-Type-Options",
        HeaderValue::from_static("nosniff"),
    );
    response
}

async fn authenticate(pool: &PgPool, headers: &HeaderMap) -> Result<(Tx, Actor), ApiError> {
    let token = headers
        .get(header::AUTHORIZATION)
        .and_then(|h| h.to_str().ok())
        .and_then(|h| h.strip_prefix("Bearer "))
        .filter(|t| !t.is_empty() && t.len() <= 512 && !t.chars().any(char::is_whitespace))
        .ok_or_else(ApiError::unauthorized)?;
    let hash = format!("{:x}", Sha256::digest(token.as_bytes()));
    let mut tx = pool.begin().await?;
    let mut actor = sqlx::query_as::<_, Actor>("SELECT * FROM app.intake_authenticate($1)")
        .bind(hash)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or_else(ApiError::unauthorized)?;
    // true means transaction-local; commit and rollback both discard these values.
    sqlx::query("SELECT set_config('app.current_org_id',$1,true),set_config('app.current_principal_id',$2,true),set_config('app.request_id',$3,true),set_config('statement_timeout','10000',true),set_config('lock_timeout','5000',true)")
        .bind(actor.org_id.to_string()).bind(actor.principal_id.to_string()).bind(Uuid::new_v4().to_string()).execute(&mut *tx).await?;
    let capabilities: (bool, bool, bool) = sqlx::query_as("SELECT app.intake_scope_can_confirm(),app.intake_scope_can_propose(),app.intake_scope_is_agent()")
        .fetch_one(&mut *tx).await?;
    actor.can_confirm_scope = capabilities.0;
    actor.can_propose_scope = capabilities.1;
    actor.is_agent = capabilities.2;
    // A proposal agent cannot inherit Handler write authority from an accidental
    // additional role. Its only write surface is explicitly scoped proposals.
    if actor.is_agent {
        actor.can_write = false;
    }
    Ok((tx, actor))
}

async fn health(State(pool): State<PgPool>) -> ApiResult {
    let identity = sqlx::query_as::<_, DatabaseIdentity>(IDENTITY_SQL)
        .fetch_one(&pool)
        .await?;
    Ok(Json(json!({"status":"ok","database":identity})).into_response())
}

async fn me(State(pool): State<PgPool>, headers: HeaderMap) -> ApiResult {
    let (tx, actor) = authenticate(&pool, &headers).await?;
    tx.commit().await?;
    Ok(Json(actor).into_response())
}

async fn list_scions(State(pool): State<PgPool>, headers: HeaderMap) -> ApiResult {
    let (mut tx, _) = authenticate(&pool, &headers).await?;
    let query = format!(
        "SELECT {REVISION_COLUMNS} FROM grimoire.intake_scions s JOIN grimoire.intake_revisions r ON (r.org_id,r.scion_id,r.number)=(s.org_id,s.id,s.current_revision) ORDER BY s.updated_at DESC,s.id"
    );
    let scions: Vec<Scion> = sqlx::query_as::<_, RevisionRow>(&query)
        .fetch_all(&mut *tx)
        .await?
        .into_iter()
        .map(RevisionRow::into_scion)
        .collect();
    tx.commit().await?;
    Ok(Json(json!({"scions":scions})).into_response())
}

fn parse_id(id: &str) -> Result<Uuid, ApiError> {
    Uuid::parse_str(id).map_err(|_| ApiError::not_found())
}

async fn get_scion(
    State(pool): State<PgPool>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> ApiResult {
    let (mut tx, _) = authenticate(&pool, &headers).await?;
    let scion = load_current(&mut tx, parse_id(&id)?).await?;
    tx.commit().await?;
    resource_response(
        StatusCode::OK,
        serde_json::to_string(&scion)?,
        etag(scion.current_revision),
        false,
    )
}

async fn history(
    State(pool): State<PgPool>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> ApiResult {
    let (mut tx, _) = authenticate(&pool, &headers).await?;
    let id = parse_id(&id)?;
    visible_revision(&mut tx, id, false).await?;
    let query = format!(
        "SELECT {REVISION_COLUMNS} FROM grimoire.intake_revisions r WHERE r.scion_id=$1 ORDER BY r.number DESC"
    );
    let revisions: Vec<Revision> = sqlx::query_as::<_, RevisionRow>(&query)
        .bind(id)
        .fetch_all(&mut *tx)
        .await?
        .into_iter()
        .map(RevisionRow::into_revision)
        .collect();
    let authors = sqlx::query_as::<_, HistoryAuthor>(
        "SELECT principal_id,display_name FROM app.intake_history_authors($1)",
    )
    .bind(id)
    .fetch_all(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(Json(json!({"revisions":revisions,"authors":authors})).into_response())
}

async fn get_revision(
    State(pool): State<PgPool>,
    headers: HeaderMap,
    Path((id, number)): Path<(String, String)>,
) -> ApiResult {
    let (mut tx, _) = authenticate(&pool, &headers).await?;
    let id = parse_id(&id)?;
    let number = number
        .parse::<i32>()
        .ok()
        .filter(|n| *n > 0)
        .ok_or_else(ApiError::not_found)?;
    visible_revision(&mut tx, id, false).await?;
    let query = format!(
        "SELECT {REVISION_COLUMNS} FROM grimoire.intake_revisions r WHERE r.scion_id=$1 AND r.number=$2"
    );
    let revision = sqlx::query_as::<_, RevisionRow>(&query)
        .bind(id)
        .bind(number)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or_else(ApiError::not_found)?
        .into_revision();
    tx.commit().await?;
    resource_response(
        StatusCode::OK,
        serde_json::to_string(&revision)?,
        etag(number),
        false,
    )
}

async fn visible_revision(tx: &mut Tx, id: Uuid, lock: bool) -> Result<i32, ApiError> {
    let query = if lock {
        "SELECT current_revision FROM grimoire.intake_scions WHERE id=$1 FOR UPDATE"
    } else {
        "SELECT current_revision FROM grimoire.intake_scions WHERE id=$1"
    };
    sqlx::query_scalar(query)
        .bind(id)
        .fetch_optional(&mut **tx)
        .await?
        .ok_or_else(ApiError::not_found)
}

async fn load_current(tx: &mut Tx, id: Uuid) -> Result<Scion, ApiError> {
    let query = format!(
        "SELECT {REVISION_COLUMNS} FROM grimoire.intake_scions s JOIN grimoire.intake_revisions r ON (r.org_id,r.scion_id,r.number)=(s.org_id,s.id,s.current_revision) WHERE s.id=$1"
    );
    Ok(sqlx::query_as::<_, RevisionRow>(&query)
        .bind(id)
        .fetch_optional(&mut **tx)
        .await?
        .ok_or_else(ApiError::not_found)?
        .into_scion())
}

fn parse_intake(input: Result<Json<Intake>, JsonRejection>) -> Result<Intake, ApiError> {
    let Json(intake) = input.map_err(|_| {
        ApiError::invalid(
            "Provide a JSON intake object with supported fields and valid field types.",
        )
    })?;
    intake.validate().map_err(ApiError::invalid)?;
    Ok(intake)
}

fn key(headers: &HeaderMap) -> Result<String, ApiError> {
    headers
        .get("Idempotency-Key")
        .and_then(|h| h.to_str().ok())
        .filter(|key| {
            !key.is_empty() && key.len() <= 128 && key.bytes().all(|c| (33..=126).contains(&c))
        })
        .map(String::from)
        .ok_or_else(|| {
            ApiError(
                StatusCode::BAD_REQUEST,
                "IDEMPOTENCY_KEY_REQUIRED",
                "Idempotency-Key must contain 1–128 printable non-space ASCII characters.".into(),
            )
        })
}

fn precondition(headers: &HeaderMap) -> Result<i32, ApiError> {
    let value = headers.get(header::IF_MATCH).ok_or_else(|| {
        ApiError(
            StatusCode::PRECONDITION_REQUIRED,
            "IF_MATCH_REQUIRED",
            "If-Match must contain the current quoted revision number.".into(),
        )
    })?;
    value
        .to_str()
        .ok()
        .and_then(|s| s.strip_prefix('"'))
        .and_then(|s| s.strip_suffix('"'))
        .and_then(|s| s.parse::<i32>().ok())
        .filter(|n| *n > 0)
        .ok_or_else(|| {
            ApiError(
                StatusCode::BAD_REQUEST,
                "INVALID_IF_MATCH",
                "If-Match must be a quoted positive revision number, for example \"1\".".into(),
            )
        })
}

fn fingerprint(path: &str, base: Option<i32>, intake: &Intake) -> Result<String, ApiError> {
    Ok(format!(
        "{:x}",
        Sha256::digest(
            format!("POST\n{path}\n{base:?}\n{}", serde_json::to_string(intake)?).as_bytes()
        )
    ))
}

#[derive(FromRow)]
struct StoredResponse {
    request_sha256: String,
    response_status: i16,
    response_body: String,
    response_etag: String,
}

async fn replay(
    tx: &mut Tx,
    actor: &Actor,
    key: &str,
    request_hash: &str,
) -> Result<Option<Response>, ApiError> {
    // Serialize same-key calls even across API processes. Hash collisions merely
    // serialize unrelated requests; the full tenant/principal/key is still checked.
    let lock_key = format!("{}:{}:{key}", actor.org_id, actor.principal_id);
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))")
        .bind(lock_key)
        .execute(&mut **tx)
        .await?;
    let stored=sqlx::query_as::<_,StoredResponse>("SELECT request_sha256,response_status,response_body,response_etag FROM grimoire.intake_idempotency WHERE org_id=$1 AND principal_id=$2 AND key=$3")
        .bind(actor.org_id).bind(actor.principal_id).bind(key).fetch_optional(&mut **tx).await?;
    match stored {
        None => Ok(None),
        Some(stored) if stored.request_sha256 != request_hash => Err(ApiError(
            StatusCode::CONFLICT,
            "IDEMPOTENCY_CONFLICT",
            "This idempotency key has already been used for a different request.".into(),
        )),
        Some(stored) => Ok(Some(resource_response(
            StatusCode::from_u16(stored.response_status as u16).unwrap_or(StatusCode::CREATED),
            stored.response_body,
            stored.response_etag,
            true,
        )?)),
    }
}

async fn store_response(
    tx: &mut Tx,
    actor: &Actor,
    key: &str,
    hash: &str,
    body: &str,
    etag: &str,
) -> Result<(), ApiError> {
    sqlx::query("INSERT INTO grimoire.intake_idempotency(org_id,principal_id,key,request_sha256,response_status,response_body,response_etag) VALUES($1,$2,$3,$4,201,$5,$6)")
        .bind(actor.org_id).bind(actor.principal_id).bind(key).bind(hash).bind(body).bind(etag).execute(&mut **tx).await?;
    Ok(())
}

async fn insert_revision(
    tx: &mut Tx,
    actor: &Actor,
    id: Uuid,
    number: i32,
    intake: &Intake,
) -> Result<(), ApiError> {
    sqlx::query("INSERT INTO grimoire.intake_revisions(org_id,scion_id,number,name,product_description,product_category,decision,requirements,questions,change_summary,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)")
        .bind(actor.org_id).bind(id).bind(number).bind(&intake.name).bind(&intake.product_description).bind(intake.product_category.as_str()).bind(&intake.decision)
        .bind(intake.requirements.as_ref().map(sqlx::types::Json)).bind(intake.questions.as_ref().map(sqlx::types::Json)).bind(&intake.change_summary).bind(actor.principal_id)
        .execute(&mut **tx).await?;
    Ok(())
}

async fn create_scion(
    State(pool): State<PgPool>,
    headers: HeaderMap,
    input: Result<Json<Intake>, JsonRejection>,
) -> ApiResult {
    let (mut tx, actor) = authenticate(&pool, &headers).await?;
    if !actor.can_write {
        return Err(ApiError::forbidden());
    }
    let intake = parse_intake(input)?;
    let key = key(&headers)?;
    let hash = fingerprint("/api/scions", None, &intake)?;
    if let Some(response) = replay(&mut tx, &actor, &key, &hash).await? {
        tx.commit().await?;
        return Ok(response);
    }
    let id = Uuid::new_v4();
    sqlx::query("INSERT INTO grimoire.intake_scions(id,org_id,created_by) VALUES($1,$2,$3)")
        .bind(id)
        .bind(actor.org_id)
        .bind(actor.principal_id)
        .execute(&mut *tx)
        .await?;
    insert_revision(&mut tx, &actor, id, 1, &intake).await?;
    let scion = load_current(&mut tx, id).await?;
    let body = serde_json::to_string(&scion)?;
    let etag = etag(1);
    store_response(&mut tx, &actor, &key, &hash, &body, &etag).await?;
    tx.commit().await?;
    resource_response(StatusCode::CREATED, body, etag, false)
}

async fn create_revision(
    State(pool): State<PgPool>,
    headers: HeaderMap,
    Path(id): Path<String>,
    input: Result<Json<Intake>, JsonRejection>,
) -> ApiResult {
    let (mut tx, actor) = authenticate(&pool, &headers).await?;
    let id = parse_id(&id)?;
    // Resolve visibility before validation, role checks, and idempotency lookup so
    // foreign and nonexistent IDs share one response even on write/history paths.
    visible_revision(&mut tx, id, false).await?;
    if !actor.can_write {
        return Err(ApiError::forbidden());
    }
    let intake = parse_intake(input)?;
    let base = precondition(&headers)?;
    let key = key(&headers)?;
    let hash = fingerprint(&format!("/api/scions/{id}/revisions"), Some(base), &intake)?;
    if let Some(response) = replay(&mut tx, &actor, &key, &hash).await? {
        tx.commit().await?;
        return Ok(response);
    }
    let current = visible_revision(&mut tx, id, true).await?;
    if base != current {
        return Err(ApiError::stale());
    }
    let next = current
        .checked_add(1)
        .ok_or_else(|| ApiError::invalid("The revision limit has been reached."))?;
    insert_revision(&mut tx, &actor, id, next, &intake).await?;
    let scion = load_current(&mut tx, id).await?;
    let body = serde_json::to_string(&scion)?;
    let etag = etag(next);
    store_response(&mut tx, &actor, &key, &hash, &body, &etag).await?;
    tx.commit().await?;
    resource_response(StatusCode::CREATED, body, etag, false)
}

fn etag(number: i32) -> String {
    format!("\"{number}\"")
}

fn resource_response(status: StatusCode, body: String, etag: String, replayed: bool) -> ApiResult {
    let mut response = (status, body).into_response();
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/json"),
    );
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response.headers_mut().insert(
        header::ETAG,
        HeaderValue::from_str(&etag).map_err(|_| ApiError::invalid("Invalid revision tag."))?,
    );
    if replayed {
        response
            .headers_mut()
            .insert("Idempotency-Replayed", HeaderValue::from_static("true"));
    }
    Ok(response)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exact_preconditions_only() {
        for invalid in ["*", "W/\"1\"", "1", "\"0\"", "\"1\",\"2\""] {
            let mut h = HeaderMap::new();
            h.insert(header::IF_MATCH, HeaderValue::from_str(invalid).unwrap());
            assert!(precondition(&h).is_err());
        }
        let mut h = HeaderMap::new();
        h.insert(header::IF_MATCH, HeaderValue::from_static("\"7\""));
        assert_eq!(precondition(&h).unwrap_or_default(), 7);
    }

    #[test]
    fn request_identity_binds_body_base_and_path() {
        let intake: Intake = serde_json::from_value(json!({"name":"Draft"})).unwrap();
        let hash = fingerprint("/a", Some(1), &intake).ok();
        assert_ne!(hash, fingerprint("/a", Some(2), &intake).ok());
        assert_ne!(hash, fingerprint("/b", Some(1), &intake).ok());
        let mut changed = intake.clone();
        changed.name = "Changed".into();
        assert_ne!(hash, fingerprint("/a", Some(1), &changed).ok());
    }
}
