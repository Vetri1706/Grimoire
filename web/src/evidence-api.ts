export type SourceInput = {
  title: string;
  origin: string;
  owner: string;
  synthetic: true;
  source_text: string;
  rights_status: 'granted';
  permission_basis: string;
  permitted_use: 'scion_review';
  change_summary: string;
};

export type SourceSummary = {
  id: string;
  scion_id: string;
  scion_revision: number;
  current_revision: number;
  title: string;
  origin: string;
  owner: string;
  content_sha256: string;
  rights_status: 'granted' | 'revoked';
  permitted_use: 'scion_review';
  permission_basis: string;
  synthetic: true;
  claim_count: number;
  revocation_reason: string | null;
};

export type SourceRevision = SourceInput & {
  source_id: string;
  number: number;
  content_sha256: string;
  byte_length: number;
  created_at: string;
  created_by: string;
  storage_backend?: 's3';
  object_key?: string;
  object_version_id?: string;
  content_hash_verified?: boolean;
};

export type ClaimLocator = { start_byte: number; end_byte: number; quote: string };
export type SourceClaim = {
  id: string;
  source_id: string;
  source_revision: number;
  statement: string;
  locator: ClaimLocator;
  authority: 'handler_entered';
  verification_status: 'unverified';
  created_at: string;
  created_by: string;
};
export type SourceDetail = { source: SourceSummary; revisions: SourceRevision[]; claims: SourceClaim[] };
export type SourceList = { sources: SourceSummary[]; verified_facts: []; extraction_status: 'not_implemented' };

// Exact quotes may repeat. Each occurrence identifies its own immutable byte range.
export const MAX_QUOTE_MATCHES = 100;
export function quoteLocators(text: string, quote: string): ClaimLocator[] {
  if (!quote) return [];
  const matches: ClaimLocator[] = [];
  const encoder = new TextEncoder();
  for (let from = 0; from <= text.length;) {
    const index = text.indexOf(quote, from);
    if (index < 0) break;
    const start_byte = encoder.encode(text.slice(0, index)).length;
    matches.push({ start_byte, end_byte: start_byte + encoder.encode(quote).length, quote });
    // One extra match lets the form ask for a narrower quote without rendering
    // thousands of choices or repeatedly encoding every prefix of a large text.
    if (matches.length > MAX_QUOTE_MATCHES) break;
    from = index + 1;
  }
  return matches;
}
