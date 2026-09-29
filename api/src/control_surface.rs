use super::*;
use serde_json::Value;
use std::collections::BTreeSet;

#[derive(sqlx::FromRow)]
struct Watch {
    id: Uuid,
    kind: String,
    last_successful_check: Option<DateTime<Utc>>,
    last_event_at: Option<DateTime<Utc>>,
}

pub(super) fn routes() -> Router<PgPool> {
    Router::new().route("/api/scions/{id}/control-surface", get(read))
}

pub(super) async fn monitor(pool: PgPool) {
    let mut interval = tokio::time::interval(Duration::from_secs(2));
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    loop {
        interval.tick().await;
        let check = sqlx::query("SELECT app.intake_watchtower_check()").execute(&pool);
        match tokio::time::timeout(Duration::from_secs(4), check).await {
            Ok(Ok(_)) => (),
            _ => tracing::warn!("Watchtower check failed; persisted heartbeat was not advanced"),
        }
    }
}

fn health(checked: Option<DateTime<Utc>>, now: DateTime<Utc>) -> &'static str {
    match checked {
        None => "pending",
        Some(at) if now.signed_duration_since(at).num_seconds() <= 10 => "healthy",
        Some(_) => "delayed",
    }
}

fn action(kind: &str, label: &str, enabled: bool) -> Value {
    json!({"kind":kind,"label":label,"enabled":enabled})
}

fn node(id: String, kind: &str, title: &str, status: &str, provenance: Value) -> Value {
    json!({"id":id,"kind":kind,"title":title,"status":status,"stale":false,
        "provenance":provenance,"blockers":[],"details":null,
        "safe_next_action":action("inspect","Inspect the current record; this grants no approval.",true)})
}

fn edge(edges: &mut Vec<Value>, source: String, target: String, kind: &str) {
    edges.push(json!({"id":format!("{source}/{kind}/{target}"),"source":source,"target":target,"kind":kind}));
}

fn text(value: &Value) -> &str {
    value.as_str().unwrap_or_default()
}

fn prefix(kind: &str) -> &str {
    match kind {
        "capability_proposal" => "plan",
        "agent_task" => "task",
        "evidence_source" => "source",
        _ => kind,
    }
}

fn blocker(reason: Option<&str>) -> &'static str {
    match reason {
        Some("source_permission_revoked") => {
            "Permission to a dependent source was revoked. Content is hidden; use other authorized evidence."
        }
        Some("scion_revision_changed") => {
            "The Scion revision changed. Prepare a new draft for the current intake."
        }
        Some("source_revision_changed") => {
            "A source has a newer revision. Review it before preparing a replacement draft."
        }
        Some("agent_task_failed" | "agent_task_cancelled") => {
            "The preparing agent did not complete successfully. Inspect its outcome; no approval was granted."
        }
        _ => {
            "Pinned inputs are no longer current. Review current permissions and prepare a new draft."
        }
    }
}

async fn read(State(pool): State<PgPool>, headers: HeaderMap, Path(id): Path<String>) -> ApiResult {
    let (mut tx, actor) = authenticate(&pool, &headers).await?;
    let id = parse_id(&id)?;
    let body = snapshot(&mut tx, &actor, id).await?;
    tx.commit().await?;
    Ok(Json(body).into_response())
}

/// Builds the same permission-filtered graph for authenticated workspaces and
/// the registered public synthetic scenarios. The caller owns the transaction
/// and must establish its organization and principal before invoking this.
pub(super) async fn snapshot(tx: &mut Tx, actor: &Actor, id: Uuid) -> Result<Value, ApiError> {
    let revision: Option<i32> = sqlx::query_scalar("SELECT app.intake_scope_lock_scion($1)")
        .bind(id)
        .fetch_one(&mut **tx)
        .await?;
    let revision = revision.ok_or_else(ApiError::not_found)?;
    let record = sqlx::query_as::<_, RevisionRow>(&format!("SELECT {REVISION_COLUMNS} FROM grimoire.intake_revisions r WHERE r.scion_id=$1 AND r.number=$2"))
        .bind(id).bind(revision).fetch_one(&mut **tx).await?.into_scion();
    let adaptive = capabilities::snapshot(tx, id, revision).await?;
    let sources = sources::control_snapshot(tx, id).await?;
    let mut tasks = byoa::control_snapshot(tx, id).await?;
    let dependencies: Vec<(String, Uuid, Option<Uuid>, Option<i32>)> = sqlx::query_as("SELECT node_kind,node_id,source_id,source_revision FROM grimoire.intake_watch_dependencies WHERE scion_id=$1 ORDER BY node_kind,node_id,source_id")
        .bind(id).fetch_all(&mut **tx).await?;
    let states: Vec<(String, Uuid, bool, bool, Option<String>)> = sqlx::query_as("SELECT node_kind,node_id,stale,blocked,reason FROM grimoire.intake_watch_node_states WHERE scion_id=$1")
        .bind(id).fetch_all(&mut **tx).await?;
    let events: Vec<Value> = sqlx::query_scalar("SELECT jsonb_build_object('id',id,'event_key',event_key,'kind',kind,'subject_id',subject_id,'subject_revision',subject_revision,'recorded_at',recorded_at,'summary',summary) FROM grimoire.intake_watch_events WHERE scion_id=$1 ORDER BY recorded_at DESC,id LIMIT 100")
        .bind(id).fetch_all(&mut **tx).await?;
    let reviews: Vec<Value> = sqlx::query_scalar("SELECT jsonb_build_object('id',id,'event_id',event_id,'status',status,'reason',reason,'created_at',created_at) FROM grimoire.intake_watch_reviews WHERE scion_id=$1 AND event_id IN (SELECT id FROM grimoire.intake_watch_events WHERE scion_id=$1 ORDER BY recorded_at DESC,id LIMIT 100) ORDER BY created_at DESC,id")
        .bind(id).fetch_all(&mut **tx).await?;
    let watches: Vec<Watch> = sqlx::query_as("SELECT id,kind,last_successful_check,last_event_at FROM grimoire.intake_watches WHERE scion_id=$1 ORDER BY kind")
        .bind(id).fetch_all(&mut **tx).await?;
    let now: DateTime<Utc> = sqlx::query_scalar("SELECT clock_timestamp()")
        .fetch_one(&mut **tx)
        .await?;
    let last_check = if watches.len() == 3
        && watches
            .iter()
            .all(|watch| watch.last_successful_check.is_some())
    {
        watches
            .iter()
            .filter_map(|watch| watch.last_successful_check)
            .min()
    } else {
        None
    };
    let watch_values: Vec<Value> = watches.into_iter().map(|watch| {
        let label = match watch.kind.as_str() {
            "scion_revisions" => "Scion revisions",
            "source_changes" => "Source revisions & permissions",
            _ => "Agent task outcomes",
        };
        json!({"id":watch.id,"kind":watch.kind,"label":label,"status":health(watch.last_successful_check, now),"last_successful_check":watch.last_successful_check,"last_event_at":watch.last_event_at})
    }).collect();
    let scion_node = format!("scion:{id}");
    let gate_node = format!("gate:{id}");
    let mut nodes = vec![];
    let mut edges = vec![];
    let mut root = node(
        scion_node.clone(),
        "scion",
        &record.revision.intake.name,
        "current",
        json!({"scion_revision":revision,"created_by":record.revision.created_by,"created_at":record.revision.created_at,"authority":"handler_provided","verification_status":"unverified"}),
    );
    root["details"] = serde_json::to_value(&record.revision)?;
    root["blockers"] = json!(
        record
            .missing_information
            .iter()
            .map(|gap| &gap.message)
            .collect::<Vec<_>>()
    );
    root["safe_next_action"] = action(
        "edit_intake",
        &record.next_safe_action,
        actor.can_manage_workspace,
    );
    nodes.push(root);
    for connector in adaptive["connectors"].as_array().into_iter().flatten() {
        let connector_id = format!("connector:{}", text(&connector["id"]));
        let mut entry = node(
            connector_id.clone(),
            "data_connector",
            text(&connector["name"]),
            text(&connector["status"]),
            json!({"registry":"app.intake_capability_connectors","authority":"organization_authorized","kind":connector["kind"]}),
        );
        entry["details"] = connector.clone();
        entry["safe_next_action"] = action("inspect", text(&connector["description"]), true);
        nodes.push(entry);
        edge(
            &mut edges,
            scion_node.clone(),
            connector_id,
            "authorized_data_path",
        );
    }
    let mut external = node(
        "connector:external".into(),
        "data_connector",
        "External provider connector",
        "unavailable",
        json!({"registry":"app.intake_capability_connectors","configured":false,"monitoring_supported":false}),
    );
    external["blockers"] = json!([
        "No authorized external provider connector is configured. No external checks have run."
    ]);
    external["safe_next_action"] = action(
        "unavailable",
        "An authorized, implemented connector is required before external evidence or monitoring is available.",
        false,
    );
    nodes.push(external);
    edge(
        &mut edges,
        scion_node.clone(),
        "connector:external".into(),
        "missing_data_path",
    );
    for source in sources {
        let source_node = format!("source:{}", text(&source["id"]));
        let mut entry = node(
            source_node.clone(),
            "evidence_source",
            text(&source["title"]),
            text(&source["status"]),
            json!({"source_id":source["id"],"source_revision":source["current_revision"],"scion_revision":source["scion_revision"],"authority":"handler_entered","verification_status":"unverified"}),
        );
        entry["details"] = source["details"].clone();
        entry["blockers"] = source["blockers"].clone();
        entry["safe_next_action"] = action(
            "inspect",
            "Inspect current source permissions and exact claims. Revoked content stays hidden.",
            true,
        );
        nodes.push(entry);
        edge(
            &mut edges,
            "connector:scion_sources".into(),
            source_node,
            "provides_authorized_source",
        );
    }
    for (collection, kind) in [
        ("plans", "capability_proposal"),
        ("comparisons", "comparison"),
    ] {
        for artifact in adaptive[collection].as_array().into_iter().flatten() {
            let artifact_node = format!("{}:{}", prefix(kind), text(&artifact["id"]));
            let status = text(&artifact["status"]);
            let title = if kind == "capability_proposal" {
                "Capability plan · agent proposal"
            } else {
                "Evidence comparison draft"
            };
            let mut entry = node(
                artifact_node.clone(),
                kind,
                title,
                status,
                json!({"scion_revision":artifact["scion_revision"],"created_at":artifact["created_at"],"created_by":artifact["created_by"],"authority":artifact["authority"],"verification_status":"unverified","agent_task_id":artifact["agent_task_id"],"plan_id":artifact["plan_id"]}),
            );
            entry["stale"] =
                json!(status == "stale" || artifact["scion_revision"] != json!(revision));
            if !artifact["input"].is_null() {
                entry["details"] = artifact.clone();
                entry["blockers"] = if kind == "capability_proposal" {
                    artifact["input"]["unresolved_gaps"].clone()
                } else {
                    artifact["unresolved_gaps"].clone()
                };
            } else {
                entry["blockers"] = json!([
                    "The pinned input is stale or permission-restricted. Prepare new work from current authorized evidence."
                ]);
            }
            entry["safe_next_action"] = action(
                "inspect",
                "Inspect the draft and its evidence gaps; a human decision is still required.",
                true,
            );
            nodes.push(entry);
            edge(
                &mut edges,
                scion_node.clone(),
                artifact_node.clone(),
                "pinned_intake",
            );
            edge(
                &mut edges,
                artifact_node.clone(),
                gate_node.clone(),
                "requires_human_review",
            );
            if kind == "capability_proposal" {
                edge(
                    &mut edges,
                    format!("task:{}", text(&artifact["agent_task_id"])),
                    artifact_node.clone(),
                    "prepared_proposal",
                );
                for capability in artifact["input"]["capabilities"]
                    .as_array()
                    .into_iter()
                    .flatten()
                {
                    for connector in capability["connector_ids"].as_array().into_iter().flatten() {
                        edge(
                            &mut edges,
                            format!("connector:{}", text(connector)),
                            artifact_node.clone(),
                            "declared_data_path",
                        );
                    }
                }
            } else {
                edge(
                    &mut edges,
                    format!("plan:{}", text(&artifact["plan_id"])),
                    artifact_node,
                    "comparison_basis",
                );
            }
        }
    }
    for task in &mut tasks {
        let task_id = text(&task["id"]).to_string();
        let state = states
            .iter()
            .find(|state| state.0 == "agent_task" && state.1.to_string() == task_id);
        task["stale"] =
            json!(task["scion_revision"] != json!(revision) || state.is_some_and(|state| state.2));
        task["blocked"] = json!(state.is_some_and(|state| state.3));
        let task_node = format!("task:{task_id}");
        let mut entry = node(
            task_node.clone(),
            "agent_task",
            text(&task["task_kind"]),
            text(&task["status"]),
            json!({"scion_revision":task["scion_revision"],"adapter":task["adapter"],"attempt":task["attempt"],"created_at":task["created_at"],"provider_run_id":task["provider_run_id"],"output_sha256":task["output_sha256"],"authority":"preparation_only"}),
        );
        entry["stale"] = task["stale"].clone();
        entry["details"] = task.clone();
        entry["safe_next_action"] = action(
            "inspect",
            "Inspect the existing task lifecycle. No agent scheduler or approval is created here.",
            true,
        );
        nodes.push(entry);
        edge(
            &mut edges,
            scion_node.clone(),
            task_node,
            "requested_preparation",
        );
    }
    for (kind, node_id, stale, blocked, reason) in &states {
        if let Some(entry) = nodes
            .iter_mut()
            .find(|entry| entry["id"] == format!("{}:{node_id}", prefix(kind)))
            && (*stale || *blocked)
        {
            entry["stale"] = json!(stale);
            if *blocked {
                entry["status"] = json!("blocked");
            }
            entry["details"] = Value::Null;
            entry["blockers"] = json!([blocker(reason.as_deref())]);
            entry["provenance"]["dependency_reason"] = json!(reason);
            entry["safe_next_action"] = action(
                "inspect",
                "Inspect the blocked dependency, then prepare replacement work from current authorized inputs.",
                true,
            );
        }
    }
    for (kind, node_id, source, _) in dependencies {
        if let Some(source) = source {
            edge(
                &mut edges,
                format!("source:{source}"),
                format!("{}:{node_id}", prefix(&kind)),
                "evidence_dependency",
            );
        }
    }
    let decision_missing = record
        .revision
        .intake
        .decision
        .as_ref()
        .is_none_or(|decision| decision.trim().is_empty());
    let mut gate = node(
        gate_node.clone(),
        "human_review",
        "Human review gate",
        "required",
        json!({"authority":"human_only","approval_available":false,"scion_revision":revision}),
    );
    gate["blockers"] = adaptive["unresolved_gaps"].clone();
    gate["safe_next_action"] = if decision_missing {
        action(
            "edit_intake",
            "Record the missing Handler decision before proceeding.",
            actor.can_manage_workspace,
        )
    } else {
        action(
            "inspect",
            "Review current evidence and unresolved gaps. Sourcing approval remains unavailable.",
            true,
        )
    };
    nodes.push(gate);
    edge(
        &mut edges,
        scion_node,
        gate_node.clone(),
        "requires_human_decision",
    );
    for review in &reviews {
        let review_node = format!("review:{}", text(&review["id"]));
        let mut entry = node(
            review_node.clone(),
            "human_review",
            "Watchtower review task",
            text(&review["status"]),
            json!({"event_id":review["event_id"],"created_at":review["created_at"],"authority":"human_only"}),
        );
        entry["blockers"] = json!([review["reason"]]);
        entry["details"] = review.clone();
        entry["safe_next_action"] = action(
            "inspect",
            "Inspect the changed dependency and prepare a new draft if required. This review cannot approve sourcing.",
            true,
        );
        nodes.push(entry);
        edge(
            &mut edges,
            review_node.clone(),
            gate_node.clone(),
            "required_review",
        );
        if let Some(event) = events
            .iter()
            .find(|event| event["id"] == review["event_id"])
        {
            let kind = text(&event["kind"]);
            let subject_prefix = if kind.starts_with("source_") {
                "source"
            } else if kind.starts_with("agent_task_") {
                "task"
            } else {
                "scion"
            };
            edge(
                &mut edges,
                format!("{subject_prefix}:{}", text(&event["subject_id"])),
                review_node,
                "change_requires_review",
            );
        }
    }
    let identities: BTreeSet<String> = nodes
        .iter()
        .map(|entry| text(&entry["id"]).to_string())
        .collect();
    let mut edge_ids = BTreeSet::new();
    edges.retain(|entry| {
        identities.contains(text(&entry["source"]))
            && identities.contains(text(&entry["target"]))
            && edge_ids.insert(text(&entry["id"]).to_string())
    });
    let agent_runtime = agents::runtime(tx).await?;
    Ok(
        json!({"scion_id":id,"scion_revision":revision,"generated_at":now,"nodes":nodes,"edges":edges,
        "watchtower":{"health":health(last_check,now),"last_successful_check":last_check,"mode":"transactional_internal_events","poll_interval_ms":2000,"watches":watch_values,"alerts":reviews},
        "operations":{"tasks":tasks,"events":events,"human_review":reviews,"agent_runtime":agent_runtime},
        "approval_available":false}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn monitoring_health_requires_a_recent_server_check() {
        let now = Utc::now();
        assert_eq!(health(None, now), "pending");
        assert_eq!(
            health(Some(now - chrono::Duration::seconds(10)), now),
            "healthy"
        );
        assert_eq!(
            health(Some(now - chrono::Duration::seconds(11)), now),
            "delayed"
        );
    }
}
