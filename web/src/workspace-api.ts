import type { AgentRuntime, NativeAgent, NativeSkill } from './agents-api';
import { useCallback, useEffect, useRef, useState } from 'react';
import { request } from './api';
import type { Scion } from './api';
import type { DataConnector } from './adaptive-api';
import type { ControlSurfaceState } from './control-api';

export type ProposalSummary = { id: string; scion_id: string; scion_revision: number; kind: 'capability_proposal' | 'comparison' | 'scope' | 'offers' | 'research'; title: string; status: string; created_at: string; agent_task_id?: string };
export type WorkspaceState = {
  org_id: string; generated_at: string; scions: Scion[]; proposals: ProposalSummary[]; collection_limit: number;
  tasks: (ControlSurfaceState['operations']['tasks'][number] & { scion_id: string; agent_id: string | null; agent_revision: number | null; review_recorded: boolean })[];
  reviews: (ControlSurfaceState['operations']['human_review'][number] & { scion_id: string })[];
  events: (ControlSurfaceState['operations']['events'][number] & { scion_id: string })[];
  watches: (Omit<ControlSurfaceState['watchtower']['watches'][number], 'label'> & { scion_id: string })[];
  agents: NativeAgent[]; skills: NativeSkill[]; agent_runtime: AgentRuntime;
  connectors: DataConnector[];
};

export function proposalPath(proposal: ProposalSummary) {
  const view = proposal.kind === 'capability_proposal' ? 'proposals' : proposal.kind === 'comparison' ? 'comparisons' : proposal.kind;
  return `/scions/${proposal.scion_id}/${view}/${proposal.kind === 'research' ? proposal.agent_task_id ?? proposal.id : proposal.id}`;
}

export function useWorkspace(token: string, orgId: string | undefined) {
  const [data, setData] = useState<WorkspaceState | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const pending = useRef<AbortController | null>(null);
  const epoch = useRef(0);
  const lease = useRef<number | undefined>(undefined);
  const clear = useCallback((reason: string) => {
    epoch.current++; pending.current?.abort(); pending.current = null;
    window.clearTimeout(lease.current); setData(null); setError(reason); setLoading(false);
  }, []);
  const refresh = useCallback(async () => {
    if (!token || !orgId || document.visibilityState !== 'visible' || !navigator.onLine || pending.current) return;
    const generation = epoch.current; const started = Date.now();
    const controller = new AbortController(); pending.current = controller;
    const timeout = window.setTimeout(() => controller.abort(), 3500);
    try {
      const value = await request<WorkspaceState>(token, '/workspace', { signal: controller.signal, cache: 'no-store' });
      if (generation !== epoch.current) return;
      if (value.org_id !== orgId || Date.now() >= started + 5000 || document.visibilityState !== 'visible' || !navigator.onLine) { clear('Workspace access must be checked again.'); return; }
      setData(value); setError(''); setLoading(false); window.clearTimeout(lease.current);
      lease.current = window.setTimeout(() => clear('Workspace refresh is overdue. Records are hidden until access is rechecked.'), Math.max(0, started + 5000 - Date.now()));
    } catch (failure) {
      if (generation === epoch.current) clear(failure instanceof Error ? failure.message : 'Workspace disconnected.');
    } finally {
      window.clearTimeout(timeout); if (pending.current === controller) pending.current = null;
    }
  }, [token, orgId, clear]);
  useEffect(() => {
    setData(null); setLoading(true); setError(''); void refresh();
    const interval = window.setInterval(() => void refresh(), 2000);
    const visible = () => { if (document.visibilityState === 'visible') void refresh(); else clear('Workspace paused while this tab is hidden.'); };
    const offline = () => clear('Workspace disconnected. Reconnect to check current records.');
    const resume = () => void refresh();
    document.addEventListener('visibilitychange', visible); window.addEventListener('offline', offline); window.addEventListener('online', resume); window.addEventListener('focus', resume); window.addEventListener('pagehide', offline); window.addEventListener('pageshow', resume);
    return () => {
      epoch.current++; pending.current?.abort(); pending.current = null; window.clearInterval(interval); window.clearTimeout(lease.current);
      document.removeEventListener('visibilitychange', visible); window.removeEventListener('offline', offline); window.removeEventListener('online', resume); window.removeEventListener('focus', resume); window.removeEventListener('pagehide', offline); window.removeEventListener('pageshow', resume);
    };
  }, [refresh, clear]);
  return { data: data?.org_id === orgId ? data : null, error, loading, refresh };
}
