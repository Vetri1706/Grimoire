//! This Windows attestation is newly implemented, not the unavailable GG-54.
use sha2::{Digest, Sha256};
use sqlx::{FromRow, PgPool};
use std::collections::BTreeMap;

macro_rules! migration {
    ($folder:literal, $name:literal) => {
        (
            $name,
            include_bytes!(concat!("../../db/", $folder, "/", $name)).as_slice(),
        )
    };
}

pub const MIGRATIONS: &[(&str, &[u8])] = &[
    migration!("gg40", "0022_grimoire_contract.sql"),
    migration!("gg40", "0023_grimoire_review_corrections.sql"),
    migration!("intake", "0024_intake.sql"),
    migration!("intake", "0025_intake_history_authors.sql"),
    migration!("intake", "0026_intake_sources.sql"),
    migration!("intake", "0027_intake_source_objects.sql"),
    migration!("intake", "0028_intake_scope.sql"),
    migration!("intake", "0029_intake_agent_tasks.sql"),
    migration!("intake", "0030_scope_chain_guard.sql"),
    migration!("intake", "0031_worker_controls.sql"),
    migration!("intake", "0032_synthetic_offer_comparison.sql"),
    migration!("intake", "0033_offer_review_identity_guards.sql"),
    migration!("intake", "0034_sourcing_authority_gate.sql"),
    // 0035-0037 are absent Mac work, not silently recreated here.
    migration!("intake", "0038_windows_adaptive_plans.sql"),
    migration!("intake", "0039_windows_approval_lockdown.sql"),
    migration!("intake", "0040_control_surface.sql"),
    migration!("intake", "0041_watchtower_artifact_guards.sql"),
    migration!("intake", "0042_watchtower_task_sources.sql"),
    migration!("intake", "0043_native_agents.sql"),
    migration!("intake", "0044_organization_onboarding.sql"),
    migration!("intake", "0045_handler_registration.sql"),
    migration!("intake", "0046_public_judge_demo.sql"),
    migration!("intake", "0047_google_identity.sql"),
    migration!("intake", "0048_handler_profile.sql"),
    migration!("intake", "0049_workspace_preparation.sql"),
    migration!("intake", "0050_worker_connections.sql"),
    migration!("intake", "0051_capability_plan_reviews.sql"),
    migration!("intake", "0052_public_web_research.sql"),
    migration!("intake", "0053_research_capture_guards.sql"),
    migration!("intake", "0054_research_receipt_locks.sql"),
    migration!("intake", "0055_task_conversations.sql"),
    migration!("intake", "0056_task_conversation_dependencies.sql"),
];

#[derive(FromRow)]
struct Material {
    key: String,
    body: String,
}

pub async fn verify(pool: &PgPool) -> Result<(), Box<dyn std::error::Error>> {
    let mut tx = pool.begin().await?;
    sqlx::query("SET LOCAL search_path=pg_catalog")
        .execute(&mut *tx)
        .await?;
    let ledger: Vec<(String, String)> =
        sqlx::query_as("SELECT name,sha256 FROM public.grimoire_schema_migrations ORDER BY name")
            .fetch_all(&mut *tx)
            .await?;
    let expected: BTreeMap<String, String> = MIGRATIONS
        .iter()
        .map(|(name, bytes)| (name.to_string(), format!("{:x}", Sha256::digest(bytes))))
        .collect();
    if ledger.into_iter().collect::<BTreeMap<_, _>>() != expected {
        return Err("STARTUP_MIGRATION_MISMATCH: database ledger differs from this compiled Windows migration set".into());
    }
    let trusted: BTreeMap<String, String> =
        serde_json::from_str(include_str!("../../db/windows-catalog.json"))?;
    if trusted.is_empty() {
        return Err("STARTUP_CATALOG_UNAVAILABLE: reviewed clean catalog is required".into());
    }
    let rows = sqlx::query_as::<_, Material>(include_str!("../../db/windows-catalog-query.sql"))
        .fetch_all(&mut *tx)
        .await?;
    let actual: BTreeMap<String, String> = rows
        .into_iter()
        .map(|v| (v.key, format!("{:x}", Sha256::digest(v.body.as_bytes()))))
        .collect();
    if actual != trusted {
        return Err("STARTUP_CATALOG_MISMATCH: function, trigger, policy, owner, privilege or constraint differs from reviewed Windows schema".into());
    }
    let unsafe_membership: bool = sqlx::query_scalar("SELECT pg_has_role(current_user,'grimoire_migrator','MEMBER') OR pg_has_role(current_user,'grimoire_app','MEMBER') OR pg_has_role(current_user,'grimoire_worker','MEMBER') OR has_database_privilege(current_user,current_database(),'CREATE,TEMPORARY') OR has_schema_privilege(current_user,'app','CREATE') OR has_schema_privilege(current_user,'grimoire','CREATE') OR has_schema_privilege(current_user,'public','CREATE')").fetch_one(&mut *tx).await?;
    if unsafe_membership {
        return Err("STARTUP_RUNTIME_AUTHORITY: runtime has forbidden membership or schema creation privileges".into());
    }
    tx.commit().await?;
    Ok(())
}
