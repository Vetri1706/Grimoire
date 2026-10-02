export type ConnectorRelease = {
  version: string;
  package: { path: '/downloads/grimoire-connector.tgz'; sha256: string };
  windows: { path: '/downloads/grimoire-connector-windows.zip'; sha256: string };
  npm: { published: false };
};

const object = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const checksum = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

// Downloads come from this installation only. A release manifest cannot turn
// a copy button into an arbitrary shell command or an unpublished npm name.
export function parseConnectorRelease(value: unknown): ConnectorRelease | null {
  if (!object(value) || typeof value.version !== 'string' || !/^\d{1,4}\.\d{1,4}\.\d{1,4}(?:-[a-z0-9.-]{1,40})?$/.test(value.version)
    || !object(value.package) || value.package.path !== '/downloads/grimoire-connector.tgz' || !checksum(value.package.sha256)
    || !object(value.windows) || value.windows.path !== '/downloads/grimoire-connector-windows.zip' || !checksum(value.windows.sha256)
    || !object(value.npm) || value.npm.published !== false) return null;
  return value as ConnectorRelease;
}

export function isConnectorOrigin(origin: string): boolean {
  let url: URL;
  try { url = new URL(origin); } catch { return false; }
  const dnsName = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;
  const ipv6 = /^\[[0-9a-f:]+\]$/;
  return url.origin === origin && (dnsName.test(url.hostname) || ipv6.test(url.hostname))
    && (url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)));
}

export function connectorArtifactPath(release: ConnectorRelease, kind: 'package' | 'windows'): string {
  // A new release must have a distinct URL so npm cannot reuse an older packed
  // connector. The validated version is restricted to shell-safe URL characters.
  if (!parseConnectorRelease(release)) throw new Error('Invalid connector release');
  return `${release[kind].path}?v=${release.version}`;
}

export function connectorCommand(origin: string, release: ConnectorRelease, connectionId?: string): string {
  // URL canonicalization alone accepts punctuation such as ! or & in hostnames.
  // Restrict to DNS/IPv6 host syntax before interpolating into any shell command.
  if (!isConnectorOrigin(origin)) throw new Error('Invalid connector origin');
  if (connectionId && !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(connectionId)) throw new Error('Invalid connection identifier');
  const options = connectionId ? `--connection ${connectionId}` : `--api "${origin}"`;
  return `npx --yes --package="${origin}${connectorArtifactPath(release, 'package')}" grimoire-connector ${options} --watch`;
}
