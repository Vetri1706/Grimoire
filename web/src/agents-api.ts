import { useCallback, useEffect, useRef, useState } from 'react';
import { request } from './api';

export type AgentConfig = { name: string; role: string; title: string; capabilities: string; instructions: string; reports_to: string | null; adapter: 'codex_cli'; timeout_seconds: number; skill_ids: string[]; paused: boolean };
export type SkillConfig = { name: string; description: string; instructions: string };
export type ManagedRecord<Config> = { id: string; kind: string; revision: number; config: Config; status: string; created_at: string; updated_at: string };
export type NativeAgent = ManagedRecord<AgentConfig>;
export type NativeSkill = ManagedRecord<SkillConfig>;
export type AgentRuntime = { backend: 'grimoire'; status: 'connected' | 'disconnected'; last_seen: string | null; adapter: 'codex_cli'; protocol: number; concurrency: number; costs_available: false };
export type NativeTask = { id: string; scion_id: string; scion_revision: number; task_kind: string; status: string; created_at: string; claimed_at: string | null; completed_at: string | null; timeout_seconds: number; proposal_id: string | null; failure_code: string | null; provider_run_id: string | null; output_sha256: string | null; agent_revision: number; stale: boolean; blocked: boolean };
export type AgentDetail = { agent: NativeAgent; tasks: NativeTask[]; runtime: AgentRuntime; revisions: { revision: number; config: AgentConfig; created_at: string; created_by: string }[]; events: { id: string; task_id: string; status: string; recorded_at: string; attempt: number }[] };

export function useAgent(token: string, id?: string) {
  const [data, setData] = useState<AgentDetail | null>(null);
  const [error, setError] = useState('');
  const epoch = useRef(0);
  const pending = useRef<AbortController | null>(null);
  const lease = useRef<number | undefined>(undefined);
  const clear = useCallback((message: string) => { epoch.current++; pending.current?.abort(); pending.current = null; clearTimeout(lease.current); setData(null); setError(message); }, []);
  const refresh = useCallback(async () => {
    if (!id || pending.current || document.visibilityState !== 'visible' || !navigator.onLine) return;
    const controller = new AbortController(); pending.current = controller;
    const generation = epoch.current; const started = Date.now();
    const deadline = window.setTimeout(() => controller.abort(), 3000);
    try {
      const value = await request<AgentDetail>(token, `/agents/${id}`, { cache: 'no-store', signal: controller.signal });
      if (generation !== epoch.current) return;
      if (value.agent.id !== id || Date.now() - started >= 5000) { clear('Agent access must be checked again.'); return; }
      setData(value); setError(''); clearTimeout(lease.current);
      lease.current = window.setTimeout(() => clear('Agent connection is overdue. Reconnecting…'), Math.max(0, started + 5000 - Date.now()));
    } catch (failure) { if (generation === epoch.current) clear(failure instanceof Error ? failure.message : 'Agent disconnected.'); }
    finally { clearTimeout(deadline); if (pending.current === controller) pending.current = null; }
  }, [token, id, clear]);
  useEffect(() => {
    clear(''); void refresh(); const timer = window.setInterval(() => void refresh(), 2000);
    const visibility = () => { if (document.visibilityState === 'visible') void refresh(); else clear('Agent content hidden until access is rechecked.'); };
    const offline = () => clear('Agent disconnected.'); const resume = () => void refresh();
    document.addEventListener('visibilitychange', visibility); window.addEventListener('offline', offline); window.addEventListener('online', resume); window.addEventListener('focus', resume);
    return () => { clear(''); clearInterval(timer); document.removeEventListener('visibilitychange', visibility); window.removeEventListener('offline', offline); window.removeEventListener('online', resume); window.removeEventListener('focus', resume); };
  }, [refresh, clear]);
  return { data: data?.agent.id === id ? data : null, error, refresh };
}
