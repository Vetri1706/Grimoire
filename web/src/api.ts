export type Category = 'physical' | 'digital' | 'unspecified';
export type Intake = {
  name: string;
  product_description: string | null;
  product_category: Category;
  decision: string | null;
  requirements: string[] | null;
  questions: string[] | null;
  change_summary: string;
};
export type Revision = Intake & { number: number; created_at: string; created_by: string };
// Directory labels are deliberately separate from immutable revision snapshots.
export type RevisionHistory = {
  revisions: Revision[];
  authors: { principal_id: string; display_name: string }[];
};
export type Scion = {
  id: string;
  current_revision: number;
  revision: Revision;
  missing_information: { field: string; message: string; next_action: string }[];
  next_safe_action: string;
  category_notice: string | null;
};
export type Principal = {
  principal_id: string;
  org_id: string;
  display_name: string;
  organization_name: string;
  can_write: boolean;
  can_manage_workspace: boolean;
  can_prepare_workspace: boolean;
  can_confirm_scope: boolean;
  can_propose_scope: boolean;
  is_agent: boolean;
};
export type HandlerIdentity = {
  identity_id: string;
  login_name: string;
  display_name: string;
  installation_owner: boolean;
};
export type OrganizationSummary = {
  org_id: string;
  organization_name: string;
  is_active: boolean;
  joined_at: string;
};
export type SessionState = {
  handler: HandlerIdentity;
  organizations: OrganizationSummary[];
  active_organization: Principal | null;
};

export const SESSION_AUTH = '__grimoire_cookie_session__';
export const sessionInvalidatedEvent = 'grimoire:session-invalidated';
export const sessionChangedEvent = 'grimoire:session-changed';
export const sessionChangedStorageKey = 'grimoire:session-changed';
export const organizationSession = (organizationId: string) => `${SESSION_AUTH}:${organizationId}`;
export function announceSessionChange() {
  // Storage events reach other tabs only. Clear this tab's private ephemeral
  // state too when a Handler signs out, signs in, or changes organizations.
  window.dispatchEvent(new Event(sessionChangedEvent));
  try { localStorage.setItem(sessionChangedStorageKey, crypto.randomUUID()); } catch { /* Request binding still rejects stale tabs. */ }
}

export class ApiError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export async function request<T>(token: string, path: string, options: RequestInit = {}): Promise<T> {
  const method = (options.method ?? 'GET').toUpperCase();
  const usesSession = token === SESSION_AUTH || token.startsWith(`${SESSION_AUTH}:`);
  const organizationId = token.startsWith(`${SESSION_AUTH}:`) ? token.slice(SESSION_AUTH.length + 1) : null;
  let response: Response;
  try {
    response = await fetch(`/api${path}`, {
      ...options,
      credentials: 'same-origin',
      headers: {
        ...(usesSession ? {} : { Authorization: `Bearer ${token}` }),
        ...(organizationId ? { 'X-Grimoire-Organization': organizationId } : {}),
        ...(usesSession && !['GET', 'HEAD', 'OPTIONS'].includes(method) ? { 'X-Grimoire-CSRF': '1' } : {}),
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
        ...options.headers,
      },
    });
  } catch {
    throw new ApiError(0, 'connection_failed', 'The local API could not be reached. Check that it is running, then retry. Your draft is still here.');
  }
  if (response.status === 204) return undefined as T;
  let data: unknown;
  try { data = await response.json(); } catch {
    throw new ApiError(response.status, 'invalid_response', 'The local API returned an unreadable response. Check the API process, then retry.');
  }
  if (!response.ok) {
    const error = data as { error?: { code?: string; message?: string } };
    if (organizationId && (response.status === 401 || error.error?.code === 'ACTIVE_ORGANIZATION_CHANGED' || error.error?.code === 'ACTIVE_ORGANIZATION_REQUIRED') && typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent(sessionInvalidatedEvent, { detail: { token } }));
    }
    throw new ApiError(response.status, error.error?.code ?? 'request_failed', error.error?.message ?? `Request failed (${response.status}).`);
  }
  return data as T;
}
