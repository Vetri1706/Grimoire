import assert from 'node:assert/strict';
import test from 'node:test';
import { newestReaction, parseFlowRoute, reactionForChange, reactionForTask } from './flow-model.ts';
import type { RevisionReaction } from './flow-model.ts';

const reactions: RevisionReaction[] = [
  {
    transition_id: 'change-r5', proposal_kind: 'offer_comparison', proposal_id: 'comparison-1', proposal_scion_revision: 4,
    superseded_by_revision: 5, reason: 'scion_revision_changed', recorded_at: '2026-09-28T10:00:00Z',
    review_task: { id: 'review-r5', task_kind: 'revision_change_review', status: 'required', required_for_revision: 5, created_at: '2026-09-28T10:00:00Z' },
  },
  {
    transition_id: 'change-r6', proposal_kind: 'physical_scope', proposal_id: 'scope-1', proposal_scion_revision: 4,
    superseded_by_revision: 6, reason: 'scion_revision_changed', recorded_at: '2026-09-28T11:00:00Z',
    review_task: { id: 'review-r6', task_kind: 'revision_change_review', status: 'required', required_for_revision: 6, created_at: '2026-09-28T11:00:00Z' },
  },
];

test('parses every addressable release-one flow route', () => {
  assert.deepEqual(parseFlowRoute('/scions/case-1/context'), { kind: 'context', scionId: 'case-1', objectId: null, comparisonId: null });
  assert.equal(parseFlowRoute('/scions/case-1/scope/scope-2').kind, 'scope');
  assert.equal(parseFlowRoute('/scions/case-1/comparisons/comparison-3').objectId, 'comparison-3');
  assert.deepEqual(parseFlowRoute('/scions/case-1/decisions/new?comparison=comparison-3'), { kind: 'decision-new', scionId: 'case-1', objectId: null, comparisonId: 'comparison-3' });
  assert.equal(parseFlowRoute('/scions/case-1/changes/change-r5').kind, 'change');
  assert.equal(parseFlowRoute('/scions/case-1/reviews/review-r5').kind, 'review');
});

test('selects the newest authoritative revision reaction without relying on API order', () => {
  assert.equal(newestReaction(reactions)?.transition_id, 'change-r6');
  assert.equal(reactionForChange(reactions, 'change-r5')?.review_task.id, 'review-r5');
  assert.equal(reactionForTask(reactions, 'review-r6')?.transition_id, 'change-r6');
  assert.equal(reactionForTask(reactions, 'missing'), null);
});

test('unknown routes fail closed instead of falling into a mutation screen', () => {
  assert.equal(parseFlowRoute('/scions/case-1/decisions').kind, 'unknown');
  assert.equal(parseFlowRoute('/not-scions/case-1/context').scionId, null);
});
