//! Private, version-pinned local S3 storage. Never returns URLs or falls back to
//! inline PostgreSQL text. Endpoint validation prevents accidental cloud access.
use super::*;
use futures_util::TryStreamExt;
use object_store::{
    ClientOptions, GetOptions, ObjectStore, PutOptions, RetryConfig, aws::AmazonS3Builder,
    path::Path as ObjectPath,
};
use std::sync::{Arc, OnceLock};

static STORAGE: OnceLock<Storage> = OnceLock::new();
const MAX_BYTES: usize = 32000;
const OPERATION_TIMEOUT: Duration = Duration::from_secs(5);

pub(super) struct Storage {
    client: Arc<dyn ObjectStore>,
    pub bucket: String,
}

pub(super) struct StoredObject {
    pub bucket: String,
    pub key: String,
    pub version: String,
    pub sha256: String,
    pub byte_length: i32,
}

fn failure(code: &'static str, message: &'static str) -> ApiError {
    ApiError(StatusCode::SERVICE_UNAVAILABLE, code, message.into())
}

pub(super) fn migration_required() -> ApiError {
    failure(
        "SOURCE_STORAGE_MIGRATION_REQUIRED",
        "This source needs verified object-storage externalization before its content or claims can be accessed.",
    )
}

fn unavailable() -> ApiError {
    failure(
        "SOURCE_STORAGE_UNAVAILABLE",
        "Private source storage is unavailable. Content and claims have not been returned or processed.",
    )
}

fn integrity_failed() -> ApiError {
    failure(
        "SOURCE_INTEGRITY_FAILED",
        "The pinned source object failed identity, length, or SHA-256 verification. Content and claims have not been returned or processed.",
    )
}

fn map_error(error: object_store::Error) -> ApiError {
    // Do not expose endpoint request strings, credential details or provider bodies.
    if matches!(error, object_store::Error::NotFound { .. }) {
        failure(
            "SOURCE_OBJECT_MISSING",
            "The exact source object version is missing. Content and claims have not been returned or processed.",
        )
    } else {
        unavailable()
    }
}

fn valid_local_endpoint(endpoint: &str) -> bool {
    let Ok(url) = url::Url::parse(endpoint) else {
        return false;
    };
    url.scheme() == "http"
        && matches!(url.host_str(), Some("127.0.0.1" | "localhost" | "[::1]"))
        && url.username().is_empty()
        && url.password().is_none()
        && url.path() == "/"
        && url.query().is_none()
        && url.fragment().is_none()
}

pub(super) fn initialize() -> Result<(), Box<dyn std::error::Error>> {
    // reqwest's rustls-no-provider feature deliberately requires an explicit
    // process-wide provider before constructing its HTTP client.
    let _ = rustls::crypto::ring::default_provider().install_default();
    fn required(name: &str) -> Result<String, Box<dyn std::error::Error>> {
        std::env::var(name)
            .ok()
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(|| {
                format!("{name} must be explicitly configured for private local source storage.")
                    .into()
            })
    }
    let endpoint = required("GRIMOIRE_S3_ENDPOINT")?;
    if !valid_local_endpoint(&endpoint) {
        return Err("This local slice requires an HTTP loopback S3 endpoint without credentials, path, query or fragment.".into());
    }
    let bucket = required("GRIMOIRE_S3_BUCKET")?;
    let client = AmazonS3Builder::new()
        .with_endpoint(endpoint)
        .with_region(required("GRIMOIRE_S3_REGION")?)
        .with_bucket_name(&bucket)
        .with_access_key_id(required("GRIMOIRE_S3_ACCESS_KEY")?)
        .with_secret_access_key(required("GRIMOIRE_S3_SECRET_KEY")?)
        .with_allow_http(true)
        .with_virtual_hosted_style_request(false)
        .with_client_options(
            ClientOptions::new()
                .with_allow_http(true)
                .with_connect_timeout(Duration::from_secs(1))
                .with_timeout(Duration::from_secs(3)),
        )
        .with_retry(RetryConfig {
            max_retries: 0,
            retry_timeout: Duration::from_secs(3),
            ..Default::default()
        })
        .build()
        .map_err(|_| "Unable to configure the private local S3 client.")?;
    STORAGE
        .set(Storage {
            client: Arc::new(client),
            bucket,
        })
        .map_err(|_| "Source storage is already initialized.")?;
    Ok(())
}

pub(super) fn configured() -> Result<&'static Storage, ApiError> {
    STORAGE.get().ok_or_else(unavailable)
}

fn verify_bytes(
    bytes: Vec<u8>,
    expected_sha256: &str,
    expected_length: i32,
) -> Result<String, ApiError> {
    if bytes.len() > MAX_BYTES
        || bytes.len() != expected_length as usize
        || format!("{:x}", Sha256::digest(&bytes)) != expected_sha256
    {
        return Err(integrity_failed());
    }
    String::from_utf8(bytes).map_err(|_| integrity_failed())
}

impl Storage {
    pub async fn read_verified(
        &self,
        bucket: &str,
        key: &str,
        version: &str,
        hash: &str,
        length: i32,
    ) -> Result<String, ApiError> {
        if bucket != self.bucket
            || version.is_empty()
            || version == "null"
            || !(1..=MAX_BYTES as i32).contains(&length)
        {
            return Err(integrity_failed());
        }
        let read = async {
            let path = ObjectPath::parse(key).map_err(|_| integrity_failed())?;
            let result = self
                .client
                .get_opts(&path, GetOptions::new().with_version(Some(version)))
                .await
                .map_err(map_error)?;
            if result.meta.version.as_deref() != Some(version) || result.meta.size != length as u64
            {
                return Err(integrity_failed());
            }
            let mut stream = result.into_stream();
            let mut bytes = Vec::with_capacity(length as usize);
            while let Some(chunk) = stream.try_next().await.map_err(map_error)? {
                if bytes.len().saturating_add(chunk.len()) > length as usize {
                    return Err(integrity_failed());
                }
                bytes.extend_from_slice(&chunk);
            }
            verify_bytes(bytes, hash, length)
        };
        tokio::time::timeout(OPERATION_TIMEOUT, read)
            .await
            .map_err(|_| unavailable())?
    }

    pub async fn put_verified(
        &self,
        org: Uuid,
        source: Uuid,
        number: i32,
        text: &str,
    ) -> Result<StoredObject, ApiError> {
        if text.is_empty() || text.len() > MAX_BYTES {
            return Err(integrity_failed());
        }
        let sha256 = format!("{:x}", Sha256::digest(text.as_bytes()));
        let byte_length = text.len() as i32;
        let key = format!(
            "org/{org}/sources/{source}/revisions/{number}/{}.txt",
            Uuid::new_v4()
        );
        let path = ObjectPath::parse(&key).map_err(|_| integrity_failed())?;
        let result = tokio::time::timeout(
            OPERATION_TIMEOUT,
            self.client.put_opts(
                &path,
                text.as_bytes().to_vec().into(),
                PutOptions::default(),
            ),
        )
        .await
        .map_err(|_| unavailable())?
        .map_err(map_error)?;
        let version = result
            .version
            .filter(|value| !value.is_empty() && value != "null")
            .ok_or_else(integrity_failed)?;
        // A successful PUT alone is insufficient: verify exactly the returned
        // version by GET before any PostgreSQL reference/receipt is committed.
        let verified = self
            .read_verified(&self.bucket, &key, &version, &sha256, byte_length)
            .await?;
        if verified.as_bytes() != text.as_bytes() {
            return Err(integrity_failed());
        }
        Ok(StoredObject {
            bucket: self.bucket.clone(),
            key,
            version,
            sha256,
            byte_length,
        })
    }
}

#[derive(FromRow)]
struct LegacyRevision {
    org_id: Uuid,
    source_id: Uuid,
    number: i32,
    source_text: String,
    content_sha256: String,
    byte_length: i32,
}

/// Administrator-only command; separate from HTTP startup and bearer authority.
/// Upload errors leave PostgreSQL intact. Failed DB commits can leave an orphan
/// object version; neither source deletion nor automatic cleanup is attempted.
pub(super) async fn externalize(pool: &PgPool) -> Result<(), ApiError> {
    let permitted: bool = sqlx::query_scalar("SELECT current_user=pg_get_userbyid(relowner) FROM pg_class WHERE oid='grimoire.intake_source_revisions'::regclass").fetch_one(pool).await?;
    if !permitted {
        return Err(ApiError::forbidden());
    }
    let mut exported = 0;
    loop {
        let mut tx = pool.begin().await?;
        // Acquire the same source lock as API writes/revocation, one source at a
        // time. Row text is fetched only by this explicit administrator command.
        let source: Option<Uuid> = sqlx::query_scalar("SELECT s.id FROM grimoire.intake_sources s WHERE EXISTS(SELECT 1 FROM grimoire.intake_source_revisions r WHERE (r.org_id,r.source_id)=(s.org_id,s.id) AND r.source_text IS NOT NULL) ORDER BY s.id LIMIT 1 FOR UPDATE OF s").fetch_optional(&mut *tx).await?;
        let Some(source) = source else {
            tx.commit().await?;
            break;
        };
        let rows = sqlx::query_as::<_, LegacyRevision>("SELECT org_id,source_id,number,source_text,content_sha256,byte_length FROM grimoire.intake_source_revisions WHERE source_id=$1 AND source_text IS NOT NULL ORDER BY number").bind(source).fetch_all(&mut *tx).await?;
        for row in rows {
            verify_bytes(
                row.source_text.as_bytes().to_vec(),
                &row.content_sha256,
                row.byte_length,
            )?;
            let object = configured()?
                .put_verified(row.org_id, row.source_id, row.number, &row.source_text)
                .await?;
            sqlx::query("SELECT app.intake_externalize_source_revision($1,$2,$3,$4,$5,$6,$7,$8)")
                .bind(row.org_id)
                .bind(row.source_id)
                .bind(row.number)
                .bind(&object.bucket)
                .bind(&object.key)
                .bind(&object.version)
                .bind(&object.sha256)
                .bind(object.byte_length)
                .execute(&mut *tx)
                .await?;
            exported += 1;
        }
        tx.commit().await?;
    }
    println!(
        "Externalized and verified {exported} source revisions; active PostgreSQL source_text copies are NULL. Semantic revisions, claims, rights and revocations were preserved. This is not a physical-erasure claim."
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn local_endpoint_cannot_silently_target_cloud() {
        for accepted in [
            "http://127.0.0.1:19000",
            "http://localhost:19000",
            "http://[::1]:19000",
        ] {
            assert!(valid_local_endpoint(accepted));
        }
        for denied in [
            "https://s3.amazonaws.com",
            "http://127.0.0.1.evil.test",
            "http://user:pass@localhost:19000",
            "http://localhost/bucket",
            "http://localhost?x=1",
        ] {
            assert!(!valid_local_endpoint(denied));
        }
    }

    #[test]
    fn exact_object_bytes_are_required_before_decoding() {
        let bytes = "SYNTHETIC café 🧪\r\n".as_bytes().to_vec();
        let hash = format!("{:x}", Sha256::digest(&bytes));
        assert!(verify_bytes(bytes.clone(), &hash, bytes.len() as i32).is_ok());
        let mut corrupted = bytes.clone();
        corrupted[0] = b'X';
        assert!(verify_bytes(corrupted, &hash, bytes.len() as i32).is_err());
        assert!(verify_bytes(bytes.clone(), &hash, bytes.len() as i32 - 1).is_err());
        let invalid = vec![255];
        let invalid_hash = format!("{:x}", Sha256::digest(&invalid));
        assert!(verify_bytes(invalid, &invalid_hash, 1).is_err());
    }
}
