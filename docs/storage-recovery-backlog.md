# Open storage work after Layer 2B

These remain separate acceptance gates. Layer 3 identity binding and Codex task
execution do not demonstrate any of them. Use synthetic data until a real-data
access policy and recovery plan have been reviewed.

| Behavior | Remaining demonstration |
| --- | --- |
| Upload interruption | Kill the writer before/after S3 PUT and PostgreSQL commit; recover safely with the same idempotency key. |
| Orphan reconciliation | Enumerate objects with no committed reference, respect in-flight writes and retention, and demonstrate bounded cleanup without deleting referenced versions. |
| Backup and restore | Restore PostgreSQL and exact object versions together into an isolated environment and validate every referenced digest and locator. Process restart is not restore. |
| Erasure | Define retention/legal holds and demonstrate deletion across versions, replicas, backups, and local remnants. Revocation is not physical erasure. |
| Object Lock | Exercise retention and legal holds with an enabled Object Lock bucket and restricted administrative identities. Ordinary versioning is not WORM. |
| Browser download URLs | No URLs are issued. Test expiry, cached access, and revocation before adding them. |
| Production storage | Test cloud S3 parity, encryption/KMS, replication, lifecycle policies, service availability and credentials rotation. The native single-node synthetic MinIO run does not establish these. |
| Revoked audit metadata | Approve a role-specific policy before real data; current access is described below. |

## Current local metadata boundary

The existing `app.intake_can_access()` accepts an enabled principal with any
GG-40 role in the authenticated organization. Consequently `org_admin`,
`procurement_preparer`, `engineering_reviewer`, `quality_reviewer`,
`commercial_approver`, `records_officer`, `read_only_agent`, and `system_worker`
can read intake/source audit metadata if separately issued a valid local bearer
credential. No anonymous or other-organization principal receives it.

Source titles, origin, owner, content hash, revision identifiers, rights state
and revocation reason remain audit metadata after revocation. Source bytes and
claim statements/quotes are denied. Layer 3 proposal content is also redacted
when its source rights are unavailable; confirmed identity IDs remain audit
metadata. This broad within-organization audit policy is a local synthetic
prototype policy, not an approved real-data role matrix.

The browser rechecks source permission nominally every two seconds and clears
content on failed checks, hidden/offline state and an expired display lease.
Browser suspension, network delay and scheduling mean this is not an absolute
two-second wall-clock guarantee. Already copied or photographed content cannot
be recalled. Local task workspaces containing explicitly supplied synthetic
candidate data are another retained copy; rights denial does not establish
their physical erasure.
