# Company workspace

Grimoire now uses a company-first information architecture, informed by the
adjacent Paperclip sidebar, breadcrumbs and design source. It is not a second
Paperclip scheduler or a simulated agent conversation.

## Navigation

| Level | Surface | Purpose |
| --- | --- | --- |
| Company | Dashboard | Attention queue, actual counts, health and recent Scions |
| Company | Inbox | Missing Handler decisions and persisted watch review obligations |
| Work | Proposals | Searchable, filtered capability, comparison and physical proposal metadata |
| Work | Scions | Compact product-decision records |
| Work | Agent work | Existing Rust active, blocked and completed tasks |
| Work | Watchtower | Persisted internal watches and last successful server checks |
| Organization | Agents / Skills | Native revisioned agent profiles, instructions, skills and task controls |
| Organization | Connectors | Actual data paths; unsupported external monitoring is unavailable |
| Organization | Activity | Content-free internal audit events |
| Scion | Overview | Brief, Handler decision, latest capability proposal, evidence and properties |
| Scion | Proposals | One selected proposal, expandable capabilities and provenance |
| Scion | Evidence / Agent work / Activity | Separate focused workflows |
| Scion | More | Comparison, graph, full brief and revisions; physical actions only when applicable |

Use `#/scions/{id}/proposals/{proposalId}` or
`#/scions/{id}/comparisons/{comparisonId}` for a focused record. Browser history
and unsaved-edit guards remain active. The company sidebar stays available
while working inside a Scion. Digital Scions do not show physical scope or
supplier-offer actions; physical records retain their exact-identity workflow.

## Read model and safeguards

`GET /api/workspace` authenticates before querying. All database reads use the
existing organization-scoped transaction and RLS. It projects current Scions,
generic proposal metadata, existing Rust tasks, immutable watch review
obligations and content-free audit events. It returns at most 300 entries in
each proposal/task/review/event collection; the UI labels capped collections.
Scion and watch lists are not capped by this limit. This is not an unlimited
audit export or a new approval API.

Proposal inputs, source text/quotes, object keys and task leases are excluded.
Blocked/stale metadata points to a detail view that rechecks authorization.
The original fail-closed source/detail hooks remain in place across navigation.
Every open Scion retains its authenticated case-monitor connection, including
while a proposal or source form is displayed.

The workspace hook polls every two seconds, uses a 3.5-second request timeout,
and expires displayed records five seconds after a read began. Failed checks,
hidden tabs and offline transitions clear displayed records. A response for a
different organization is never displayed. This browser polling observes the
existing server monitor; it does not perform watch checks. The PostgreSQL event
and restart guarantees described in `control-surface.md` are unchanged.

Agents and skills now belong to Grimoire, not a separate Paperclip backend.
Each native profile has focused configuration and runtime views, immutable
revisions, real assignments and actual run history. Skill assignment is not
proof of execution. The proposal UI identifies the recorded task adapter without
asserting that every synthetic protocol fixture represents a real model run.
Human review remains separate from completion; no approval control is invented.
See [native agent architecture and supported controls](native-agents.md).

Migration 0043 adds native profiles and assignments. Previously applied migration
files and the sibling Paperclip checkout remain unchanged.
