import type { AgentRuntime } from './agents-api';
import { useCallback, useEffect, useRef, useState } from 'react';
import { request } from './api';
import { demoRequest } from './demo-api';
import type { DemoSlug } from './demo-api';

export type CaseNode = {
  id: string;
  kind: 'scion' | 'capability_proposal' | 'agent_task' | 'evidence_source' | 'data_connector' | 'comparison' | 'human_review';
  title: string; status: string; stale: boolean;
  provenance: Record<string, unknown>; blockers: string[];
  safe_next_action: { kind: string; label: string; enabled: boolean };
  details: Record<string, unknown> | null;
};
export type ReviewTask = { id: string; event_id: string; status: string; reason: string; created_at: string };
export type ControlSurfaceState = {
  synthetic?: boolean; read_only?: boolean;
  scion_id: string; scion_revision: number; generated_at: string;
  nodes: CaseNode[]; edges: { id: string; source: string; target: string; kind: string }[];
  watchtower: {
    health: string; last_successful_check: string | null; mode: string; poll_interval_ms: number;
    watches: { id: string; kind: string; label: string; status: string; last_successful_check: string | null; last_event_at: string | null }[];
    alerts: ReviewTask[];
  };
  operations: {
    tasks: { id: string; task_kind: string; status: string; scion_revision: number; created_at: string; completed_at: string | null; failure_code: string | null; proposal_id: string | null; stale: boolean; blocked: boolean }[];
    human_review: ReviewTask[];
    events: { id: string; event_key: string; kind: string; subject_id: string; recorded_at: string; summary: string }[];
    agent_runtime: AgentRuntime;
  };
  approval_available: boolean;
};

export const caseInvalidatedEvent = 'grimoire:case-invalidated';
export function useCaseInvalidation(scionId: string, clear: (reason: string) => void) {
  useEffect(() => {
    const changed = (event: Event) => {
      if ((event as CustomEvent<{ scionId: string }>).detail?.scionId === scionId) clear('The case revision or source access changed. Content and unsaved evidence forms are hidden until rechecked.');
    };
    window.addEventListener(caseInvalidatedEvent, changed);
    return () => window.removeEventListener(caseInvalidatedEvent, changed);
  }, [scionId, clear]);
}
const LEASE_MS = 5000;
const POLL_MS = 2000;

// Polling observes the persisted server monitor. It never performs or simulates a watch check.
// A short display lease bounds how long a formerly authorized projection can remain visible.
export function useControlSurface(token: string, scionId: string, demoSlug?: DemoSlug) {
  const [data, setData] = useState<ControlSurfaceState | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [receivedAt, setReceivedAt] = useState<string | null>(null);
  const epoch = useRef(0);
  const pending = useRef<AbortController | null>(null);
  const lease = useRef<number | undefined>(undefined);
  const fingerprint = useRef<string | null>(null);
  const invalidate = useCallback(() => {
    window.dispatchEvent(new CustomEvent(caseInvalidatedEvent, { detail: { scionId } }));
  }, [scionId]);
  const clear = useCallback((reason: string) => {
    epoch.current++; pending.current?.abort(); pending.current = null;
    window.clearTimeout(lease.current);
    setData(null); setLoading(false); setError(reason); invalidate();
  }, [invalidate]);
  const refresh = useCallback(async () => {
    if (document.visibilityState !== 'visible' || !navigator.onLine || pending.current) return;
    const sequence = epoch.current;
    const started = Date.now();
    const controller = new AbortController(); pending.current = controller;
    const timeout = window.setTimeout(() => controller.abort(), 2500);
    try {
      const result = demoSlug
        ? await demoRequest<ControlSurfaceState>(`/demo/${demoSlug}`, controller.signal)
        : await request<ControlSurfaceState>(token, `/scions/${encodeURIComponent(scionId)}/control-surface`, { signal: controller.signal, cache: 'no-store' });
      if (sequence !== epoch.current) return;
      if (demoSlug && (result.synthetic !== true || result.read_only !== true)) throw new Error('The public synthetic case could not be verified.');
      if (result.scion_id !== scionId || !Array.isArray(result.nodes) || !Array.isArray(result.edges)) throw new Error('The case projection could not be verified.');
      if (document.visibilityState !== 'visible' || !navigator.onLine || Date.now() >= started + LEASE_MS) { clear('Access check expired. Case content has been cleared.'); return; }
      const nextFingerprint = JSON.stringify([result.scion_revision, result.nodes.filter(node => node.kind === 'evidence_source').map(node => [node.id, node.status, node.stale, node.provenance])]);
      if (fingerprint.current !== null && fingerprint.current !== nextFingerprint) invalidate();
      fingerprint.current = nextFingerprint;
      setData(result); setError(''); setLoading(false); setReceivedAt(new Date().toISOString());
      window.clearTimeout(lease.current);
      lease.current = window.setTimeout(() => clear(`The ${demoSlug ? 'demo snapshot' : 'authenticated'} refresh is overdue. Case content is hidden until access is rechecked.`), Math.max(0, started + LEASE_MS - Date.now()));
    } catch (failure) {
      if (sequence === epoch.current) clear(failure instanceof Error ? failure.message : 'The control surface is disconnected. Case content has been cleared.');
    } finally {
      window.clearTimeout(timeout);
      if (pending.current === controller) pending.current = null;
    }
  }, [token, scionId, demoSlug, clear, invalidate]);
  useEffect(() => {
    fingerprint.current = null; setLoading(true); setData(null); setReceivedAt(null);
    void refresh();
    const interval = window.setInterval(() => void refresh(), POLL_MS);
    const visibility = () => { if (document.visibilityState === 'visible') void refresh(); else clear('This tab is hidden. Case content has been cleared; server monitoring is independent of this page.'); };
    const offline = () => clear('Disconnected. Case content has been cleared until a fresh server snapshot is available.');
    const focus = () => void refresh();
    document.addEventListener('visibilitychange', visibility);
    window.addEventListener('focus', focus); window.addEventListener('online', focus); window.addEventListener('offline', offline); window.addEventListener('pagehide', offline); window.addEventListener('pageshow', focus);
    return () => {
      epoch.current++; pending.current?.abort(); pending.current = null;
      window.clearInterval(interval); window.clearTimeout(lease.current);
      document.removeEventListener('visibilitychange', visibility);
      window.removeEventListener('focus', focus); window.removeEventListener('online', focus); window.removeEventListener('offline', offline); window.removeEventListener('pagehide', offline); window.removeEventListener('pageshow', focus);
    };
  }, [refresh, clear]);
  return { data, error, loading, receivedAt, refresh };
}

export type ControlSurfaceConnection = ReturnType<typeof useControlSurface>;
