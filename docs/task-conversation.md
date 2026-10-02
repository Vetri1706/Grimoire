# Task conversations

A task conversation contains saved Handler messages and responses from actual native task runs. **Add note** records a message without running an agent. Selecting **Ask agent** and **Send message** records the message and dispatches one new task atomically. A note, a queued task, a heartbeat and a completed provider run remain distinct states.

Follow-up execution supports digital capability planning and public web research. Physical workflow tasks accept notes and retain their existing preparation/review controls. The same organization authorization, immutable agent configuration binding, task queue, signed lease, timeout, cancellation, proposals/reports and human review rules apply. Chat never grants approval or silently writes requirements, canonical facts or procurement decisions.

## What reaches the agent

- Planning receives the current server-pinned Scion candidate and the exact Handler follow-up message. It may also receive the immediately preceding completed capability plan and its preparation note, only when they belong to the same current revision and remain authorized. This previous-result context is limited to 24,000 UTF-8 bytes; larger context is omitted explicitly.
- Public research requires fresh public-brief consent and an exact selected computer on every follow-up. The message becomes the complete public research objective. Private thread history and previous report text are not added to it.
- The worker uses a fresh ephemeral Codex execution. This is not a resumed CLI session or unbounded conversational memory. Messages written while a task is active can be saved as notes; they do not steer a running model. Follow-up dispatch is unavailable until the current thread task finishes or is cancelled.
- The displayed agent reply is the actual persisted `preparation_note` plus a link to its native deliverable. It is attributed to that task's pinned agent and provider-run metadata. No canned assistant reply, raw reasoning transcript or second copy of source-derived output is stored in the message table.

Update/restart the user's idle local worker after updating the checkout. It must advertise `X-Grimoire-Task-Messages: 1` as well as native worker protocol 2. Older workers can continue ordinary supported jobs but cannot claim message-bound tasks. Research also requires its independent public-web capability header and explicit task consent. The normal Windows wrapper remains:

```powershell
pwsh -File scripts/byoa.ps1 -Mode Stop -Connection YOUR_CONNECTION_UUID
pwsh -File scripts/byoa.ps1 -Mode Start -Connection YOUR_CONNECTION_UUID
```

The stop operation refuses to interrupt an active child task. No provider login or credential is sent through the conversation.

## Persistence and API

Migration `0055_task_conversations.sql` adds append-only `intake_task_messages` and immutable `intake_task_followups`. They hold conversation metadata and links, not a parallel task state machine. Follow-up links record the canonical root task, the actual preceding task, the triggering Handler message and the new native task. They do not claim subagent execution or task decomposition. Additive migration `0056_task_conversation_dependencies.sql` makes withdrawn thread evidence block dependent artifact insertion and propagates that state to the existing Watchtower task/proposal projection used by global deliverable and review views.

- `GET /api/scions/:scion/agent-tasks/:task/conversation` resolves any linked task to its canonical thread. It returns ordered messages, actual task response metadata, current revision, task IDs and follow-up availability.
- `POST /api/scions/:scion/agent-tasks/:task/messages` accepts `body`, `intent` (`note` or `follow_up`) and optional `agent_id`, `worker_connection_id`, `public_web_consent`. It requires the current revision through `If-Match` and an `Idempotency-Key`. Notes cannot carry execution permissions.
- A new message returns HTTP201; an exact retry returns HTTP200 with the same message/task IDs. Reusing the key with different content conflicts. Agent task creation, assignment, follow-up linking and dispatch happen in the message transaction, so a lost response does not require another dispatch request.
- Messages are bounded to 4,000 characters and threads to 200 messages. The client should preserve a draft until it receives or recovers the exact persisted receipt.

The server hides source-derived reply text and deliverable IDs when the task is stale or the thread has blocked evidence. Conversation reads, worker context reads and artifact insertion use source/capture row locks to serialize against withdrawal. Withdrawal of evidence used by a thread prevents further dependent follow-up work and hides existing dependent outputs through their native state. Handler-authored messages remain distinguishable from agent-derived content. Required factual corrections and answers still use the existing revision API, preserving stale-dependency behavior. Human review stays separate from agent completion and conversation messages.

Apply 0055 and 0056 additively through the existing migration runner, preserving their exact ledger SHA-256 and startup catalog. Do not edit an applied migration. Back up the primary database before upgrading it.

## Verification

The increment passed 50 Rust tests with incremental compilation disabled, clean Windows migration/catalog generation (3,780 entries), and restricted-runtime SQL probes in `api/tests/task_conversation_guards.sql` and `api/tests/research_guards.sql`. The probes cover append-only Handler messages, notes creating no work, exclusion of active-task follow-ups, exact native links, older-worker rejection and foreign-organization isolation. A source-withdrawal regression creates two native research follow-ups, withdraws their parent's receipt, verifies existing report visibility is blocked, and rejects the still-running follow-up's report insertion. All SQL fixtures roll back and invoke no model.

A separate HTTP protocol preflight passed planning rejection of public-research consent with transaction rollback, exact message retry to one dispatched task, changed-input idempotency conflict, legacy worker direct-claim denial, current prior-plan context, canonical thread resolution and actual stored preparation-note projection. Evidence: `.local/task-conversation-preflight-result.json`. Its previous plan is explicitly labelled as a protocol fixture, with no model/provider execution claimed. A research conversation preflight also passed missing-consent rollback, exact computer selection, per-message public-brief binding and exclusion of previous result/private description from the claim. Evidence: `.local/research-conversation-preflight-result.json`; zero model runs.

The browser journey in `web/tests/task-conversation.mjs` completed exactly one actual Codex follow-up. Its response and typed capability reflected the Handler's instruction; a saved note created no task, a lost response retry created one child, and an older worker was denied. Proper foreign-organization requests were denied. Source withdrawal hid the actual response and deliverable references in the open thread and after reload. Evidence: `.local/task-conversation/1790912991459/results.json`. An outsider fixture initially lacked an active organization; that assertion was corrected and the same actual result was checked through a temporary fixture session, revoked afterward, without another model run. Worker tests passed 47/47. These results establish the bounded fresh-run workflow described above, not unlimited chat memory or procurement approval.

Frontend validation passed 26 unit tests, a production build, and seven real-stack browser checks in `web/tests/task-conversation-ui.mjs`. Those checks cover drafts, keyboard input, failed access checks, session isolation, latest-message scrolling, and desktop/mobile layouts without invoking a model. Six native record sets from the live journey retained identical row counts and content fingerprints across the final API restart. The local primary upgrade then backed up `grimoire_dev`, preserved all 112 existing tables' contents and the historical migration ledger, and passed startup attestation and API/object-storage health checks. No external deployment was performed.
