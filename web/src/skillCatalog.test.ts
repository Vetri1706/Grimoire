import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { starterSkills } from './skillCatalog.ts';
import { productPlanningCatalog, renderCatalog } from '../../skills/product-planning/build-catalog.mjs';

const bundle = new URL('../../skills/product-planning/', import.meta.url);
const sha256 = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');

test('starter skills retain verified upstream bytes, pinned source identity, and redistribution license', async () => {
  const manifest = JSON.parse(await readFile(new URL('manifest.json', bundle), 'utf8'));
  const license = await readFile(new URL(manifest.licensePath, bundle));
  assert.equal(sha256(license), manifest.licenseSha256);
  assert.equal(new Set(starterSkills.map(skill => skill.id)).size, starterSkills.length);
  assert.equal(starterSkills.length, manifest.skills.length);
  for (const skill of starterSkills) {
    const entry = manifest.skills.find((item: { id: string }) => item.id === skill.id);
    assert.ok(entry, 'Every presented skill has a reviewed source manifest.');
    assert.deepEqual(skill.source, entry.source);
    assert.match(skill.source.commit, /^[a-f0-9]{40}$/);
    assert.match(skill.source.sha256, /^[a-f0-9]{64}$/);
    assert.equal(sha256(await readFile(new URL(entry.upstreamPath, bundle))), skill.source.sha256);
    assert.equal(skill.source.license, 'MIT');
    // The existing API stores only these three fields. Verify that the persisted
    // payload still contains attribution when catalog-only metadata is discarded.
    const saved = JSON.parse(JSON.stringify({ name: skill.name, description: skill.description, instructions: skill.instructions }));
    for (const value of [skill.source.repository, skill.source.commit, skill.source.path, skill.source.sha256, skill.source.catalogUrl, `Grimoire adaptation version: ${skill.adaptationVersion}`, license.toString('utf8').trim()]) {
      assert.ok(saved.instructions.includes(value), `${skill.id} loses required provenance in native storage.`);
    }
  }
});

test('catalog instructions fit native API byte limits and match their authorable skill documents', async () => {
  for (const skill of starterSkills) {
    assert.ok(skill.name.trim() && Buffer.byteLength(skill.name) <= 100);
    assert.ok(Buffer.byteLength(skill.description) <= 2000);
    assert.ok(skill.instructions.trim() && Buffer.byteLength(skill.instructions) <= 12000);
    assert.equal(skill.instructions.includes('\0'), false);
    const document = (await readFile(new URL(`${skill.id}/SKILL.md`, bundle), 'utf8')).replace(/\r\n/g, '\n');
    assert.equal(skill.instructions, document.trimEnd() + '\n');
  }
  assert.deepEqual(await productPlanningCatalog(), starterSkills);
  const shipped = (await readFile(new URL('./skillCatalog.ts', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
  assert.equal(shipped, renderCatalog(starterSkills), 'Regenerate the static catalog after editing skill documents.');
});
