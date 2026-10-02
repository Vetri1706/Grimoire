import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, request, sessionChangedEvent, sessionChangedStorageKey, sessionInvalidatedEvent } from './api';
import type { AgentTask } from './scope-api';

export type TaskMessage = { id: string; body: string; intent: 'note' | 'follow_up'; author_principal_id: string; author_name: string; created_at: string; task_id: string | null };
export type TaskResponse = { task_id: string; agent_id: string | null; agent_name: string | null; status: AgentTask['status']; created_at: string; completed_at: string | null; preparation_note: string | null; proposal_id: string | null; task_kind: AgentTask['task_kind']; provider_run_id: string | null; stale: boolean; blocked: boolean; content_hidden: boolean };
export type TaskConversationState = { thread_task_id: string; current_task_id: string; task_ids: string[]; current_revision: number; messages: TaskMessage[]; responses: TaskResponse[]; follow_up_available: boolean; follow_up_reason: string | null };
export type MessageReceipt = { message: TaskMessage; task_id: string | null; thread_task_id: string };

/** A short authenticated display lease; messages and results never enter browser storage. */
export function useTaskConversation(token: string, scionId: string, taskId: string, revision: number) {
  const [data, setData] = useState<TaskConversationState | null>(null);
  const [error, setError] = useState(''); const [unsupported, setUnsupported] = useState(false);
  const epoch = useRef(0); const pending = useRef<AbortController | null>(null);
  const authEnded = useRef(false);
  const lease = useRef<number | undefined>(undefined);
  const clear = useCallback((reason: string) => { epoch.current++; pending.current?.abort(); pending.current = null; window.clearTimeout(lease.current); setData(null); setError(reason); }, []);
  const refresh = useCallback(async (force = false) => {
    if (authEnded.current || document.visibilityState !== 'visible' || !navigator.onLine || pending.current && !force) return;
    if (force) { epoch.current++; pending.current?.abort(); }
    const controller = new AbortController(); pending.current = controller;
    const generation = epoch.current, started = Date.now();
    const timeout = window.setTimeout(() => controller.abort(), 3500);
    try {
      const next = await request<TaskConversationState>(token, `/scions/${scionId}/agent-tasks/${taskId}/conversation`, { signal: controller.signal, cache: 'no-store' });
      if (generation !== epoch.current) return;
      if (Date.now() - started >= 5000 || document.visibilityState !== 'visible' || !navigator.onLine) { clear('Conversation access must be checked again.'); return; }
      setData(next); setError(''); setUnsupported(false);
      window.clearTimeout(lease.current); lease.current = window.setTimeout(() => clear('Connection lost. Conversation content is hidden until access is checked.'), Math.max(0, started + 5000 - Date.now()));
    } catch (failure) {
      if (generation !== epoch.current) return;
      clear(failure instanceof Error ? failure.message : 'The conversation could not be checked.');
      setUnsupported(failure instanceof ApiError && failure.status === 404);
    } finally { window.clearTimeout(timeout); if (pending.current === controller) pending.current = null; }
  }, [token, scionId, taskId, revision, clear]);
  useEffect(() => {
    clear(''); setUnsupported(false); void refresh(); const timer = window.setInterval(() => void refresh(), 2000);
    const changed = () => { if (document.visibilityState === 'visible' && navigator.onLine) void refresh(true); else clear('Conversation content is hidden until access is checked.'); };
    const invalidated = (event: Event) => { if ((event as CustomEvent<{ scionId: string }>).detail?.scionId === scionId) { clear('The Scion or its sources changed.'); void refresh(true); } };
    const signedOut = (event?: Event) => {
      const endedToken = (event as CustomEvent<{ token?: string }> | undefined)?.detail?.token;
      if (endedToken && endedToken !== token) return;
      authEnded.current = true; clear('Sign-in changed. Reopen the task after signing in.');
    };
    const sessionChanged = (event: StorageEvent) => { if (event.key === sessionChangedStorageKey) signedOut(); };
    document.addEventListener('visibilitychange', changed); window.addEventListener('online', changed); window.addEventListener('offline', changed); window.addEventListener('pagehide', changed); window.addEventListener('pageshow', changed); window.addEventListener('grimoire:case-invalidated', invalidated);
    window.addEventListener(sessionInvalidatedEvent, signedOut); window.addEventListener(sessionChangedEvent, signedOut); window.addEventListener('storage', sessionChanged);
    return () => { epoch.current++; pending.current?.abort(); pending.current = null; window.clearInterval(timer); window.clearTimeout(lease.current); document.removeEventListener('visibilitychange', changed); window.removeEventListener('online', changed); window.removeEventListener('offline', changed); window.removeEventListener('pagehide', changed); window.removeEventListener('pageshow', changed); window.removeEventListener('grimoire:case-invalidated', invalidated); window.removeEventListener(sessionInvalidatedEvent, signedOut); window.removeEventListener(sessionChangedEvent, signedOut); window.removeEventListener('storage', sessionChanged); };
  }, [refresh, clear, scionId]);
  return { data, error, unsupported, refresh };
}
