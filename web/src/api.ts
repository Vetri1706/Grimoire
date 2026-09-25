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
export type Principal = { principal_id: string; org_id: string; display_name: string; organization_name: string; can_write?: boolean };

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
  let response: Response;
  try {
    response = await fetch(`/api${path}`, {
      ...options,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
        ...options.headers,
      },
    });
  } catch {
    throw new ApiError(0, 'connection_failed', 'The local API could not be reached. Check that it is running, then retry. Your draft is still here.');
  }
  let data: unknown;
  try { data = await response.json(); } catch {
    throw new ApiError(response.status, 'invalid_response', 'The local API returned an unreadable response. Check the API process, then retry.');
  }
  if (!response.ok) {
    const error = data as { error?: { code?: string; message?: string } };
    throw new ApiError(response.status, error.error?.code ?? 'request_failed', error.error?.message ?? `Request failed (${response.status}).`);
  }
  return data as T;
}
