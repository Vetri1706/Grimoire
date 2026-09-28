import assert from 'node:assert/strict';
import test from 'node:test';
import { newestReaction, parseFlowRoute, principalRoleLabel, reactionForChange, reactionForTask, recommendedFlowAction, settleNamedReads } from './flow-model.ts';
import type { FlowActionInput, PrincipalCapabilities, WorkflowReadKey } from './flow-model.ts';
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

const baseAction: FlowActionInput = {
  page: 'context', scionId: 'case-1', scopeId: 'scope-1', scopeState: 'usable', comparisonId: null, comparisonState: 'missing', reactionId: null,
  canPrepareScope: false, canPrepareComparison: false, canConfirmComparison: false, freshnessKnown: true,
};

test('state and capability table exposes at most one legal forward action', () => {
  const missingScope = recommendedFlowAction({ ...baseAction, scopeId: null, scopeState: 'missing', canPrepareScope: true });
  assert.deepEqual(missingScope, { label: 'Complete exact scope', route: '/scions/case-1/workbench/scope' });
  assert.equal(recommendedFlowAction({ ...baseAction, scopeId: null, scopeState: 'missing', canPrepareScope: false }), null);

  const prepareComparison = recommendedFlowAction({ ...baseAction, canPrepareComparison: true });
  assert.deepEqual(prepareComparison, { label: 'Prepare exact comparison', route: '/scions/case-1/workbench/offers' });
  for (const scopeState of ['restricted', 'blocked', 'stale', 'proposed'] as const) {
    assert.equal(recommendedFlowAction({ ...baseAction, page: 'scope', scopeState, canPrepareComparison: true }), null);
  }

  const confirmedComparison = { ...baseAction, page: 'comparison' as const, comparisonId: 'comparison-1', comparisonState: 'usable' as const };
  assert.equal(recommendedFlowAction({ ...confirmedComparison, canConfirmComparison: true }), null, 'confirmation never implies decision authority');
  assert.deepEqual(recommendedFlowAction({ ...confirmedComparison, comparisonState: 'proposed', canConfirmComparison: true }), { label: 'Complete normalization review', route: '/scions/case-1/workbench/offers' });
  assert.equal(recommendedFlowAction({ ...baseAction, canPrepareComparison: true, freshnessKnown: false }), null);
  assert.deepEqual(recommendedFlowAction({ ...baseAction, reactionId: 'change-1' }), { label: 'Review latest change', route: '/scions/case-1/changes/change-1' });
});

test('displayed identity role comes only from explicit server capability fields', () => {
  const role = (overrides: Partial<PrincipalCapabilities>) => principalRoleLabel({ can_write: false, can_confirm_scope: false, can_propose_scope: false, is_agent: false, ...overrides });
  assert.equal(role({}), 'Viewer');
  assert.equal(role({ can_write: true }), 'Intake editor');
  assert.equal(role({ can_propose_scope: true }), 'Scope proposer');
  assert.equal(role({ can_confirm_scope: true }), 'Engineering Reviewer');
  assert.equal(role({ is_agent: true, can_write: true, can_confirm_scope: true, can_propose_scope: true }), 'Proposal agent');
  assert.notEqual(role({ can_write: true }), 'Commercial Approver');
});

test('each independent read failure preserves all other permitted results', async () => {
  const keys: WorkflowReadKey[] = ['scope', 'comparisons', 'offers', 'reactions'];
  for (const failedKey of keys) {
    const results = await settleNamedReads(keys.map(key => [key, () => key === failedKey ? Promise.reject(new Error(`${key} failed`)) : Promise.resolve(`${key} value`)] as const));
    assert.equal(results.length, 4);
    assert.equal(results.find(result => result.key === failedKey)?.status, 'rejected');
    for (const key of keys.filter(key => key !== failedKey)) {
      const result = results.find(item => item.key === key);
      assert.equal(result?.status, 'fulfilled');
      if (result?.status === 'fulfilled') assert.equal(result.value, `${key} value`);
    }
  }
});
