export type DemoSlug = 'current' | 'revised' | 'revoked';
export type DemoScenario = { slug: DemoSlug; title: string; description: string; scion_id: string };
export type DemoCatalog = { synthetic: true; read_only: true; title: string; description: string; scenarios: DemoScenario[] };

// Public demo reads deliberately bypass the authenticated API helper. They do not
// send cookies, bearer tokens, organization headers, or allocate guest sessions.
export async function demoRequest<T>(path: '/demo' | `/demo/${DemoSlug}`, signal?: AbortSignal): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api${path}`, { method: 'GET', credentials: 'omit', cache: 'no-store', signal });
  } catch (failure) {
    if (signal?.aborted) throw failure;
    throw new Error('The demo service could not be reached. No case data is available until it reconnects.');
  }
  if (!response.ok) throw new Error(response.status === 503 ? 'The synthetic demo is not available on this installation yet. Please retry later.' : 'The demo snapshot could not be read. Please retry.');
  try { return await response.json() as T; } catch { throw new Error('The demo service returned an unreadable snapshot.'); }
}

export function isDemoCatalog(value: unknown): value is DemoCatalog {
  if (!value || typeof value !== 'object') return false;
  const catalog = value as Partial<DemoCatalog>;
  return catalog.synthetic === true && catalog.read_only === true
    && typeof catalog.title === 'string' && typeof catalog.description === 'string'
    && Array.isArray(catalog.scenarios) && catalog.scenarios.length === 3
    && new Set(catalog.scenarios.map(scenario => scenario?.slug)).size === 3
    && catalog.scenarios.every(scenario => scenario && ['current', 'revised', 'revoked'].includes(scenario.slug)
      && typeof scenario.title === 'string' && typeof scenario.description === 'string'
      && typeof scenario.scion_id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(scenario.scion_id));
}
