-- Separate synthetic test identities. No real reviewer qualification is implied.
BEGIN;
SET LOCAL search_path = grimoire, public;
SELECT set_config('app.request_id',gen_random_uuid()::text,true);
SELECT set_config('app.effective_role','local_setup',true);
SELECT set_config('app.endpoint_scope','local:scope-actor-seed',true);
SELECT set_config('app.action_reason','Provision synthetic reviewer and proposal-only local Codex agent',true);
INSERT INTO principals(id,org_id,external_subject,display_name) VALUES
 ('10000000-0000-4000-8000-000000000012','10000000-0000-4000-8000-000000000001','local:synthetic-reviewer-a','Synthetic Engineering Reviewer A'),
 ('10000000-0000-4000-8000-000000000018','10000000-0000-4000-8000-000000000001','local:codex-agent-a','Local Codex Proposal Agent A')
ON CONFLICT (id) DO NOTHING;
INSERT INTO principal_roles(org_id,principal_id,role) VALUES
 ('10000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000012','engineering_reviewer'),
 ('10000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000018','read_only_agent')
ON CONFLICT DO NOTHING;
INSERT INTO intake_scope_reviewers(org_id,principal_id) VALUES
 ('10000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000012')
ON CONFLICT DO NOTHING;
INSERT INTO intake_scope_agents(org_id,principal_id) VALUES
 ('10000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000018')
ON CONFLICT DO NOTHING;
INSERT INTO intake_credentials(token_sha256,org_id,principal_id,label) VALUES
 (encode(public.digest('__TOKEN_REVIEWER_A__','sha256'),'hex'),'10000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000012','Local-only synthetic Engineering Reviewer A'),
 (encode(public.digest('__TOKEN_AGENT_A__','sha256'),'hex'),'10000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000018','Local-only Codex proposal agent A')
ON CONFLICT DO NOTHING;
COMMIT;
