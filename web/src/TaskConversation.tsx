import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { ApiError, request, sessionChangedStorageKey, sessionInvalidatedEvent } from './api';
import type { Scion } from './api';
import type { AgentTask } from './scope-api';
import type { NativeAgent } from './agents-api';
import AgentAvatar from './AgentAvatar';
import { useResearch } from './research-api';
import { useTaskConversation } from './task-conversation-api';
import type { MessageReceipt, TaskResponse } from './task-conversation-api';
import WorkStateGlyph from './WorkStateGlyph';
import { taskWorkflow } from './task-workflow';
import { useLayoutPreferences } from './LayoutPreferences';
import './task-conversation.css';

type Retry = { body: string; key: string; revision: number; intent: 'note' | 'follow_up'; unknown: boolean };
type Draft = { body: string; intent: 'note' | 'follow_up'; agentId: string; connectionId: string; consent: boolean; retry: Retry | null };
// Drafts are user input, kept only in this tab's memory. A new authentication
// context clears the previous account's drafts; no source/result cache is kept.
let draftScope = '';
const drafts = new Map<string, Draft>();
function scopeDrafts(token: string) { if (draftScope !== token) { drafts.clear(); draftScope = token; } }
// The session may change while the user is on another page, after every chat
// component has unmounted. Invalidate that tab-memory cache in that case too.
function clearDrafts() { drafts.clear(); draftScope = ''; }
if (typeof window !== 'undefined') {
  const invalidated = (event: Event) => { const token = (event as CustomEvent<{ token?: string }>).detail?.token; if (!token || draftScope.endsWith(`:${token}`)) clearDrafts(); };
  const changed = (event: StorageEvent) => { if (event.key === sessionChangedStorageKey) clearDrafts(); };
  window.addEventListener(sessionInvalidatedEvent, invalidated);
  window.addEventListener('storage', changed);
  const hot = (import.meta as ImportMeta & { hot?: { dispose: (callback: () => void) => void } }).hot;
  hot?.dispose(() => { window.removeEventListener(sessionInvalidatedEvent, invalidated); window.removeEventListener('storage', changed); });
}
const when = (value: string) => new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const taskPath = (scionId: string, id: string, kind: AgentTask['task_kind']) => `/scions/${scionId}/${kind === 'research_public_web' ? 'research' : kind === 'prepare_capability_plan' ? 'tasks' : 'agent-work'}/${id}`;

export type TaskConversationProps = {
  token: string; scion: Scion; task: AgentTask; nativeAgents: NativeAgent[]; canPrepare: boolean;
  onNavigate: (path: string) => void; onDirty?: (dirty: boolean) => void; onChanged?: () => unknown | Promise<unknown>;
  intro?: ReactNode; children?: ReactNode; renderResponse?: (response: TaskResponse) => ReactNode;
};

export function TaskConversationEntry({ author, name, agentId, timestamp, children }: { author: 'human' | 'agent' | 'system'; name: string; agentId?: string; timestamp?: string | null; children: ReactNode }) {
  return <article className={`task-thread-entry task-thread-entry-${author}`}>
    {author !== 'system' && <div className="task-thread-author">{author === 'agent' ? <AgentAvatar name={name} id={agentId} size="sm" /> : <span className="task-thread-human-avatar" aria-hidden="true">{name.slice(0, 1).toUpperCase()}</span>}<strong>{name}</strong></div>}
    <div className="task-thread-entry-content">{children}</div>
    {timestamp && <time dateTime={timestamp}>{when(timestamp)}</time>}
  </article>;
}

export default function TaskConversation(props: TaskConversationProps) {
  const { scopeKey } = useLayoutPreferences();
  const authScope = `${scopeKey}:${props.token}`;
  return <ConversationBody key={`${authScope}:${props.scion.id}:${props.task.id}`} {...props} authScope={authScope} />;
}

function ConversationBody({ token, scion, task, nativeAgents, canPrepare, onNavigate, onDirty, onChanged, intro, children, renderResponse, authScope }: TaskConversationProps & { authScope: string }) {
  scopeDrafts(authScope);
  const draftKey = `${scion.id}:${task.id}`;
  const allowsAgent = ['prepare_capability_plan', 'research_public_web'].includes(task.task_kind);
  const [draft, setDraft] = useState<Draft>(() => drafts.get(draftKey) ?? { body: '', intent: allowsAgent ? 'follow_up' : 'note', agentId: task.agent_id ?? '', connectionId: '', consent: false, retry: null });
  const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [notice, setNotice] = useState('');
  const [authEnded, setAuthEnded] = useState(false); const sessionActive = useRef(true);
  const [connectionReady, setConnectionReady] = useState(false);
  const { data, error: readError, unsupported, refresh } = useTaskConversation(token, scion.id, task.id, scion.current_revision);
  const live = useRef(true); const pending = useRef<AbortController | null>(null);
  const dirtyHandler = useRef(onDirty); dirtyHandler.current = onDirty;
  const form = useRef<HTMLFormElement>(null); const editor = useRef<HTMLTextAreaElement>(null);
  const dock = useRef<HTMLDivElement>(null);
  const latest = useRef<HTMLDivElement>(null); const nearLatest = useRef(true);
  const seenVersion = useRef(''); const forceLatest = useRef(false);
  const [jumpVisible, setJumpVisible] = useState(false);
  const dirty = Boolean(draft.body.trim() || draft.retry);
  useEffect(() => {
    if (draftScope !== authScope || !sessionActive.current) return;
    if (dirty) { drafts.delete(draftKey); drafts.set(draftKey, draft); while (drafts.size > 24) drafts.delete(drafts.keys().next().value!); } else drafts.delete(draftKey);
    dirtyHandler.current?.(dirty);
  }, [draft, draftKey, dirty, authScope]);
  useEffect(() => { live.current = true; return () => {
    live.current = false;
    const cached = drafts.get(draftKey);
    if (pending.current && draftScope === authScope && cached?.retry) cached.retry.unknown = true;
    pending.current?.abort(); dirtyHandler.current?.(false);
  }; }, []);
  useEffect(() => {
    const element = dock.current; const main = element?.closest<HTMLElement>('#main-content');
    if (!element || !main) return;
    const resize = () => main.style.setProperty('--task-chat-dock-height', `${Math.ceil(element.getBoundingClientRect().height) + 24}px`);
    const observer = new ResizeObserver(resize); observer.observe(element); resize();
    return () => { observer.disconnect(); main.style.removeProperty('--task-chat-dock-height'); };
  }, []);
  useEffect(() => {
    const ended = (event?: Event) => {
      const endedToken = (event as CustomEvent<{ token?: string }> | undefined)?.detail?.token;
      if (endedToken && endedToken !== token) return;
      sessionActive.current = false; setAuthEnded(true); clearDrafts(); pending.current?.abort(); setDraft(old => ({ ...old, body: '', retry: null, consent: false })); dirtyHandler.current?.(false);
    };
    const changed = (event: StorageEvent) => { if (event.key === sessionChangedStorageKey) ended(); };
    window.addEventListener(sessionInvalidatedEvent, ended); window.addEventListener('storage', changed);
    return () => { window.removeEventListener(sessionInvalidatedEvent, ended); window.removeEventListener('storage', changed); };
  }, []);
  const update = (patch: Partial<Draft>) => setDraft(old => ({ ...old, ...patch }));
  const research = task.task_kind === 'research_public_web' && draft.intent === 'follow_up';
  const readyChanged = useCallback((ready: boolean) => setConnectionReady(ready), []);
  const locked = busy || Boolean(draft.retry) || authEnded;
  const permitted = Boolean(data && canPrepare && (draft.intent === 'note' || data.follow_up_available && (!research || draft.consent && connectionReady)));
  const composerAgent = nativeAgents.find(agent => agent.id === (draft.agentId || task.agent_id));
  const composerAgentName = composerAgent?.config.name || 'your agent';
  const sendLabel = busy ? 'Sending…' : draft.retry ? 'Retry message' : draft.intent === 'note' ? 'Add note' : 'Send message';
  useLayoutEffect(() => {
    const input = editor.current;
    if (!input) return;
    input.style.height = '0px';
    input.style.height = `${Math.min(180, Math.max(60, input.scrollHeight))}px`;
  }, [draft.body]);
  const responses = data?.responses ?? [];
  const items = [
    ...(data?.messages ?? []).map(message => ({ id: message.id, timestamp: message.created_at, message, response: null })),
    ...responses.map(response => ({ id: response.task_id, timestamp: response.completed_at ?? response.created_at, message: null, response })),
  ].sort((left, right) => Date.parse(left.timestamp) - Date.parse(right.timestamp) || left.id.localeCompare(right.id));
  // Immutable record IDs and meaningful response changes drive scrolling. A
  // fresh 2-second access check alone must never move the reader's viewport.
  const recordVersion = data ? items.map(item => item.message ? `m:${item.id}` : `r:${item.id}:${item.response?.status}:${item.response?.stale}:${item.response?.blocked}:${item.response?.content_hidden}`).join('|') : '';
  const showLatest = useCallback(() => {
    latest.current?.scrollIntoView({ block: 'end', behavior: 'auto' });
    nearLatest.current = true; setJumpVisible(false);
  }, []);
  useEffect(() => {
    const main = dock.current?.closest<HTMLElement>('#main-content');
    if (!main) return;
    const moved = () => {
      if (!latest.current || !dock.current) return;
      const point = latest.current.getBoundingClientRect(); const viewport = main.getBoundingClientRect();
      const visibleBottom = Math.min(viewport.bottom, dock.current.getBoundingClientRect().top);
      nearLatest.current = point.bottom >= viewport.top && point.bottom - visibleBottom <= 160;
      if (seenVersion.current) setJumpVisible(!nearLatest.current);
    };
    let resizeFrame = 0;
    const resized = () => { window.cancelAnimationFrame(resizeFrame); if (nearLatest.current) resizeFrame = window.requestAnimationFrame(showLatest); else moved(); };
    main.addEventListener('scroll', moved, { passive: true });
    window.addEventListener('resize', resized);
    return () => { main.removeEventListener('scroll', moved); window.removeEventListener('resize', resized); window.cancelAnimationFrame(resizeFrame); };
  }, [showLatest]);
  useLayoutEffect(() => {
    if (!recordVersion || recordVersion === seenVersion.current) return;
    const scroll = !seenVersion.current || nearLatest.current || forceLatest.current;
    seenVersion.current = recordVersion; forceLatest.current = false;
    if (!scroll) { setJumpVisible(true); return; }
    const frame = window.requestAnimationFrame(showLatest);
    return () => window.cancelAnimationFrame(frame);
  }, [recordVersion, showLatest]);

  async function send(event: FormEvent) {
    event.preventDefault(); if (busy || !sessionActive.current || !data || !canPrepare || !draft.body.trim() || !draft.retry && !permitted) return;
    const retry = draft.retry ?? { body: JSON.stringify({ body: draft.body.trim(), intent: draft.intent, ...(draft.intent === 'follow_up' ? { ...(draft.agentId ? { agent_id: draft.agentId } : {}), ...(research ? { worker_connection_id: draft.connectionId, public_web_consent: true } : {}) } : {}) }), key: crypto.randomUUID(), revision: data.current_revision, intent: draft.intent, unknown: false };
    drafts.set(draftKey, { ...draft, retry });
    update({ retry }); setBusy(true); setError(''); setNotice('');
    const controller = new AbortController(); pending.current = controller; const deadline = window.setTimeout(() => controller.abort(), 12000);
    try {
      const receipt = await request<MessageReceipt>(token, `/scions/${scion.id}/agent-tasks/${task.id}/messages`, { method: 'POST', body: retry.body, signal: controller.signal, headers: { 'If-Match': `"${retry.revision}"`, 'Idempotency-Key': retry.key } });
      if (!receipt.message?.id || !receipt.thread_task_id) throw new Error('The server response did not contain a saved message receipt.');
      if (!live.current || !sessionActive.current) { if (draftScope === authScope) drafts.delete(draftKey); return; }
      update({ body: '', retry: null, consent: false }); drafts.delete(draftKey); dirtyHandler.current?.(false);
      forceLatest.current = true;
      setNotice(receipt.task_id ? 'Message saved. Follow-up work is dispatched.' : 'Note saved to this task.');
      await Promise.allSettled([refresh(true), Promise.resolve().then(() => onChanged?.())]);
      if (!live.current || !sessionActive.current) return;
      if (receipt.task_id && retry.intent === 'follow_up') onNavigate(taskPath(scion.id, receipt.task_id, task.task_kind));
      else editor.current?.focus();
    } catch (failure) {
      if (!live.current || !sessionActive.current) return;
      const rejected = failure instanceof ApiError && failure.status >= 400 && failure.status < 500 && ![408, 429].includes(failure.status);
      if (rejected && !retry.unknown) update({ retry: null });
      else { retry.unknown = true; update({ retry }); }
      setError(`${failure instanceof Error ? failure.message : 'The message could not be sent.'}${rejected && !retry.unknown ? ' Your draft is preserved.' : ' Retry this same request to recover its receipt without creating duplicate work.'}`);
    } finally { window.clearTimeout(deadline); if (pending.current === controller) pending.current = null; if (live.current) setBusy(false); }
  }

  return <section className="task-conversation" aria-label="Task conversation">
    <div className="task-thread-flow">
      {!authEnded && intro && <div className="task-thread-intro">{intro}</div>}
      {(readError || unsupported) && <div className="task-thread-access" role="status"><p>{unsupported ? 'This task conversation is not available from the running API.' : readError}</p><button type="button" className="text-button" onClick={() => void refresh(true)}>Check conversation again</button></div>}
      {!data && !readError && <p role="status">Loading conversation…</p>}
      {data && <div className="task-thread-records" aria-label="Recorded task conversation">{items.map(item => item.message ? <TaskConversationEntry key={`message:${item.id}`} author="human" name={item.message.author_name || 'Handler'} timestamp={item.timestamp}>
        <p className="task-thread-message">{item.message.body}</p><span className="task-thread-message-kind">{item.message.intent === 'follow_up' ? 'Follow-up request' : 'Task note'}</span>
      </TaskConversationEntry> : item.response && <ResponseEntry key={`response:${item.id}`} response={item.response} nativeAgents={nativeAgents} onOpen={() => onNavigate(taskPath(scion.id, item.response!.task_id, item.response!.task_kind))}>{renderResponse?.(item.response)}</ResponseEntry>)}</div>}
      {data && items.length === 0 && <p className="task-thread-empty">No messages have been recorded. Start the conversation below.</p>}
      <div ref={latest} className="task-thread-latest" aria-hidden="true" />
      {!authEnded && children && <div className="task-thread-actions">{children}</div>}
    </div>
    <div ref={dock} className="task-chat-dock">
      {jumpVisible && data && <button type="button" className="task-chat-jump button secondary" onClick={showLatest}>Jump to latest <span aria-hidden="true">↓</span></button>}
      {error && <p className="task-chat-error" role="alert">{error}</p>}{notice && <p className="task-chat-notice" role="status">{notice}</p>}
      <form ref={form} className="task-chat-composer" aria-label="Message task" onSubmit={send}>
        <label className="task-chat-sr-only" htmlFor={`task-message-${task.id}`}>{research ? 'Public follow-up brief' : 'Message'}</label>
        <textarea ref={editor} id={`task-message-${task.id}`} aria-describedby={`task-message-help-${task.id}`} value={draft.body} maxLength={4000} rows={2} disabled={locked || !canPrepare} onChange={event => update({ body: event.target.value })} placeholder={draft.intent === 'note' ? 'Add a note to this task…' : research ? `Message ${composerAgentName} — what should we research next? Public information only…` : `Message ${composerAgentName} — describe what you want done…`} onKeyDown={event => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.nativeEvent.isComposing) { event.preventDefault(); form.current?.requestSubmit(); } }} />
        {research && <ResearchConsent token={token} scion={scion} connectionId={draft.connectionId} consent={draft.consent} disabled={locked} onConnection={value => update({ connectionId: value, consent: false })} onConsent={value => update({ consent: value })} onReady={readyChanged} />}
        <div className="task-chat-composer-actions">
          <div className="task-chat-options">
            <button type="button" className="task-chat-add" aria-label="Manage task evidence" title="Add or manage Scion evidence" disabled={busy || authEnded || !canPrepare} onClick={() => onNavigate(`/scions/${scion.id}/sources`)}><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg></button>
            <select className="task-chat-mode" aria-label="Message action" title="Ask agent starts follow-up work. Add note saves without starting work." value={draft.intent} disabled={locked || !canPrepare} onChange={event => update({ intent: event.target.value as Draft['intent'], consent: false })}><option value="note">Add note</option>{allowsAgent && <option value="follow_up">Ask agent</option>}</select>
          </div>
          <div className="task-chat-recipient">
            {draft.intent === 'follow_up' && <label className="task-chat-agent"><span className="task-chat-sr-only">Agent</span><AgentAvatar id={composerAgent?.id || task.agent_id || undefined} name={composerAgentName} size="sm" /><select aria-label="Agent" title={composerAgentName} value={draft.agentId} disabled={locked || !canPrepare} onChange={event => update({ agentId: event.target.value })}><option value="">{nativeAgents.find(agent => agent.id === task.agent_id)?.config.name || 'Current task agent'}</option>{nativeAgents.filter(agent => !agent.config.paused || agent.id === draft.agentId).map(agent => <option key={agent.id} value={agent.id}>{agent.config.name}{agent.config.paused ? ' (paused)' : ''}</option>)}</select></label>}
            <button type="submit" className="task-chat-send" aria-label={sendLabel} title={`${sendLabel} (Ctrl / ⌘ Enter)`} disabled={busy || !draft.body.trim() || !data || !canPrepare || !draft.retry && !permitted}>{busy ? <span aria-hidden="true">…</span> : <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 19V5m-6 6 6-6 6 6" /></svg>}</button>
          </div>
        </div>
        <p className="task-chat-sr-only" id={`task-message-help-${task.id}`}>{draft.intent === 'follow_up' ? 'Creates a linked task from the current brief and your message. Human review stays separate.' : 'A note records your message without starting agent work.'} Press Ctrl or Command and Enter to send.</p>
        {draft.intent === 'follow_up' && data && !data.follow_up_available && <p className="task-chat-blocker">{data.follow_up_reason || 'Follow-up work is not available yet. You can add a note.'}</p>}
      </form>
    </div>
  </section>;
}

function ResponseEntry({ response, nativeAgents, onOpen, children }: { response: TaskResponse; nativeAgents: NativeAgent[]; onOpen: () => void; children?: ReactNode }) {
  const name = response.agent_name || nativeAgents.find(agent => agent.id === response.agent_id)?.config.name || 'Codex worker';
  const workflow = taskWorkflow({ status: response.status, stale: response.stale, blocked: response.blocked });
  const completed = response.status === 'completed';
  return <TaskConversationEntry author={completed ? 'agent' : 'system'} name={name} agentId={response.agent_id ?? undefined} timestamp={response.completed_at ?? response.created_at}>
    {completed ? <>{response.content_hidden ? <p className="task-thread-withheld">This result is hidden because its inputs are stale, blocked, or unavailable.</p> : <>{response.preparation_note && <p className="task-thread-message">{response.preparation_note}</p>}{children}{!children && response.proposal_id && <button type="button" className="task-thread-deliverable" onClick={onOpen}><span>Prepared result</span><span>Open task →</span></button>}</>}<span className="task-thread-result-boundary">Agent preparation · human review is separate</span></> : <div className="task-thread-system-event"><WorkStateGlyph state={workflow.state} /><span>{name} · {workflow.label}</span><button type="button" className="text-button" onClick={onOpen}>Open task</button></div>}
  </TaskConversationEntry>;
}

function ResearchConsent({ token, scion, connectionId, consent, disabled, onConnection, onConsent, onReady }: { token: string; scion: Scion; connectionId: string; consent: boolean; disabled: boolean; onConnection: (id: string) => void; onConsent: (checked: boolean) => void; onReady: (ready: boolean) => void }) {
  const { data } = useResearch(token, scion.id, scion.current_revision);
  const connections = data?.worker_connections.filter(connection => connection.status === 'connected' && connection.research_capable) ?? [];
  const ready = connections.some(connection => connection.connection_id === connectionId);
  useEffect(() => { onReady(ready); return () => onReady(false); }, [ready, onReady]);
  return <div className="task-chat-research"><label>Research computer<select aria-label="Research computer" value={connectionId} disabled={disabled} onChange={event => onConnection(event.target.value)}><option value="">Choose a connected computer</option>{connections.map(connection => <option key={connection.connection_id} value={connection.connection_id}>{connection.device_name}</option>)}</select></label><label className="task-chat-consent"><input type="checkbox" checked={consent} disabled={disabled} onChange={event => onConsent(event.target.checked)} /><span>Send this public brief to my Codex account and retrieve public pages. My private Scion brief and uploaded sources are not included.</span></label>{data && !connections.length && <p>No authorized research computer is currently connected.</p>}</div>;
}
