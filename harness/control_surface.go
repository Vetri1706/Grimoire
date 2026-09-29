package main

// These checks use the same real HTTP boundary and process restarts as the
// other slices. Synthetic protocol output is not represented as a Codex run.
import (
	"bytes"
	"encoding/json"
	"fmt"
	"sort"
	"strings"
	"time"
)

type controlNode struct {
	ID       string          `json:"id"`
	Kind     string          `json:"kind"`
	Status   string          `json:"status"`
	Stale    bool            `json:"stale"`
	Details  json.RawMessage `json:"details"`
	Blockers []string        `json:"blockers"`
}

type controlEvent struct {
	ID              string `json:"id"`
	EventKey        string `json:"event_key"`
	Kind            string `json:"kind"`
	SubjectID       string `json:"subject_id"`
	SubjectRevision int    `json:"subject_revision"`
	RecordedAt      string `json:"recorded_at"`
}

type controlReview struct {
	ID      string `json:"id"`
	EventID string `json:"event_id"`
	Status  string `json:"status"`
	Reason  string `json:"reason"`
}

type controlWatch struct {
	ID                  string  `json:"id"`
	Kind                string  `json:"kind"`
	LastSuccessfulCheck *string `json:"last_successful_check"`
	LastEventAt         *string `json:"last_event_at"`
}

type controlSurface struct {
	ScionID       string        `json:"scion_id"`
	ScionRevision int           `json:"scion_revision"`
	Nodes         []controlNode `json:"nodes"`
	Edges         []struct {
		Source string `json:"source"`
		Target string `json:"target"`
		Kind   string `json:"kind"`
	} `json:"edges"`
	Watchtower struct {
		Health              string          `json:"health"`
		LastSuccessfulCheck *string         `json:"last_successful_check"`
		Watches             []controlWatch  `json:"watches"`
		Alerts              []controlReview `json:"alerts"`
	} `json:"watchtower"`
	Operations struct {
		Tasks []struct {
			ID      string `json:"id"`
			Status  string `json:"status"`
			Blocked bool   `json:"blocked"`
			Stale   bool   `json:"stale"`
		} `json:"tasks"`
		Events       []controlEvent  `json:"events"`
		HumanReview  []controlReview `json:"human_review"`
		AgentRuntime struct {
			Status   string  `json:"status"`
			Backend  string  `json:"backend"`
			LastSeen *string `json:"last_seen"`
		} `json:"agent_runtime"`
	} `json:"operations"`
	ApprovalAvailable bool `json:"approval_available"`
}

func (h *harness) controlRead(path string) (controlSurface, response, error) {
	r, e := h.sourceReq("GET", path+"/control-surface", h.tokenA, nil, "", "", 200)
	if e != nil {
		return controlSurface{}, r, e
	}
	s, e := decode[controlSurface](r)
	return s, r, e
}

func (s controlSurface) node(kind, id string) (controlNode, error) {
	for _, n := range s.Nodes {
		if n.Kind == kind && strings.HasSuffix(n.ID, ":"+id) {
			return n, nil
		}
	}
	return controlNode{}, fmt.Errorf("missing %s node for %s", kind, id)
}

func (s controlSurface) oneEvent(kind, subject string, revision ...int) (controlEvent, error) {
	var matches []controlEvent
	for _, event := range s.Operations.Events {
		if event.Kind == kind && event.SubjectID == subject && (len(revision) == 0 || event.SubjectRevision == revision[0]) {
			matches = append(matches, event)
		}
	}
	if len(matches) != 1 || matches[0].ID == "" || matches[0].EventKey == "" || matches[0].RecordedAt == "" {
		return controlEvent{}, fmt.Errorf("expected one durable %s event for %s, got %+v", kind, subject, matches)
	}
	return matches[0], nil
}

func (s controlSurface) requiredReview(eventID string) error {
	count := 0
	for _, review := range s.Operations.HumanReview {
		if review.EventID == eventID {
			count++
			if review.ID == "" || review.Status != "required" || review.Reason == "" {
				return fmt.Errorf("event %s lacks a concrete required human review: %+v", eventID, review)
			}
		}
	}
	if count != 1 {
		return fmt.Errorf("event %s has %d review tasks, want exactly one", eventID, count)
	}
	return nil
}

func (s controlSurface) validateGraph() error {
	nodes := map[string]bool{}
	for _, node := range s.Nodes {
		if node.ID == "" || nodes[node.ID] || node.Kind == "" || node.Status == "" {
			return fmt.Errorf("graph has missing or duplicate node identity/status: %+v", node)
		}
		nodes[node.ID] = true
	}
	if len(nodes) == 0 || len(s.Edges) == 0 {
		return fmt.Errorf("control surface is missing its connected graph")
	}
	for _, edge := range s.Edges {
		if !nodes[edge.Source] || !nodes[edge.Target] || edge.Kind == "" {
			return fmt.Errorf("graph exposes a dangling or unidentified edge: %+v", edge)
		}
	}
	events, keys, reviews := map[string]bool{}, map[string]bool{}, map[string]bool{}
	for _, event := range s.Operations.Events {
		if event.ID == "" || events[event.ID] || event.EventKey == "" || keys[event.EventKey] {
			return fmt.Errorf("duplicate or unidentified auditable event: %+v", event)
		}
		events[event.ID], keys[event.EventKey] = true, true
	}
	for _, review := range s.Operations.HumanReview {
		if review.ID == "" || review.EventID == "" || !events[review.EventID] || reviews[review.EventID] {
			return fmt.Errorf("duplicate or unbound human review: %+v", review)
		}
		reviews[review.EventID] = true
	}
	if s.ApprovalAvailable {
		return fmt.Errorf("control surface incorrectly grants approval availability")
	}
	if s.Operations.AgentRuntime.Backend != "grimoire" || (s.Operations.AgentRuntime.Status != "disconnected" && s.Operations.AgentRuntime.Status != "connected") {
		return fmt.Errorf("native worker health has invalid provenance")
	}
	if s.Operations.AgentRuntime.Status == "connected" && s.Operations.AgentRuntime.LastSeen == nil {
		return fmt.Errorf("native worker connected without authenticated heartbeat")
	}
	return nil
}

// Heartbeats may advance between responses. Compare only durable work and
// audit identities when proving mutation replay does not duplicate effects.
func controlEffects(s controlSurface) []byte {
	ids := []string{}
	for _, e := range s.Operations.Events {
		ids = append(ids, "event:"+e.ID+":"+e.EventKey+":"+e.RecordedAt)
	}
	for _, r := range s.Operations.HumanReview {
		ids = append(ids, "review:"+r.ID+":"+r.EventID+":"+r.Status)
	}
	for _, t := range s.Operations.Tasks {
		ids = append(ids, "task:"+t.ID+":"+t.Status)
	}
	for _, a := range s.Watchtower.Alerts {
		ids = append(ids, "alert:"+a.ID+":"+a.EventID+":"+a.Status)
	}
	sort.Strings(ids)
	return mustJSON(ids)
}

func (h *harness) controlHealthy(path string) (controlSurface, error) {
	deadline := time.Now().Add(15 * time.Second)
	for {
		s, _, e := h.controlRead(path)
		if e != nil {
			return s, e
		}
		if s.Watchtower.Health == "healthy" && s.Watchtower.LastSuccessfulCheck != nil {
			if _, e = time.Parse(time.RFC3339Nano, *s.Watchtower.LastSuccessfulCheck); e != nil {
				return s, fmt.Errorf("monitoring last successful check is not a timestamp: %w", e)
			}
			if len(s.Watchtower.Watches) == 0 {
				return s, fmt.Errorf("healthy Watchtower has no persisted watches")
			}
			for _, watch := range s.Watchtower.Watches {
				if watch.ID == "" || watch.Kind == "" || watch.LastSuccessfulCheck == nil {
					return s, fmt.Errorf("healthy watch has missing durable identity/check: %+v", watch)
				}
			}
			return s, nil
		}
		if time.Now().After(deadline) {
			return s, fmt.Errorf("server monitor never reported a successful check: %+v", s.Watchtower)
		}
		time.Sleep(250 * time.Millisecond)
	}
}

func (h *harness) runControlSurface() error {
	if e := h.check("Scion revision alone stales its completed proposal without approving it", func() error {
		fixture, err := h.newAdaptiveFixture("os-revision-only")
		if err != nil {
			return err
		}
		task, err := h.adaptiveTask(fixture.path, "os-revision-only", 1)
		if err != nil {
			return err
		}
		task, err = h.adaptiveClaim(fixture.path, task, 1)
		if err != nil {
			return err
		}
		capabilities, err := h.adaptiveRead(fixture.path)
		if err != nil {
			return err
		}
		result, err := h.agentProposal(fixture.path+"/capability-plans", adaptivePlanBody(capabilities.UnresolvedGaps), "os-revision-plan", task, 201)
		if err != nil {
			return err
		}
		plan, err := decode[adaptivePlan](result)
		if err != nil {
			return err
		}
		if err = h.adaptiveComplete(task, plan.ID); err != nil {
			return err
		}
		changed := fixture.draft
		changed.ChangeSummary = "Synthetic OS revision-only acceptance"
		if _, err = h.req("POST", fixture.path+"/revisions", h.tokenA, changed, "os-revision-only-change", `"1"`, 201); err != nil {
			return err
		}
		state, _, err := h.controlRead(fixture.path)
		if err != nil {
			return err
		}
		node, err := state.node("capability_proposal", plan.ID)
		if err != nil {
			return err
		}
		if node.Status != "stale" || !node.Stale || string(node.Details) != "null" || state.ApprovalAvailable {
			return fmt.Errorf("revision alone failed to stale and withhold plan: %+v", node)
		}
		return state.validateGraph()
	}); e != nil {
		return e
	}
	f, e := h.newAdaptiveFixture("control-surface")
	if e != nil {
		return e
	}
	scionID := strings.TrimPrefix(f.path, "/api/scions/")
	statement := "SYNTHETIC private source " + h.runID + ": its Handler can edit the website pages."
	sourcePath, claimID, source, e := h.adaptiveSource(f.path, "control-surface", statement)
	if e != nil {
		return e
	}
	sourceID := sourcePath[strings.LastIndex(sourcePath, "/")+1:]
	task, e := h.adaptiveTask(f.path, "control-surface", 1)
	if e != nil {
		return e
	}
	task, e = h.adaptiveClaim(f.path, task, 1)
	if e != nil {
		return e
	}
	capabilities, e := h.adaptiveRead(f.path)
	if e != nil {
		return e
	}
	r, e := h.agentProposal(f.path+"/capability-plans", adaptivePlanBody(capabilities.UnresolvedGaps), "control-surface-plan", task, 201)
	if e != nil {
		return e
	}
	plan, e := decode[adaptivePlan](r)
	if e != nil {
		return e
	}
	comparisonBody := adaptiveComparisonBody(plan.ID, []string{claimID})
	r, e = h.sourceReq("POST", f.path+"/evidence-comparisons", h.tokenA, comparisonBody, "control-surface-comparison", `"1"`, 201)
	if e != nil {
		return e
	}
	comparison, e := decode[adaptiveComparison](r)
	if e != nil {
		return e
	}
	var baseline controlSurface
	if e = h.check("OS graph projects authorized persisted digital case relationships and disconnected integrations", func() error {
		var e error
		baseline, e = h.controlHealthy(f.path)
		if e != nil {
			return e
		}
		if baseline.ScionID != scionID || baseline.ScionRevision != 1 {
			return fmt.Errorf("graph is not bound to the current case revision")
		}
		if e = baseline.validateGraph(); e != nil {
			return e
		}
		for _, expected := range []struct{ kind, id string }{{"scion", scionID}, {"capability_proposal", plan.ID}, {"agent_task", task.ID}, {"evidence_source", sourceID}, {"comparison", comparison.ID}} {
			if _, e = baseline.node(expected.kind, expected.id); e != nil {
				return e
			}
		}
		kinds := map[string]bool{}
		for _, n := range baseline.Nodes {
			kinds[n.Kind] = true
			if n.Kind == "physical_scope" || n.Kind == "supplier_offer" {
				return fmt.Errorf("digital Scion gained an inapplicable physical workflow node")
			}
		}
		if !kinds["data_connector"] || !kinds["human_review"] {
			return fmt.Errorf("digital graph lacks its connector or human review gate")
		}
		if len(baseline.Operations.Tasks) != 1 || baseline.Operations.Tasks[0].ID != task.ID || baseline.Operations.Tasks[0].Status != "running" {
			return fmt.Errorf("operations dock diverges from the existing Rust task state")
		}
		return nil
	}); e != nil {
		return e
	}
	if e = h.check("OS nodes, edges, alerts and monitoring metadata require authentication and hide foreign organizations", func() error {
		if _, e := h.sourceReq("GET", f.path+"/control-surface", "", nil, "", "", 401); e != nil {
			return e
		}
		foreign, e := h.sourceReq("GET", f.path+"/control-surface", h.tokenB, nil, "", "", 404)
		if e != nil {
			return e
		}
		unknown, e := h.sourceReq("GET", "/api/scions/00000000-0000-4000-8000-000000000001/control-surface", h.tokenB, nil, "", "", 404)
		if e != nil {
			return e
		}
		if !equalJSON(foreign.body, unknown.body) || foreign.header.Get("ETag") != "" || foreign.header.Get("Location") != "" {
			return fmt.Errorf("foreign graph response differs from an unknown case")
		}
		for _, forbidden := range []string{scionID, task.ID, plan.ID, sourceID, comparison.ID, "nodes", "edges", "alerts", "last_successful_check"} {
			if bytes.Contains(foreign.body, []byte(forbidden)) {
				return fmt.Errorf("foreign graph denial disclosed %q", forbidden)
			}
		}
		return nil
	}); e != nil {
		return e
	}
	if e = h.check("completed agent task emits one audit event and required review without creating approval", func() error {
		if e := h.adaptiveComplete(task, plan.ID); e != nil {
			return e
		}
		s, _, e := h.controlRead(f.path)
		if e != nil {
			return e
		}
		if e = s.validateGraph(); e != nil {
			return e
		}
		event, e := s.oneEvent("agent_task_completed", task.ID)
		if e != nil {
			return e
		}
		if e = s.requiredReview(event.ID); e != nil {
			return e
		}
		p, e := s.node("capability_proposal", plan.ID)
		if e != nil {
			return e
		}
		if p.Status != "current" || p.Stale || len(s.Operations.Tasks) != 1 || s.Operations.Tasks[0].Status != "completed" {
			return fmt.Errorf("task completion incorrectly changed proposal authority or invented work")
		}
		for _, n := range s.Nodes {
			if n.Status == "approved" || n.Status == "confirmed" {
				return fmt.Errorf("agent completion conferred human authority on %s", n.ID)
			}
		}
		before := controlEffects(s)
		if e = h.adaptiveComplete(task, plan.ID); e != nil {
			return e
		}
		s, _, e = h.controlRead(f.path)
		if e != nil {
			return e
		}
		if !bytes.Equal(before, controlEffects(s)) {
			return fmt.Errorf("duplicate completion created additional audit effects or tasks")
		}
		return nil
	}); e != nil {
		return e
	}
	if e = h.check("Watchtower source revision events stale exact comparisons and mutation retries have no duplicate effects", func() error {
		source.SourceText += "A second synthetic source revision changes the evidence.\n"
		source.ChangeSummary = "Synthetic revision for Watchtower acceptance"
		created, e := h.sourceReq("POST", sourcePath+"/revisions", h.tokenA, source, "control-source-revision", `"1"`, 201)
		if e != nil {
			return e
		}
		s, _, e := h.controlRead(f.path)
		if e != nil {
			return e
		}
		event, e := s.oneEvent("source_revision_changed", sourceID, 2)
		if e != nil {
			return e
		}
		if e = s.requiredReview(event.ID); e != nil {
			return e
		}
		c, e := s.node("comparison", comparison.ID)
		if e != nil {
			return e
		}
		if !c.Stale || c.Status != "blocked" || len(c.Blockers) == 0 {
			return fmt.Errorf("source revision did not stale and block the exact dependent comparison: %+v", c)
		}
		before := controlEffects(s)
		replay, e := h.sourceReq("POST", sourcePath+"/revisions", h.tokenA, source, "control-source-revision", `"1"`, 201)
		if e != nil {
			return e
		}
		if e = equalReplay(created, replay); e != nil {
			return e
		}
		s, _, e = h.controlRead(f.path)
		if e != nil {
			return e
		}
		if !bytes.Equal(before, controlEffects(s)) {
			return fmt.Errorf("source revision retry duplicated watch audit/review effects")
		}
		return s.validateGraph()
	}); e != nil {
		return e
	}
	blockedTask, e := h.adaptiveTask(f.path, "os-revocation-blocks-queued", 1)
	if e != nil {
		return e
	}
	runningTask, e := h.adaptiveTask(f.path, "os-revocation-stops-running", 1)
	if e != nil {
		return e
	}
	runningTask, e = h.adaptiveClaim(f.path, runningTask, 1)
	if e != nil {
		return e
	}
	if e = h.check("source revocation redacts graph content and blocks dependent work with one auditable review", func() error {
		body := map[string]string{"reason": "Synthetic source author withdrew permission for Watchtower acceptance"}
		created, e := h.sourceReq("POST", sourcePath+"/revoke", h.tokenA, body, "control-source-revoke", `"2"`, 201)
		if e != nil {
			return e
		}
		s, raw, e := h.controlRead(f.path)
		if e != nil {
			return e
		}
		for _, expected := range []struct{ kind, id, status string }{{"evidence_source", sourceID, "revoked"}, {"comparison", comparison.ID, "blocked"}} {
			n, e := s.node(expected.kind, expected.id)
			if e != nil {
				return e
			}
			if n.Status != expected.status || string(n.Details) != "null" || len(n.Blockers) == 0 {
				return fmt.Errorf("revocation did not withhold content and explain blocked work: %+v", n)
			}
		}
		if bytes.Contains(raw.body, []byte(statement)) || bytes.Contains(raw.body, []byte(source.SourceText)) {
			return fmt.Errorf("graph retained revoked source content")
		}
		blockedNode, e := s.node("agent_task", blockedTask.ID)
		if e != nil {
			return e
		}
		if blockedNode.Status != "blocked" || !blockedNode.Stale {
			return fmt.Errorf("source revocation did not block queued dependent work: %+v", blockedNode)
		}
		if _, e = h.sourceReq("POST", f.path+"/agent-tasks/"+blockedTask.ID+"/dispatch", h.tokenA, nil, "", `"1"`, 403); e != nil {
			return e
		}
		if _, e = h.sourceReq("GET", sourcePath+"/revisions/1", h.tokenA, nil, "", "", 403); e != nil {
			return e
		}
		if _, e = h.sourceReq("POST", f.path+"/evidence-comparisons", h.tokenA, comparisonBody, "control-surface-comparison", `"1"`, 403); e != nil {
			return e
		}
		event, e := s.oneEvent("source_permission_revoked", sourceID)
		if e != nil {
			return e
		}
		if e = s.requiredReview(event.ID); e != nil {
			return e
		}
		before := controlEffects(s)
		replay, e := h.sourceReq("POST", sourcePath+"/revoke", h.tokenA, body, "control-source-revoke", `"2"`, 201)
		if e != nil {
			return e
		}
		if e = equalReplay(created, replay); e != nil {
			return e
		}
		s, _, e = h.controlRead(f.path)
		if e != nil {
			return e
		}
		if !bytes.Equal(before, controlEffects(s)) {
			return fmt.Errorf("source revocation retry duplicated watch audit/review effects")
		}
		return s.validateGraph()
	}); e != nil {
		return e
	}
	if e = h.check("revocation denies running worker control and replayed failure records only one outcome", func() error {
		response, err := h.client.request("GET", "/api/agent/tasks/"+runningTask.ID+"/control", h.agent, nil, map[string]string{"X-Grimoire-Task-Lease": runningTask.Lease})
		if err != nil {
			return err
		}
		if err = expectStatus(response, 403); err != nil {
			return err
		}
		var before []byte
		for attempt := 0; attempt < 2; attempt++ {
			response, err = h.client.request("POST", "/api/agent/tasks/"+runningTask.ID+"/fail", h.agent, map[string]string{"failure_code": "TASK_CONTROL_UNAVAILABLE"}, map[string]string{"X-Grimoire-Task-Lease": runningTask.Lease})
			if err != nil {
				return err
			}
			if err = expectStatus(response, 200); err != nil {
				return err
			}
			state, _, err := h.controlRead(f.path)
			if err != nil {
				return err
			}
			if attempt == 0 {
				before = controlEffects(state)
			} else if !bytes.Equal(before, controlEffects(state)) {
				return fmt.Errorf("replayed failure duplicated watch effects")
			}
			if _, err = state.oneEvent("agent_task_failed", runningTask.ID); err != nil {
				return err
			}
		}
		return nil
	}); e != nil {
		return e
	}
	if e = h.check("Scion revision immediately makes the plan stale and duplicate watch effects remain idempotent", func() error {
		changed := f.draft
		text := *changed.ProductDescription + " The Handler now requests a booking decision before implementation."
		changed.ProductDescription = &text
		changed.ChangeSummary = "Revise synthetic website requirements for Watchtower acceptance"
		created, e := h.req("POST", f.path+"/revisions", h.tokenA, changed, "control-scion-revision", `"1"`, 201)
		if e != nil {
			return e
		}
		s, _, e := h.controlRead(f.path)
		if e != nil {
			return e
		}
		p, e := s.node("capability_proposal", plan.ID)
		if e != nil {
			return e
		}
		if s.ScionRevision != 2 || p.Status != "blocked" || !p.Stale || len(p.Blockers) == 0 {
			return fmt.Errorf("revision change did not expose stale plan and blockers: %+v", p)
		}
		event, e := s.oneEvent("scion_revision_changed", scionID)
		if e != nil {
			return e
		}
		if e = s.requiredReview(event.ID); e != nil {
			return e
		}
		before := controlEffects(s)
		replay, e := h.req("POST", f.path+"/revisions", h.tokenA, changed, "control-scion-revision", `"1"`, 201)
		if e != nil {
			return e
		}
		if e = equalReplay(created, replay); e != nil {
			return e
		}
		for i := 0; i < 3; i++ {
			s, _, e = h.controlRead(f.path)
			if e != nil {
				return e
			}
			if !bytes.Equal(before, controlEffects(s)) {
				return fmt.Errorf("revision replay/read created duplicate events, alerts or tasks")
			}
		}
		return s.validateGraph()
	}); e != nil {
		return e
	}
	if e = h.check("company workspace projects blocked proposals without revoked inputs or read side effects", func() error {
		before, _, err := h.controlRead(f.path)
		if err != nil {
			return err
		}
		for attempt := 0; attempt < 2; attempt++ {
			response, err := h.sourceReq("GET", "/api/workspace", h.tokenA, nil, "", "", 200)
			if err != nil {
				return err
			}
			var workspace struct {
				OrgID     string `json:"org_id"`
				Proposals []struct {
					ID      string `json:"id"`
					ScionID string `json:"scion_id"`
					Status  string `json:"status"`
				} `json:"proposals"`
			}
			if err = json.Unmarshal(response.body, &workspace); err != nil {
				return err
			}
			for _, forbidden := range []string{statement, source.SourceText, `"source_text":`, `"object_key":`, `"lease_token":`, `"inputs":`} {
				if bytes.Contains(response.body, []byte(forbidden)) {
					return fmt.Errorf("company projection exposed content or worker authority")
				}
			}
			for _, expectedID := range []string{plan.ID, comparison.ID} {
				found := false
				for _, proposal := range workspace.Proposals {
					if proposal.ID == expectedID && proposal.ScionID == scionID && proposal.Status == "blocked" {
						found = true
					}
				}
				if !found {
					return fmt.Errorf("company projection missed blocked proposal %s", expectedID)
				}
			}
		}
		after, _, err := h.controlRead(f.path)
		if err != nil {
			return err
		}
		if !bytes.Equal(controlEffects(before), controlEffects(after)) {
			return fmt.Errorf("workspace reads mutated watch effects")
		}
		return nil
	}); e != nil {
		return e
	}
	if e = h.check("company workspace requires authentication and cannot mutate records", func() error {
		for _, token := range []string{"", "invalid-token"} {
			if _, err := h.sourceReq("GET", "/api/workspace", token, nil, "", "", 401); err != nil {
				return err
			}
		}
		_, err := h.sourceReq("POST", "/api/workspace", h.tokenA, nil, "", "", 405)
		return err
	}); e != nil {
		return e
	}
	if e = h.check("foreign company workspace contains no case proposals, work, watches or alerts", func() error {
		response, err := h.sourceReq("GET", "/api/workspace", h.tokenB, nil, "", "", 200)
		if err != nil {
			return err
		}
		for _, forbidden := range []string{scionID, plan.ID, comparison.ID, task.ID, sourceID, statement} {
			if bytes.Contains(response.body, []byte(forbidden)) {
				return fmt.Errorf("foreign organization saw another company's workspace metadata")
			}
		}
		return nil
	}); e != nil {
		return e
	}
	if e = h.check("server Watchtower advances successful checks without a browser timer", func() error {
		before, e := h.controlHealthy(f.path)
		if e != nil {
			return e
		}
		// No HTTP request or browser is active during the server monitoring period.
		time.Sleep(6 * time.Second)
		after, e := h.controlHealthy(f.path)
		if e != nil {
			return e
		}
		a, _ := time.Parse(time.RFC3339Nano, *before.Watchtower.LastSuccessfulCheck)
		b, _ := time.Parse(time.RFC3339Nano, *after.Watchtower.LastSuccessfulCheck)
		if !b.After(a) || !bytes.Equal(controlEffects(before), controlEffects(after)) {
			return fmt.Errorf("server heartbeat failed to advance independently or duplicated work")
		}
		baseline = after
		return nil
	}); e != nil {
		return e
	}
	return h.check("actual API restart restores persisted watches, alerts, stale state and source revocation", func() error {
		if e := h.restartSources(); e != nil {
			return e
		}
		after, _, e := h.controlRead(f.path)
		if e != nil {
			return e
		}
		if !bytes.Equal(controlEffects(baseline), controlEffects(after)) || len(baseline.Watchtower.Watches) != len(after.Watchtower.Watches) {
			return fmt.Errorf("restart changed durable watches, audit effects or review tasks")
		}
		for _, before := range baseline.Watchtower.Watches {
			found := false
			for _, watch := range after.Watchtower.Watches {
				if watch.ID == before.ID {
					found = true
					if watch.Kind != before.Kind || before.LastSuccessfulCheck == nil || watch.LastSuccessfulCheck == nil || !equalJSON(mustJSON(before.LastEventAt), mustJSON(watch.LastEventAt)) {
						return fmt.Errorf("persisted watch metadata lost across restart")
					}
					a, e := time.Parse(time.RFC3339Nano, *before.LastSuccessfulCheck)
					if e != nil {
						return e
					}
					b, e := time.Parse(time.RFC3339Nano, *watch.LastSuccessfulCheck)
					if e != nil || b.Before(a) {
						return fmt.Errorf("restart discarded a watch's last successful check")
					}
				}
			}
			if !found {
				return fmt.Errorf("restart replaced persisted watch %s", before.ID)
			}
		}
		p, e := after.node("capability_proposal", plan.ID)
		if e != nil {
			return e
		}
		c, e := after.node("comparison", comparison.ID)
		if e != nil {
			return e
		}
		if after.ScionRevision != 2 || !p.Stale || p.Status != "blocked" || c.Status != "blocked" || string(c.Details) != "null" {
			return fmt.Errorf("restart restored stale or revoked dependent content")
		}
		if _, e = h.sourceReq("GET", sourcePath+"/revisions/1", h.tokenA, nil, "", "", 403); e != nil {
			return e
		}
		if _, e = h.sourceReq("GET", f.path+"/control-surface", h.tokenB, nil, "", "", 404); e != nil {
			return e
		}
		return after.validateGraph()
	})
}
