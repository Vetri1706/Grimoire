//! Synthetic draft sources, historical attestations and manually entered claims.
//! Private source bytes are read only from a hash-verified pinned S3 version.
use super::*;
use serde::{Deserialize, de::DeserializeOwned};

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct SourceInput {
    title: String,
    origin: String,
    owner: String,
    #[serde(default)]
    synthetic: bool,
    source_text: String,
    #[serde(default)]
    rights_status: Option<String>,
    #[serde(default)]
    permission_basis: Option<String>,
    #[serde(default)]
    permitted_use: Option<String>,
    change_summary: String,
}

fn rights_denied() -> ApiError {
    ApiError(StatusCode::FORBIDDEN, "SOURCE_RIGHTS_DENIED", "Source permission for Scion review is absent or revoked. Content and claims cannot be accessed or processed.".into())
}

fn bounded(value: &str, max: usize, label: &str) -> Result<(), ApiError> {
    if value.trim().is_empty() || value.chars().count() > max || value.contains('\0') {
        return Err(ApiError::invalid(format!(
            "{label} must contain 1–{max} characters and no null character."
        )));
    }
    Ok(())
}

impl SourceInput {
    fn validate(&self) -> Result<(), ApiError> {
        // Check the explicit permission attestation before inspecting/hash-processing
        // source bytes. Deserializing a bounded HTTP request does not grant rights.
        if self.rights_status.as_deref() != Some("granted")
            || self.permitted_use.as_deref() != Some("scion_review")
            || self
                .permission_basis
                .as_deref()
                .is_none_or(|v| v.trim().is_empty())
        {
            return Err(rights_denied());
        }
        if !self.synthetic {
            return Err(ApiError::invalid(
                "This slice accepts only explicitly synthetic source text.",
            ));
        }
        bounded(&self.title, 160, "Title")?;
        bounded(&self.origin, 2000, "Origin")?;
        bounded(&self.owner, 300, "Owner")?;
        bounded(
            self.permission_basis.as_deref().unwrap_or_default(),
            4000,
            "Permission basis",
        )?;
        bounded(&self.change_summary, 1000, "Change summary")?;
        if self.source_text.trim().is_empty()
            || self.source_text.len() > 32000
            || self.source_text.contains('\0')
        {
            return Err(ApiError::invalid(
                "Synthetic source text must contain 1–32000 UTF-8 bytes and no null character.",
            ));
        }
        Ok(())
    }
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Locator {
    start_byte: i32,
    end_byte: i32,
    quote: String,
}

impl Locator {
    fn validate(&self, source: &str) -> Result<(), ApiError> {
        let start = usize::try_from(self.start_byte).ok();
        let end = usize::try_from(self.end_byte).ok();
        if !matches!((start, end), (Some(a), Some(b)) if a < b && source.get(a..b) == Some(self.quote.as_str()))
        {
            return Err(ApiError::invalid(
                "The locator must name a nonempty, exact UTF-8 byte interval and matching quote in this source revision.",
            ));
        }
        Ok(())
    }
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct ClaimInput {
    statement: String,
    locator: Locator,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct RevokeInput {
    reason: String,
}

#[derive(FromRow, Serialize)]
struct SourceSummary {
    id: Uuid,
    scion_id: Uuid,
    scion_revision: i32,
    current_revision: i32,
    title: String,
    origin: String,
    owner: String,
    content_sha256: String,
    rights_status: String,
    permitted_use: String,
    permission_basis: String,
    synthetic: bool,
    claim_count: i64,
    revocation_reason: Option<String>,
}

#[derive(FromRow, Serialize)]
struct SourceRevision {
    source_id: Uuid,
    number: i32,
    title: String,
    origin: String,
    owner: String,
    synthetic: bool,
    #[sqlx(default)]
    source_text: String,
    content_sha256: String,
    byte_length: i32,
    rights_status: String,
    permission_basis: String,
    permitted_use: String,
    change_summary: String,
    created_at: DateTime<Utc>,
    created_by: Uuid,
    storage_backend: String,
    object_bucket: String,
    object_key: String,
    object_version_id: String,
    #[sqlx(default)]
    content_hash_verified: bool,
}

#[derive(FromRow)]
struct SourceState {
    current_revision: i32,
    revoked: bool,
}

#[derive(FromRow)]
struct ClaimRow {
    id: Uuid,
    source_id: Uuid,
    source_revision: i32,
    statement: String,
    start_byte: i32,
    end_byte: i32,
    quote: String,
    authority: String,
    verification_status: String,
    created_at: DateTime<Utc>,
    created_by: Uuid,
}

impl ClaimRow {
    fn into_json(self) -> serde_json::Value {
        json!({"id":self.id,"source_id":self.source_id,"source_revision":self.source_revision,
            "statement":self.statement,"locator":{"start_byte":self.start_byte,"end_byte":self.end_byte,"quote":self.quote},
            "authority":self.authority,"verification_status":self.verification_status,
            "created_at":self.created_at,"created_by":self.created_by})
    }
}

const SOURCE_COLUMNS: &str = "r.source_id,r.number,r.title,r.origin,r.owner,r.synthetic,r.content_sha256,r.byte_length,r.rights_status,r.permission_basis,r.permitted_use,r.change_summary,r.created_at,r.created_by,COALESCE(o.storage_backend,'') AS storage_backend,COALESCE(o.object_bucket,'') AS object_bucket,COALESCE(o.object_key,'') AS object_key,COALESCE(o.object_version_id,'') AS object_version_id";
const SOURCE_JOIN: &str = "grimoire.intake_source_revisions r LEFT JOIN grimoire.intake_source_objects o ON (o.org_id,o.source_id,o.source_revision)=(r.org_id,r.source_id,r.number)";
const CLAIM_COLUMNS: &str = "id,source_id,source_revision,statement,start_byte,end_byte,quote,authority,verification_status,created_at,created_by";

pub(super) fn routes() -> Router<PgPool> {
    Router::new()
        .route("/api/scions/{id}/sources", get(list).post(create))
        .route("/api/scions/{id}/sources/{source}", get(detail))
        .route(
            "/api/scions/{id}/sources/{source}/revisions",
            get(history).post(revise),
        )
        .route(
            "/api/scions/{id}/sources/{source}/revisions/{number}",
            get(revision),
        )
        .route(
            "/api/scions/{id}/sources/{source}/revisions/{number}/claims",
            get(claims).post(claim),
        )
        .route(
            "/api/scions/{id}/sources/{source}/revoke",
            axum::routing::post(revoke),
        )
}

fn input<T: DeserializeOwned>(value: Result<Json<T>, JsonRejection>) -> Result<T, ApiError> {
    value.map(|Json(v)| v).map_err(|_| ApiError::invalid("Provide a JSON object with only the documented source or claim fields and valid field types."))
}

fn number(value: &str) -> Result<i32, ApiError> {
    value
        .parse::<i32>()
        .ok()
        .filter(|n| *n > 0)
        .ok_or_else(ApiError::not_found)
}

fn hash_request<T: Serialize>(
    path: &str,
    base: Option<i32>,
    input: &T,
) -> Result<String, ApiError> {
    Ok(format!(
        "{:x}",
        Sha256::digest(
            format!("POST\n{path}\n{base:?}\n{}", serde_json::to_string(input)?).as_bytes()
        )
    ))
}

async fn source_state(
    tx: &mut Tx,
    scion: Uuid,
    source: Uuid,
    lock: bool,
) -> Result<SourceState, ApiError> {
    if lock {
        sqlx::query_scalar::<_, i32>("SELECT current_revision FROM grimoire.intake_sources WHERE scion_id=$1 AND id=$2 FOR UPDATE")
            .bind(scion).bind(source).fetch_optional(&mut **tx).await?.ok_or_else(ApiError::not_found)?;
    }
    // A separate statement after acquiring the lock gets a fresh READ COMMITTED
    // snapshot, including any revocation committed while lock acquisition waited.
    sqlx::query_as::<_, SourceState>("SELECT s.current_revision,EXISTS(SELECT 1 FROM grimoire.intake_source_revocations v WHERE (v.org_id,v.source_id)=(s.org_id,s.id)) AS revoked FROM grimoire.intake_sources s WHERE s.scion_id=$1 AND s.id=$2")
        .bind(scion).bind(source).fetch_optional(&mut **tx).await?.ok_or_else(ApiError::not_found)
}

async fn source_read_state(
    tx: &mut Tx,
    scion: Uuid,
    source: Uuid,
) -> Result<SourceState, ApiError> {
    sqlx::query_scalar::<_, Option<i32>>("SELECT app.intake_source_read_lock($1,$2)")
        .bind(scion)
        .bind(source)
        .fetch_one(&mut **tx)
        .await?
        .ok_or_else(ApiError::not_found)?;
    source_state(tx, scion, source, false).await
}

fn permitted(state: &SourceState) -> Result<(), ApiError> {
    if state.revoked {
        Err(rights_denied())
    } else {
        Ok(())
    }
}

async fn summaries(tx: &mut Tx, scion: Uuid) -> Result<Vec<SourceSummary>, ApiError> {
    Ok(
        sqlx::query_as::<_, SourceSummary>("SELECT * FROM app.intake_source_summaries($1)")
            .bind(scion)
            .fetch_all(&mut **tx)
            .await?,
    )
}

async fn revisions(tx: &mut Tx, source: Uuid) -> Result<Vec<SourceRevision>, ApiError> {
    let rows = sqlx::query_as::<_, SourceRevision>(&format!(
        "SELECT {SOURCE_COLUMNS} FROM {SOURCE_JOIN} WHERE r.source_id=$1 ORDER BY r.number DESC"
    ))
    .bind(source)
    .fetch_all(&mut **tx)
    .await?;
    let mut verified = Vec::with_capacity(rows.len());
    for row in rows {
        verified.push(verify_revision(row).await?);
    }
    Ok(verified)
}

async fn load_revision(tx: &mut Tx, source: Uuid, number: i32) -> Result<SourceRevision, ApiError> {
    let row = sqlx::query_as::<_, SourceRevision>(&format!(
        "SELECT {SOURCE_COLUMNS} FROM {SOURCE_JOIN} WHERE r.source_id=$1 AND r.number=$2"
    ))
    .bind(source)
    .bind(number)
    .fetch_optional(&mut **tx)
    .await?
    .ok_or_else(ApiError::not_found)?;
    verify_revision(row).await
}

async fn verify_revision(mut revision: SourceRevision) -> Result<SourceRevision, ApiError> {
    if revision.storage_backend != "s3"
        || revision.object_key.is_empty()
        || revision.object_version_id.is_empty()
    {
        return Err(storage::migration_required());
    }
    revision.source_text = storage::configured()?
        .read_verified(
            &revision.object_bucket,
            &revision.object_key,
            &revision.object_version_id,
            &revision.content_sha256,
            revision.byte_length,
        )
        .await?;
    revision.content_hash_verified = true;
    Ok(revision)
}

async fn load_claims(
    tx: &mut Tx,
    source: Uuid,
    number: Option<i32>,
) -> Result<Vec<serde_json::Value>, ApiError> {
    Ok(sqlx::query_as::<_, ClaimRow>(&format!("SELECT {CLAIM_COLUMNS} FROM grimoire.intake_source_claims WHERE source_id=$1 AND ($2::integer IS NULL OR source_revision=$2) ORDER BY source_revision DESC,id"))
        .bind(source).bind(number).fetch_all(&mut **tx).await?.into_iter().map(ClaimRow::into_json).collect())
}

pub(super) async fn control_snapshot(
    tx: &mut Tx,
    scion: Uuid,
) -> Result<Vec<serde_json::Value>, ApiError> {
    let rows = summaries(tx, scion).await?;
    let mut result = Vec::new();
    for summary in rows {
        let state = source_read_state(tx, scion, summary.id).await?;
        if state.revoked {
            result.push(json!({"id":summary.id,"scion_revision":summary.scion_revision,"current_revision":state.current_revision,"title":"Revoked source","status":"revoked","details":null,"blockers":["Source permission revoked; content and claims are hidden."]}));
            continue;
        }
        match load_revision(tx, summary.id, state.current_revision).await {
            Ok(revision) => {
                let claims = load_claims(tx, summary.id, Some(state.current_revision)).await?;
                // Object storage keys are not part of the public graph.
                result.push(json!({"id":summary.id,"scion_revision":summary.scion_revision,"current_revision":state.current_revision,"title":revision.title,"status":"available","details":{"source_text":revision.source_text,"origin":revision.origin,"owner":revision.owner,"permission_basis":revision.permission_basis,"content_sha256":revision.content_sha256,"content_hash_verified":true,"claims":claims},"blockers":[]}));
            }
            Err(error) if error.0 == StatusCode::SERVICE_UNAVAILABLE => {
                result.push(json!({"id":summary.id,"scion_revision":summary.scion_revision,"current_revision":state.current_revision,"title":"Source temporarily unavailable","status":"unavailable","details":null,"blockers":[error.1]}));
            }
            Err(error) => return Err(error),
        }
    }
    Ok(result)
}

async fn list(State(pool): State<PgPool>, headers: HeaderMap, Path(id): Path<String>) -> ApiResult {
    let (mut tx, _) = authenticate(&pool, &headers).await?;
    let id = parse_id(&id)?;
    visible_revision(&mut tx, id, false).await?;
    let sources = summaries(&mut tx, id).await?;
    tx.commit().await?;
    Ok(
        Json(json!({"sources":sources,"verified_facts":[],"extraction_status":"not_implemented"}))
            .into_response(),
    )
}

async fn detail(
    State(pool): State<PgPool>,
    headers: HeaderMap,
    Path((id, source)): Path<(String, String)>,
) -> ApiResult {
    let (mut tx, _) = authenticate(&pool, &headers).await?;
    let (id, source) = (parse_id(&id)?, parse_id(&source)?);
    permitted(&source_read_state(&mut tx, id, source).await?)?;
    let summary = summaries(&mut tx, id)
        .await?
        .into_iter()
        .find(|s| s.id == source)
        .ok_or_else(ApiError::not_found)?;
    let revisions = revisions(&mut tx, source).await?;
    let claims = load_claims(&mut tx, source, None).await?;
    // The shared source lock remains held until this content snapshot commits.
    tx.commit().await?;
    Ok(Json(json!({"source":summary,"revisions":revisions,"claims":claims})).into_response())
}

async fn history(
    State(pool): State<PgPool>,
    headers: HeaderMap,
    Path((id, source)): Path<(String, String)>,
) -> ApiResult {
    let (mut tx, _) = authenticate(&pool, &headers).await?;
    let (id, source) = (parse_id(&id)?, parse_id(&source)?);
    permitted(&source_read_state(&mut tx, id, source).await?)?;
    let revisions = revisions(&mut tx, source).await?;
    tx.commit().await?;
    Ok(Json(json!({"revisions":revisions})).into_response())
}

async fn revision(
    State(pool): State<PgPool>,
    headers: HeaderMap,
    Path((id, source, revision)): Path<(String, String, String)>,
) -> ApiResult {
    let (mut tx, _) = authenticate(&pool, &headers).await?;
    let (id, source, n) = (parse_id(&id)?, parse_id(&source)?, number(&revision)?);
    permitted(&source_read_state(&mut tx, id, source).await?)?;
    let revision = load_revision(&mut tx, source, n).await?;
    tx.commit().await?;
    resource_response(
        StatusCode::OK,
        serde_json::to_string(&revision)?,
        etag(n),
        false,
    )
}

async fn claims(
    State(pool): State<PgPool>,
    headers: HeaderMap,
    Path((id, source, revision)): Path<(String, String, String)>,
) -> ApiResult {
    let (mut tx, _) = authenticate(&pool, &headers).await?;
    let (id, source, n) = (parse_id(&id)?, parse_id(&source)?, number(&revision)?);
    permitted(&source_read_state(&mut tx, id, source).await?)?;
    load_revision(&mut tx, source, n).await?;
    let claims = load_claims(&mut tx, source, Some(n)).await?;
    tx.commit().await?;
    Ok(Json(json!({"claims":claims})).into_response())
}

async fn insert_source_revision(
    tx: &mut Tx,
    actor: &Actor,
    source: Uuid,
    number: i32,
    value: &SourceInput,
) -> Result<(), ApiError> {
    let object = storage::configured()?
        .put_verified(actor.org_id, source, number, &value.source_text)
        .await?;
    // The object reference FK is deferred so reference and immutable revision
    // commit atomically after the exact uploaded version has been verified.
    sqlx::query("INSERT INTO grimoire.intake_source_objects(org_id,source_id,source_revision,object_bucket,object_key,object_version_id,content_sha256,byte_length,recorded_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)")
        .bind(actor.org_id).bind(source).bind(number).bind(&object.bucket).bind(&object.key).bind(&object.version).bind(&object.sha256).bind(object.byte_length).bind(actor.principal_id).execute(&mut **tx).await?;
    sqlx::query("INSERT INTO grimoire.intake_source_revisions(org_id,source_id,number,title,origin,owner,synthetic,source_text,content_sha256,byte_length,rights_status,permission_basis,permitted_use,change_summary,created_by) VALUES($1,$2,$3,$4,$5,$6,true,NULL,$7,$8,'granted',$9,'scion_review',$10,$11)")
        .bind(actor.org_id).bind(source).bind(number).bind(&value.title).bind(&value.origin).bind(&value.owner).bind(&object.sha256).bind(object.byte_length).bind(&value.permission_basis).bind(&value.change_summary).bind(actor.principal_id).execute(&mut **tx).await?;
    Ok(())
}

async fn receipt(
    tx: Tx,
    actor: &Actor,
    key: &str,
    hash: &str,
    value: serde_json::Value,
    number: i32,
) -> ApiResult {
    let mut tx = tx;
    let body = serde_json::to_string(&value)?;
    let tag = etag(number);
    store_response(&mut tx, actor, key, hash, &body, &tag).await?;
    tx.commit().await?;
    resource_response(StatusCode::CREATED, body, tag, false)
}

async fn create(
    State(pool): State<PgPool>,
    headers: HeaderMap,
    Path(id): Path<String>,
    value: Result<Json<SourceInput>, JsonRejection>,
) -> ApiResult {
    let (mut tx, actor) = authenticate(&pool, &headers).await?;
    let id = parse_id(&id)?;
    visible_revision(&mut tx, id, false).await?;
    if !actor.can_prepare_workspace {
        return Err(ApiError::forbidden());
    }
    let value = input(value)?;
    value.validate()?;
    let base = precondition(&headers)?;
    let key = key(&headers)?;
    let hash = hash_request(&format!("/api/scions/{id}/sources"), Some(base), &value)?;
    if let Some(response) = replay(&mut tx, &actor, &key, &hash).await? {
        // Identifier-only creation receipts cannot restore rights or disclose bytes.
        tx.commit().await?;
        return Ok(response);
    }
    if visible_revision(&mut tx, id, true).await? != base {
        return Err(ApiError::stale());
    }
    let source = Uuid::new_v4();
    sqlx::query("INSERT INTO grimoire.intake_sources(id,org_id,scion_id,scion_revision,created_by) VALUES($1,$2,$3,$4,$5)").bind(source).bind(actor.org_id).bind(id).bind(base).bind(actor.principal_id).execute(&mut *tx).await?;
    insert_source_revision(&mut tx, &actor, source, 1, &value).await?;
    receipt(
        tx,
        &actor,
        &key,
        &hash,
        json!({"source_id":source,"number":1}),
        1,
    )
    .await
}

async fn revise(
    State(pool): State<PgPool>,
    headers: HeaderMap,
    Path((id, source)): Path<(String, String)>,
    value: Result<Json<SourceInput>, JsonRejection>,
) -> ApiResult {
    let (mut tx, actor) = authenticate(&pool, &headers).await?;
    let (id, source) = (parse_id(&id)?, parse_id(&source)?);
    source_state(&mut tx, id, source, false).await?;
    if !actor.can_prepare_workspace {
        return Err(ApiError::forbidden());
    }
    // All writes and revocations serialize on this row. Check permission before
    // parsing content, hashing, or replaying a previous mutation receipt.
    let state = source_state(&mut tx, id, source, true).await?;
    permitted(&state)?;
    let value = input(value)?;
    value.validate()?;
    let base = precondition(&headers)?;
    let key = key(&headers)?;
    let hash = hash_request(
        &format!("/api/scions/{id}/sources/{source}/revisions"),
        Some(base),
        &value,
    )?;
    if let Some(response) = replay(&mut tx, &actor, &key, &hash).await? {
        tx.commit().await?;
        return Ok(response);
    }
    if state.current_revision != base {
        return Err(ApiError::stale());
    }
    let next = base
        .checked_add(1)
        .ok_or_else(|| ApiError::invalid("Source revision limit reached."))?;
    insert_source_revision(&mut tx, &actor, source, next, &value).await?;
    receipt(
        tx,
        &actor,
        &key,
        &hash,
        json!({"source_id":source,"number":next}),
        next,
    )
    .await
}

async fn claim(
    State(pool): State<PgPool>,
    headers: HeaderMap,
    Path((id, source, revision)): Path<(String, String, String)>,
    value: Result<Json<ClaimInput>, JsonRejection>,
) -> ApiResult {
    let (mut tx, actor) = authenticate(&pool, &headers).await?;
    let (id, source, n) = (parse_id(&id)?, parse_id(&source)?, number(&revision)?);
    source_state(&mut tx, id, source, false).await?;
    if !actor.can_prepare_workspace {
        return Err(ApiError::forbidden());
    }
    let state = source_state(&mut tx, id, source, true).await?;
    permitted(&state)?;
    let revision = load_revision(&mut tx, source, n).await?;
    let value = input(value)?;
    bounded(&value.statement, 4000, "Claim statement")?;
    value.locator.validate(&revision.source_text)?;
    let key = key(&headers)?;
    let hash = hash_request(
        &format!("/api/scions/{id}/sources/{source}/revisions/{n}/claims"),
        None,
        &value,
    )?;
    if let Some(response) = replay(&mut tx, &actor, &key, &hash).await? {
        tx.commit().await?;
        return Ok(response);
    }
    let exists: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM grimoire.intake_source_claims WHERE source_id=$1 AND source_revision=$2)").bind(source).bind(n).fetch_one(&mut *tx).await?;
    if exists {
        return Err(ApiError(
            StatusCode::CONFLICT,
            "CLAIM_ALREADY_RECORDED",
            "This source revision already has its one immutable Handler-entered claim.".into(),
        ));
    }
    let claim = Uuid::new_v4();
    sqlx::query("INSERT INTO grimoire.intake_source_claims(id,org_id,source_id,source_revision,statement,start_byte,end_byte,quote,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)").bind(claim).bind(actor.org_id).bind(source).bind(n).bind(&value.statement).bind(value.locator.start_byte).bind(value.locator.end_byte).bind(&value.locator.quote).bind(actor.principal_id).execute(&mut *tx).await?;
    receipt(
        tx,
        &actor,
        &key,
        &hash,
        json!({"claim_id":claim,"source_id":source,"source_revision":n}),
        n,
    )
    .await
}

async fn revoke(
    State(pool): State<PgPool>,
    headers: HeaderMap,
    Path((id, source)): Path<(String, String)>,
    value: Result<Json<RevokeInput>, JsonRejection>,
) -> ApiResult {
    let (mut tx, actor) = authenticate(&pool, &headers).await?;
    let (id, source) = (parse_id(&id)?, parse_id(&source)?);
    source_state(&mut tx, id, source, false).await?;
    if !actor.can_prepare_workspace {
        return Err(ApiError::forbidden());
    }
    let state = source_state(&mut tx, id, source, true).await?;
    let value = input(value)?;
    bounded(&value.reason, 2000, "Revocation reason")?;
    let base = precondition(&headers)?;
    let key = key(&headers)?;
    let hash = hash_request(
        &format!("/api/scions/{id}/sources/{source}/revoke"),
        Some(base),
        &value,
    )?;
    if let Some(response) = replay(&mut tx, &actor, &key, &hash).await? {
        tx.commit().await?;
        return Ok(response);
    }
    permitted(&state)?;
    if state.current_revision != base {
        return Err(ApiError::stale());
    }
    sqlx::query("INSERT INTO grimoire.intake_source_revocations(org_id,source_id,source_revision,reason,created_by) VALUES($1,$2,$3,$4,$5)").bind(actor.org_id).bind(source).bind(base).bind(&value.reason).bind(actor.principal_id).execute(&mut *tx).await?;
    receipt(
        tx,
        &actor,
        &key,
        &hash,
        json!({"source_id":source,"rights_status":"revoked"}),
        base,
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn source() -> SourceInput {
        serde_json::from_value(json!({"title":"Synthetic","origin":"synthetic://test","owner":"Handler","synthetic":true,"source_text":"A café 🧪 note","rights_status":"granted","permission_basis":"I authored this synthetic note.","permitted_use":"scion_review","change_summary":"Initial"})).unwrap()
    }

    #[test]
    fn explicit_rights_are_required_before_source_processing() {
        let mut value = source();
        assert!(value.validate().is_ok());
        value.source_text = "\0".into();
        for denied in [None, Some("denied".into()), Some("revoked".into())] {
            value.rights_status = denied;
            assert_eq!(value.validate().err().unwrap().0, StatusCode::FORBIDDEN);
        }
        value = source();
        value.permission_basis = Some("  ".into());
        assert_eq!(value.validate().err().unwrap().0, StatusCode::FORBIDDEN);
        value = source();
        value.permitted_use = Some("supplier_distribution".into());
        assert_eq!(value.validate().err().unwrap().0, StatusCode::FORBIDDEN);
    }

    #[test]
    fn locator_uses_exact_utf8_bytes_not_character_offsets() {
        let text = "A café 🧪 note";
        assert!(
            Locator {
                start_byte: 2,
                end_byte: 7,
                quote: "café".into()
            }
            .validate(text)
            .is_ok()
        );
        assert!(
            Locator {
                start_byte: 8,
                end_byte: 12,
                quote: "🧪".into()
            }
            .validate(text)
            .is_ok()
        );
        for locator in [
            Locator {
                start_byte: 2,
                end_byte: 6,
                quote: "café".into(),
            },
            Locator {
                start_byte: 9,
                end_byte: 12,
                quote: "🧪".into(),
            },
            Locator {
                start_byte: -1,
                end_byte: 7,
                quote: "café".into(),
            },
            Locator {
                start_byte: 2,
                end_byte: 2,
                quote: "".into(),
            },
            Locator {
                start_byte: 2,
                end_byte: i32::MAX,
                quote: "café".into(),
            },
            Locator {
                start_byte: 2,
                end_byte: 7,
                quote: "cafe\u{301}".into(),
            },
        ] {
            assert!(locator.validate(text).is_err());
        }
    }

    #[test]
    fn text_bounds_count_utf8_bytes_and_unknown_authority_is_rejected() {
        let mut value = source();
        value.source_text = "é".repeat(16000);
        assert!(value.validate().is_ok());
        value.source_text.push('a');
        assert!(value.validate().is_err());
        let mut forged = serde_json::to_value(source()).unwrap();
        forged["content_sha256"] = json!("trusted-client-hash");
        assert!(serde_json::from_value::<SourceInput>(forged).is_err());
        assert!(serde_json::from_value::<ClaimInput>(json!({"statement":"Claim","locator":{"start_byte":0,"end_byte":1,"quote":"A"},"verification_status":"verified"})).is_err());
    }
}
