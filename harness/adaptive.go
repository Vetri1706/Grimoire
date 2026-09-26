package main

// Adaptive checks use only the running Rust HTTP API. The known synthetic agent
// output below tests the leased protocol, not a model or a provider search.
import (
	"bytes"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"strings"
)

type adaptiveConnector struct {
	ID          string `json:"id"`
	Kind        string `json:"kind"`
	Enabled     bool   `json:"enabled"`
	Status      string `json:"status"`
	Description string `json:"description"`
}

type adaptivePlan struct {
	ID            string          `json:"id"`
	ScionRevision int             `json:"scion_revision"`
	AgentTaskID   string          `json:"agent_task_id"`
	Status        string          `json:"status"`
	Input         json.RawMessage `json:"input"`
	CreatedBy     string          `json:"created_by"`
	CreatedAt     string          `json:"created_at"`
}

type adaptiveComparison struct {
	ID            string          `json:"id"`
	ScionRevision int             `json:"scion_revision"`
	PlanID        string          `json:"plan_id"`
	Status        string          `json:"status"`
	Input         json.RawMessage `json:"input"`
	Evidence      []struct {
		ID                 string       `json:"id"`
		SourceID           string       `json:"source_id"`
		SourceRevision     int          `json:"source_revision"`
		Statement          string       `json:"statement"`
		Locator            claimLocator `json:"locator"`
		ContentSHA256      string       `json:"content_sha256"`
		VerificationStatus string       `json:"verification_status"`
	} `json:"evidence"`
	UnresolvedGaps     []string `json:"unresolved_gaps"`
	VerificationStatus string   `json:"verification_status"`
	BlockedReason      *string  `json:"blocked_reason"`
}

type adaptiveState struct {
	ScionRevision               int                  `json:"scion_revision"`
	Connectors                  []adaptiveConnector  `json:"connectors"`
	ExternalConnectorsAvailable bool                 `json:"external_connectors_available"`
	UnresolvedGaps              []string             `json:"unresolved_gaps"`
	Plans                       []adaptivePlan       `json:"plans"`
	Comparisons                 []adaptiveComparison `json:"comparisons"`
}

type adaptiveFixture struct {
	path    string
	draft   intake
	initial response
}

func (h *harness) newAdaptiveFixture(label string) (adaptiveFixture, error) {
	description := "I need a website for a synthetic community pottery workshop. Visitors should read class descriptions, request a place, and reach the organiser. I need to update the pages myself. No provider has been researched."
	draft := intake{Name: "SYNTHETIC website " + label + " " + h.runID, ProductDescription: &description,
		ProductCategory: "digital", ChangeSummary: "Handler free-text website description; other requirements remain unknown"}
	r, e := h.req("POST", "/api/scions", h.tokenA, draft, "adaptive-"+label+"-intake", "", 201)
	if e != nil {
		return adaptiveFixture{}, e
	}
	s, e := decode[scion](r)
	return adaptiveFixture{path: "/api/scions/" + s.ID, draft: draft, initial: r}, e
}

func (h *harness) adaptiveRead(path string) (adaptiveState, error) {
	r, e := h.sourceReq("GET", path+"/capabilities", h.tokenA, nil, "", "", 200)
	if e != nil {
		return adaptiveState{}, e
	}
	return decode[adaptiveState](r)
}

func adaptivePlanBody(gaps []string) map[string]any {
	return map[string]any{
		"synthetic": true,
		"summary":   "Synthetic proposal: clarify content editing and class enquiry capabilities for the Handler's website description.",
		"capabilities": []any{
			map[string]any{"key": "content_editing", "title": "Handler-managed pages", "reason": "The Handler wants to update class descriptions.", "evidence_needed": []string{"Authorized documentation demonstrating the proposed page-editing workflow"}, "connector_ids": []string{"handler_intake", "scion_sources"}},
			map[string]any{"key": "class_enquiry", "title": "Class enquiry form", "reason": "Visitors should request a class place and contact the organiser.", "evidence_needed": []string{"Authorized documentation for enquiry delivery and handling"}, "connector_ids": []string{"handler_intake", "scion_sources"}},
		},
		"unresolved_gaps": append(append([]string{}, gaps...), "No vendor identity, price, offer, or independent capability verification is present."),
		"change_summary":  "Synthetic Go protocol proposal; not an LLM run, supplier recommendation, or human approval",
	}
}

func adaptiveComparisonBody(plan string, claims []string) map[string]any {
	var first, second []string
	if len(claims) > 0 {
		first = []string{claims[0]}
	}
	if len(claims) > 1 {
		second = []string{claims[1]}
	}
	if first == nil {
		first = []string{}
	}
	if second == nil {
		second = []string{}
	}
	return map[string]any{
		"synthetic": true, "plan_id": plan,
		"alternatives": []any{
			map[string]any{"label": "Synthetic website approach A", "criteria": []any{map[string]any{"capability_key": "content_editing", "claim_ids": first}, map[string]any{"capability_key": "class_enquiry", "claim_ids": []string{}}}},
			map[string]any{"label": "Synthetic website approach B", "criteria": []any{map[string]any{"capability_key": "content_editing", "claim_ids": second}, map[string]any{"capability_key": "class_enquiry", "claim_ids": []string{}}}},
		},
		"unresolved_gaps": []string{"Synthetic Handler claims do not verify either implementation; independent authorised evidence is still needed."},
		"change_summary":  "Record two synthetic approach descriptions for review, without a provider listing or decision",
	}
}

func (h *harness) adaptiveTask(path, label string, revision int) (agentTask, error) {
	r, e := h.sourceReq("POST", path+"/agent-tasks", h.tokenA, map[string]any{"task_kind": "prepare_capability_plan", "candidate_proposal": map[string]any{"synthetic": true}, "timeout_seconds": 240}, "adaptive-"+label+"-task", fmt.Sprintf(`"%d"`, revision), 201)
	if e != nil {
		return agentTask{}, e
	}
	return decode[agentTask](r)
}

func (h *harness) adaptiveClaim(path string, task agentTask, revision int) (agentTask, error) {
	_, e := h.sourceReq("POST", path+"/agent-tasks/"+task.ID+"/dispatch", h.tokenA, nil, "", fmt.Sprintf(`"%d"`, revision), 200)
	if e != nil {
		return agentTask{}, e
	}
	r, e := h.sourceReq("POST", "/api/agent/tasks/"+task.ID+"/claim", h.agent, nil, "", "", 200)
	if e != nil {
		return agentTask{}, e
	}
	return decode[agentTask](r)
}

func (h *harness) adaptiveComplete(task agentTask, planID string) error {
	result := map[string]any{"proposal_id": planID, "provider_run_id": "synthetic-go-protocol-no-model", "output_sha256": strings.Repeat("6", 64), "preparation_note": "Known synthetic protocol output; actual Codex execution is a separate check."}
	for i := 0; i < 2; i++ {
		r, e := h.client.request("POST", "/api/agent/tasks/"+task.ID+"/result", h.agent, result, map[string]string{"X-Grimoire-Task-Lease": task.Lease})
		if e != nil {
			return e
		}
		if e = expectStatus(r, 200); e != nil {
			return e
		}
		done, e := decode[agentTask](r)
		if e != nil {
			return e
		}
		if done.Status != "completed" || done.ProposalID == nil || *done.ProposalID != planID || done.Revision != task.Revision {
			return fmt.Errorf("completed task lost revision/proposal binding")
		}
	}
	return nil
}

func (h *harness) adaptiveSource(path, label, statement string) (string, string, sourceInput, error) {
	input := sourceInput{Title: "SYNTHETIC website approach " + label, Origin: "synthetic://handler/" + h.runID + "/" + label,
		Owner: "Synthetic Handler", Synthetic: true, SourceText: "SYNTHETIC AUTHOR NOTE; no provider or independent evidence.\n" + statement + "\n",
		RightsStatus: "granted", PermissionBasis: "Authored synthetic text; local Scion review permitted", PermittedUse: "scion_review", ChangeSummary: "Initial exact synthetic approach description"}
	r, e := h.sourceReq("POST", path+"/sources", h.tokenA, input, "adaptive-"+label+"-source", `"1"`, 201)
	if e != nil {
		return "", "", input, e
	}
	s, e := decode[sourceReceipt](r)
	if e != nil {
		return "", "", input, e
	}
	sourcePath := path + "/sources/" + s.SourceID
	start := strings.Index(input.SourceText, statement)
	claim := claimInput{Statement: statement, Locator: claimLocator{StartByte: start, EndByte: start + len([]byte(statement)), Quote: statement}}
	if _, e = h.sourceReq("POST", sourcePath+"/revisions/1/claims", h.tokenA, claim, "adaptive-"+label+"-claim", "", 201); e != nil {
		return sourcePath, "", input, e
	}
	r, e = h.sourceReq("GET", sourcePath+"/revisions/1/claims", h.tokenA, nil, "", "", 200)
	if e != nil {
		return sourcePath, "", input, e
	}
	list, e := decode[struct {
		Claims []sourceClaim `json:"claims"`
	}](r)
	if e != nil || len(list.Claims) != 1 {
		return sourcePath, "", input, fmt.Errorf("expected exact synthetic claim: %v", e)
	}
	return sourcePath, list.Claims[0].ID, input, nil
}

func adaptiveFindPlan(state adaptiveState, id string) (adaptivePlan, error) {
	for _, p := range state.Plans {
		if p.ID == id {
			return p, nil
		}
	}
	return adaptivePlan{}, fmt.Errorf("plan %s missing from revision history", id)
}
func adaptiveFindComparison(state adaptiveState, id string) (adaptiveComparison, error) {
	for _, c := range state.Comparisons {
		if c.ID == id {
			return c, nil
		}
	}
	return adaptiveComparison{}, fmt.Errorf("comparison %s missing from review history", id)
}

func (h *harness) runAdaptive() error {
	var f adaptiveFixture
	var state adaptiveState
	if e := h.check("adaptive digital free-text intake preserves Handler description and explicit unknown fields", func() error {
		var e error
		f, e = h.newAdaptiveFixture("main")
		if e != nil {
			return e
		}
		s, e := decode[scion](f.initial)
		if e != nil {
			return e
		}
		var entered intake
		if e = json.Unmarshal(s.Revision, &entered); e != nil {
			return e
		}
		if entered.ProductDescription == nil || *entered.ProductDescription != *f.draft.ProductDescription || entered.ProductCategory != "digital" || entered.Decision != nil || entered.Requirements != nil || entered.Questions != nil || len(s.MissingInformation) == 0 {
			return fmt.Errorf("adaptive intake changed Handler facts or filled unknowns")
		}
		return nil
	}); e != nil {
		return e
	}
	if e := h.check("unverified Windows sourcing approval remains disabled for Handlers, reviewers, and agents", func() error {
		r, e := h.req("GET", "/api/authority-status", h.tokenA, nil, "", "", 200)
		if e != nil {
			return e
		}
		status, e := decode[map[string]any](r)
		if e != nil {
			return e
		}
		if status["sourcing_approval_enabled"] != false {
			return fmt.Errorf("unverified sourcing approval is enabled")
		}
		for _, token := range []string{h.tokenA, h.reviewer, h.agent} {
			for _, path := range []string{"/api/approvals", f.path + "/sourcing-approval"} {
				r, e = h.req("POST", path, token, map[string]any{}, "", "", 403)
				if e != nil {
					return e
				}
				if !bytes.Contains(r.body, []byte("APPROVAL_UNAVAILABLE")) {
					return fmt.Errorf("disabled approval lacks explicit error code")
				}
			}
		}
		_, e = h.req("POST", f.path+"/sourcing-approval", h.tokenB, map[string]any{}, "", "", 404)
		return e
	}); e != nil {
		return e
	}
	if e := h.check("connector discovery lists actual enabled local adapters and explicitly reports absent external providers", func() error {
		var e error
		state, e = h.adaptiveRead(f.path)
		if e != nil {
			return e
		}
		if state.ScionRevision != 1 || state.ExternalConnectorsAvailable || len(state.UnresolvedGaps) == 0 || len(state.Plans) != 0 || len(state.Comparisons) != 0 {
			return fmt.Errorf("new discovery invented evidence or lost unknowns")
		}
		seen := map[string]bool{}
		for _, c := range state.Connectors {
			if (c.ID != "handler_intake" && c.ID != "scion_sources") || !c.Enabled || c.Description == "" || seen[c.ID] {
				return fmt.Errorf("unexpected/invented connector: %+v", c)
			}
			seen[c.ID] = true
		}
		if !seen["handler_intake"] || !seen["scion_sources"] {
			return fmt.Errorf("local intake/source adapters not discovered")
		}
		return nil
	}); e != nil {
		return e
	}
	queueBody := map[string]any{"task_kind": "prepare_capability_plan", "candidate_proposal": map[string]any{"synthetic": true}, "timeout_seconds": 240}
	if e := h.check("name-only drafts may discover connectors but cannot queue an invented capability plan", func() error {
		draft := intake{Name: "SYNTHETIC no description " + h.runID, ProductCategory: "digital", ChangeSummary: "Description intentionally unknown"}
		r, e := h.req("POST", "/api/scions", h.tokenA, draft, "adaptive-empty-description", "", 201)
		if e != nil {
			return e
		}
		created, e := decode[scion](r)
		if e != nil {
			return e
		}
		path := "/api/scions/" + created.ID
		s, e := h.adaptiveRead(path)
		if e != nil {
			return e
		}
		if len(s.UnresolvedGaps) == 0 || len(s.Plans) != 0 {
			return fmt.Errorf("empty description lost explicit gaps")
		}
		_, e = h.sourceReq("POST", path+"/agent-tasks", h.tokenA, queueBody, "adaptive-empty-description-task", `"1"`, 422)
		return e
	}); e != nil {
		return e
	}
	var task agentTask
	if e := h.check("adaptive tasks require Handler dispatch, reject invented candidates, and retry one revision-bound task", func() error {
		if _, e := h.sourceReq("POST", f.path+"/agent-tasks", h.agent, queueBody, "adaptive-agent-queue-denied", `"1"`, 403); e != nil {
			return e
		}
		bad := objectMap(queueBody)
		bad["candidate_proposal"].(map[string]any)["connectors"] = []string{"invented_provider"}
		if _, e := h.sourceReq("POST", f.path+"/agent-tasks", h.tokenA, bad, "adaptive-invented-candidate", `"1"`, 422); e != nil {
			return e
		}
		var e error
		task, e = h.adaptiveTask(f.path, "main", 1)
		if e != nil {
			return e
		}
		retry, e := h.adaptiveTask(f.path, "main", 1)
		if e != nil {
			return e
		}
		if task.ID == "" || retry.ID != task.ID || task.Revision != 1 || task.Status != "queued" || task.Lease != "" || len(task.Input) != 0 {
			return fmt.Errorf("queue did not retain exact revision/content boundary")
		}
		_, e = h.sourceReq("POST", "/api/agent/tasks/"+task.ID+"/claim", h.agent, nil, "", "", 409)
		return e
	}); e != nil {
		return e
	}
	var candidate struct {
		Candidate struct {
			Intake         json.RawMessage     `json:"intake"`
			UnresolvedGaps []string            `json:"unresolved_gaps"`
			Connectors     []adaptiveConnector `json:"connectors"`
		} `json:"candidate_proposal"`
	}
	if e := h.check("claimed capability task exposes only pinned Handler intake and actual connector discovery", func() error {
		var e error
		task, e = h.adaptiveClaim(f.path, task, 1)
		if e != nil {
			return e
		}
		if e = json.Unmarshal(task.Input, &candidate); e != nil {
			return e
		}
		if task.Status != "running" || task.Lease == "" || task.Revision != 1 || len(candidate.Candidate.UnresolvedGaps) == 0 || !bytes.Contains(candidate.Candidate.Intake, []byte("pottery")) || len(candidate.Candidate.Connectors) != 2 {
			return fmt.Errorf("claimed capability task lacks current intake, connectors or explicit gaps: %s", task.Input)
		}
		return nil
	}); e != nil {
		return e
	}
	planBody := adaptivePlanBody(candidate.Candidate.UnresolvedGaps)
	var plan adaptivePlan
	var planResponse response
	if e := h.check("adaptive reads and writes reject missing authentication and missing revision preconditions", func() error {
		for _, route := range []struct {
			method, suffix string
			body           any
		}{
			{"GET", "/capabilities", nil}, {"POST", "/capability-plans", planBody}, {"POST", "/evidence-comparisons", adaptiveComparisonBody("00000000-0000-4000-8000-000000000001", nil)},
		} {
			if _, e := h.sourceReq(route.method, f.path+route.suffix, "", route.body, "adaptive-unauth-"+route.suffix, `"1"`, 401); e != nil {
				return e
			}
		}
		r, e := h.client.request("POST", f.path+"/capability-plans", h.agent, planBody, map[string]string{"Idempotency-Key": h.runID + "-adaptive-no-match", "X-Grimoire-Task-Id": task.ID, "X-Grimoire-Task-Lease": task.Lease})
		if e != nil {
			return e
		}
		return expectStatus(r, 428)
	}); e != nil {
		return e
	}
	if e := h.check("capability proposals require an active agent lease and reject unknown connectors or erased gaps", func() error {
		if _, e := h.sourceReq("POST", f.path+"/capability-plans", h.tokenA, planBody, "adaptive-handler-plan", `"1"`, 403); e != nil {
			return e
		}
		if _, e := h.sourceReq("POST", f.path+"/capability-plans", h.agent, planBody, "adaptive-unleased-plan", `"1"`, 409); e != nil {
			return e
		}
		for _, connector := range []string{"invented_provider", "external_web"} {
			bad := objectMap(planBody)
			bad["capabilities"].([]any)[0].(map[string]any)["connector_ids"] = []string{connector}
			if _, e := h.agentProposal(f.path+"/capability-plans", bad, "adaptive-connector-"+connector, task, 422); e != nil {
				return e
			}
		}
		bad := objectMap(planBody)
		bad["unresolved_gaps"] = []string{}
		_, e := h.agentProposal(f.path+"/capability-plans", bad, "adaptive-erased-gaps", task, 422)
		return e
	}); e != nil {
		return e
	}
	if e := h.check("leased capability plan is immutable, idempotent and bound to the originating Scion revision and task", func() error {
		var e error
		planResponse, e = h.agentProposal(f.path+"/capability-plans", planBody, "adaptive-plan", task, 201)
		if e != nil {
			return e
		}
		plan, e = decode[adaptivePlan](planResponse)
		if e != nil {
			return e
		}
		if plan.ID == "" || plan.AgentTaskID != task.ID || plan.ScionRevision != 1 || plan.Status != "current" || plan.CreatedBy == "" || plan.CreatedAt == "" || !equalJSON(plan.Input, mustJSON(planBody)) {
			return fmt.Errorf("proposal lost immutable input/provenance: %s", planResponse.body)
		}
		retry, e := h.agentProposal(f.path+"/capability-plans", planBody, "adaptive-plan", task, 201)
		if e != nil {
			return e
		}
		if e = equalReplay(planResponse, retry); e != nil {
			return e
		}
		bad := objectMap(planBody)
		bad["summary"] = "Changed same-key proposal"
		_, e = h.agentProposal(f.path+"/capability-plans", bad, "adaptive-plan", task, 409)
		return e
	}); e != nil {
		return e
	}
	if e := h.check("capability task completion retries retain proposal status without reviewer confirmation", func() error {
		if e := h.adaptiveComplete(task, plan.ID); e != nil {
			return e
		}
		s, e := h.adaptiveRead(f.path)
		if e != nil {
			return e
		}
		p, e := adaptiveFindPlan(s, plan.ID)
		if e != nil {
			return e
		}
		if !equalJSON(mustJSON(plan), mustJSON(p)) {
			return fmt.Errorf("completion mutated capability proposal")
		}
		_, e = h.sourceReq("POST", f.path+"/evidence-comparisons", h.agent, adaptiveComparisonBody(plan.ID, nil), "adaptive-agent-cannot-review", `"1"`, 403)
		return e
	}); e != nil {
		return e
	}
	if e := h.check("adaptive routes hide cross-organization cases with identical unknown-case errors and no identity headers", func() error {
		unknown := "/api/scions/00000000-0000-4000-8000-000000000001"
		for _, endpoint := range []struct {
			method, suffix string
			body           any
		}{
			{"GET", "/capabilities", nil}, {"POST", "/capability-plans", planBody}, {"POST", "/evidence-comparisons", adaptiveComparisonBody(plan.ID, nil)},
			{"POST", "/agent-tasks", queueBody}, {"GET", "/agent-tasks", nil}, {"GET", "/agent-tasks/" + task.ID + "/events", nil},
		} {
			foreign, e := h.sourceReq(endpoint.method, f.path+endpoint.suffix, h.tokenB, endpoint.body, "adaptive-foreign-"+endpoint.suffix, `"1"`, 404)
			if e != nil {
				return e
			}
			missing, e := h.sourceReq(endpoint.method, unknown+endpoint.suffix, h.tokenB, endpoint.body, "adaptive-unknown-"+endpoint.suffix, `"1"`, 404)
			if e != nil {
				return e
			}
			if !equalJSON(foreign.body, missing.body) || foreign.header.Get("ETag") != "" || foreign.header.Get("Location") != "" {
				return fmt.Errorf("foreign case leaked through %s", endpoint.suffix)
			}
		}
		return nil
	}); e != nil {
		return e
	}
	var missing adaptiveComparison
	if e := h.check("comparison without evidence preserves explicit gaps and never invents claims or provider listings", func() error {
		r, e := h.sourceReq("POST", f.path+"/evidence-comparisons", h.tokenA, adaptiveComparisonBody(plan.ID, nil), "adaptive-no-evidence", `"1"`, 201)
		if e != nil {
			return e
		}
		missing, e = decode[adaptiveComparison](r)
		if e != nil {
			return e
		}
		if missing.ID == "" || missing.VerificationStatus != "unverified" || len(missing.Evidence) != 0 || len(missing.UnresolvedGaps) == 0 {
			return fmt.Errorf("missing evidence turned into facts: %s", r.body)
		}
		return nil
	}); e != nil {
		return e
	}
	if e := h.check("unpermitted synthetic website source cannot enter an evidence comparison", func() error {
		input := sourceInput{Title: "Unpermitted website note", Origin: "synthetic://unpermitted", Owner: "Synthetic unknown permission", Synthetic: true, SourceText: "This must never become evidence.", RightsStatus: "unknown", PermittedUse: "scion_review", ChangeSummary: "Missing permission test"}
		_, e := h.sourceReq("POST", f.path+"/sources", h.tokenA, input, "adaptive-missing-rights", `"1"`, 403)
		return e
	}); e != nil {
		return e
	}
	var sourcePaths, claims []string
	var sourceInputs []sourceInput
	var mcp *liveMCP
	defer func() { mcp.close() }()
	if e := h.check("authorized synthetic website claims retain exact versioned source hashes and UTF-8 locators", func() error {
		for i, statement := range []string{"Synthetic approach A: the café class page can be edited by its Handler.", "Synthetic approach B: the workshop page is edited in a local text file."} {
			path, claim, input, e := h.adaptiveSource(f.path, fmt.Sprintf("main-%d", i), statement)
			if e != nil {
				return e
			}
			sourcePaths = append(sourcePaths, path)
			claims = append(claims, claim)
			sourceInputs = append(sourceInputs, input)
		}
		return nil
	}); e != nil {
		return e
	}
	if e := h.check("real MCP stdio discovers only read-only tools and reads authorized source bytes through Rust", func() error {
		var e error
		mcp, e = h.startMCP(h.tokenA)
		if e != nil {
			return e
		}
		r, e := mcp.request("tools/list", map[string]any{})
		if e != nil {
			return e
		}
		var list struct {
			Tools []struct {
				Name        string `json:"name"`
				Annotations struct {
					ReadOnlyHint    bool `json:"readOnlyHint"`
					DestructiveHint bool `json:"destructiveHint"`
				} `json:"annotations"`
			} `json:"tools"`
		}
		if e = json.Unmarshal(r, &list); e != nil {
			return e
		}
		seen := map[string]bool{}
		for _, tool := range list.Tools {
			if !tool.Annotations.ReadOnlyHint || tool.Annotations.DestructiveHint || seen[tool.Name] {
				return fmt.Errorf("MCP tool is not uniquely read-only")
			}
			seen[tool.Name] = true
		}
		if len(seen) != 3 || !seen["grimoire_discover_connectors"] || !seen["grimoire_read_intake"] || !seen["grimoire_read_source"] {
			return fmt.Errorf("MCP has unexpected or missing tools")
		}
		scionID := f.path[strings.LastIndex(f.path, "/")+1:]
		sourceID := sourcePaths[0][strings.LastIndex(sourcePaths[0], "/")+1:]
		for _, tool := range []string{"grimoire_read_intake", "grimoire_discover_connectors", "grimoire_read_source"} {
			args := map[string]string{"scion_id": scionID}
			if tool == "grimoire_read_source" {
				args["source_id"] = sourceID
			}
			body, isError, e := mcp.tool(tool, args)
			if e != nil {
				return e
			}
			if isError {
				return fmt.Errorf("MCP authorized %s failed: %s", tool, body)
			}
			if tool == "grimoire_read_source" {
				var source struct {
					Revisions []struct {
						SourceText string `json:"source_text"`
					} `json:"revisions"`
					Claims []sourceClaim `json:"claims"`
				}
				if e = json.Unmarshal(body, &source); e != nil {
					return e
				}
				if len(source.Revisions) != 1 || source.Revisions[0].SourceText != sourceInputs[0].SourceText || len(source.Claims) != 1 || source.Claims[0].VerificationStatus != "unverified" {
					return fmt.Errorf("MCP failed exact source/claim provenance")
				}
			}
		}
		return nil
	}); e != nil {
		return e
	}
	if e := h.check("real MCP rejects another organization's intake, discovery and source reads without content", func() error {
		foreign, e := h.startMCP(h.tokenB)
		if e != nil {
			return e
		}
		defer foreign.close()
		scionID := f.path[strings.LastIndex(f.path, "/")+1:]
		sourceID := sourcePaths[0][strings.LastIndex(sourcePaths[0], "/")+1:]
		for _, tool := range []string{"grimoire_read_intake", "grimoire_discover_connectors", "grimoire_read_source"} {
			args := map[string]string{"scion_id": scionID}
			if tool == "grimoire_read_source" {
				args["source_id"] = sourceID
			}
			body, isError, e := foreign.tool(tool, args)
			if e != nil {
				return e
			}
			if !isError || !equalJSON(body, []byte(`{"error":"RESOURCE_UNAVAILABLE"}`)) {
				return fmt.Errorf("MCP disclosed cross-organization %s: %s", tool, body)
			}
		}
		return nil
	}); e != nil {
		return e
	}
	comparisonBody := adaptiveComparisonBody(plan.ID, claims)
	var comparison adaptiveComparison
	var comparisonResponse response
	if e := h.check("comparison requests require current revision and reject forged approval or verified status", func() error {
		if _, e := h.sourceReq("POST", f.path+"/evidence-comparisons", h.tokenA, comparisonBody, "adaptive-comparison-no-match", "", 428); e != nil {
			return e
		}
		for _, field := range []string{"verified", "approved"} {
			bad := objectMap(comparisonBody)
			bad[field] = true
			if _, e := h.sourceReq("POST", f.path+"/evidence-comparisons", h.tokenA, bad, "adaptive-forged-"+field, `"1"`, 422); e != nil {
				return e
			}
		}
		return nil
	}); e != nil {
		return e
	}
	if e := h.check("reviewable comparison uses only authorized exact claims and remains explicitly unverified on retry", func() error {
		var e error
		comparisonResponse, e = h.sourceReq("POST", f.path+"/evidence-comparisons", h.tokenA, comparisonBody, "adaptive-comparison", `"1"`, 201)
		if e != nil {
			return e
		}
		comparison, e = decode[adaptiveComparison](comparisonResponse)
		if e != nil {
			return e
		}
		if comparison.ID == "" || comparison.PlanID != plan.ID || comparison.ScionRevision != 1 || comparison.Status != "reviewable" || comparison.VerificationStatus != "unverified" || len(comparison.Evidence) != 2 || len(comparison.UnresolvedGaps) == 0 {
			return fmt.Errorf("comparison lost scope/evidence/proposal-only state: %s", comparisonResponse.body)
		}
		for _, evidence := range comparison.Evidence {
			index := -1
			for i, id := range claims {
				if evidence.ID == id {
					index = i
				}
			}
			if index < 0 {
				return fmt.Errorf("comparison included an invented claim")
			}
			input := sourceInputs[index]
			if evidence.SourceRevision != 1 || evidence.ContentSHA256 != fmt.Sprintf("%x", sha256.Sum256([]byte(input.SourceText))) || evidence.VerificationStatus != "unverified" || evidence.Locator.StartByte < 0 || evidence.Locator.EndByte > len([]byte(input.SourceText)) || string([]byte(input.SourceText)[evidence.Locator.StartByte:evidence.Locator.EndByte]) != evidence.Locator.Quote || evidence.Statement != evidence.Locator.Quote {
				return fmt.Errorf("comparison evidence lost exact locator/hash or asserted verification")
			}
		}
		retry, e := h.sourceReq("POST", f.path+"/evidence-comparisons", h.tokenA, comparisonBody, "adaptive-comparison", `"1"`, 201)
		if e != nil {
			return e
		}
		if e = equalReplay(comparisonResponse, retry); e != nil {
			return e
		}
		bad := objectMap(comparisonBody)
		bad["change_summary"] = "Changed same-key comparison must not rewrite history"
		_, e = h.sourceReq("POST", f.path+"/evidence-comparisons", h.tokenA, bad, "adaptive-comparison", `"1"`, 409)
		return e
	}); e != nil {
		return e
	}
	if e := h.check("unknown capabilities, missing claims and cross-case plan or claim bindings are rejected", func() error {
		bad := objectMap(comparisonBody)
		bad["alternatives"].([]any)[0].(map[string]any)["criteria"].([]any)[0].(map[string]any)["capability_key"] = "invented_capability"
		if _, e := h.sourceReq("POST", f.path+"/evidence-comparisons", h.tokenA, bad, "adaptive-unknown-capability", `"1"`, 422); e != nil {
			return e
		}
		bad = adaptiveComparisonBody(plan.ID, []string{"00000000-0000-4000-8000-000000000001", claims[1]})
		if _, e := h.sourceReq("POST", f.path+"/evidence-comparisons", h.tokenA, bad, "adaptive-unknown-claim", `"1"`, 404); e != nil {
			return e
		}
		other, e := h.newAdaptiveFixture("foreign-case")
		if e != nil {
			return e
		}
		if _, e = h.sourceReq("POST", other.path+"/evidence-comparisons", h.tokenA, comparisonBody, "adaptive-cross-case-plan", `"1"`, 404); e != nil {
			return e
		}
		_, foreignClaim, _, e := h.adaptiveSource(other.path, "foreign-case", "Synthetic foreign case claim must never bind to another Scion.")
		if e != nil {
			return e
		}
		_, e = h.sourceReq("POST", f.path+"/evidence-comparisons", h.tokenA, adaptiveComparisonBody(plan.ID, []string{foreignClaim, claims[1]}), "adaptive-cross-case-claim", `"1"`, 404)
		return e
	}); e != nil {
		return e
	}
	if e := h.check("plan, comparison, intake and task provenance survive a real Rust API restart unchanged", func() error {
		if e := h.restartSources(); e != nil {
			return e
		}
		s, e := h.adaptiveRead(f.path)
		if e != nil {
			return e
		}
		p, e := adaptiveFindPlan(s, plan.ID)
		if e != nil {
			return e
		}
		c, e := adaptiveFindComparison(s, comparison.ID)
		if e != nil {
			return e
		}
		if !equalJSON(mustJSON(plan), mustJSON(p)) || !equalJSON(mustJSON(comparison), mustJSON(c)) {
			return fmt.Errorf("persisted adaptive history changed across restart")
		}
		r, e := h.req("GET", f.path, h.tokenA, nil, "", "", 200)
		if e != nil {
			return e
		}
		if !equalJSON(f.initial.body, r.body) {
			return fmt.Errorf("adaptive operations rewrote original intake")
		}
		r, e = h.sourceReq("GET", f.path+"/agent-tasks", h.tokenA, nil, "", "", 200)
		if e != nil {
			return e
		}
		list, e := decode[struct {
			Tasks []agentTask `json:"tasks"`
		}](r)
		if e != nil {
			return e
		}
		if len(list.Tasks) != 1 || list.Tasks[0].Status != "completed" || list.Tasks[0].ProposalID == nil || *list.Tasks[0].ProposalID != plan.ID {
			return fmt.Errorf("task completion not durable")
		}
		return nil
	}); e != nil {
		return e
	}
	if e := h.check("revocation blocks comparison retries and removes source statements and quotations from already available results", func() error {
		if _, e := h.sourceReq("POST", sourcePaths[0]+"/revoke", h.tokenA, map[string]string{"reason": "Synthetic adaptive source author withdrew permission"}, "adaptive-revoke", `"1"`, 201); e != nil {
			return e
		}
		if _, e := h.sourceReq("POST", f.path+"/evidence-comparisons", h.tokenA, comparisonBody, "adaptive-comparison", `"1"`, 403); e != nil {
			return e
		}
		r, e := h.sourceReq("GET", f.path+"/capabilities", h.tokenA, nil, "", "", 200)
		if e != nil {
			return e
		}
		s, e := decode[adaptiveState](r)
		if e != nil {
			return e
		}
		c, e := adaptiveFindComparison(s, comparison.ID)
		if e != nil {
			return e
		}
		if c.Status != "blocked" || string(c.Input) != "null" || len(c.Evidence) != 0 || c.BlockedReason == nil {
			return fmt.Errorf("revoked comparison retained derived content")
		}
		for _, source := range sourceInputs {
			if bytes.Contains(r.body, []byte(strings.Split(source.SourceText, "\n")[1])) {
				return fmt.Errorf("revoked comparison leaked quotation")
			}
		}
		_, e = h.sourceReq("GET", f.path+"/capabilities", h.tokenB, nil, "", "", 404)
		return e
	}); e != nil {
		return e
	}
	if e := h.check("already open real MCP session stops returning revoked source bytes and derived quotations", func() error {
		scionID := f.path[strings.LastIndex(f.path, "/")+1:]
		sourceID := sourcePaths[0][strings.LastIndex(sourcePaths[0], "/")+1:]
		body, isError, e := mcp.tool("grimoire_read_source", map[string]string{"scion_id": scionID, "source_id": sourceID})
		if e != nil {
			return e
		}
		if !isError || !equalJSON(body, []byte(`{"error":"PERMISSION_DENIED"}`)) {
			return fmt.Errorf("MCP retained revoked source content: %s", body)
		}
		body, isError, e = mcp.tool("grimoire_discover_connectors", map[string]string{"scion_id": scionID})
		if e != nil {
			return e
		}
		if isError {
			return fmt.Errorf("MCP should retain safe discovery metadata")
		}
		var saved adaptiveState
		if e = json.Unmarshal(body, &saved); e != nil {
			return e
		}
		c, e := adaptiveFindComparison(saved, comparison.ID)
		if e != nil {
			return e
		}
		if c.Status != "blocked" || string(c.Input) != "null" || len(c.Evidence) != 0 {
			return fmt.Errorf("MCP discovery retained derived content after revocation")
		}
		return nil
	}); e != nil {
		return e
	}
	if e := h.check("revoked comparison content remains withheld after another real API restart", func() error {
		if e := h.restartSources(); e != nil {
			return e
		}
		s, e := h.adaptiveRead(f.path)
		if e != nil {
			return e
		}
		c, e := adaptiveFindComparison(s, comparison.ID)
		if e != nil {
			return e
		}
		if c.Status != "blocked" || string(c.Input) != "null" || len(c.Evidence) != 0 {
			return fmt.Errorf("restart restored revoked comparison content")
		}
		_, e = h.sourceReq("POST", f.path+"/evidence-comparisons", h.tokenA, comparisonBody, "adaptive-revoked-after-restart", `"1"`, 403)
		return e
	}); e != nil {
		return e
	}
	return h.adaptiveStaleChecks()
}

func mustJSON(value any) []byte { data, _ := json.Marshal(value); return data }

func (h *harness) adaptiveStaleChecks() error {
	f, e := h.newAdaptiveFixture("stale")
	if e != nil {
		return e
	}
	task, e := h.adaptiveTask(f.path, "stale", 1)
	if e != nil {
		return e
	}
	task, e = h.adaptiveClaim(f.path, task, 1)
	if e != nil {
		return e
	}
	s, e := h.adaptiveRead(f.path)
	if e != nil {
		return e
	}
	body := adaptivePlanBody(s.UnresolvedGaps)
	r, e := h.agentProposal(f.path+"/capability-plans", body, "adaptive-stale-plan", task, 201)
	if e != nil {
		return e
	}
	plan, e := decode[adaptivePlan](r)
	if e != nil {
		return e
	}
	if e = h.adaptiveComplete(task, plan.ID); e != nil {
		return e
	}
	sourcePath, claimID, sourceInput, e := h.adaptiveSource(f.path, "stale-source", "Synthetic stale approach: its class page can be edited locally.")
	if e != nil {
		return e
	}
	comparisonBody := adaptiveComparisonBody(plan.ID, []string{claimID})
	r, e = h.sourceReq("POST", f.path+"/evidence-comparisons", h.tokenA, comparisonBody, "adaptive-stale-comparison", `"1"`, 201)
	if e != nil {
		return e
	}
	comparison, e := decode[adaptiveComparison](r)
	if e != nil {
		return e
	}
	if e = h.check("new source revisions invalidate earlier exact-claim comparison bindings without overwriting their history", func() error {
		sourceInput.SourceText += "Synthetic changed source revision.\n"
		sourceInput.ChangeSummary = "Record changed synthetic description in revision two"
		if _, e := h.sourceReq("POST", sourcePath+"/revisions", h.tokenA, sourceInput, "adaptive-source-revision-two", `"1"`, 201); e != nil {
			return e
		}
		if _, e := h.sourceReq("POST", f.path+"/evidence-comparisons", h.tokenA, comparisonBody, "adaptive-old-source-denied", `"1"`, 409); e != nil {
			return e
		}
		s, e := h.adaptiveRead(f.path)
		if e != nil {
			return e
		}
		c, e := adaptiveFindComparison(s, comparison.ID)
		if e != nil {
			return e
		}
		if c.Status != "blocked" || len(c.Evidence) != 0 || string(c.Input) != "null" {
			return fmt.Errorf("stale source comparison not redacted")
		}
		p, e := adaptiveFindPlan(s, plan.ID)
		if e != nil {
			return e
		}
		if !equalJSON(mustJSON(plan), mustJSON(p)) {
			return fmt.Errorf("source mutation rewrote plan revision")
		}
		return nil
	}); e != nil {
		return e
	}
	queued, e := h.adaptiveTask(f.path, "stale-queued", 1)
	if e != nil {
		return e
	}
	running, e := h.adaptiveTask(f.path, "stale-running", 1)
	if e != nil {
		return e
	}
	running, e = h.adaptiveClaim(f.path, running, 1)
	if e != nil {
		return e
	}
	if e = h.check("intake revision changes reject queued dispatch, running proposals and earlier capability-plan comparisons", func() error {
		changed := f.draft
		changed.ChangeSummary = "Handler changes website scope explicitly"
		text := *changed.ProductDescription + " The site now needs a separately assessed booking workflow."
		changed.ProductDescription = &text
		if _, e := h.req("POST", f.path+"/revisions", h.tokenA, changed, "adaptive-intake-revision-two", `"1"`, 201); e != nil {
			return e
		}
		if _, e := h.sourceReq("POST", f.path+"/agent-tasks/"+queued.ID+"/dispatch", h.tokenA, nil, "", `"1"`, 412); e != nil {
			return e
		}
		if _, e := h.agentProposal(f.path+"/capability-plans", body, "adaptive-stale-running-proposal", running, 412); e != nil {
			return e
		}
		if _, e := h.sourceReq("POST", f.path+"/evidence-comparisons", h.tokenA, adaptiveComparisonBody(plan.ID, nil), "adaptive-stale-plan-base", `"1"`, 412); e != nil {
			return e
		}
		if _, e := h.sourceReq("POST", f.path+"/evidence-comparisons", h.tokenA, adaptiveComparisonBody(plan.ID, nil), "adaptive-stale-plan-current", `"2"`, 409); e != nil {
			return e
		}
		s, e := h.adaptiveRead(f.path)
		if e != nil {
			return e
		}
		p, e := adaptiveFindPlan(s, plan.ID)
		if e != nil {
			return e
		}
		if p.Status != "stale" || p.ScionRevision != 1 || p.AgentTaskID != plan.AgentTaskID || p.CreatedAt != plan.CreatedAt || p.CreatedBy != plan.CreatedBy {
			return fmt.Errorf("stale plan lost original revision metadata")
		}
		r, e := h.req("GET", f.path+"/revisions/1", h.tokenA, nil, "", "", 200)
		if e != nil {
			return e
		}
		old, e := decode[scion](f.initial)
		if e != nil {
			return e
		}
		if !equalJSON(old.Revision, r.body) {
			return fmt.Errorf("original intake revision changed")
		}
		return nil
	}); e != nil {
		return e
	}
	return h.check("stale running task rejects completion and releases its lease through explicit failure", func() error {
		result := map[string]any{"proposal_id": plan.ID, "provider_run_id": "stale-synthetic-test", "output_sha256": strings.Repeat("7", 64), "preparation_note": "Stale completion must be rejected."}
		r, e := h.client.request("POST", "/api/agent/tasks/"+running.ID+"/result", h.agent, result, map[string]string{"X-Grimoire-Task-Lease": running.Lease})
		if e != nil {
			return e
		}
		if e = expectStatus(r, 412); e != nil {
			return e
		}
		r, e = h.client.request("POST", "/api/agent/tasks/"+running.ID+"/fail", h.agent, map[string]string{"failure_code": "SYNTHETIC_ADAPTIVE_STALE_INPUT"}, map[string]string{"X-Grimoire-Task-Lease": running.Lease})
		if e != nil {
			return e
		}
		return expectStatus(r, 200)
	})
}
