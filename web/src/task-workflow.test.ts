import assert from 'node:assert/strict';
import test from 'node:test';
import { answeredIntake, taskCreationRejected, taskWorkflow, taskWorkflowPriority } from './task-workflow.ts';

test('a prepared result needs Handler input or review; a review receipt never overrides stale or blocked inputs', () => {
  assert.equal(taskWorkflow({ status: 'completed' }).state, 'needs_review');
  assert.equal(taskWorkflow({ status: 'completed', needsInput: true }).state, 'needs_input');
  assert.equal(taskWorkflow({ status: 'completed', reviewed: true }).state, 'completed');
  assert.equal(taskWorkflow({ status: 'completed', reviewed: true, stale: true }).state, 'blocked');
  assert.equal(taskWorkflow({ status: 'completed', reviewed: true, blocked: true }).action, 'resolve');
});

test('a queued task stays explicitly startable and cancellation stays pending until acknowledged', () => {
  assert.equal(taskWorkflow({ status: 'queued', needsInput: true }).action, 'start');
  assert.equal(taskWorkflow({ status: 'cancel_requested' }).state, 'in_progress');
  assert.equal(taskWorkflow({ status: 'cancelled', stale: true }).state, 'cancelled');
  assert.equal(taskWorkflow({ status: 'failed' }).action, 'retry');
});

test('actionable current tasks take precedence over historical completed or blocked records', () => {
  const ordered = [taskWorkflow({ status: 'completed', reviewed: true }), taskWorkflow({ status: 'failed' }), taskWorkflow({ status: 'queued' }), taskWorkflow({ status: 'completed', needsInput: true }), taskWorkflow({ status: 'completed' })].sort((left, right) => taskWorkflowPriority(left) - taskWorkflowPriority(right));
  assert.deepEqual(ordered.map(item => item.state), ['needs_input', 'needs_review', 'todo', 'blocked', 'completed']);
});

test('creation validation unlocks the form but uncertain or conflicting writes retain the exact request', () => {
  assert.equal(taskCreationRejected(409, 'AGENT_PAUSED', false), true);
  assert.equal(taskCreationRejected(422, 'INVALID_INPUT', false), true);
  assert.equal(taskCreationRejected(409, 'IDEMPOTENCY_CONFLICT', false), false);
  assert.equal(taskCreationRejected(500, 'INTERNAL_ERROR', false), false);
  assert.equal(taskCreationRejected(403, 'FORBIDDEN', true), false);
  assert.equal(taskCreationRejected(412, 'STALE_REVISION', true), true);
});

test('answering one brief question preserves other inputs and unresolved questions', () => {
  const base = { name: 'Synthetic workshop', product_category: 'digital' as const, product_description: 'Booking website', decision: null, requirements: ['Accessible booking'], questions: ['Which classes?', 'Which timezone?'], change_summary: 'Initial' };
  const next = answeredIntake(base, { 0: 'Pottery classes' }, '', 'Choose a booking capability');
  assert.deepEqual(next.questions, ['Which timezone?']);
  assert.deepEqual(next.requirements, ['Accessible booking', 'Handler answer — Which classes?\nPottery classes']);
  assert.equal(next.product_description, base.product_description);
  assert.equal(next.decision, 'Choose a booking capability');
  assert.equal(base.questions.length, 2);
});

test('unknown and explicitly empty brief fields stay distinct and answer limits reject rather than truncate', () => {
  const base = { name: 'Synthetic', product_category: 'digital' as const, product_description: null, decision: null, requirements: null, questions: null, change_summary: '' };
  assert.equal(answeredIntake(base, {}, '', '').questions, null);
  assert.deepEqual(answeredIntake({ ...base, questions: [] }, {}, '', '').questions, []);
  assert.equal(answeredIntake(base, {}, '', '').requirements, null);
  assert.throws(() => answeredIntake({ ...base, questions: ['Q'] }, { 0: 'a'.repeat(2001) }, '', ''), /2,000/);
});
