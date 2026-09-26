-- Reviewed schema attestation material; contains no customer rows or secrets.
SELECT key,body FROM (
 SELECT 'function:'||n.nspname||'.'||p.proname||'('||pg_get_function_identity_arguments(p.oid)||')' AS key,
   pg_get_functiondef(p.oid)||E'\nOWNER='||pg_get_userbyid(p.proowner)||E'\nACL='||COALESCE(p.proacl::text,'DEFAULT') AS body
 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
 WHERE n.nspname IN ('app','grimoire') AND p.prokind='f'
 UNION ALL
 SELECT 'trigger:'||n.nspname||'.'||c.relname||'.'||t.tgname,
   pg_get_triggerdef(t.oid)||E'\nENABLED='||t.tgenabled::text
 FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
 WHERE n.nspname='grimoire' AND NOT t.tgisinternal
 UNION ALL
 SELECT 'policy:'||n.nspname||'.'||c.relname||'.'||p.polname,
   p.polcmd::text||':'||p.polpermissive::text||':'||COALESCE(pg_get_expr(p.polqual,p.polrelid),'')||':'||COALESCE(pg_get_expr(p.polwithcheck,p.polrelid),'')||':'||
   (SELECT string_agg(CASE WHEN role_id=0 THEN 'PUBLIC' ELSE pg_get_userbyid(role_id)::text END,',' ORDER BY role_id) FROM unnest(p.polroles) role_id)
 FROM pg_policy p JOIN pg_class c ON c.oid=p.polrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='grimoire'
 UNION ALL
 SELECT 'table:'||n.nspname||'.'||c.relname,
   pg_get_userbyid(c.relowner)||':'||c.relrowsecurity::text||':'||c.relforcerowsecurity::text||':'||COALESCE(c.relacl::text,'DEFAULT')
 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='grimoire' AND c.relkind IN ('r','v','S')
 UNION ALL
 SELECT 'column:'||n.nspname||'.'||c.relname||'.'||a.attname,
   a.attnum::text||':'||format_type(a.atttypid,a.atttypmod)||':'||a.attnotnull::text||':'||a.attidentity::text||':'||a.attgenerated::text||':'||
   COALESCE(pg_get_expr(d.adbin,d.adrelid),'<no-default>')||':'||COALESCE(nullif(a.attacl::text,'{}'),'DEFAULT')
 FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace
 LEFT JOIN pg_attrdef d ON (d.adrelid,d.adnum)=(a.attrelid,a.attnum)
 WHERE n.nspname='grimoire' AND c.relkind IN ('r','v','S') AND a.attnum>0 AND NOT a.attisdropped
 UNION ALL
 SELECT 'constraint:'||n.nspname||'.'||c.relname||'.'||k.conname,pg_get_constraintdef(k.oid)
 FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='grimoire'
 UNION ALL
 -- Internal RI trigger names contain database-local OIDs, so identify each by
 -- its owning FK, firing table, action function and event type instead.
 SELECT 'constraint-trigger:'||n.nspname||'.'||c.relname||':'||kn.nspname||'.'||kc.relname||'.'||k.conname||':'||pn.nspname||'.'||p.proname||':'||t.tgtype::text,
   t.tgenabled::text||':'||t.tgdeferrable::text||':'||t.tginitdeferred::text||':'||t.tgattr::text||':'||COALESCE(pg_get_expr(t.tgqual,t.tgrelid),'<no-condition>')
 FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
 JOIN pg_constraint k ON k.oid=t.tgconstraint JOIN pg_class kc ON kc.oid=k.conrelid JOIN pg_namespace kn ON kn.oid=kc.relnamespace
 JOIN pg_proc p ON p.oid=t.tgfoid JOIN pg_namespace pn ON pn.oid=p.pronamespace
 WHERE n.nspname='grimoire' AND t.tgisinternal AND k.contype='f'
) material ORDER BY key;
