export type Capability = { key: string; title: string; reason: string; evidence_needed: string[]; connector_ids: string[] };
export type CapabilityPlanInput = { synthetic: true; summary: string; capabilities: Capability[]; unresolved_gaps: string[]; change_summary: string };
export type CapabilityPlan = { id: string; scion_revision: number; agent_task_id: string; status: 'current' | 'stale'; input: CapabilityPlanInput | null; created_at: string; created_by: string };
export type DataConnector = { id: string; name: string; kind: string; enabled: true; status: string; description: string };
export type EvidenceComparisonInput = {
  synthetic: true; plan_id: string;
  alternatives: { label: string; criteria: { capability_key: string; claim_ids: string[] }[] }[];
  unresolved_gaps: string[]; change_summary: string;
};
export type ComparisonEvidence = { id: string; source_id: string; source_revision: number; statement: string; locator: { start_byte: number; end_byte: number; quote: string }; content_sha256: string; verification_status: 'unverified' };
export type EvidenceComparison = {
  id: string; scion_revision: number; plan_id: string; status: 'reviewable' | 'blocked'; input: EvidenceComparisonInput | null;
  evidence: ComparisonEvidence[]; unresolved_gaps: string[]; verification_status: 'unverified'; blocked_reason: string | null; created_at: string; created_by: string;
};
export type AdaptiveState = { scion_revision: number; connectors: DataConnector[]; external_connectors_available: false; unresolved_gaps: string[]; plans: CapabilityPlan[]; comparisons: EvidenceComparison[] };
