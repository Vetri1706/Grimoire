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
    status: 'required' | 'in_progress' | 'completed' | string;
    required_for_revision: number;
    created_at: string;
  };
};

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

