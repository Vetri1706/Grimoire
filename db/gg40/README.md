# GG-40 v2.2.1 PostgreSQL inputs

These three SQL blocks were extracted without modification from the GG-40 v2.2.1 page capture supplied by the user. Their exact UTF-8 byte hashes, including one trailing LF, match the hashes in independent GG-43 PostgreSQL 17 verification:

| File | SHA-256 |
| --- | --- |
| 0022_grimoire_contract.sql | 5af2c09b31f1be6b537fba05b7af7c561e4b7e959849532bbed43a8d8de4205b |
| 0023_grimoire_review_corrections.sql | 9f7012c8ea6f9e0a32395fa9e569b6f83bff8bbbb7b36862e2a80523b4e82df9 |
| fixture_one_case_two_event.sql | 1372d06269030dd33e95adce9e19d0f6d9591523fc4bc641f4d29cabbff6f698 |

Accepted execution order on a clean PostgreSQL 17 database: 0022 → 0023 → synthetic fixture. The fixture is for test data and should not be applied to production. Do not edit the three accepted SQL files; create separately reviewed migrations for new intake data. The page capture in reference/ includes UI wrapper text; its full-file hash is NOT the canonical GG-40 document-body hash. Only the three SQL blocks above have been byte-verified against GG-43.

GG-42 bounded verdict: supported with conditions for the database contract and synthetic fixtures, not server, MCP, S3, restore, security, or production behavior. The combined A7–A9 example has a SET LOCAL ROLE 42501 migrator-runner defect; execute role checks with distinct authorized sessions. The Go API harness requested for Layer 1 is new work; this package does not claim it already exists.
