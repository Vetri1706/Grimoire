import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('revision-review tasks are required-only in the current canonical schema', async () => {
  const migration = await readFile(new URL('../../db/intake/0034_persisted_revision_monitoring.sql', import.meta.url), 'utf8');
  assert.match(migration, /status text NOT NULL CHECK \(status='required'\)/);
  assert.doesNotMatch(migration, /status='completed'/);
  assert.match(migration, /intake_proposal_review_tasks_immutable/);
});

test('current API emits the stored required-only task status without synthesizing an outcome', async () => {
  const monitoring = await readFile(new URL('../../api/src/monitoring.rs', import.meta.url), 'utf8');
  assert.match(monitoring, /'status',w\.status/);
  assert.doesNotMatch(monitoring, /completed_at|outcome/);
});
