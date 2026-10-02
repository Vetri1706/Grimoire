import assert from 'node:assert/strict';
import test from 'node:test';
import { agentIdentity, agentPalettes, agentSilhouettes } from './agent-identity.ts';

test('a saved agent keeps its visual identity through renaming and repeated rendering', () => {
  const id = '579b05cc-1087-4d6d-9461-31f85f8a3905';
  const original = agentIdentity('Planning agent', id);
  assert.deepEqual(agentIdentity('Requirements researcher', id), original);
  assert.deepEqual(agentIdentity('Planning agent', id), original);
  assert.notDeepEqual(agentIdentity('Planning agent', 'another-agent-id'), original);
});

test('agents with the same display name remain individually recognizable', () => {
  const identities = Array.from({ length: 250 }, (_, index) => agentIdentity('Planning agent', `fixture-agent-${index}`));
  assert.equal(new Set(identities.map(identity => JSON.stringify(identity))).size, identities.length);
  assert.equal(new Set(identities.map(identity => identity.palette)).size, agentPalettes.length);
  assert.equal(new Set(identities.map(identity => identity.silhouette)).size, agentSilhouettes.length);
  // Color is not the sole identity cue; multiple silhouettes, faces and marks are used.
  assert.ok(new Set(identities.map(({ silhouette, eyes, smile, mark, mirrored }) => JSON.stringify({ silhouette, eyes, smile, mark, mirrored }))).size > 230);
});

test('placeholder identities are deterministic without browser storage or randomness', () => {
  assert.deepEqual(agentIdentity('New agent'), agentIdentity('New agent'));
  assert.deepEqual(agentIdentity(''), agentIdentity('   '));
  assert.deepEqual(agentIdentity('Researcher', '  '), agentIdentity('Researcher'));
  assert.notDeepEqual(agentIdentity('Researcher'), agentIdentity('Reviewer'));
  assert.notDeepEqual(agentIdentity('Researcher'), agentIdentity('Any name', 'Researcher'));
});

test('identity traits remain renderable for UUIDs, Unicode names and long identifiers', () => {
  for (const value of ['a', '00000000-0000-0000-0000-000000000001', 'ஆராய்ச்சியாளர்', '研究者🧭', 'x'.repeat(1024)]) {
    const identity = agentIdentity(value, value);
    assert.ok(agentPalettes[identity.palette]);
    assert.ok(agentSilhouettes[identity.silhouette]);
    assert.ok(identity.eyes >= 0 && identity.eyes < 4);
    assert.ok(identity.smile >= 0 && identity.smile < 4);
    assert.ok(identity.mark >= 0 && identity.mark < 8);
    assert.ok([-6, -3, 0, 3, 6].includes(identity.faceTilt));
    assert.ok([18, 21, 24, 27].includes(identity.eyeSpacing));
  }
});
