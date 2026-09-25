# Local source-byte storage

Layer 2B uses a real, private, versioned MinIO S3-compatible object store at `http://127.0.0.1:19000`. PostgreSQL remains the canonical source-revision and rights ledger. The Rust API stores and retrieves exact object version IDs and checks SHA-256. Object-store credentials are server-side; Grimoire does not return browser download URLs.

The local store is built from pinned official community sources, not a mocked S3 server. The current official MinIO repository describes community distribution as source-only and is archived. Historical executable downloads returned HTTP 410 during this setup; container pulls were also unavailable. Docker Engine itself was reachable, so this is an image availability limitation rather than a claim that Docker is still broken. The native local runtime keeps this synthetic development slice executable without changing the existing native PostgreSQL cluster.

Pinned build inputs:

- MinIO server: `github.com/minio/minio`, commit `9e49d5e7a648f00e26f2246f4dc28e6b07f8c84a` (`RELEASE.2025-10-15T17-29-55Z`).
- MinIO client: `github.com/minio/mc`, commit `7394ce0dd2a80935aded936b09fa12cbb3cb8096` (`RELEASE.2025-08-13T08-35-41Z`).
- Sources: [official source/build instructions](https://github.com/minio/minio), [server revision](https://github.com/minio/minio/tree/9e49d5e7a648f00e26f2246f4dc28e6b07f8c84a), [client revision](https://github.com/minio/mc/tree/7394ce0dd2a80935aded936b09fa12cbb3cb8096).

This archived community build is a local synthetic test dependency, not a production storage recommendation.

## Start and inspect

From `C:\proj\Grimoire\grim` in PowerShell:

```powershell
# Once, using the existing workspace Go installation (or add -Go first).
pwsh -NoProfile -File scripts/install-local-tools.ps1 -ObjectStore
pwsh -NoProfile -File scripts/storage.ps1 -Task Init
pwsh -NoProfile -File scripts/storage.ps1 -Task Up
pwsh -NoProfile -File scripts/storage.ps1 -Task Status

# Apply the additive migration, then move legacy synthetic source bytes once.
pwsh -NoProfile -File scripts/dev.ps1 -Task Migrate
pwsh -NoProfile -File scripts/dev.ps1 -Task ExternalizeSources

# Existing API command loads the development runtime credentials automatically.
pwsh -NoProfile -File scripts/dev.ps1 -Task Api

# Existing harness command loads the separate test runtime and fault credentials.
pwsh -NoProfile -File scripts/dev.ps1 -Task Harness

# Stop/restart the managed process without deleting persistent data.
pwsh -NoProfile -File scripts/storage.ps1 -Task Down
pwsh -NoProfile -File scripts/storage.ps1 -Task Up
pwsh -NoProfile -File scripts/storage.ps1 -Task Restart
```

The browser console is disabled, and the server binds only to loopback. Persistent bytes are under ignored `.local/minio-data`; build outputs are under ignored `.tools/minio`. Newly generated credentials are in ignored `.local/storage.env`. Setup preserves the existing `.env` and does not import Paperclip's database or source records.

## Isolation and permissions

`grimoire-sources-dev` is persistent development storage. `grimoire-sources-test` is disposable synthetic harness storage. Both have bucket versioning enabled and anonymous access disabled. There are separate runtime identities for the two buckets. Runtime policy permits only bucket location/versioning reads and object put/get/get-version. It cannot delete object versions, change bucket policies/versioning, or access the other bucket.

The harness receives a third identity scoped to `grimoire-sources-test` only. It can list versions, put/get, and remove versions for fault injection. It is not the MinIO root identity. Rust child processes must not inherit the harness fault credentials. Root credentials are used by the local provisioning script only.

`scripts/storage.ps1 -Task Environment -TestDatabase` exports runtime variables to its calling PowerShell process. Add `-ForHarness` only for the harness; that additionally exports the test fault identity and the absolute `GRIMOIRE_STORAGE_SCRIPT` path. Ordinary `dev.ps1 -Task Api` receives only its runtime identity.

## Reset disposable fixtures

```powershell
pwsh -NoProfile -File scripts/storage.ps1 -Task ResetTest
pwsh -NoProfile -File scripts/dev.ps1 -Task ResetTest
```

The object reset deletes all versions only in the fixed `grimoire-sources-test` bucket. The database reset affects only `grimoire_test`. Neither operation removes the development bucket, native database cluster, or development records. Reset both together before a clean harness run. No development reset command is provided.

The harness corruption hook accepts only a validated object key and version in that fixed test bucket. It verifies the version exists, requires one unique stored part, checks the absolute path stays under the disposable bucket, then corrupts that part. `MINIO_STORAGE_CLASS_INLINE_BLOCK=0` ensures tiny synthetic sources use a separate part. This deliberately damages a test object to verify the API fails closed; it is not an application endpoint.

## Limits

Version preservation and integrity are distinct from verified source truth. A successful byte hash check does not verify a Handler-entered claim. Revocation hides content through the Rust permission boundary; it does not erase bytes or undo content a user has already copied.

No browser signed URLs, URL expiry behavior, multi-node replication, cloud S3 parity, lifecycle expiry, WORM/object lock, encryption-at-rest/KMS, physical erasure, backup restoration, or disaster recovery is claimed here. Native process restart recovery is a separate, narrower behavior and must be evidenced by the live harness. Backend corruption and API access checks must also be reported from actual harness output, not inferred from this setup.
