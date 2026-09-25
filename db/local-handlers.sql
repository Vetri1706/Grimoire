-- Local development principals only; no product, offer, price or approval seed.
-- Token placeholders are replaced in a gitignored file by scripts/dev.ps1.
BEGIN;
SET LOCAL search_path = grimoire, public;
SELECT set_config('app.request_id',gen_random_uuid()::text,true);
SELECT set_config('app.effective_role','local_setup',true);
SELECT set_config('app.endpoint_scope','local:handler-seed',true);
SELECT set_config('app.action_reason','Create local development principals; no product or approval seed',true);
INSERT INTO organizations(id,name) VALUES
 ('10000000-0000-4000-8000-000000000001','Local workspace A'),
 ('20000000-0000-4000-8000-000000000001','Local workspace B')
ON CONFLICT (id) DO NOTHING;
INSERT INTO org_security_epochs(org_id) VALUES
 ('10000000-0000-4000-8000-000000000001'),('20000000-0000-4000-8000-000000000001')
ON CONFLICT (org_id) DO NOTHING;
INSERT INTO principals(id,org_id,external_subject,display_name) VALUES
 ('10000000-0000-4000-8000-000000000011','10000000-0000-4000-8000-000000000001','local:handler-a','Local Handler A'),
 ('20000000-0000-4000-8000-000000000011','20000000-0000-4000-8000-000000000001','local:handler-b','Local Handler B')
ON CONFLICT (id) DO NOTHING;
INSERT INTO principal_roles(org_id,principal_id,role) VALUES
 ('10000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000011','procurement_preparer'),
 ('20000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000011','procurement_preparer')
ON CONFLICT DO NOTHING;
INSERT INTO intake_credentials(token_sha256,org_id,principal_id,label) VALUES
 (encode(public.digest('__TOKEN_A__','sha256'),'hex'),'10000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000011','Local-only Handler A'),
 (encode(public.digest('__TOKEN_B__','sha256'),'hex'),'20000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000011','Local-only Handler B')
ON CONFLICT DO NOTHING;
COMMIT;
