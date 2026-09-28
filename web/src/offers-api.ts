import type { RevisionReaction } from './flow-model';

export type OfferSource = { source_id: string; source_revision: number; claim_id: string; content_sha256: string; start_byte: number; end_byte: number };
export type SupplierIdentity = { legal_name: string; jurisdiction: string; registration_ref: string; site_code: string; country_code: string; account_ref: string };
export type OfferInput = {
  synthetic: true; scion_revision: number; scope_proposal_id: string; supplier: SupplierIdentity; source: OfferSource; offer_ref: string; identity_match: 'exact' | 'ambiguous';
  offered_manufacturer: string | null; offered_part_number: string | null; quantity: string | null; uom: string | null; unit_price: string | null; currency: string | null;
  destination: string | null; incoterm: string | null; payment_terms: string | null; quoted_at: string | null; valid_from: string | null; valid_until: string | null; lead_time_days: number | null; change_summary: string;
};
export type OfferRevision = { id: string; number: number; input: OfferInput | null; created_by: string; created_at: string; missing_fields: string[]; governed_offer_revision_id: string | null; governed_offer_line_id: string | null; blockers: string[]; content_redacted: boolean };
export type OfferView = { id: string; scion_id: string; current_revision: number; revision: OfferRevision };
export type OfferDetail = OfferView & { revisions: OfferRevision[] };
export type OfferList = { offers: OfferView[]; synthetic_only: true };
export type ComparisonBasis = { quantity: string; uom: string; currency: string; destination: string; incoterm: string; payment_terms: string; as_of: string; valid_from: string; valid_until: string };
export type ComparisonInput = { synthetic: true; scope_proposal_id: string; offer_revision_ids: [string, string]; basis: ComparisonBasis; change_summary: string };
export type ComparisonLine = { offer_id: string; offer_revision_id: string; governed_offer_line_id: string | null; state: 'comparable' | 'excluded'; exclusion_reasons: string[]; normalized_unit_price: string | null; extended_price: string | null; currency: string | null; lead_time_days: number | null };
export type ComparisonSnapshot = { lines: ComparisonLine[]; basis: ComparisonBasis; synthetic: true; algorithm: 'same-basis-exact-v1' };
export type ComparisonConfirmation = { comparison_revision_id: string; artifact_id: string; sourcing_case_revision_id: string; requirement_revision_id: string; confirmed_by: string; confirmed_at: string; review_note: string | null; synthetic: true };
export type ComparisonProposal = { id: string; scion_id: string; scion_revision: number; input: ComparisonInput | null; snapshot: ComparisonSnapshot | null; created_by: string; created_at: string; status: 'proposed' | 'confirmed' | 'blocked'; blockers: string[]; confirmation: ComparisonConfirmation | null; reviewer_conflict: boolean; can_confirm_this_proposal: boolean; content_redacted: boolean; computed_stale?: boolean; persisted_revision_reaction?: RevisionReaction | null };
export type ComparisonList = { proposals: ComparisonProposal[]; can_confirm: boolean; can_propose: boolean; synthetic_only: true };
