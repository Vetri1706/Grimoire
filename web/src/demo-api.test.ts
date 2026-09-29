import assert from 'node:assert/strict';
import test from 'node:test';
import { demoRequest, isDemoCatalog } from './demo-api.ts';

test('public demo requests omit all account credentials and only read fresh server state', async t => {
  let url: unknown;
  let sent: RequestInit | undefined;
  t.mock.method(globalThis, 'fetch', async (target: unknown, options: RequestInit) => {
    url = target; sent = options;
    return new Response(JSON.stringify({ scion_id: 'synthetic' }));
  });
  assert.deepEqual(await demoRequest('/demo/current'), { scion_id: 'synthetic' });
  assert.equal(url, '/api/demo/current');
  assert.equal(sent?.method, 'GET');
  assert.equal(sent?.credentials, 'omit');
  assert.equal(sent?.cache, 'no-store');
  assert.equal(sent?.body, undefined);
  for (const key of ['Authorization', 'Cookie', 'X-Grimoire-Organization', 'X-Grimoire-CSRF']) {
    assert.equal(new Headers(sent?.headers).get(key), null);
  }
});

test('an unavailable or unreadable demo fails without substituting example data', async t => {
  t.mock.method(globalThis, 'fetch', async () => new Response('unavailable', { status: 503 }));
  await assert.rejects(demoRequest('/demo'), /not available on this installation/);
  t.mock.restoreAll();
  t.mock.method(globalThis, 'fetch', async () => new Response('<html>proxy fallback</html>'));
  await assert.rejects(demoRequest('/demo'), /unreadable snapshot/);
});

test('a catalog must explicitly identify all published cases as synthetic and read only', () => {
  const catalog = {
    synthetic: true, read_only: true, title: 'Demo', description: 'Synthetic cases',
    scenarios: ['current', 'revised', 'revoked'].map((slug, index) => ({ slug, title: slug, description: slug, scion_id: `00000000-0000-0000-0000-00000000000${index}` })),
  };
  assert.equal(isDemoCatalog(catalog), true);
  assert.equal(isDemoCatalog({ ...catalog, synthetic: false }), false);
  assert.equal(isDemoCatalog({ ...catalog, read_only: false }), false);
  assert.equal(isDemoCatalog({ ...catalog, scenarios: [catalog.scenarios[0], catalog.scenarios[0], catalog.scenarios[2]] }), false);
});
