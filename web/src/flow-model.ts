export type FlowRouteKind =
  | 'context'
  | 'scope'
  | 'comparison'
  | 'decision-new'
  | 'decision'
  | 'change'
  | 'review'
  | 'history'
  | 'sources'
  | 'scope-workbench'
  | 'offers-workbench'
  | 'unknown';

export type FlowRoute = {
  kind: FlowRouteKind;
  scionId: string | null;
  objectId: string | null;
  comparisonId: string | null;
};

export type RevisionReaction = {
  transition_id: string;
  proposal_kind: 'physical_scope' | 'offer_comparison' | string;
  proposal_id: string;
  proposal_scion_revision: number;
  superseded_by_revision: number;
  reason: 'scion_revision_changed' | string;
  recorded_at: string;
  review_task: {
    id: string;
    task_kind: 'revision_change_review' | string;
    status: 'required';
    required_for_revision: number;
    created_at: string;
  };
};

export type WorkflowReadKey = 'scope' | 'comparisons' | 'offers' | 'reactions';

export type NamedReadResult =
  | { key: WorkflowReadKey; status: 'fulfilled'; value: unknown }
  | { key: WorkflowReadKey; status: 'rejected'; reason: unknown };

export async function settleNamedReads(entries: Array<readonly [WorkflowReadKey, () => Promise<unknown>]>): Promise<NamedReadResult[]> {
  return Promise.all(entries.map(async ([key, read]) => {
    try {
      return { key, status: 'fulfilled', value: await read() } as const;
    } catch (reason) {
      return { key, status: 'rejected', reason } as const;
    }
  }));
}

export type FlowRecordState = 'missing' | 'restricted' | 'blocked' | 'stale' | 'proposed' | 'usable';
export type FlowAction = { label: string; route: string };

export type FlowActionInput = {
  page: 'context' | 'scope' | 'comparison';
  scionId: string;
  scopeId: string | null;
  scopeState: FlowRecordState;
  comparisonId: string | null;
  comparisonState: FlowRecordState;
  reactionId: string | null;
  canPrepareScope: boolean;
  canPrepareComparison: boolean;
  canConfirmComparison: boolean;
  freshnessKnown: boolean;
};

/**
 * Return the sole legal forward action for a read route. Mutating workbench
 * routes are exposed only from explicit server capability fields and only
 * while revision-reaction freshness is known.
 */
export function recommendedFlowAction(input: FlowActionInput): FlowAction | null {
  const base = `/scions/${input.scionId}`;
  if (!input.freshnessKnown) return null;
  if (input.reactionId) return { label: 'Review latest change', route: `${base}/changes/${input.reactionId}` };

  if (input.page === 'context') {
    if (input.comparisonId) return { label: 'Review exact comparison', route: `${base}/comparisons/${input.comparisonId}` };
    if (input.scopeState === 'missing' && input.canPrepareScope) return { label: 'Complete exact scope', route: `${base}/workbench/scope` };
    if (input.scopeState === 'usable' && input.canPrepareComparison) return { label: 'Prepare exact comparison', route: `${base}/workbench/offers` };
    return null;
  }

  if (input.page === 'scope') {
    return input.scopeState === 'usable' && input.canPrepareComparison
      ? { label: 'Prepare exact comparison', route: `${base}/workbench/offers` }
      : null;
  }

  return input.comparisonState === 'proposed' && input.canConfirmComparison
    ? { label: 'Complete normalization review', route: `${base}/workbench/offers` }
    : null;
}

export type PrincipalCapabilities = {
  can_write: boolean;
  can_confirm_scope: boolean;
  can_propose_scope: boolean;
  is_agent: boolean;
};

export function principalRoleLabel(capabilities: PrincipalCapabilities): string {
  if (capabilities.is_agent) return 'Proposal agent';
  if (capabilities.can_confirm_scope) return 'Engineering Reviewer';
  if (capabilities.can_propose_scope) return 'Scope proposer';
  if (capabilities.can_write) return 'Intake editor';
  return 'Viewer';
}

export function parseFlowRoute(route: string): FlowRoute {
  const [pathname, query = ''] = route.split('?', 2);
  const parts = pathname.split('/').filter(Boolean).map(decodeURIComponent);
  if (parts[0] !== 'scions' || !parts[1]) return { kind: 'unknown', scionId: null, objectId: null, comparisonId: null };
  const scionId = parts[1];
  const tail = parts.slice(2);
  const base = { scionId, objectId: tail[1] ?? null, comparisonId: null as string | null };
  if (!tail.length || tail[0] === 'context') return { ...base, kind: 'context', objectId: null };
  if (tail[0] === 'scope' && tail[1]) return { ...base, kind: 'scope' };
  if (tail[0] === 'comparisons' && tail[1]) return { ...base, kind: 'comparison' };
  if (tail[0] === 'decisions' && tail[1] === 'new') return { ...base, kind: 'decision-new', objectId: null, comparisonId: new URLSearchParams(query).get('comparison') };
  if (tail[0] === 'decisions' && tail[1]) return { ...base, kind: 'decision' };
  if (tail[0] === 'changes' && tail[1]) return { ...base, kind: 'change' };
  if (tail[0] === 'reviews' && tail[1]) return { ...base, kind: 'review' };
  if (tail[0] === 'history') return { ...base, kind: 'history', objectId: null };
  if (tail[0] === 'sources') return { ...base, kind: 'sources', objectId: null };
  if (tail[0] === 'workbench' && tail[1] === 'scope') return { ...base, kind: 'scope-workbench', objectId: null };
  if (tail[0] === 'workbench' && tail[1] === 'offers') return { ...base, kind: 'offers-workbench', objectId: null };
  return { ...base, kind: 'unknown' };
}

export function scionIdFromRoute(route: string): string | null {
  return parseFlowRoute(route).scionId;
}

export function newestReaction(items: RevisionReaction[]): RevisionReaction | null {
  return [...items].sort((left, right) =>
    right.superseded_by_revision - left.superseded_by_revision ||
    Date.parse(right.recorded_at) - Date.parse(left.recorded_at) ||
    right.transition_id.localeCompare(left.transition_id),
  )[0] ?? null;
}

export function reactionForTask(items: RevisionReaction[], taskId: string | null): RevisionReaction | null {
  if (!taskId) return newestReaction(items);
  return items.find(item => item.review_task.id === taskId) ?? null;
}

export function reactionForChange(items: RevisionReaction[], changeId: string | null): RevisionReaction | null {
  if (!changeId) return newestReaction(items);
  return items.find(item => item.transition_id === changeId) ?? null;
}
