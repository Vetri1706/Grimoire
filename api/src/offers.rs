//! Synthetic supplier quotations and reviewed exact-basis comparison.
//! Decimal arithmetic and canonical materialization live in bounded SQL helpers.
use super::*;
use serde::{Deserialize, de::DeserializeOwned};
use serde_json::Value;

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Supplier {
    legal_name: String,
    jurisdiction: String,
    registration_ref: String,
    site_code: String,
    country_code: String,
    account_ref: String,
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Source {
    source_id: Uuid,
    source_revision: i32,
    claim_id: Uuid,
    content_sha256: String,
    start_byte: i32,
    end_byte: i32,
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct OfferInput {
    synthetic: bool,
    scion_revision: i32,
    scope_proposal_id: Uuid,
    supplier: Supplier,
    source: Source,
    offer_ref: String,
    identity_match: String,
    offered_manufacturer: Option<String>,
    offered_part_number: Option<String>,
    quantity: Option<String>,
    uom: Option<String>,
    unit_price: Option<String>,
    currency: Option<String>,
    destination: Option<String>,
    incoterm: Option<String>,
    payment_terms: Option<String>,
    quoted_at: Option<DateTime<Utc>>,
    valid_from: Option<DateTime<Utc>>,
    valid_until: Option<DateTime<Utc>>,
    lead_time_days: Option<i32>,
    change_summary: String,
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Basis {
    quantity: String,
    uom: String,
    currency: String,
    destination: String,
    incoterm: String,
    payment_terms: String,
    as_of: DateTime<Utc>,
    valid_from: DateTime<Utc>,
    valid_until: DateTime<Utc>,
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct ComparisonInput {
    synthetic: bool,
    scope_proposal_id: Uuid,
    offer_revision_ids: Vec<Uuid>,
    basis: Basis,
    change_summary: String,
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Confirm {
    confirm_synthetic_normalization: bool,
    review_note: String,
}
#[derive(FromRow)]
struct OfferRow {
    id: Uuid,
    offer_id: Uuid,
    scion_id: Uuid,
    number: i32,
    input: sqlx::types::Json<Value>,
    missing_fields: Value,
    governed_offer_revision_id: Option<Uuid>,
    governed_offer_line_id: Option<Uuid>,
    created_by: Uuid,
    created_at: DateTime<Utc>,
}
#[derive(FromRow)]
struct ComparisonRow {
    id: Uuid,
    scion_id: Uuid,
    scion_revision: i32,
    input: sqlx::types::Json<Value>,
    snapshot: Value,
    created_by: Uuid,
    created_at: DateTime<Utc>,
}
const OFFER_COLUMNS: &str = "id,offer_id,scion_id,number,input,missing_fields,governed_offer_revision_id,governed_offer_line_id,created_by,created_at";
const COMPARISON_COLUMNS: &str = "id,scion_id,scion_revision,input,snapshot,created_by,created_at";

fn invalid(message: impl Into<String>) -> ApiError {
    ApiError(
        StatusCode::UNPROCESSABLE_ENTITY,
        "INVALID_OFFER",
        message.into(),
    )
}
fn parse<T: DeserializeOwned>(body: Result<Json<T>, JsonRejection>) -> Result<T, ApiError> {
    body.map(|Json(v)| v).map_err(|_| {
        invalid("Provide the documented synthetic offer or normalization fields with exact types.")
    })
}
fn bounded(v: &str, max: usize, name: &str) -> Result<(), ApiError> {
    if v.trim().is_empty() || v.chars().count() > max || v.contains('\0') {
        Err(invalid(format!(
            "{name} requires explicit text, at most {max} characters."
        )))
    } else {
        Ok(())
    }
}
fn decimal(v: &str) -> Result<(), ApiError> {
    let parts: Vec<_> = v.split('.').collect();
    if parts.len() > 2
        || parts[0].is_empty()
        || parts[0].len() > 16
        || parts
            .iter()
            .any(|p| p.is_empty() || !p.bytes().all(|c| c.is_ascii_digit()))
        || parts.get(1).is_some_and(|p| p.len() > 8)
        || !v.bytes().any(|b| (b'1'..=b'9').contains(&b))
    {
        return Err(invalid(
            "Amounts and quantities require positive decimal strings with at most 16 integer and 8 fractional digits; no rounding or floating point is accepted.",
        ));
    }
    Ok(())
}
fn currency(v: &str) -> Result<(), ApiError> {
    if v.len() != 3 || !v.bytes().all(|b| b.is_ascii_uppercase()) {
        Err(invalid(
            "Currency must be an explicit three-letter uppercase code.",
        ))
    } else {
        Ok(())
    }
}
impl OfferInput {
    fn validate(&self) -> Result<(), ApiError> {
        if !self.synthetic || self.scion_revision <= 0 {
            return Err(invalid(
                "An explicit synthetic offer and positive Scion revision are required.",
            ));
        }
        for (v, n) in [
            (&self.supplier.legal_name, "Supplier legal name"),
            (&self.supplier.jurisdiction, "Supplier jurisdiction"),
            (
                &self.supplier.registration_ref,
                "Supplier registration reference",
            ),
            (&self.supplier.site_code, "Supplier site code"),
            (&self.supplier.account_ref, "Supplier account"),
            (&self.offer_ref, "Offer reference"),
        ] {
            bounded(v, 200, n)?;
        }
        if self.supplier.country_code.len() != 2
            || !self
                .supplier
                .country_code
                .bytes()
                .all(|b| b.is_ascii_uppercase())
        {
            return Err(invalid(
                "Supplier country must be an explicit two-letter uppercase code.",
            ));
        }
        if !["exact", "ambiguous"].contains(&self.identity_match.as_str()) {
            return Err(invalid("Identity match must be exact or ambiguous."));
        }
        for (v, n) in [
            (&self.offered_manufacturer, "Offered manufacturer"),
            (&self.offered_part_number, "Offered part number"),
            (&self.uom, "Unit of measure"),
            (&self.destination, "Destination"),
            (&self.incoterm, "Incoterm"),
            (&self.payment_terms, "Payment terms"),
        ] {
            if let Some(v) = v {
                bounded(v, 500, n)?;
            }
        }
        for v in [&self.quantity, &self.unit_price].into_iter().flatten() {
            decimal(v)?;
        }
        if let Some(v) = &self.currency {
            currency(v)?;
        }
        if self
            .lead_time_days
            .is_some_and(|v| !(0..=36500).contains(&v))
        {
            return Err(invalid(
                "Lead time must be an explicit nonnegative day count, at most 36500.",
            ));
        }
        if matches!((self.valid_from,self.valid_until),(Some(a),Some(b)) if a>=b) {
            return Err(invalid("Validity end must follow its start."));
        }
        if self.source.source_revision <= 0
            || self.source.start_byte < 0
            || self.source.end_byte <= self.source.start_byte
            || self.source.end_byte > 32000
            || self.source.content_sha256.len() != 64
            || !self
                .source
                .content_sha256
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        {
            return Err(invalid(
                "Source must pin an exact revision, SHA-256, claim and UTF-8 byte interval.",
            ));
        }
        bounded(&self.change_summary, 1000, "Change summary")
    }
}
impl ComparisonInput {
    fn validate(&self) -> Result<(), ApiError> {
        if !self.synthetic
            || self.offer_revision_ids.len() != 2
            || self.offer_revision_ids[0] == self.offer_revision_ids[1]
        {
            return Err(invalid(
                "Exactly two distinct synthetic offer revisions are required.",
            ));
        }
        decimal(&self.basis.quantity)?;
        currency(&self.basis.currency)?;
        for (v, n) in [
            (&self.basis.uom, "Target UOM"),
            (&self.basis.destination, "Destination"),
            (&self.basis.incoterm, "Incoterm"),
            (&self.basis.payment_terms, "Payment terms"),
        ] {
            bounded(v, 500, n)?;
        }
        if self.basis.valid_from >= self.basis.valid_until
            || self.basis.as_of < self.basis.valid_from
            || self.basis.as_of >= self.basis.valid_until
        {
            return Err(invalid(
                "The comparison as-of instant must lie within the explicit nonempty validity basis.",
            ));
        }
        bounded(&self.change_summary, 1000, "Change summary")
    }
}
pub(super) fn validate_candidate(value: &Value) -> Result<(), ApiError> {
    let input: ComparisonInput = serde_json::from_value(value.clone()).map_err(|_| {
        invalid("A normalization task requires the documented exact comparison candidate.")
    })?;
    input.validate()
}

pub(super) fn routes() -> Router<PgPool> {
    Router::new()
        .route(
            "/api/scions/{id}/offers",
            get(list_offers).post(create_offer),
        )
        .route("/api/scions/{id}/offers/{offer}", get(detail_offer))
        .route(
            "/api/scions/{id}/offers/{offer}/revisions",
            get(history_offers).post(revise_offer),
        )
        .route("/api/scions/{id}/comparisons", get(list_comparisons))
        .route(
            "/api/scions/{id}/comparisons/proposals",
            axum::routing::post(propose),
        )
        .route(
            "/api/scions/{id}/comparisons/proposals/{proposal}",
            get(detail_comparison),
        )
        .route(
            "/api/scions/{id}/comparisons/proposals/{proposal}/confirm",
            axum::routing::post(confirm),
        )
}

async fn load_offer(tx: &mut Tx, scion: Uuid, offer: Uuid) -> Result<i32, ApiError> {
    sqlx::query_scalar(
        "SELECT current_revision FROM grimoire.intake_offer_series WHERE scion_id=$1 AND id=$2",
    )
    .bind(scion)
    .bind(offer)
    .fetch_optional(&mut **tx)
    .await?
    .ok_or_else(ApiError::not_found)
}
async fn load_submission(tx: &mut Tx, scion: Uuid, revision: Uuid) -> Result<OfferRow, ApiError> {
    sqlx::query_as(&format!(
        "SELECT {OFFER_COLUMNS} FROM grimoire.intake_offer_submissions WHERE scion_id=$1 AND id=$2"
    ))
    .bind(scion)
    .bind(revision)
    .fetch_optional(&mut **tx)
    .await?
    .ok_or_else(ApiError::not_found)
}
async fn verify_offer(
    tx: &mut Tx,
    scion: Uuid,
    input: &OfferInput,
    current: bool,
) -> Result<(), ApiError> {
    scope::confirmed(tx, scion, input.scion_revision, input.scope_proposal_id).await?;
    let reference = serde_json::to_value(&input.source)?;
    if current {
        scope::verify_reference(tx, scion, input.scion_revision, &reference).await
    } else {
        scope::verify_historical_reference(tx, scion, input.scion_revision, &reference).await
    }
}
async fn offer_revision_view(tx: &mut Tx, row: OfferRow) -> Result<Value, ApiError> {
    let input: OfferInput = serde_json::from_value(row.input.0.clone())?;
    let error = verify_offer(tx, row.scion_id, &input, false).await.err();
    let blockers: Vec<String> = error
        .as_ref()
        .map(|e| vec![format!("{}: {}", e.1, e.2)])
        .unwrap_or_default();
    let redacted = error.is_some();
    let governed: Option<Value> = if !redacted && row.governed_offer_revision_id.is_some() {
        sqlx::query_scalar("SELECT app.intake_offer_governed($1)")
            .bind(row.id)
            .fetch_one(&mut **tx)
            .await?
    } else {
        None
    };
    Ok(
        json!({"id":row.id,"offer_id":row.offer_id,"number":row.number,"input":if redacted{Value::Null}else{row.input.0},"missing_fields":row.missing_fields,"governed_offer_revision_id":row.governed_offer_revision_id,"governed_offer_line_id":row.governed_offer_line_id,"governed":governed,"created_by":row.created_by,"created_at":row.created_at,"blockers":blockers,"content_redacted":redacted}),
    )
}
async fn offer_view(
    tx: &mut Tx,
    scion: Uuid,
    offer: Uuid,
    history: bool,
) -> Result<Value, ApiError> {
    let current = load_offer(tx, scion, offer).await?;
    let rows=sqlx::query_as::<_,OfferRow>(&format!("SELECT {OFFER_COLUMNS} FROM grimoire.intake_offer_submissions WHERE scion_id=$1 AND offer_id=$2 AND ($3 OR number=$4) ORDER BY number DESC")).bind(scion).bind(offer).bind(history).bind(current).fetch_all(&mut **tx).await?;
    let mut revisions = Vec::new();
    for row in rows {
        revisions.push(offer_revision_view(tx, row).await?);
    }
    let mut value = json!({"id":offer,"scion_id":scion,"current_revision":current,"revision":revisions.first()});
    if history {
        value["revisions"] = json!(revisions);
    }
    Ok(value)
}
async fn list_offers(
    State(pool): State<PgPool>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> ApiResult {
    let (mut tx, _) = authenticate(&pool, &headers).await?;
    let id = parse_id(&id)?;
    visible_revision(&mut tx, id, false).await?;
    let ids: Vec<Uuid> = sqlx::query_scalar(
        "SELECT id FROM grimoire.intake_offer_series WHERE scion_id=$1 ORDER BY created_at,id",
    )
    .bind(id)
    .fetch_all(&mut *tx)
    .await?;
    let mut offers = Vec::new();
    for offer in ids {
        offers.push(offer_view(&mut tx, id, offer, false).await?);
    }
    tx.commit().await?;
    Ok(Json(json!({"offers":offers,"synthetic_only":true})).into_response())
}
async fn detail_offer(
    State(pool): State<PgPool>,
    headers: HeaderMap,
    Path((id, offer)): Path<(String, String)>,
) -> ApiResult {
    let (mut tx, _) = authenticate(&pool, &headers).await?;
    let (id, offer) = (parse_id(&id)?, parse_id(&offer)?);
    visible_revision(&mut tx, id, false).await?;
    let result = offer_view(&mut tx, id, offer, true).await?;
    tx.commit().await?;
    Ok(Json(result).into_response())
}
async fn history_offers(
    state: State<PgPool>,
    headers: HeaderMap,
    path: Path<(String, String)>,
) -> ApiResult {
    detail_offer(state, headers, path).await
}
fn request_hash<T: Serialize>(path: &str, base: i32, input: &T) -> Result<String, ApiError> {
    Ok(format!(
        "{:x}",
        Sha256::digest(
            format!("POST\n{path}\n{base}\n{}", serde_json::to_string(input)?).as_bytes()
        )
    ))
}
async fn audit_context(
    tx: &mut Tx,
    role: &str,
    endpoint: &str,
    hash: &str,
    reason: &str,
) -> Result<(), ApiError> {
    sqlx::query("SELECT set_config('app.effective_role',$1,true),set_config('app.endpoint_scope',$2,true),set_config('app.input_hash',$3,true),set_config('app.action_reason',$4,true),set_config('app.action_outcome','committed',true)")
        .bind(role).bind(endpoint).bind(hash).bind(reason).execute(&mut **tx).await?;
    Ok(())
}
async fn write_offer(
    pool: PgPool,
    headers: HeaderMap,
    scion: Uuid,
    offer: Option<Uuid>,
    body: Result<Json<OfferInput>, JsonRejection>,
) -> ApiResult {
    let (mut tx, actor) = authenticate(&pool, &headers).await?;
    visible_revision(&mut tx, scion, false).await?;
    let previous = if let Some(id) = offer {
        Some(load_offer(&mut tx, scion, id).await?)
    } else {
        None
    };
    if !actor.can_write || actor.is_agent {
        return Err(ApiError::forbidden());
    }
    let input: OfferInput = parse(body)?;
    input.validate()?;
    let base = precondition(&headers)?;
    let key = key(&headers)?;
    let path = if let Some(id) = offer {
        format!("/api/scions/{scion}/offers/{id}/revisions")
    } else {
        format!("/api/scions/{scion}/offers")
    };
    let hash = request_hash(&path, base, &input)?;
    verify_offer(&mut tx, scion, &input, true).await?;
    if let Some(response) = scope::replay_scope(&mut tx, &actor, &key, &hash).await? {
        tx.commit().await?;
        return Ok(response);
    }
    if previous.is_some_and(|n| n != base) || previous.is_none() && base != input.scion_revision {
        return Err(ApiError::stale());
    }
    let number = previous.map_or(1, |n| n + 1);
    let id = offer.unwrap_or_else(Uuid::new_v4);
    audit_context(
        &mut tx,
        "synthetic_offer_handler",
        "intake:synthetic-offer-submit",
        &hash,
        &input.change_summary,
    )
    .await?;
    let _: Uuid = sqlx::query_scalar("SELECT app.intake_offer_submit($1,$2,$3,$4)")
        .bind(scion)
        .bind(id)
        .bind(number)
        .bind(sqlx::types::Json(&input))
        .fetch_one(&mut *tx)
        .await?;
    let response = serde_json::to_string(&offer_view(&mut tx, scion, id, false).await?)?;
    scope::store(&mut tx, &actor, &key, &hash, &response, number).await?;
    tx.commit().await?;
    resource_response(StatusCode::CREATED, response, etag(number), false)
}
async fn create_offer(
    State(pool): State<PgPool>,
    headers: HeaderMap,
    Path(id): Path<String>,
    body: Result<Json<OfferInput>, JsonRejection>,
) -> ApiResult {
    write_offer(pool, headers, parse_id(&id)?, None, body).await
}
async fn revise_offer(
    State(pool): State<PgPool>,
    headers: HeaderMap,
    Path((id, offer)): Path<(String, String)>,
    body: Result<Json<OfferInput>, JsonRejection>,
) -> ApiResult {
    write_offer(pool, headers, parse_id(&id)?, Some(parse_id(&offer)?), body).await
}

pub(super) async fn verify_candidate(
    tx: &mut Tx,
    scion: Uuid,
    revision: i32,
    value: &Value,
) -> Result<(), ApiError> {
    validate_candidate(value)?;
    let input: ComparisonInput = serde_json::from_value(value.clone())?;
    scope::confirmed(tx, scion, revision, input.scope_proposal_id).await?;
    for id in &input.offer_revision_ids {
        let row = load_submission(tx, scion, *id).await?;
        let offer: OfferInput = serde_json::from_value(row.input.0)?;
        if offer.scope_proposal_id != input.scope_proposal_id {
            return Err(invalid(
                "Both offers must bind this exact confirmed physical scope.",
            ));
        }
        verify_offer(tx, scion, &offer, false).await?;
    }
    sqlx::query("SELECT app.intake_offer_assert_candidate($1,$2,$3)")
        .bind(scion)
        .bind(revision)
        .bind(value)
        .execute(&mut **tx)
        .await?;
    Ok(())
}
async fn load_comparison(tx: &mut Tx, scion: Uuid, id: Uuid) -> Result<ComparisonRow, ApiError> {
    sqlx::query_as(&format!("SELECT {COMPARISON_COLUMNS} FROM grimoire.intake_comparison_proposals WHERE scion_id=$1 AND id=$2")).bind(scion).bind(id).fetch_optional(&mut **tx).await?.ok_or_else(ApiError::not_found)
}
async fn comparison_view(tx: &mut Tx, row: ComparisonRow) -> Result<Value, ApiError> {
    let current_revision = visible_revision(tx, row.scion_id, false).await?;
    let computed_stale = current_revision != row.scion_revision;
    let persisted_reaction = monitoring::latest_reaction(tx, "offer_comparison", row.id).await?;
    let error = verify_candidate(tx, row.scion_id, row.scion_revision, &row.input)
        .await
        .err();
    let redacted = error.is_some();
    let mut blockers = Vec::new();
    if let Some(e) = error {
        blockers.push(format!("{}: {}", e.1, e.2));
    }
    if !redacted {
        let fresh: Value = sqlx::query_scalar("SELECT app.intake_offer_snapshot($1,$2,$3)")
            .bind(row.scion_id)
            .bind(row.scion_revision)
            .bind(&row.input.0)
            .fetch_one(&mut **tx)
            .await?;
        if fresh != row.snapshot {
            blockers.push(
                "An offer or source revision changed; the immutable snapshot is no longer current."
                    .into(),
            );
        }
    }
    let mut confirmation:Option<Value>=sqlx::query_scalar("SELECT to_jsonb(c)-'org_id' FROM grimoire.intake_comparison_confirmations c WHERE proposal_id=$1").bind(row.id).fetch_optional(&mut **tx).await?;
    if let Some(c) = &mut confirmation {
        if redacted {
            c["review_note"] = Value::Null;
            c["governed"] = Value::Null;
        } else {
            let governed: Option<Value> =
                sqlx::query_scalar("SELECT app.intake_comparison_governed($1)")
                    .bind(row.id)
                    .fetch_one(&mut **tx)
                    .await?;
            c["governed"] = governed.unwrap_or(Value::Null);
        }
    }
    let reviewer_conflict: bool =
        sqlx::query_scalar("SELECT app.intake_offer_reviewer_conflict($1)")
            .bind(row.id)
            .fetch_one(&mut **tx)
            .await?;
    let can_confirm: bool = sqlx::query_scalar("SELECT app.intake_scope_can_confirm()")
        .fetch_one(&mut **tx)
        .await?;
    let status = if !blockers.is_empty() {
        "blocked"
    } else if confirmation.is_some() {
        "confirmed"
    } else {
        "proposed"
    };
    Ok(
        json!({"id":row.id,"scion_id":row.scion_id,"scion_revision":row.scion_revision,"input":if redacted{Value::Null}else{row.input.0},"snapshot":if redacted{Value::Null}else{row.snapshot},"created_by":row.created_by,"created_at":row.created_at,"status":status,"blockers":blockers,"confirmation":confirmation,"reviewer_conflict":reviewer_conflict,"computed_stale":computed_stale,"persisted_revision_reaction":persisted_reaction,"can_confirm_this_proposal":can_confirm&&!reviewer_conflict&&blockers.is_empty()&&confirmation.is_none(),"content_redacted":redacted}),
    )
}
async fn list_comparisons(
    State(pool): State<PgPool>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> ApiResult {
    let (mut tx, actor) = authenticate(&pool, &headers).await?;
    let id = parse_id(&id)?;
    visible_revision(&mut tx, id, false).await?;
    let rows=sqlx::query_as::<_,ComparisonRow>(&format!("SELECT {COMPARISON_COLUMNS} FROM grimoire.intake_comparison_proposals WHERE scion_id=$1 ORDER BY created_at DESC,id")).bind(id).fetch_all(&mut *tx).await?;
    let mut proposals = Vec::new();
    for row in rows {
        proposals.push(comparison_view(&mut tx, row).await?);
    }
    tx.commit().await?;
    Ok(Json(json!({"proposals":proposals,"can_confirm":actor.can_confirm_scope,"can_propose":actor.can_propose_scope,"synthetic_only":true})).into_response())
}
async fn detail_comparison(
    State(pool): State<PgPool>,
    headers: HeaderMap,
    Path((id, proposal)): Path<(String, String)>,
) -> ApiResult {
    let (mut tx, _) = authenticate(&pool, &headers).await?;
    let id = parse_id(&id)?;
    visible_revision(&mut tx, id, false).await?;
    let row = load_comparison(&mut tx, id, parse_id(&proposal)?).await?;
    let value = comparison_view(&mut tx, row).await?;
    tx.commit().await?;
    Ok(Json(value).into_response())
}
async fn propose(
    State(pool): State<PgPool>,
    headers: HeaderMap,
    Path(id): Path<String>,
    body: Result<Json<ComparisonInput>, JsonRejection>,
) -> ApiResult {
    let (mut tx, actor) = authenticate(&pool, &headers).await?;
    let id = parse_id(&id)?;
    visible_revision(&mut tx, id, false).await?;
    if !actor.can_propose_scope {
        return Err(ApiError::forbidden());
    }
    let input: ComparisonInput = parse(body)?;
    input.validate()?;
    let base = precondition(&headers)?;
    let key = key(&headers)?;
    let value = serde_json::to_value(&input)?;
    let hash = request_hash(
        &format!("/api/scions/{id}/comparisons/proposals"),
        base,
        &input,
    )?;
    verify_candidate(&mut tx, id, base, &value).await?;
    byoa::submission(
        &mut tx,
        &actor,
        &headers,
        id,
        base,
        "prepare_offer_normalization",
        &value,
    )
    .await?;
    if let Some(response) = scope::replay_scope(&mut tx, &actor, &key, &hash).await? {
        tx.commit().await?;
        return Ok(response);
    }
    let proposal = Uuid::new_v4();
    sqlx::query("INSERT INTO grimoire.intake_comparison_proposals(id,org_id,scion_id,scion_revision,input,snapshot,created_by) VALUES($1,$2,$3,$4,$5,'{}',$6)").bind(proposal).bind(actor.org_id).bind(id).bind(base).bind(&value).bind(actor.principal_id).execute(&mut *tx).await?;
    let row = load_comparison(&mut tx, id, proposal).await?;
    let response = serde_json::to_string(&comparison_view(&mut tx, row).await?)?;
    scope::store(&mut tx, &actor, &key, &hash, &response, base).await?;
    tx.commit().await?;
    resource_response(StatusCode::CREATED, response, etag(base), false)
}
async fn confirm(
    State(pool): State<PgPool>,
    headers: HeaderMap,
    Path((id, proposal)): Path<(String, String)>,
    body: Result<Json<Confirm>, JsonRejection>,
) -> ApiResult {
    let (mut tx, actor) = authenticate(&pool, &headers).await?;
    let (id, proposal) = (parse_id(&id)?, parse_id(&proposal)?);
    visible_revision(&mut tx, id, false).await?;
    let row = load_comparison(&mut tx, id, proposal).await?;
    let conflict: bool = sqlx::query_scalar("SELECT app.intake_offer_reviewer_conflict($1)")
        .bind(proposal)
        .fetch_one(&mut *tx)
        .await?;
    if !actor.can_confirm_scope || actor.is_agent || conflict {
        return Err(ApiError(StatusCode::FORBIDDEN,"NORMALIZATION_REVIEW_DENIED","A separate enrolled synthetic engineering reviewer must confirm normalization; preparers and agents cannot.".into()));
    }
    let input: Confirm = parse(body)?;
    if !input.confirm_synthetic_normalization {
        return Err(invalid(
            "Explicit synthetic normalization confirmation is required.",
        ));
    }
    bounded(&input.review_note, 2000, "Review rationale")?;
    let base = precondition(&headers)?;
    if base != row.scion_revision {
        return Err(ApiError::stale());
    }
    let key = key(&headers)?;
    let hash = request_hash(
        &format!("/api/scions/{id}/comparisons/proposals/{proposal}/confirm"),
        base,
        &input,
    )?;
    verify_candidate(&mut tx, id, base, &row.input).await?;
    if let Some(response) = scope::replay_scope(&mut tx, &actor, &key, &hash).await? {
        tx.commit().await?;
        return Ok(response);
    }
    audit_context(
        &mut tx,
        "synthetic_engineering_reviewer",
        "intake:synthetic-normalization-confirm",
        &hash,
        &input.review_note,
    )
    .await?;
    sqlx::query("SELECT app.intake_offer_confirm($1,$2,$3,$4)")
        .bind(id)
        .bind(proposal)
        .bind(base)
        .bind(&input.review_note)
        .execute(&mut *tx)
        .await?;
    let response = serde_json::to_string(&comparison_view(&mut tx, row).await?)?;
    scope::store(&mut tx, &actor, &key, &hash, &response, base).await?;
    tx.commit().await?;
    resource_response(StatusCode::CREATED, response, etag(base), false)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn exact_decimal_validation_never_rounds() {
        for v in ["0.00000001", "9999999999999999.12345678", "12.50"] {
            assert!(decimal(v).is_ok());
        }
        for v in [
            "0",
            "-1",
            "1e2",
            "1.000000001",
            "10000000000000000",
            ".5",
            "1.",
            "NaN",
        ] {
            assert!(decimal(v).is_err(), "{v}");
        }
    }
}
