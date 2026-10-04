//! Explicitly consented public research on the native task queue. All findings are
//! unverified; server fetch receipts attest retrieval only, never commercial facts.
use super::*;
use serde::Deserialize;
use serde_json::Value;
use std::{collections::HashSet, net::IpAddr, time::Duration};
use url::Url;

pub const POLICY: &str = "public-web-research-v1";
pub fn routes() -> Router<PgPool> {
    Router::new()
        .route("/api/scions/{id}/research", get(state))
        .route(
            "/api/scions/{id}/research-reports",
            axum::routing::post(submit),
        )
        .route("/api/scions/{id}/research-reports/{report}", get(detail))
        .route(
            "/api/scions/{id}/research-reports/{report}/reviews",
            axum::routing::post(review),
        )
        .route(
            "/api/agent/tasks/{id}/research-captures",
            axum::routing::post(capture),
        )
        .route(
            "/api/scions/{id}/research-captures/{capture}/revoke",
            axum::routing::post(revoke),
        )
}
fn input<T>(value: Result<Json<T>, JsonRejection>) -> Result<T, ApiError> {
    value
        .map(|Json(v)| v)
        .map_err(|_| ApiError::invalid("Use the bounded public research fields."))
}
fn bounded(text: &str, max: usize) -> bool {
    !text.trim().is_empty() && text.chars().count() <= max && !text.contains('\0')
}
pub fn capable(headers: &HeaderMap) -> bool {
    let mut values = headers.get_all("X-Grimoire-Public-Web").iter();
    values.next().and_then(|v| v.to_str().ok()) == Some("1") && values.next().is_none()
}
pub fn serpapi_capable(headers: &HeaderMap) -> bool {
    let mut values = headers.get_all("X-Grimoire-SerpApi").iter();
    capable(headers)
        && values.next().and_then(|v| v.to_str().ok()) == Some("1")
        && values.next().is_none()
}
pub fn validate_candidate(value: &Value) -> Result<(), ApiError> {
    let object = value
        .as_object()
        .ok_or_else(|| ApiError::invalid("A public research brief is required."))?;
    if !((object.len() == 5 && !object.contains_key("search_provider"))
        || (object.len() == 6 && value["search_provider"] == "serpapi"))
        || value["synthetic"] != false
        || value["consent"] != true
        || value["policy_version"] != POLICY
        || !value["objective"]
            .as_str()
            .is_some_and(|s| bounded(s, 4000))
        || value["worker_connection_id"]
            .as_str()
            .is_none_or(|s| Uuid::parse_str(s).is_err())
    {
        return Err(ApiError(StatusCode::UNPROCESSABLE_ENTITY,"RESEARCH_CONSENT_REQUIRED","Choose a computer and explicitly consent to this public research brief using public-web-research-v1. No private source content is sent.".into()));
    }
    Ok(())
}
async fn visible(tx: &mut Tx, id: Uuid) -> Result<i32, ApiError> {
    sqlx::query_scalar("SELECT current_revision FROM grimoire.intake_scions WHERE id=$1")
        .bind(id)
        .fetch_optional(&mut **tx)
        .await?
        .ok_or_else(ApiError::not_found)
}
fn lease(headers: &HeaderMap) -> Result<Uuid, ApiError> {
    headers
        .get("X-Grimoire-Task-Lease")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| Uuid::parse_str(v).ok())
        .ok_or_else(ApiError::forbidden)
}
async fn authorize_task(
    tx: &mut Tx,
    actor: &Actor,
    headers: &HeaderMap,
    task: Uuid,
) -> Result<(Uuid, i32), ApiError> {
    if !actor.is_agent || !capable(headers) {
        return Err(ApiError::forbidden());
    }
    crate::agents::worker_seen(tx, headers).await?;
    let token = lease(headers)?;
    sqlx::query("SELECT app.intake_research_assert_task($1,$2)")
        .bind(task)
        .bind(token)
        .execute(&mut **tx)
        .await?;
    sqlx::query(
        "SELECT set_config('app.agent_task_id',$1,true),set_config('app.agent_task_lease',$2,true)",
    )
    .bind(task.to_string())
    .bind(token.to_string())
    .execute(&mut **tx)
    .await?;
    Ok(sqlx::query_as(
        "SELECT scion_id,scion_revision FROM grimoire.intake_agent_tasks WHERE id=$1",
    )
    .bind(task)
    .fetch_one(&mut **tx)
    .await?)
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Step {
    title: String,
    detail: String,
    source_urls: Vec<String>,
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Candidate {
    name: String,
    url: String,
    rationale: String,
    source_urls: Vec<String>,
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Source {
    url: String,
    title: String,
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Query {
    query: String,
    observed_at: DateTime<Utc>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    provider: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    engine: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    search_id: Option<String>,
}
impl Query {
    fn provider_valid(&self) -> bool {
        match (&self.provider, &self.engine, &self.search_id) {
            (None, None, None) => true,
            (Some(provider), Some(engine), Some(id)) => {
                provider == "serpapi"
                    && engine == "google"
                    && (1..=128).contains(&id.len())
                    && id
                        .bytes()
                        .all(|v| v.is_ascii_alphanumeric() || v == b'_' || v == b'-')
            }
            _ => false,
        }
    }
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct ReportInput {
    synthetic: bool,
    summary: String,
    process_steps: Vec<Step>,
    candidates: Vec<Candidate>,
    sources: Vec<Source>,
    unresolved_gaps: Vec<String>,
    queries: Vec<Query>,
    capture_ids: Vec<Uuid>,
}
impl ReportInput {
    fn validate_provider(&self, provider: Option<&str>) -> Result<(), ApiError> {
        if self
            .queries
            .iter()
            .any(|query| query.provider.as_deref() != provider)
        {
            return Err(ApiError::invalid(
                "Search receipts must match the search provider explicitly selected for this task.",
            ));
        }
        if provider == Some("serpapi") && (self.queries.len() > 3 || self.sources.is_empty()) {
            return Err(ApiError::invalid(
                "SerpApi research permits at most three queries and requires at least one successfully captured source.",
            ));
        }
        Ok(())
    }
    fn validate(&self) -> Result<(), ApiError> {
        let urls: HashSet<&str> = self.sources.iter().map(|v| v.url.as_str()).collect();
        let refs =
            |list: &Vec<String>| list.len() <= 8 && list.iter().all(|u| urls.contains(u.as_str()));
        if self.synthetic
            || !bounded(&self.summary, 4000)
            || self.process_steps.len() > 8
            || self.candidates.len() > 8
            || self.sources.len() > 8
            || urls.len() != self.sources.len()
            || self.capture_ids.len() != self.sources.len()
            || self.capture_ids.iter().collect::<HashSet<_>>().len() != self.capture_ids.len()
            || self.queries.is_empty()
            || self.queries.len() > 5
            || self.unresolved_gaps.len() > 40
            || self.unresolved_gaps.iter().any(|v| !bounded(v, 1000))
            || self
                .sources
                .iter()
                .any(|v| !bounded(&v.title, 160) || public_url(&v.url).is_err())
            || self.process_steps.iter().any(|v| {
                !bounded(&v.title, 160) || !bounded(&v.detail, 4000) || !refs(&v.source_urls)
            })
            || self.candidates.iter().any(|v| {
                !bounded(&v.name, 160)
                    || !bounded(&v.rationale, 4000)
                    || !urls.contains(v.url.as_str())
                    || !refs(&v.source_urls)
            })
            || self.queries.iter().any(|v| {
                !v.provider_valid()
                    || !bounded(&v.query, 2000)
                    || v.observed_at > Utc::now() + chrono::Duration::minutes(2)
            })
        {
            return Err(ApiError::invalid(
                "Research must contain bounded findings, actual query receipts and one capture for every attributed public URL.",
            ));
        }
        Ok(())
    }
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CaptureInput {
    url: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Note {
    note: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Revocation {
    reason: String,
}

// Reject special-purpose IP space, including IPv4-mapped IPv6, transition and
// documentation ranges. DNS is validated and pinned separately for every hop.
fn public_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v) => {
            let n = u32::from(v);
            ![
                (0, 8),
                (0x0a000000, 8),
                (0x64400000, 10),
                (0x7f000000, 8),
                (0xa9fe0000, 16),
                (0xac100000, 12),
                (0xc0000000, 24),
                (0xc0000200, 24),
                (0xc0586300, 24),
                (0xc0a80000, 16),
                (0xc6120000, 15),
                (0xc6336400, 24),
                (0xcb007100, 24),
                (0xe0000000, 4),
                (0xf0000000, 4),
            ]
            .iter()
            .any(|(network, bits)| n & (u32::MAX << (32 - bits)) == *network)
        }
        IpAddr::V6(v) => {
            if let Some(v4) = v.to_ipv4_mapped() {
                return public_ip(IpAddr::V4(v4));
            }
            let b = v.octets();
            b[0] & 0xe0 == 0x20
                && !(b[0] == 0x20 && b[1] == 0x01 && (b[2] < 2 || b[2] == 0x0d && b[3] == 0xb8))
                && !(b[0] == 0x20 && b[1] == 0x02)
                && !(b[0] == 0x3f && b[1] == 0xff)
        }
    }
}
fn public_url(raw: &str) -> Result<Url, &'static str> {
    if raw.len() > 2000 || raw.chars().any(char::is_control) {
        return Err("URL_REJECTED");
    }
    let url = Url::parse(raw).map_err(|_| "URL_REJECTED")?;
    if !matches!(url.scheme(), "https" | "http")
        || !url.username().is_empty()
        || url.password().is_some()
        || !matches!(
            (url.scheme(), url.port_or_known_default()),
            ("https", Some(443)) | ("http", Some(80))
        )
    {
        return Err("URL_REJECTED");
    }
    match url.host().ok_or("URL_REJECTED")? {
        url::Host::Ipv4(ip) if !public_ip(IpAddr::V4(ip)) => return Err("URL_REJECTED"),
        url::Host::Ipv6(ip) if !public_ip(IpAddr::V6(ip)) => return Err("URL_REJECTED"),
        url::Host::Domain(host)
            if !host.contains('.')
                || [
                    "localhost",
                    ".localhost",
                    ".local",
                    ".internal",
                    ".test",
                    ".invalid",
                    ".example",
                ]
                .iter()
                .any(|v| host.ends_with(v)) =>
        {
            return Err("URL_REJECTED");
        }
        _ => {}
    }
    Ok(url)
}
fn extract_text(body: &str, html: bool) -> String {
    let mut plain = String::new();
    if html {
        let mut rest = body;
        while let Some(at) = rest.find('<') {
            plain.push_str(&rest[..at]);
            plain.push(' ');
            rest = &rest[at + 1..];
            if rest.starts_with("!--") {
                if let Some(end) = rest.find("-->") {
                    rest = &rest[end + 3..];
                    continue;
                } else {
                    break;
                }
            }
            let Some(end) = rest.find('>') else {
                break;
            };
            let tag = rest[..end]
                .split_whitespace()
                .next()
                .unwrap_or("")
                .trim_end_matches('/')
                .to_ascii_lowercase();
            rest = &rest[end + 1..];
            if matches!(
                tag.as_str(),
                "script" | "style" | "noscript" | "svg" | "template"
            ) {
                let close = format!("</{tag}");
                if let Some(pos) = rest.to_ascii_lowercase().find(&close) {
                    rest = &rest[pos..];
                    if let Some(end) = rest.find('>') {
                        rest = &rest[end + 1..];
                    } else {
                        break;
                    }
                } else {
                    break;
                }
            }
        }
        plain.push_str(rest);
    } else {
        plain.push_str(body);
    }
    let plain = plain
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&nbsp;", " ");
    let mut result = plain
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .filter(|c| !c.is_control())
        .collect::<String>();
    let mut limit = result.len().min(32000);
    while !result.is_char_boundary(limit) {
        limit -= 1;
    }
    result.truncate(limit);
    result
}
struct Fetched {
    url: String,
    status: i32,
    hash: String,
    len: i32,
    excerpt: String,
}
async fn fetch_public(raw: &str) -> Result<Fetched, &'static str> {
    let mut url = public_url(raw)?;
    for hop in 0..=3 {
        let host = url
            .host_str()
            .ok_or("URL_REJECTED")?
            .trim_matches(['[', ']'])
            .to_string();
        let port = url.port_or_known_default().ok_or("URL_REJECTED")?;
        let addresses: Vec<SocketAddr> = tokio::net::lookup_host((host.as_str(), port))
            .await
            .map_err(|_| "DNS_UNAVAILABLE")?
            .collect();
        if addresses.is_empty() || addresses.iter().any(|v| !public_ip(v.ip())) {
            return Err("DNS_ADDRESS_REJECTED");
        }
        let client = reqwest::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(8))
            .resolve_to_addrs(&host, &addresses)
            .user_agent("GrimoirePublicResearch/1.0")
            .build()
            .map_err(|_| "FETCH_UNAVAILABLE")?;
        let mut response = client
            .get(url.clone())
            .header("Accept", "text/html,text/plain,application/xhtml+xml")
            .send()
            .await
            .map_err(|_| "FETCH_UNAVAILABLE")?;
        let status = response.status();
        if status.is_redirection() {
            if hop == 3 {
                return Err("REDIRECT_LIMIT");
            }
            let location = response
                .headers()
                .get("location")
                .and_then(|v| v.to_str().ok())
                .ok_or("INVALID_REDIRECT")?;
            let next = url.join(location).map_err(|_| "INVALID_REDIRECT")?;
            url = public_url(next.as_str())?;
            continue;
        }
        if !status.is_success() {
            return Err("HTTP_ERROR");
        }
        let mime = response
            .headers()
            .get("content-type")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .split(';')
            .next()
            .unwrap_or("")
            .trim();
        let html = matches!(mime, "text/html" | "application/xhtml+xml");
        if !html && mime != "text/plain" {
            return Err("UNSUPPORTED_CONTENT_TYPE");
        }
        if response.content_length().is_some_and(|n| n > 262144) {
            return Err("RESPONSE_TOO_LARGE");
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(|_| "BODY_UNAVAILABLE")? {
            if bytes.len() + chunk.len() > 262144 {
                return Err("RESPONSE_TOO_LARGE");
            }
            bytes.extend_from_slice(&chunk);
        }
        let text = std::str::from_utf8(&bytes).map_err(|_| "UNSUPPORTED_ENCODING")?;
        let excerpt = extract_text(text, html);
        if excerpt.is_empty() {
            return Err("NO_EXTRACTABLE_TEXT");
        }
        return Ok(Fetched {
            url: url.to_string(),
            status: i32::from(status.as_u16()),
            hash: format!("{:x}", Sha256::digest(&bytes)),
            len: bytes.len() as i32,
            excerpt,
        });
    }
    Err("REDIRECT_LIMIT")
}

async fn captures(tx: &mut Tx, task: Uuid) -> Result<Vec<Value>, ApiError> {
    // Revocation writes take the same capture row lock, so read and withdrawal serialize.
    sqlx::query("SELECT app.intake_research_lock_captures($1,NULL)")
        .bind(task)
        .execute(&mut **tx)
        .await?;
    Ok(sqlx::query_scalar("SELECT jsonb_build_object('id',c.id,'url',CASE WHEN r.capture_id IS NULL THEN c.requested_url END,'final_url',CASE WHEN r.capture_id IS NULL THEN c.final_url END,'status',CASE WHEN r.capture_id IS NULL THEN c.status ELSE 'revoked' END,'http_status',CASE WHEN r.capture_id IS NULL THEN c.http_status END,'fetched_at',c.fetched_at,'content_sha256',CASE WHEN r.capture_id IS NULL THEN c.content_sha256 END,'byte_length',CASE WHEN r.capture_id IS NULL THEN c.byte_length END,'excerpt',CASE WHEN r.capture_id IS NULL THEN c.excerpt END,'failure_code',CASE WHEN r.capture_id IS NULL THEN c.failure_code ELSE 'SOURCE_REVOKED' END,'authority','public_web_capture','verification_status','unverified') FROM grimoire.intake_research_captures c LEFT JOIN grimoire.intake_research_capture_revocations r ON (r.org_id,r.capture_id)=(c.org_id,c.id) WHERE c.agent_task_id=$1 ORDER BY c.recorded_at,c.id")
        .bind(task).fetch_all(&mut **tx).await?)
}
async fn capture(
    State(pool): State<PgPool>,
    headers: HeaderMap,
    Path(task): Path<String>,
    body: Result<Json<CaptureInput>, JsonRejection>,
) -> ApiResult {
    let task = parse_id(&task)?;
    let body = input(body)?;
    public_url(&body.url).map_err(|_| {
        ApiError::invalid(
            "Only public HTTP(S) URLs on standard ports without credentials are allowed.",
        )
    })?;
    // Authorize before fetching, release all database locks during network I/O,
    // then reauthorize before recording. Cancellation must remain responsive.
    let (mut tx, actor) = authenticate(&pool, &headers).await?;
    authorize_task(&mut tx, &actor, &headers, task).await?;
    let old:Option<Uuid>=sqlx::query_scalar("SELECT id FROM grimoire.intake_research_captures WHERE agent_task_id=$1 AND requested_url=$2").bind(task).bind(&body.url).fetch_optional(&mut *tx).await?;
    if let Some(id) = old {
        let result = captures(&mut tx, task)
            .await?
            .into_iter()
            .find(|v| v["id"] == id.to_string())
            .ok_or_else(ApiError::not_found)?;
        tx.commit().await?;
        return Ok(Json(result).into_response());
    }
    let count: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM grimoire.intake_research_captures WHERE agent_task_id=$1",
    )
    .bind(task)
    .fetch_one(&mut *tx)
    .await?;
    if count >= 8 {
        return Err(ApiError::invalid(
            "This research task already has eight URL capture receipts.",
        ));
    }
    tx.commit().await?;
    let result = tokio::time::timeout(Duration::from_secs(10), fetch_public(&body.url))
        .await
        .unwrap_or(Err("FETCH_TIMEOUT"));
    let (mut tx, actor) = authenticate(&pool, &headers).await?;
    let (scion, revision) = authorize_task(&mut tx, &actor, &headers, task).await?;
    // Concurrent retries may retrieve twice, but only one immutable receipt and
    // audit effect are stored. The database guard also caps the final row count.
    let old:Option<Uuid>=sqlx::query_scalar("SELECT id FROM grimoire.intake_research_captures WHERE agent_task_id=$1 AND requested_url=$2").bind(task).bind(&body.url).fetch_optional(&mut *tx).await?;
    if let Some(id) = old {
        let receipt = captures(&mut tx, task)
            .await?
            .into_iter()
            .find(|v| v["id"] == id.to_string())
            .ok_or_else(ApiError::not_found)?;
        tx.commit().await?;
        return Ok(Json(receipt).into_response());
    }
    let id = Uuid::new_v4();
    let at = Utc::now();
    let (status, final_url, http, hash, len, excerpt, failure) = match result {
        Ok(v) => (
            "captured",
            Some(v.url),
            Some(v.status),
            Some(v.hash),
            Some(v.len),
            Some(v.excerpt),
            None,
        ),
        Err(code) => ("failed", None, None, None, None, None, Some(code)),
    };
    sqlx::query("INSERT INTO grimoire.intake_research_captures(id,org_id,scion_id,scion_revision,agent_task_id,requested_url,final_url,status,http_status,fetched_at,content_sha256,byte_length,excerpt,failure_code,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)")
        .bind(id).bind(actor.org_id).bind(scion).bind(revision).bind(task).bind(body.url).bind(final_url).bind(status).bind(http).bind(at).bind(hash).bind(len).bind(excerpt).bind(failure).bind(actor.principal_id).execute(&mut *tx).await?;
    let receipt = captures(&mut tx, task)
        .await?
        .into_iter()
        .find(|v| v["id"] == id.to_string())
        .ok_or_else(ApiError::not_found)?;
    tx.commit().await?;
    Ok((StatusCode::CREATED, Json(receipt)).into_response())
}
async fn report(tx: &mut Tx, scion: Uuid, id: Uuid) -> Result<Value, ApiError> {
    let current = visible(tx, scion).await?;
    let row:Option<(Uuid,i32,Value,DateTime<Utc>)>=sqlx::query_as("SELECT agent_task_id,scion_revision,input,created_at FROM grimoire.intake_research_reports WHERE scion_id=$1 AND id=$2").bind(scion).bind(id).fetch_optional(&mut **tx).await?;
    let (task, revision, value, created) = row.ok_or_else(ApiError::not_found)?;
    let receipts = captures(tx, task).await?;
    let revoked = receipts.iter().any(|v| v["status"] == "revoked");
    let flags:Option<(bool,bool)>=sqlx::query_as("SELECT stale,blocked FROM grimoire.intake_watch_node_states WHERE node_kind='agent_task' AND node_id=$1").bind(task).fetch_optional(&mut **tx).await?;
    let stale = revision != current || flags.is_some_and(|v| v.0);
    let blocked = revoked || flags.is_some_and(|v| v.1);
    let reviews: Vec<Value> = if blocked {
        vec![]
    } else {
        sqlx::query_scalar("SELECT jsonb_build_object('id',id,'reviewer_id',reviewer_id,'note',note,'created_at',created_at) FROM grimoire.intake_research_reviews WHERE report_id=$1 ORDER BY created_at,id").bind(id).fetch_all(&mut **tx).await?
    };
    Ok(
        json!({"id":id,"agent_task_id":task,"scion_revision":revision,"status":if blocked{"blocked"}else if stale{"stale"}else{"current"},"input":if blocked{Value::Null}else{value},"captures":receipts,"reviews":reviews,"created_at":created,"authority":"agent_research","verification_status":"unverified","approval_available":false}),
    )
}
async fn state(
    State(pool): State<PgPool>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> ApiResult {
    let (mut tx, actor) = authenticate(&pool, &headers).await?;
    let id = parse_id(&id)?;
    let current = visible(&mut tx, id).await?;
    let ids:Vec<Uuid>=sqlx::query_scalar("SELECT id FROM grimoire.intake_research_reports WHERE scion_id=$1 ORDER BY created_at DESC,id LIMIT 50").bind(id).fetch_all(&mut *tx).await?;
    let mut reports = Vec::new();
    for id2 in ids {
        reports.push(report(&mut tx, id, id2).await?);
    }
    let connections: Vec<Value> = if actor.is_agent {
        vec![]
    } else {
        sqlx::query_scalar("SELECT jsonb_build_object('connection_id',c.id,'device_name',c.device_name,'last_seen',p.last_seen,'status',CASE WHEN c.revoked_at IS NOT NULL THEN 'revoked' WHEN p.last_seen>clock_timestamp()-interval '15 seconds' THEN 'connected' ELSE 'disconnected' END,'research_capable',COALESCE(r.last_seen>clock_timestamp()-interval '15 seconds',false),'serpapi_capable',COALESCE(r.serpapi_capable AND r.last_seen>clock_timestamp()-interval '15 seconds',false)) FROM grimoire.intake_worker_connections c LEFT JOIN grimoire.intake_worker_presence p ON (p.org_id,p.principal_id)=(c.org_id,c.principal_id) LEFT JOIN grimoire.intake_research_worker_presence r ON (r.org_id,r.principal_id)=(c.org_id,c.principal_id) ORDER BY c.created_at DESC,c.id LIMIT 100").fetch_all(&mut *tx).await?
    };
    let briefs: Vec<Value> = if actor.is_agent {
        vec![]
    } else {
        sqlx::query_scalar("SELECT jsonb_build_object('task_id',id,'objective',input->'candidate_proposal'->'objective','worker_connection_id',input->'candidate_proposal'->'worker_connection_id','search_provider',COALESCE(input->'candidate_proposal'->>'search_provider','codex')) FROM grimoire.intake_agent_tasks WHERE scion_id=$1 AND scion_revision=$2 AND task_kind='research_public_web' ORDER BY created_at DESC LIMIT 100").bind(id).bind(current).fetch_all(&mut *tx).await?
    };
    tx.commit().await?;
    Ok(Json(json!({"available":true,"policy_version":POLICY,"limits":{"max_sources":8,"max_queries":5,"max_steps":8,"max_candidates":8,"timeout_seconds":300},"worker_connections":connections,"reports":reports,"briefs":briefs})).into_response())
}
async fn detail(
    State(pool): State<PgPool>,
    headers: HeaderMap,
    Path((scion, id)): Path<(String, String)>,
) -> ApiResult {
    let (mut tx, _) = authenticate(&pool, &headers).await?;
    let value = report(&mut tx, parse_id(&scion)?, parse_id(&id)?).await?;
    tx.commit().await?;
    Ok(Json(value).into_response())
}
async fn submit(
    State(pool): State<PgPool>,
    headers: HeaderMap,
    Path(scion): Path<String>,
    body: Result<Json<ReportInput>, JsonRejection>,
) -> ApiResult {
    let body = input(body)?;
    body.validate()?;
    let scion = parse_id(&scion)?;
    let base = precondition(&headers)?;
    let _key = key(&headers)?;
    let task = headers
        .get("X-Grimoire-Task-Id")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| Uuid::parse_str(v).ok())
        .ok_or_else(ApiError::forbidden)?;
    let (mut tx, actor) = authenticate(&pool, &headers).await?;
    let (owned, revision) = authorize_task(&mut tx, &actor, &headers, task).await?;
    if owned != scion {
        return Err(ApiError::not_found());
    }
    if revision != base {
        return Err(ApiError::stale());
    }
    let search_provider: Option<String> = sqlx::query_scalar(
        "SELECT input->'candidate_proposal'->>'search_provider' FROM grimoire.intake_agent_tasks WHERE id=$1",
    )
    .bind(task)
    .fetch_one(&mut *tx)
    .await?;
    body.validate_provider(search_provider.as_deref())?;
    let value = serde_json::to_value(&body)?;
    let hash = format!("{:x}", Sha256::digest(serde_json::to_vec(&value)?));
    let old: Option<(Uuid, String)> = sqlx::query_as(
        "SELECT id,request_sha256 FROM grimoire.intake_research_reports WHERE agent_task_id=$1",
    )
    .bind(task)
    .fetch_optional(&mut *tx)
    .await?;
    if let Some((id, old_hash)) = old {
        if old_hash != hash {
            return Err(ApiError(
                StatusCode::CONFLICT,
                "IDEMPOTENCY_CONFLICT",
                "This task already has a different research report.".into(),
            ));
        }
        tx.commit().await?;
        return Ok(Json(json!({"id":id})).into_response());
    }
    let receipts = captures(&mut tx, task).await?;
    for (source, capture_id) in body.sources.iter().zip(&body.capture_ids) {
        if !receipts.iter().any(|v| {
            v["id"] == capture_id.to_string()
                && v["url"] == source.url
                && v["status"] != "revoked"
                && (search_provider.as_deref() != Some("serpapi") || v["status"] == "captured")
        }) {
            return Err(ApiError::invalid(
                "Each source must reference this task's exact URL capture receipt in the same order.",
            ));
        }
    }
    let started: DateTime<Utc> =
        sqlx::query_scalar("SELECT claimed_at FROM grimoire.intake_agent_tasks WHERE id=$1")
            .bind(task)
            .fetch_one(&mut *tx)
            .await?;
    if body
        .queries
        .iter()
        .any(|v| v.observed_at < started - chrono::Duration::minutes(2))
    {
        return Err(ApiError::invalid(
            "Query timestamps must belong to this task run.",
        ));
    }
    let id = Uuid::new_v4();
    sqlx::query("INSERT INTO grimoire.intake_research_reports(id,org_id,scion_id,scion_revision,agent_task_id,input,created_by,request_sha256) VALUES($1,$2,$3,$4,$5,$6,$7,$8)").bind(id).bind(actor.org_id).bind(scion).bind(base).bind(task).bind(sqlx::types::Json(value)).bind(actor.principal_id).bind(hash).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok((StatusCode::CREATED, Json(json!({"id":id}))).into_response())
}
async fn review(
    State(pool): State<PgPool>,
    headers: HeaderMap,
    Path((scion, id)): Path<(String, String)>,
    body: Result<Json<Note>, JsonRejection>,
) -> ApiResult {
    let body = input(body)?;
    if !bounded(&body.note, 4000) {
        return Err(ApiError::invalid(
            "Enter a review note of 1–4000 characters.",
        ));
    }
    let (mut tx, actor) = authenticate(&pool, &headers).await?;
    if !actor.can_prepare_workspace || actor.is_agent {
        return Err(ApiError::forbidden());
    }
    let scion = parse_id(&scion)?;
    let id = parse_id(&id)?;
    let key = key(&headers)?;
    if precondition(&headers)? != visible(&mut tx, scion).await? {
        return Err(ApiError::stale());
    }
    let value = report(&mut tx, scion, id).await?;
    if value["status"] != "current" {
        return Err(ApiError::stale());
    }
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))")
        .bind(format!(
            "research-review:{}:{}:{key}",
            actor.org_id, actor.principal_id
        ))
        .execute(&mut *tx)
        .await?;
    let old:Option<(Uuid,Uuid,String)>=sqlx::query_as("SELECT id,report_id,note FROM grimoire.intake_research_reviews WHERE reviewer_id=$1 AND request_key=$2").bind(actor.principal_id).bind(&key).fetch_optional(&mut *tx).await?;
    if let Some((review_id, previous, note)) = old {
        if previous != id || note != body.note {
            return Err(ApiError(
                StatusCode::CONFLICT,
                "IDEMPOTENCY_CONFLICT",
                "Review key has different input.".into(),
            ));
        }
        tx.commit().await?;
        return Ok(Json(json!({"id":review_id,"approval_available":false})).into_response());
    }
    let review_id = Uuid::new_v4();
    sqlx::query("INSERT INTO grimoire.intake_research_reviews(id,org_id,report_id,reviewer_id,note,request_key) VALUES($1,$2,$3,$4,$5,$6)").bind(review_id).bind(actor.org_id).bind(id).bind(actor.principal_id).bind(body.note).bind(key).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok((
        StatusCode::CREATED,
        Json(json!({"id":review_id,"approval_available":false})),
    )
        .into_response())
}
async fn revoke(
    State(pool): State<PgPool>,
    headers: HeaderMap,
    Path((scion, id)): Path<(String, String)>,
    body: Result<Json<Revocation>, JsonRejection>,
) -> ApiResult {
    let body = input(body)?;
    if !bounded(&body.reason, 2000) {
        return Err(ApiError::invalid("Enter a withdrawal reason."));
    }
    let (mut tx, actor) = authenticate(&pool, &headers).await?;
    if !actor.can_prepare_workspace || actor.is_agent {
        return Err(ApiError::forbidden());
    }
    let scion = parse_id(&scion)?;
    let id = parse_id(&id)?;
    visible(&mut tx, scion).await?;
    let found: Option<Uuid> = sqlx::query_scalar(
        "SELECT agent_task_id FROM grimoire.intake_research_captures WHERE scion_id=$1 AND id=$2",
    )
    .bind(scion)
    .bind(id)
    .fetch_optional(&mut *tx)
    .await?;
    let Some(task) = found else {
        return Err(ApiError::not_found());
    };
    let locked: bool = sqlx::query_scalar("SELECT app.intake_research_lock_captures($1,$2)")
        .bind(task)
        .bind(id)
        .fetch_one(&mut *tx)
        .await?;
    if !locked {
        return Err(ApiError::not_found());
    }
    sqlx::query("INSERT INTO grimoire.intake_research_capture_revocations(org_id,capture_id,reason,created_by) VALUES($1,$2,$3,$4) ON CONFLICT(org_id,capture_id) DO NOTHING").bind(actor.org_id).bind(id).bind(body.reason).bind(actor.principal_id).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(Json(json!({"id":id,"status":"revoked"})).into_response())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_private_local_and_credential_urls() {
        for url in [
            "http://127.0.0.1/",
            "http://2130706433/",
            "http://0x7f000001/",
            "http://10.1.2.3/",
            "http://169.254.169.254/",
            "http://[::1]/",
            "http://[::ffff:127.0.0.1]/",
            "http://[2002:7f00:1::]/",
            "http://[2001:db8::1]/",
            "https://u:p@example.com/",
            "file:///secret",
            "https://example.com:444/",
            "http://localhost/",
            "http://x.internal/",
        ] {
            assert!(public_url(url).is_err(), "{url}");
        }
        assert!(public_url("https://www.example.com/procurement?q=paper").is_ok());
        assert!(public_ip(IpAddr::V4(std::net::Ipv4Addr::new(8, 8, 8, 8))));
        assert!(!public_ip("100.64.0.1".parse().unwrap()));
    }
    #[test]
    fn extraction_excludes_active_content_and_bounds_utf8() {
        assert_eq!(
            extract_text(
                "<p>Public &amp; readable</p><script>secret()</script><style>.bad{}</style><!--hidden--><p>Next</p>",
                true
            ),
            "Public & readable Next"
        );
        let text = extract_text(&"é".repeat(32000), false);
        assert_eq!(text.len(), 32000);
        assert!(!text.contains('\0'));
    }
    #[test]
    fn research_consent_never_accepts_synthetic_or_extra_fields() {
        let mut value = json!({"synthetic":false,"objective":"Public procurement steps","consent":true,"policy_version":POLICY,"worker_connection_id":Uuid::new_v4()});
        assert!(validate_candidate(&value).is_ok());
        value["synthetic"] = json!(true);
        assert!(validate_candidate(&value).is_err());
        value["synthetic"] = json!(false);
        value["private_sources"] = json!(["private"]);
        assert!(validate_candidate(&value).is_err());
    }
    #[test]
    fn serpapi_is_explicit_and_does_not_relax_consent() {
        let candidate = json!({"synthetic":false,"objective":"Public procurement steps","consent":true,"policy_version":POLICY,"worker_connection_id":Uuid::new_v4(),"search_provider":"serpapi"});
        assert!(validate_candidate(&candidate).is_ok());
        for change in [
            json!({"consent":false}),
            json!({"search_provider":null}),
            json!({"search_provider":"unknown"}),
            json!({"private_sources":[]}),
        ] {
            let mut invalid = candidate.clone();
            invalid
                .as_object_mut()
                .unwrap()
                .extend(change.as_object().unwrap().clone());
            assert!(validate_candidate(&invalid).is_err());
        }
    }
    #[test]
    fn search_provider_receipts_are_atomic_and_bounded() {
        let legacy: Query =
            serde_json::from_value(json!({"query":"public procurement","observed_at":Utc::now()}))
                .unwrap();
        assert!(legacy.provider_valid());
        assert!(
            serde_json::to_value(legacy)
                .unwrap()
                .get("provider")
                .is_none()
        );
        let receipt = json!({"query":"public procurement","observed_at":Utc::now(),"provider":"serpapi","engine":"google","search_id":"search_ABC-123"});
        assert!(
            serde_json::from_value::<Query>(receipt.clone())
                .unwrap()
                .provider_valid()
        );
        for change in [
            json!({"engine":null}),
            json!({"provider":"codex"}),
            json!({"search_id":"https://serpapi.com/?api_key=secret"}),
            json!({"search_id":"a".repeat(129)}),
        ] {
            let mut invalid = receipt.clone();
            invalid
                .as_object_mut()
                .unwrap()
                .extend(change.as_object().unwrap().clone());
            assert!(
                !serde_json::from_value::<Query>(invalid)
                    .unwrap()
                    .provider_valid()
            );
        }
    }
    #[test]
    fn serpapi_capability_requires_single_explicit_headers() {
        let mut headers = HeaderMap::new();
        headers.insert("X-Grimoire-SerpApi", "1".parse().unwrap());
        assert!(!serpapi_capable(&headers));
        headers.insert("X-Grimoire-Public-Web", "1".parse().unwrap());
        assert!(serpapi_capable(&headers));
        headers.append("X-Grimoire-SerpApi", "1".parse().unwrap());
        assert!(!serpapi_capable(&headers));
    }
    #[test]
    fn serpapi_report_limits_match_consent_without_changing_legacy_reports() {
        let query = json!({"query":"public procurement","observed_at":Utc::now(),"provider":"serpapi","engine":"google","search_id":"search_ABC-123"});
        let mut report: ReportInput = serde_json::from_value(json!({
            "synthetic":false,"summary":"Public research","process_steps":[],"candidates":[],
            "sources":[{"url":"https://www.gov.uk/contracts-finder","title":"Public source"}],
            "capture_ids":[Uuid::new_v4()],"unresolved_gaps":[],"queries":[query.clone(),query.clone(),query.clone()]
        })).unwrap();
        assert!(report.validate().is_ok());
        assert!(report.validate_provider(Some("serpapi")).is_ok());
        assert!(report.validate_provider(None).is_err());
        report.queries.push(serde_json::from_value(query).unwrap());
        assert!(report.validate().is_ok());
        assert!(report.validate_provider(Some("serpapi")).is_err());
        report.queries.pop();
        report.sources.clear();
        report.capture_ids.clear();
        assert!(report.validate().is_ok());
        assert!(report.validate_provider(Some("serpapi")).is_err());
        for query in &mut report.queries {
            query.provider = None;
            query.engine = None;
            query.search_id = None;
        }
        assert!(report.validate_provider(None).is_ok());
    }
}
