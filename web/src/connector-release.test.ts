import assert from 'node:assert/strict';
import test from 'node:test';
import { connectorArtifactPath, connectorCommand, isConnectorOrigin, parseConnectorRelease } from './connector-release.ts';

const manifest = {
  version: '0.1.1',
  package: { path: '/downloads/grimoire-connector.tgz', sha256: 'a'.repeat(64) },
  windows: { path: '/downloads/grimoire-connector-windows.zip', sha256: 'b'.repeat(64) },
  npm: { published: false },
};

test('only this installation can supply the unpublished release command', () => {
  const release = parseConnectorRelease(manifest);
  assert.ok(release);
  assert.equal(connectorCommand('https://grimoire.example', release), 'npx --yes --package="https://grimoire.example/downloads/grimoire-connector.tgz?v=0.1.1" grimoire-connector --api "https://grimoire.example" --watch');
  assert.equal(connectorCommand('http://127.0.0.1:5182', release, '12345678-1234-1234-1234-123456789abc'), 'npx --yes --package="http://127.0.0.1:5182/downloads/grimoire-connector.tgz?v=0.1.1" grimoire-connector --connection 12345678-1234-1234-1234-123456789abc --watch');
});

test('new releases invalidate tarball and Windows download URLs together', () => {
  const current = parseConnectorRelease(manifest)!;
  const previous = parseConnectorRelease({ ...manifest, version: '0.1.0' })!;
  assert.equal(connectorArtifactPath(current, 'package'), '/downloads/grimoire-connector.tgz?v=0.1.1');
  assert.equal(connectorArtifactPath(current, 'windows'), '/downloads/grimoire-connector-windows.zip?v=0.1.1');
  for (const kind of ['package', 'windows'] as const) assert.notEqual(connectorArtifactPath(current, kind), connectorArtifactPath(previous, kind));
});

test('unavailable, unverified and command-injected releases do not enable setup', () => {
  for (const value of [null, {}, { ...manifest, npm: { published: true, name: 'unverified-name' } },
    { ...manifest, version: '0.1.0; echo injected' },
    { ...manifest, package: { ...manifest.package, path: 'https://other.example/connector.tgz' } },
    { ...manifest, windows: { ...manifest.windows, path: '//other.example/connector.zip' } },
    { ...manifest, package: { ...manifest.package, sha256: 'missing' } }]) assert.equal(parseConnectorRelease(value), null);
});

test('command fields reject shell syntax and malformed origins or identifiers', () => {
  const release = parseConnectorRelease(manifest)!;
  for (const origin of ['https://grimoire.example/path', 'https://grimoire.example/', 'https://user:pass@grimoire.example', 'https://grimoire.example/$(calc)', 'javascript:alert(1)',
    'https://a!x!.example', 'https://a&whoami.example', 'https://a(b).example', 'https://a;b.example', 'https://a,b.example', 'https://a=b.example', 'https://a~b.example', 'https://-a.example',
    'http://grimoire.example', 'http://localhost.example', 'http://127.0.0.2', 'http://127.1', 'http://[::2]']) {
    assert.throws(() => connectorCommand(origin, release));
  }
  assert.throws(() => connectorCommand('https://grimoire.example', release, '123; echo injected'));
  for (const version of ['0.1.1&command=bad', '0.1.1"; echo injected', '0.1.1$(whoami)', '0.1.1!x!']) {
    assert.throws(() => connectorArtifactPath({ ...release, version }, 'windows'));
    assert.throws(() => connectorCommand('https://grimoire.example', { ...release, version }));
  }
});

test('only canonical HTTPS or exact loopback HTTP origins can pair', () => {
  for (const origin of ['https://grimoire.example', 'https://xn--bcher-kva.example', 'https://[2001:db8::1]:444', 'http://localhost:5182', 'http://127.0.0.1:5182', 'http://[::1]:5182']) assert.equal(isConnectorOrigin(origin), true);
  for (const origin of ['not-a-url', 'https://GRIMOIRE.example', 'https://grimoire.example.', 'https://localhost:443', 'http://2130706433', 'http://0x7f000001', 'https://127.0.0.1/../']) assert.equal(isConnectorOrigin(origin), false);
});
