import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, request } from './api';
import type { AgentTask, AgentTaskList } from './scope-api';

export type ResearchInput = {
  synthetic: false; summary: string;
  process_steps: { title: string; detail: string; source_urls: string[] }[];
  candidates: { name: string; url: string; rationale: string; source_urls: string[] }[];
  sources: { url: string; title: string }[]; unresolved_gaps: string[];
  queries: { query: string; observed_at: string }[]; capture_ids: string[];
};
export type ResearchCapture = { id: string; url: string | null; final_url: string | null; status: 'captured' | 'failed' | 'revoked'; excerpt: string | null; content_sha256: string | null; fetched_at: string; failure_code: string | null; http_status: number | null; byte_length: number | null };
export type ResearchReport = {
  id: string; agent_task_id: string; scion_revision: number; status: 'current' | 'stale' | 'blocked';
  input: ResearchInput | null; captures: ResearchCapture[];
  reviews: { id: string; note: string; created_at: string }[]; created_at: string;
};
export type ResearchState = {
  available: true; policy_version: string; limits: Record<string, number>;
  worker_connections: { connection_id: string; device_name: string; status: string; last_seen: string | null; research_capable: boolean }[];
  reports: ResearchReport[]; briefs: { task_id: string; objective: string; worker_connection_id?: string }[];
};

/** Live authorization lease; derived website content is never persisted in browser storage. */
export function useResearch(token: string, scionId: string, revision: number) {
  const [data, setData] = useState<(ResearchState & { tasks: AgentTask[] }) | null>(null);
  const [error, setError] = useState(''); const [unsupported, setUnsupported] = useState(false);
  const pending = useRef<AbortController | null>(null); const epoch = useRef(0);
  const lease = useRef<number | undefined>(undefined);
  const clear = useCallback((reason: string) => { epoch.current++; pending.current?.abort(); pending.current = null; window.clearTimeout(lease.current); setData(null); setError(reason); }, []);
  const refresh = useCallback(async () => {
    if (pending.current || document.visibilityState !== 'visible' || !navigator.onLine) return;
    const controller = new AbortController(); pending.current = controller;
    const generation = epoch.current, started = Date.now();
    const deadline = window.setTimeout(() => controller.abort(), 3500);
    try {
      const [state, tasks] = await Promise.all([
        request<ResearchState>(token, `/scions/${scionId}/research`, { signal: controller.signal, cache: 'no-store' }),
        request<AgentTaskList>(token, `/scions/${scionId}/agent-tasks`, { signal: controller.signal, cache: 'no-store' }),
      ]);
      if (generation !== epoch.current) return;
      if (Date.now() - started >= 5000) { clear('Research access must be checked again.'); return; }
      setData({ ...state, tasks: tasks.tasks.filter(task => task.task_kind === 'research_public_web') }); setError(''); setUnsupported(false);
      window.clearTimeout(lease.current); lease.current = window.setTimeout(() => clear('Research connection lost. Saved sources are hidden until access is checked.'), Math.max(0, started + 5000 - Date.now()));
    } catch (failure) {
      if (generation !== epoch.current) return;
      clear(failure instanceof Error ? failure.message : 'Research is unavailable.');
      setUnsupported(failure instanceof ApiError && failure.status === 404);
    } finally { window.clearTimeout(deadline); if (pending.current === controller) pending.current = null; }
  }, [token, scionId, revision, clear]);
  useEffect(() => {
    clear(''); setUnsupported(false); void refresh(); const timer = window.setInterval(() => void refresh(), 2000);
    const changed = () => { if (document.visibilityState === 'visible' && navigator.onLine) void refresh(); else clear('Research content hidden until access is checked.'); };
    const invalidate = (event: Event) => { if ((event as CustomEvent<{ scionId: string }>).detail?.scionId === scionId) { clear('Source access or the Scion revision changed.'); void refresh(); } };
    document.addEventListener('visibilitychange', changed); window.addEventListener('online', changed); window.addEventListener('offline', changed); window.addEventListener('pagehide', changed); window.addEventListener('grimoire:case-invalidated', invalidate);
    return () => { epoch.current++; pending.current?.abort(); pending.current = null; window.clearTimeout(lease.current); window.clearInterval(timer); document.removeEventListener('visibilitychange', changed); window.removeEventListener('online', changed); window.removeEventListener('offline', changed); window.removeEventListener('pagehide', changed); window.removeEventListener('grimoire:case-invalidated', invalidate); };
  }, [refresh, clear, scionId]);
  return { data, error, unsupported, refresh };
}

export function publicResearchUrl(raw: string): string | undefined {
  try { const url = new URL(raw); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : undefined; } catch { return undefined; }
}
