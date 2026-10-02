//! Google is an identity provider only. The stable subject identifies an account;
//! email, hosted domain, and profile fields never grant Grimoire membership.
use std::{
    collections::HashMap,
    sync::OnceLock,
    time::{Duration, Instant},
};

use axum::http::StatusCode;
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use jsonwebtoken::{Algorithm, DecodingKey, Validation, decode, decode_header};
use reqwest::header::{AGE, CACHE_CONTROL};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use tokio::sync::Mutex;

use crate::ApiError;

// No configurable key URL or tokeninfo fallback: credentials only go to this
// process, and signing keys only come from Google's fixed HTTPS endpoint.
const GOOGLE_JWKS: &str = "https://www.googleapis.com/oauth2/v3/certs";
const MAX_TOKEN_BYTES: usize = 16_384;
const MAX_JWKS_BYTES: usize = 65_536;
const MAX_KEYS: usize = 16;
const MAX_CACHE_SECONDS: u64 = 3_600;
const REFRESH_INTERVAL: Duration = Duration::from_secs(30);
const CLOCK_SKEW_SECONDS: u64 = 60;
const MAX_TOKEN_LIFETIME_SECONDS: u64 = 7_200;
static GOOGLE: OnceLock<Option<GoogleVerifier>> = OnceLock::new();

struct GoogleVerifier {
    client_id: String,
    http: reqwest::Client,
    keys: Mutex<KeyCache>,
}

#[derive(Default)]
struct KeyCache {
    keys: HashMap<String, DecodingKey>,
    expires_at: Option<Instant>,
    last_attempt: Option<Instant>,
}

#[derive(Deserialize)]
struct GoogleJwks {
    keys: Vec<GoogleJwk>,
}

#[derive(Deserialize)]
struct GoogleJwk {
    kty: String,
    alg: Option<String>,
    #[serde(rename = "use")]
    usage: Option<String>,
    kid: String,
    n: Option<String>,
    e: Option<String>,
}

#[derive(Clone, Deserialize)]
struct GoogleClaims {
    sub: String,
    // A single exact web-client audience is required. Multi-audience tokens are
    // unnecessary for this GIS flow and are deliberately not accepted.
    aud: String,
    iss: String,
    exp: u64,
    iat: u64,
    nonce: String,
    azp: Option<String>,
    name: Option<String>,
}

pub(crate) struct VerifiedGoogleIdentity {
    pub subject: String,
    pub display_name: String,
}

pub(crate) fn initialize() -> Result<(), Box<dyn std::error::Error>> {
    let configured = match std::env::var("GRIMOIRE_GOOGLE_CLIENT_ID") {
        Ok(value) => Some(value),
        Err(std::env::VarError::NotPresent) => None,
        Err(std::env::VarError::NotUnicode(_)) => {
            return Err(
                "GRIMOIRE_GOOGLE_CLIENT_ID must be a valid Google web OAuth client ID.".into(),
            );
        }
    };
    let client_id = parse_client_id(configured.as_deref())?;
    let verifier = client_id
        .map(|client_id| {
            // This is the same TLS provider already installed for source storage.
            let _ = rustls::crypto::ring::default_provider().install_default();
            let http = reqwest::Client::builder()
                .https_only(true)
                .redirect(reqwest::redirect::Policy::none())
                .connect_timeout(Duration::from_secs(2))
                .timeout(Duration::from_secs(5))
                .build()
                .map_err(|_| "Google identity HTTPS client could not be initialized.")?;
            Ok::<_, &'static str>(GoogleVerifier {
                client_id: client_id.to_owned(),
                http,
                keys: Mutex::new(KeyCache::default()),
            })
        })
        .transpose()?;
    GOOGLE
        .set(verifier)
        .map_err(|_| "Google identity configuration has already been initialized.".into())
}

fn parse_client_id(value: Option<&str>) -> Result<Option<&str>, &'static str> {
    let Some(value) = value else {
        return Ok(None);
    };
    let prefix = value
        .strip_suffix(".apps.googleusercontent.com")
        .ok_or("GRIMOIRE_GOOGLE_CLIENT_ID must be a valid Google web OAuth client ID.")?;
    if !(3..=200).contains(&prefix.len())
        || !prefix.as_bytes()[0].is_ascii_digit()
        || !prefix
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
    {
        return Err("GRIMOIRE_GOOGLE_CLIENT_ID must be a valid Google web OAuth client ID.");
    }
    Ok(Some(value))
}

pub(crate) fn client_id() -> Option<&'static str> {
    GOOGLE
        .get()
        .and_then(Option::as_ref)
        .map(|verifier| verifier.client_id.as_str())
}

fn invalid() -> ApiError {
    ApiError(
        StatusCode::UNAUTHORIZED,
        "GOOGLE_CREDENTIAL_INVALID",
        "Google sign-in could not be verified. Start a new sign-in attempt.".into(),
    )
}

fn unavailable() -> ApiError {
    ApiError(
        StatusCode::SERVICE_UNAVAILABLE,
        "GOOGLE_IDENTITY_UNAVAILABLE",
        "Google sign-in is unavailable. Try again later or use your Grimoire login.".into(),
    )
}

pub(crate) async fn verify(
    credential: &str,
    expected_nonce_sha256: &str,
) -> Result<VerifiedGoogleIdentity, ApiError> {
    let verifier = GOOGLE
        .get()
        .and_then(Option::as_ref)
        .ok_or_else(unavailable)?;
    let kid = token_key_id(credential)?;
    let key = verifier.key(&kid).await?;
    verify_with_key(credential, expected_nonce_sha256, &verifier.client_id, &key)
}

fn token_key_id(credential: &str) -> Result<String, ApiError> {
    if credential.is_empty() || credential.len() > MAX_TOKEN_BYTES {
        return Err(invalid());
    }
    let header = decode_header(credential).map_err(|_| invalid())?;
    if header.alg != Algorithm::RS256
        || header.typ.as_deref().is_some_and(|kind| kind != "JWT")
        || header
            .crit
            .as_ref()
            .is_some_and(|fields| !fields.is_empty())
        || header.jku.is_some()
        || header.jwk.is_some()
        || header.x5u.is_some()
        || header.zip.is_some()
        || header.enc.is_some()
    {
        return Err(invalid());
    }
    header
        .kid
        .filter(|kid| valid_key_id(kid))
        .ok_or_else(invalid)
}

fn valid_key_id(kid: &str) -> bool {
    (1..=128).contains(&kid.len())
        && kid
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
}

impl KeyCache {
    fn current_key(&self, kid: &str, now: Instant) -> Option<DecodingKey> {
        self.expires_at
            .filter(|expiry| now < *expiry)
            .and_then(|_| self.keys.get(kid).cloned())
    }

    fn refresh_allowed(&self, now: Instant) -> bool {
        self.last_attempt
            .is_none_or(|last| now.duration_since(last) >= REFRESH_INTERVAL)
    }
}

impl GoogleVerifier {
    async fn key(&self, kid: &str) -> Result<DecodingKey, ApiError> {
        cached_key(&self.keys, kid, self.fetch_keys()).await
    }

    async fn fetch_keys(&self) -> Result<(HashMap<String, DecodingKey>, Duration), ApiError> {
        let mut response = self
            .http
            .get(GOOGLE_JWKS)
            .send()
            .await
            .map_err(|_| unavailable())?;
        if !response.status().is_success()
            || response
                .content_length()
                .is_some_and(|length| length > MAX_JWKS_BYTES as u64)
        {
            return Err(unavailable());
        }
        let cache_control = response
            .headers()
            .get_all(CACHE_CONTROL)
            .iter()
            .map(|value| value.to_str().unwrap_or("no-cache"))
            .collect::<Vec<_>>()
            .join(",");
        let age = response
            .headers()
            .get(AGE)
            .map(|value| {
                value
                    .to_str()
                    .ok()
                    .and_then(|value| value.parse::<u64>().ok())
                    .unwrap_or(u64::MAX)
            })
            .unwrap_or(0);
        let ttl = cache_ttl(&cache_control, age);
        let mut bytes = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(|_| unavailable())? {
            if bytes.len() + chunk.len() > MAX_JWKS_BYTES {
                return Err(unavailable());
            }
            bytes.extend_from_slice(&chunk);
        }
        Ok((parse_keys(&bytes)?, ttl))
    }
}

async fn cached_key(
    cache: &Mutex<KeyCache>,
    kid: &str,
    fetch: impl std::future::Future<Output = Result<(HashMap<String, DecodingKey>, Duration), ApiError>>,
) -> Result<DecodingKey, ApiError> {
    // Holding this bounded async lock across the fetch makes refresh single-
    // flight. Random unknown kids cannot trigger concurrent provider calls.
    let mut cache = cache.lock().await;
    let now = Instant::now();
    if let Some(key) = cache.current_key(kid, now) {
        return Ok(key);
    }
    if !cache.refresh_allowed(now) {
        return Err(if cache.expires_at.is_some_and(|expiry| now < expiry) {
            invalid()
        } else {
            unavailable()
        });
    }
    cache.last_attempt = Some(now);
    let (keys, ttl) = fetch.await?;
    let selected = keys.get(kid).cloned();
    cache.keys = keys;
    cache.expires_at = Some(now + ttl);
    // A max-age=0 response can verify this request but is never reused.
    selected.ok_or_else(invalid)
}

fn cache_ttl(cache_control: &str, age: u64) -> Duration {
    let mut max_age = None;
    for part in cache_control.split(',').map(str::trim) {
        if part.eq_ignore_ascii_case("no-store") || part.eq_ignore_ascii_case("no-cache") {
            return Duration::ZERO;
        }
        if let Some((name, value)) = part.split_once('=') {
            if name.trim().eq_ignore_ascii_case("max-age") {
                let Ok(seconds) = value.trim().trim_matches('"').parse::<u64>() else {
                    return Duration::ZERO;
                };
                max_age = Some(max_age.map_or(seconds, |previous: u64| previous.min(seconds)));
            } else if name.trim().eq_ignore_ascii_case("no-cache") {
                return Duration::ZERO;
            }
        }
    }
    Duration::from_secs(
        max_age
            .unwrap_or(0)
            .saturating_sub(age)
            .min(MAX_CACHE_SECONDS),
    )
}

fn parse_keys(bytes: &[u8]) -> Result<HashMap<String, DecodingKey>, ApiError> {
    if bytes.len() > MAX_JWKS_BYTES {
        return Err(unavailable());
    }
    let jwks: GoogleJwks = serde_json::from_slice(bytes).map_err(|_| unavailable())?;
    if jwks.keys.is_empty() || jwks.keys.len() > MAX_KEYS {
        return Err(unavailable());
    }
    let mut keys = HashMap::new();
    for key in jwks.keys {
        if key.kty != "RSA"
            || key.alg.as_deref() != Some("RS256")
            || key.usage.as_deref() != Some("sig")
        {
            continue;
        }
        let (Some(modulus), Some(exponent)) = (key.n, key.e) else {
            return Err(unavailable());
        };
        if !valid_key_id(&key.kid) || modulus.len() > 1366 || exponent.len() > 12 {
            return Err(unavailable());
        }
        let modulus_bytes = URL_SAFE_NO_PAD
            .decode(&modulus)
            .map_err(|_| unavailable())?;
        // Google uses RSA-2048. Bound validation cost and reject undersized or
        // zero-prefixed moduli rather than accepting a padded weak key.
        if !(256..=1024).contains(&modulus_bytes.len()) || modulus_bytes[0] < 128 {
            return Err(unavailable());
        }
        let decoding_key =
            DecodingKey::from_rsa_components(&modulus, &exponent).map_err(|_| unavailable())?;
        if keys.insert(key.kid, decoding_key).is_some() {
            return Err(unavailable());
        }
    }
    if keys.is_empty() {
        return Err(unavailable());
    }
    Ok(keys)
}

fn verify_with_key(
    credential: &str,
    expected_nonce_sha256: &str,
    client_id: &str,
    key: &DecodingKey,
) -> Result<VerifiedGoogleIdentity, ApiError> {
    token_key_id(credential)?;
    let mut validation = Validation::new(Algorithm::RS256);
    validation.leeway = 0;
    validation.validate_nbf = true;
    validation.set_audience(&[client_id]);
    validation.set_issuer(&["accounts.google.com", "https://accounts.google.com"]);
    validation.set_required_spec_claims(&["exp", "iss", "aud", "sub"]);
    let claims = decode::<GoogleClaims>(credential, key, &validation)
        .map_err(|_| invalid())?
        .claims;
    let now = jsonwebtoken::get_current_timestamp();
    if claims.aud != client_id
        || !matches!(
            claims.iss.as_str(),
            "accounts.google.com" | "https://accounts.google.com"
        )
        || claims.azp.as_deref().is_some_and(|azp| azp != client_id)
        || claims.exp <= now
        || claims.iat > now.saturating_add(CLOCK_SKEW_SECONDS)
        || claims.iat < now.saturating_sub(MAX_TOKEN_LIFETIME_SECONDS)
        || claims.exp <= claims.iat
        || claims.exp - claims.iat > MAX_TOKEN_LIFETIME_SECONDS
        || !(1..=255).contains(&claims.sub.len())
        || !claims.sub.bytes().all(|byte| byte.is_ascii_graphic())
        || !(32..=256).contains(&claims.nonce.len())
        || !claims.nonce.bytes().all(|byte| byte.is_ascii_graphic())
        || expected_nonce_sha256.len() != 64
        || !expected_nonce_sha256
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        || format!("{:x}", Sha256::digest(claims.nonce.as_bytes())) != expected_nonce_sha256
    {
        return Err(invalid());
    }
    let name: String = claims
        .name
        .unwrap_or_default()
        .chars()
        .filter(|character| !character.is_control())
        .take(120)
        .collect();
    let display_name = if name.trim().is_empty() {
        "Google Handler".to_owned()
    } else {
        name.trim().to_owned()
    };
    Ok(VerifiedGoogleIdentity {
        subject: claims.sub,
        display_name,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use jsonwebtoken::{EncodingKey, Header, encode};
    use rsa::{RsaPrivateKey, pkcs1::EncodeRsaPrivateKey, traits::PublicKeyParts};
    use serde_json::{Value, json};

    const CLIENT: &str = "1234567890-testfixture.apps.googleusercontent.com";
    const NONCE: &str = "synthetic-test-nonce-0123456789-abcdef";
    // Ephemeral keys are generated only by the test binary. They are not Google
    // keys and cannot enter the production verifier or a deployed API process.
    static TEST_RSA: OnceLock<RsaPrivateKey> = OnceLock::new();

    fn rsa() -> &'static RsaPrivateKey {
        TEST_RSA.get_or_init(|| RsaPrivateKey::new(&mut rand::rngs::OsRng, 2048).unwrap())
    }

    fn jwk() -> Value {
        json!({"kty":"RSA","alg":"RS256","use":"sig","kid":"local-test-key",
            "n":URL_SAFE_NO_PAD.encode(rsa().n().to_bytes_be()),
            "e":URL_SAFE_NO_PAD.encode(rsa().e().to_bytes_be())})
    }

    fn key() -> DecodingKey {
        parse_keys(&serde_json::to_vec(&json!({"keys":[jwk()]})).unwrap())
            .ok()
            .unwrap()
            .remove("local-test-key")
            .unwrap()
    }

    fn claims() -> Value {
        let now = jsonwebtoken::get_current_timestamp();
        json!({"sub":"synthetic-subject", "aud":CLIENT, "iss":"https://accounts.google.com",
            "iat":now-5,"exp":now+3600,"nonce":NONCE,"azp":CLIENT,"name":"Synthetic Handler"})
    }

    fn signed(claims: &Value) -> String {
        let mut header = Header::new(Algorithm::RS256);
        header.kid = Some("local-test-key".into());
        let der = rsa().to_pkcs1_der().unwrap();
        encode(&header, claims, &EncodingKey::from_rsa_der(der.as_bytes())).unwrap()
    }

    fn nonce_hash() -> String {
        format!("{:x}", Sha256::digest(NONCE.as_bytes()))
    }

    fn accepts(claims: &Value) -> bool {
        verify_with_key(&signed(claims), &nonce_hash(), CLIENT, &key()).is_ok()
    }

    #[test]
    fn google_configuration_is_disabled_only_when_absent() {
        assert_eq!(parse_client_id(None), Ok(None));
        assert_eq!(parse_client_id(Some(CLIENT)), Ok(Some(CLIENT)));
        for value in [
            "",
            " ",
            "client-id",
            "https://evil.test",
            "a.apps.googleusercontent.com",
            "123.apps.googleusercontent.com.evil.test",
            "1234/evil.apps.googleusercontent.com",
        ] {
            assert!(parse_client_id(Some(value)).is_err());
        }
    }

    #[test]
    fn signed_google_claims_require_exact_issuer_audience_and_authorized_party() {
        assert!(accepts(&claims()));
        let mut valid = claims();
        valid["iss"] = json!("accounts.google.com");
        valid.as_object_mut().unwrap().remove("azp");
        assert!(accepts(&valid));
        for (field, value) in [
            ("aud", json!("another-client")),
            ("aud", json!([CLIENT, "another-client"])),
            ("iss", json!("https://accounts.google.com.evil.test")),
            ("azp", json!("another-client")),
        ] {
            let mut bad = claims();
            bad[field] = value;
            assert!(!accepts(&bad), "{field}");
        }
        for field in ["aud", "iss", "exp", "iat", "sub", "nonce"] {
            let mut bad = claims();
            bad.as_object_mut().unwrap().remove(field);
            assert!(!accepts(&bad), "missing {field}");
        }
    }

    #[test]
    fn signed_google_claims_require_current_bounded_lifetime_and_nonce() {
        // Key generation can take several seconds under parallel test load.
        // Build it before sampling time, and keep iat fixed across the cases so
        // an overlong lifetime cannot become valid as the loop advances.
        let _ = rsa();
        let base = claims();
        let now = jsonwebtoken::get_current_timestamp();
        for (field, value) in [
            ("exp", json!(now)),
            ("exp", json!(now - 1)),
            ("exp", json!(now + MAX_TOKEN_LIFETIME_SECONDS + 1)),
            ("iat", json!(now + CLOCK_SKEW_SECONDS + 10)),
            ("iat", json!(now - MAX_TOKEN_LIFETIME_SECONDS - 1)),
            ("nonce", json!("different-synthetic-nonce-0123456789")),
            ("sub", json!("")),
            ("sub", json!("x".repeat(256))),
            ("sub", json!("subject with spaces")),
        ] {
            let mut bad = base.clone();
            bad[field] = value;
            assert!(!accepts(&bad), "{field}");
        }
        assert!(verify_with_key(&signed(&claims()), &"0".repeat(64), CLIENT, &key()).is_err());
    }

    #[test]
    fn verifier_rejects_forgery_algorithm_confusion_and_header_key_urls() {
        let token = signed(&claims());
        let mut parts = token.split('.').map(str::to_owned).collect::<Vec<_>>();
        let mut forged = claims();
        forged["sub"] = json!("forged-subject");
        parts[1] = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&forged).unwrap());
        assert!(verify_with_key(&parts.join("."), &nonce_hash(), CLIENT, &key()).is_err());
        let mut header = Header::new(Algorithm::HS256);
        header.kid = Some("local-test-key".into());
        let symmetric =
            encode(&header, &claims(), &EncodingKey::from_secret(b"synthetic")).unwrap();
        assert!(verify_with_key(&symmetric, &nonce_hash(), CLIENT, &key()).is_err());
        let mut parts = token.split('.').map(str::to_owned).collect::<Vec<_>>();
        parts[0] = URL_SAFE_NO_PAD
            .encode(br#"{"alg":"RS256","kid":"local-test-key","jku":"https://evil.test/keys"}"#);
        assert!(token_key_id(&parts.join(".")).is_err());
        assert!(token_key_id(&"x".repeat(MAX_TOKEN_BYTES + 1)).is_err());
    }

    #[test]
    fn profile_fields_cannot_change_identity_and_names_are_bounded() {
        let mut source = claims();
        source["email"] = json!("owner@example.test");
        source["email_verified"] = json!(true);
        source["hd"] = json!("existing-organization.test");
        source["name"] = json!(format!("\n{}", "x".repeat(130)));
        let identity = verify_with_key(&signed(&source), &nonce_hash(), CLIENT, &key())
            .ok()
            .unwrap();
        assert_eq!(identity.subject, "synthetic-subject");
        assert_eq!(identity.display_name, "x".repeat(120));
    }

    #[test]
    fn key_cache_honors_provider_age_limits_and_never_uses_expired_keys() {
        assert_eq!(
            cache_ttl("public, max-age=120", 20),
            Duration::from_secs(100)
        );
        assert_eq!(
            cache_ttl("max-age=90000", 0),
            Duration::from_secs(MAX_CACHE_SECONDS)
        );
        assert_eq!(
            cache_ttl("max-age=120, max-age=20", 0),
            Duration::from_secs(20)
        );
        for control in [
            "",
            "no-store,max-age=120",
            "no-cache,max-age=120",
            "no-cache=\"set-cookie\",max-age=120",
            "max-age=bad",
        ] {
            assert_eq!(cache_ttl(control, 0), Duration::ZERO);
        }
        assert_eq!(cache_ttl("max-age=20", 21), Duration::ZERO);
        let now = Instant::now();
        let mut cache = KeyCache::default();
        cache.keys.insert("local-test-key".into(), key());
        cache.expires_at = Some(now + Duration::from_secs(1));
        assert!(cache.current_key("local-test-key", now).is_some());
        assert!(cache.current_key("unknown", now).is_none());
        assert!(
            cache
                .current_key("local-test-key", now + Duration::from_secs(1))
                .is_none()
        );
        assert!(cache.refresh_allowed(now));
        cache.last_attempt = Some(now);
        assert!(!cache.refresh_allowed(now + Duration::from_secs(29)));
        assert!(cache.refresh_allowed(now + REFRESH_INTERVAL));
    }

    #[test]
    fn provider_keys_reject_duplicates_weak_moduli_and_oversized_responses() {
        let encoded = |keys: Value| serde_json::to_vec(&json!({"keys":keys})).unwrap();
        assert!(parse_keys(&encoded(json!([jwk(), jwk()]))).is_err());
        let mut weak = jwk();
        weak["n"] = json!(URL_SAFE_NO_PAD.encode([255u8; 128]));
        assert!(parse_keys(&encoded(json!([weak]))).is_err());
        let mut wrong_use = jwk();
        wrong_use["use"] = json!("enc");
        assert!(parse_keys(&encoded(json!([wrong_use]))).is_err());
        assert!(parse_keys(&vec![b'x'; MAX_JWKS_BYTES + 1]).is_err());
        assert!(parse_keys(&encoded(json!(vec![jwk(); MAX_KEYS + 1]))).is_err());
    }

    #[tokio::test]
    async fn key_refresh_is_single_flight_and_unknown_kids_are_throttled() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        let calls = AtomicUsize::new(0);
        let cache = Mutex::new(KeyCache::default());
        let fetch = || async {
            calls.fetch_add(1, Ordering::SeqCst);
            tokio::task::yield_now().await;
            Ok((
                HashMap::from([("local-test-key".to_owned(), key())]),
                Duration::from_secs(120),
            ))
        };
        let (first, concurrent) = tokio::join!(
            cached_key(&cache, "local-test-key", fetch()),
            cached_key(&cache, "local-test-key", fetch())
        );
        assert!(first.is_ok() && concurrent.is_ok());
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert!(cached_key(&cache, "unknown-one", fetch()).await.is_err());
        assert!(cached_key(&cache, "unknown-two", fetch()).await.is_err());
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        // Once the cooldown ends an unknown rotated kid triggers one refresh,
        // even while the previously fetched key set remains otherwise current.
        cache.lock().await.last_attempt = Some(Instant::now() - REFRESH_INTERVAL);
        assert!(cached_key(&cache, "unknown-three", fetch()).await.is_err());
        assert!(cached_key(&cache, "unknown-four", fetch()).await.is_err());
        assert_eq!(calls.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn expired_keys_fail_closed_when_the_provider_fails() {
        let cache = Mutex::new(KeyCache {
            keys: HashMap::from([("local-test-key".to_owned(), key())]),
            expires_at: Some(Instant::now() - Duration::from_secs(1)),
            last_attempt: None,
        });
        let result = cached_key(&cache, "local-test-key", async { Err(unavailable()) }).await;
        assert!(matches!(
            result,
            Err(ApiError(StatusCode::SERVICE_UNAVAILABLE, _, _))
        ));
        assert!(
            cache
                .lock()
                .await
                .current_key("local-test-key", Instant::now())
                .is_none()
        );
        let retry = cached_key(&cache, "local-test-key", async {
            panic!("provider failures must be throttled too")
        })
        .await;
        assert!(matches!(
            retry,
            Err(ApiError(StatusCode::SERVICE_UNAVAILABLE, _, _))
        ));
    }
}
