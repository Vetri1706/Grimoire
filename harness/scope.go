package main

// Scope checks use only the running Rust HTTP API. Synthetic source statements
// explicitly provide each identity; the harness never manufactures production evidence.
import (
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"strings"
	"sync"
)

type scopeProposal struct {
	ID            string            `json:"id"`
	ScionID       string            `json:"scion_id"`
	ScionRevision int               `json:"scion_revision"`
	CreatedBy     string            `json:"created_by"`
	Input         json.RawMessage   `json:"input"`
	Blockers      []json.RawMessage `json:"blockers"`
	Confirmation  json.RawMessage   `json:"confirmation"`
}
type scopeFixture struct {
	path          string
	draft         intake
	proposal      map[string]any
	sources       []sourceInput
	sourcePaths   []string
	snapshots     []response
	scionSnapshot response
}

func (h *harness) newScopeFixture(label string) (scopeFixture, error) {
	f := scopeFixture{}
	description := "Synthetic controlled enclosure article for scope binding tests only."
	decision := "Confirm only the explicitly documented synthetic physical identity chain."
	requirements := []string{"Synthetic target width 120 mm"}
	questions := []string{}
	f.draft = intake{Name: "SYNTHETIC scope " + label + " " + h.runID, ProductDescription: &description, ProductCategory: "physical", Decision: &decision, Requirements: &requirements, Questions: &questions, ChangeSummary: "Synthetic physical scope setup"}
	res, err := h.req("POST", "/api/scions", h.tokenA, f.draft, "scope-"+label+"-scion", "", 201)
	if err != nil {
		return f, err
	}
	created, err := decode[scion](res)
	if err != nil {
		return f, err
	}
	f.path = "/api/scions/" + created.ID
	f.scionSnapshot = res
	suffix := h.runID + "-" + label
	f.proposal = map[string]any{
		"synthetic": true, "identity_match": "exact",
		"configuration": map[string]any{"product_code": "SYN-P-" + suffix, "product_name": "Synthetic enclosure", "configuration_code": "SYN-CFG-A", "specification": map[string]any{"enclosure": "Synthetic controlled enclosure configuration"}},
		"component":     map[string]any{"internal_part_code": "SYN-C-" + suffix, "manufacturer": "Synthetic manufacturer", "part_number": "SYN-PART-001", "attributes": map[string]any{"material": "synthetic aluminum"}},
		"occurrence":    map[string]any{"path": "/synthetic/enclosure[1]", "quantity": "1", "uom": "EA"},
		"requirement":   map[string]any{"code": "SYN-WIDTH-001", "criteria": map[string]any{"target_width_mm": 120}},
		"case_code":     "SYN-CASE-" + suffix, "case_title": "Synthetic enclosure scope " + label,
		"unresolved_gaps": []string{}, "change_summary": "Handler proposes explicit synthetic exact scope for separate engineering review",
	}
	statements := []string{
		"Configuration: product SYN-P-" + suffix + ", Synthetic enclosure, configuration SYN-CFG-A; specification Synthetic controlled enclosure configuration.",
		"Component: SYN-C-" + suffix + ", manufacturer Synthetic manufacturer, part SYN-PART-001; material synthetic aluminum.",
		"Exact BOM occurrence: /synthetic/enclosure[1], quantity 1, unit EA; uses the named configuration and component above.",
		"Requirement: SYN-WIDTH-001, target_width_mm = 120 for this exact enclosure occurrence.",
	}
	refs := []map[string]any{}
	for i, kind := range []string{"configuration", "component", "occurrence", "requirement"} {
		text := "SYNTHETIC TEST SOURCE — no manufacturer evidence.\n" + statements[i] + "\n"
		input := sourceInput{Title: "SYNTHETIC " + kind + " " + label, Origin: "Harness authored synthetic controlled fixture", Owner: "Synthetic local test owner", Synthetic: true, SourceText: text, RightsStatus: "granted", PermissionBasis: "Synthetic test author permits this local test", PermittedUse: "scion_review", ChangeSummary: "Initial explicit synthetic identity source"}
		r, e := h.sourceReq("POST", f.path+"/sources", h.tokenA, input, fmt.Sprintf("scope-%s-source-%d", label, i), `"1"`, 201)
		if e != nil {
			return f, e
		}
		receipt, e := decode[sourceReceipt](r)
		if e != nil {
			return f, e
		}
		path := f.path + "/sources/" + receipt.SourceID
		start := strings.Index(text, statements[i])
		claim := claimInput{Statement: statements[i], Locator: claimLocator{StartByte: start, EndByte: start + len([]byte(statements[i])), Quote: statements[i]}}
		_, e = h.sourceReq("POST", path+"/revisions/1/claims", h.tokenA, claim, fmt.Sprintf("scope-%s-claim-%d", label, i), "", 201)
		if e != nil {
			return f, e
		}
		claims, e := h.sourceReq("GET", path+"/revisions/1/claims", h.tokenA, nil, "", "", 200)
		if e != nil {
			return f, e
		}
		list, e := decode[struct {
			Claims []sourceClaim `json:"claims"`
		}](claims)
		if e != nil || len(list.Claims) != 1 {
			return f, fmt.Errorf("expected one exact claim: %v", e)
		}
		refs = append(refs, map[string]any{"kind": kind, "source_id": receipt.SourceID, "source_revision": 1, "claim_id": list.Claims[0].ID, "content_sha256": fmt.Sprintf("%x", sha256.Sum256([]byte(text))), "start_byte": start, "end_byte": start + len([]byte(statements[i]))})
		snapshot, e := h.sourceReq("GET", path+"/revisions/1", h.tokenA, nil, "", "", 200)
		if e != nil {
			return f, e
		}
		f.sources = append(f.sources, input)
		f.sourcePaths = append(f.sourcePaths, path)
		f.snapshots = append(f.snapshots, snapshot)
	}
	f.proposal["source_claims"] = refs
	return f, nil
}
func cloneScope(p map[string]any) map[string]any { return objectMap(p) }
func scopeRef(p map[string]any, i int) map[string]any {
	return p["source_claims"].([]any)[i].(map[string]any)
}
func (h *harness) propose(f scopeFixture, key string, body map[string]any, status int) (response, error) {
	return h.sourceReq("POST", f.path+"/scope/proposals", h.tokenA, body, key, `"1"`, status)
}
func confirmationBody() map[string]any {
	return map[string]any{"confirm_synthetic_scope": true, "review_note": "Synthetic test reviewer checked the four exact identities and source locators; no sourcing approval or real reviewer qualification is asserted."}
}
func (h *harness) runScope() error {
	var f scopeFixture
	if err := h.check("Layer 3 separate reviewer/agent capabilities and four explicit synthetic sources", func() error {
		for _, entry := range []struct {
			token                   string
			confirm, propose, agent bool
		}{{h.tokenA, false, true, false}, {h.reviewer, true, false, false}, {h.agent, false, true, true}} {
			res, e := h.req("GET", "/api/me", entry.token, nil, "", "", 200)
			if e != nil {
				return e
			}
			p, e := decode[struct {
				CanConfirm bool `json:"can_confirm_scope"`
				CanPropose bool `json:"can_propose_scope"`
				Agent      bool `json:"is_agent"`
			}](res)
			if e != nil {
				return e
			}
			if p.CanConfirm != entry.confirm || p.CanPropose != entry.propose || p.Agent != entry.agent {
				return fmt.Errorf("incorrect scope capabilities: %+v", p)
			}
		}
		var e error
		f, e = h.newScopeFixture("main")
		return e
	}); err != nil {
		return err
	}
	if err := h.check("scope proposal rejects missing identities, duplicate links, and invented extra approval", func() error {
		for i, mutate := range []func(map[string]any){func(p map[string]any) { delete(p, "component") }, func(p map[string]any) { p["source_claims"] = p["source_claims"].([]any)[:3] }, func(p map[string]any) { scopeRef(p, 1)["kind"] = "configuration" }, func(p map[string]any) { p["approved"] = true }} {
			p := cloneScope(f.proposal)
			mutate(p)
			if _, e := h.propose(f, fmt.Sprintf("scope-invalid-%d", i), p, 422); e != nil {
				return e
			}
		}
		return nil
	}); err != nil {
		return err
	}
	if err := h.check("scope rejects wrong source revision, claim identity, hash, and locator", func() error {
		cases := []struct {
			field  string
			value  any
			status int
		}{{"source_revision", 2, 409}, {"claim_id", "00000000-0000-4000-8000-000000000001", 422}, {"content_sha256", strings.Repeat("0", 64), 422}, {"start_byte", 0, 422}}
		for i, c := range cases {
			p := cloneScope(f.proposal)
			scopeRef(p, 0)[c.field] = c.value
			if _, e := h.propose(f, fmt.Sprintf("scope-wrong-%d", i), p, c.status); e != nil {
				return e
			}
		}
		return nil
	}); err != nil {
		return err
	}
	var other scopeFixture
	if err := h.check("scope rejects a valid source claim belonging to a different Scion", func() error {
		var e error
		other, e = h.newScopeFixture("other")
		if e != nil {
			return e
		}
		p := cloneScope(f.proposal)
		p["source_claims"].([]any)[0] = scopeRef(cloneScope(other.proposal), 0)
		_, e = h.propose(f, "scope-cross-case", p, 404)
		return e
	}); err != nil {
		return err
	}
	if err := h.check("ambiguous identities and unresolved gaps stay reviewable but cannot be confirmed", func() error {
		for i, mutate := range []func(map[string]any){func(p map[string]any) { p["identity_match"] = "ambiguous" }, func(p map[string]any) {
			p["unresolved_gaps"] = []string{"Controlled occurrence identity still unresolved"}
		}} {
			p := cloneScope(f.proposal)
			mutate(p)
			r, e := h.propose(f, fmt.Sprintf("scope-blocked-%d", i), p, 201)
			if e != nil {
				return e
			}
			saved, e := decode[scopeProposal](r)
			if e != nil {
				return e
			}
			if len(saved.Blockers) == 0 {
				return fmt.Errorf("missing blockers")
			}
			if _, e = h.sourceReq("POST", f.path+"/scope/proposals/"+saved.ID+"/confirm", h.reviewer, confirmationBody(), fmt.Sprintf("scope-block-confirm-%d", i), `"1"`, 409); e != nil {
				return e
			}
		}
		return nil
	}); err != nil {
		return err
	}
	var proposal scopeProposal
	var created response
	if err := h.check("exact physical scope proposal persists pinned revision IDs and locators", func() error {
		var e error
		created, e = h.propose(f, "scope-exact", f.proposal, 201)
		if e != nil {
			return e
		}
		proposal, e = decode[scopeProposal](created)
		if e != nil {
			return e
		}
		if proposal.ID == "" || proposal.ScionRevision != 1 || len(proposal.Blockers) != 0 || string(proposal.Confirmation) != "null" {
			return fmt.Errorf("unexpected proposal state: %s", created.body)
		}
		want, _ := json.Marshal(f.proposal)
		if !equalJSON(want, proposal.Input) {
			return fmt.Errorf("proposal changed explicit identity inputs")
		}
		return nil
	}); err != nil {
		return err
	}
	proposalPath := f.path + "/scope/proposals/" + proposal.ID
	if err := h.check("scope idempotent retry and conflicting-key rejection", func() error {
		replay, e := h.propose(f, "scope-exact", f.proposal, 201)
		if e != nil {
			return e
		}
		if e = equalReplay(created, replay); e != nil {
			return e
		}
		changed := cloneScope(f.proposal)
		changed["case_title"] = "Changed"
		_, e = h.propose(f, "scope-exact", changed, 409)
		return e
	}); err != nil {
		return err
	}
	if err := h.check("Handler and connected agent cannot confirm scope; agent cannot edit intake or sources", func() error {
		for i, token := range []string{h.tokenA, h.agent} {
			if _, e := h.sourceReq("POST", proposalPath+"/confirm", token, confirmationBody(), fmt.Sprintf("scope-deny-role-%d", i), `"1"`, 403); e != nil {
				return e
			}
		}
		if _, e := h.req("POST", f.path+"/revisions", h.agent, f.draft, "agent-edit-denied", `"1"`, 403); e != nil {
			return e
		}
		_, e := h.sourceReq("POST", f.path+"/sources", h.agent, f.sources[0], "agent-source-denied", `"1"`, 403)
		return e
	}); err != nil {
		return err
	}
	if err := h.check("scope list/detail/confirmation hide foreign organization and wrong Scion equally", func() error {
		for _, path := range []string{f.path + "/scope", proposalPath} {
			if _, e := h.sourceReq("GET", path, h.tokenB, nil, "", "", 404); e != nil {
				return e
			}
		}
		if _, e := h.sourceReq("POST", proposalPath+"/confirm", h.tokenB, confirmationBody(), "scope-foreign-confirm", `"1"`, 404); e != nil {
			return e
		}
		if _, e := h.sourceReq("POST", f.path+"/scope/proposals", h.tokenB, f.proposal, "scope-foreign-propose", `"1"`, 404); e != nil {
			return e
		}
		_, e := h.sourceReq("GET", other.path+"/scope/proposals/"+proposal.ID, h.tokenA, nil, "", "", 404)
		return e
	}); err != nil {
		return err
	}
	if err := h.check("scope confirmation requires current If-Match and explicit reviewer acknowledgement", func() error {
		if _, e := h.sourceReq("POST", proposalPath+"/confirm", h.reviewer, confirmationBody(), "scope-no-match", "", 428); e != nil {
			return e
		}
		if _, e := h.sourceReq("POST", proposalPath+"/confirm", h.reviewer, confirmationBody(), "scope-bad-match", `"2"`, 412); e != nil {
			return e
		}
		_, e := h.sourceReq("POST", proposalPath+"/confirm", h.reviewer, map[string]any{"confirm_synthetic_scope": false, "review_note": "No confirmation"}, "scope-not-ack", `"1"`, 422)
		return e
	}); err != nil {
		return err
	}
	var confirmed response
	winningKey := ""
	if err := h.check("concurrent confirmations create exactly one governed physical identity chain", func() error {
		results := make([]response, 2)
		errs := make([]error, 2)
		var wg sync.WaitGroup
		start := make(chan struct{})
		for i := range results {
			wg.Add(1)
			go func(i int) {
				defer wg.Done()
				<-start
				results[i], errs[i] = h.client.request("POST", proposalPath+"/confirm", h.reviewer, confirmationBody(), map[string]string{"If-Match": `"1"`, "Idempotency-Key": h.runID + fmt.Sprintf("-scope-race-%d", i)})
			}(i)
		}
		close(start)
		wg.Wait()
		winners := 0
		for i, r := range results {
			if errs[i] != nil {
				return errs[i]
			}
			if r.status == 201 {
				winners++
				confirmed = r
				winningKey = fmt.Sprintf("scope-race-%d", i)
			} else if r.status != 409 {
				return fmt.Errorf("race status=%d body=%s", r.status, r.body)
			}
		}
		if winners != 1 {
			return fmt.Errorf("%d confirmation winners", winners)
		}
		p, e := decode[scopeProposal](confirmed)
		if e != nil {
			return e
		}
		var links map[string]any
		if e = json.Unmarshal(p.Confirmation, &links); e != nil {
			return e
		}
		for _, key := range []string{"configuration_revision_id", "component_revision_id", "occurrence_revision_id", "requirement_revision_id", "sourcing_case_id", "sourcing_case_revision_id", "confirmed_by"} {
			if value, ok := links[key].(string); !ok || value == "" {
				return fmt.Errorf("confirmation lacks %s", key)
			}
		}
		chain, ok := links["governed_chain"].(map[string]any)
		if !ok || chain["consistent"] != true || chain["criteria_hash_matches"] != true {
			return fmt.Errorf("persisted governed joins or requirement digest are inconsistent: %+v", chain)
		}
		for _, key := range []string{"configuration_revision_no", "component_revision_no", "occurrence_revision_no", "requirement_revision_no"} {
			if chain[key] != float64(1) {
				return fmt.Errorf("wrong governed %s: %v", key, chain[key])
			}
		}
		return nil
	}); err != nil {
		return err
	}
	if err := h.check("confirmed scope retry replays exact receipt and a new confirmation key is rejected", func() error {
		replay, e := h.sourceReq("POST", proposalPath+"/confirm", h.reviewer, confirmationBody(), winningKey, `"1"`, 201)
		if e != nil {
			return e
		}
		if e = equalReplay(confirmed, replay); e != nil {
			return e
		}
		_, e = h.sourceReq("POST", proposalPath+"/confirm", h.reviewer, confirmationBody(), "scope-confirm-again", `"1"`, 409)
		return e
	}); err != nil {
		return err
	}
	if err := h.check("confirmed scope leaves original intake/source revisions and unverified claims unchanged", func() error {
		now, e := h.req("GET", f.path, h.tokenA, nil, "", "", 200)
		if e != nil {
			return e
		}
		if !equalJSON(now.body, f.scionSnapshot.body) {
			return fmt.Errorf("scope confirmation modified intake")
		}
		for i, path := range f.sourcePaths {
			now, e = h.sourceReq("GET", path+"/revisions/1", h.tokenA, nil, "", "", 200)
			if e != nil {
				return e
			}
			if !equalJSON(now.body, f.snapshots[i].body) {
				return fmt.Errorf("source revision mutated")
			}
			r, e := h.sourceReq("GET", path+"/revisions/1/claims", h.tokenA, nil, "", "", 200)
			if e != nil {
				return e
			}
			claims, e := decode[struct {
				Claims []sourceClaim `json:"claims"`
			}](r)
			if e != nil {
				return e
			}
			if len(claims.Claims) != 1 || claims.Claims[0].VerificationStatus != "unverified" {
				return fmt.Errorf("scope confirmation changed claim authority")
			}
		}
		return nil
	}); err != nil {
		return err
	}
	if err := h.check("confirmed scope and exact governed IDs survive actual Rust process restart", func() error {
		before, e := h.sourceReq("GET", proposalPath, h.tokenA, nil, "", "", 200)
		if e != nil {
			return e
		}
		if e = h.process.stop(); e != nil {
			return e
		}
		if e = h.process.start(h.client); e != nil {
			return e
		}
		after, e := h.sourceReq("GET", proposalPath, h.tokenA, nil, "", "", 200)
		if e != nil {
			return e
		}
		if !equalJSON(before.body, after.body) {
			return fmt.Errorf("scope changed after restart")
		}
		return nil
	}); err != nil {
		return err
	}
	if err := h.check("intake revision change blocks an earlier scope proposal from confirmation", func() error {
		r, e := h.propose(other, "scope-stale-proposal", other.proposal, 201)
		if e != nil {
			return e
		}
		p, e := decode[scopeProposal](r)
		if e != nil {
			return e
		}
		if _, e = h.req("POST", other.path+"/revisions", h.tokenA, other.draft, "scope-new-intake", `"1"`, 201); e != nil {
			return e
		}
		_, e = h.sourceReq("POST", other.path+"/scope/proposals/"+p.ID+"/confirm", h.reviewer, confirmationBody(), "scope-stale-confirm", `"2"`, 412)
		return e
	}); err != nil {
		return err
	}
	if err := h.check("new source revision blocks confirmation of an older exact source binding", func() error {
		stale, e := h.newScopeFixture("stale-source")
		if e != nil {
			return e
		}
		r, e := h.propose(stale, "scope-stale-source-propose", stale.proposal, 201)
		if e != nil {
			return e
		}
		p, e := decode[scopeProposal](r)
		if e != nil {
			return e
		}
		changed := stale.sources[0]
		changed.SourceText += "Revised synthetic context.\n"
		changed.ChangeSummary = "New synthetic controlled revision"
		if _, e = h.sourceReq("POST", stale.sourcePaths[0]+"/revisions", h.tokenA, changed, "scope-new-source", `"1"`, 201); e != nil {
			return e
		}
		_, e = h.sourceReq("POST", stale.path+"/scope/proposals/"+p.ID+"/confirm", h.reviewer, confirmationBody(), "scope-stale-source-confirm", `"1"`, 409)
		return e
	}); err != nil {
		return err
	}
	if err := h.check("revoked source prevents both proposal and confirmation, including saved proposal retry", func() error {
		revoked, e := h.newScopeFixture("revoked")
		if e != nil {
			return e
		}
		r, e := h.propose(revoked, "scope-revoked-propose", revoked.proposal, 201)
		if e != nil {
			return e
		}
		p, e := decode[scopeProposal](r)
		if e != nil {
			return e
		}
		if _, e = h.sourceReq("POST", revoked.sourcePaths[0]+"/revoke", h.tokenA, map[string]string{"reason": "Synthetic scope permission withdrawn"}, "scope-revoke", `"1"`, 201); e != nil {
			return e
		}
		if _, e = h.sourceReq("POST", revoked.path+"/scope/proposals/"+p.ID+"/confirm", h.reviewer, confirmationBody(), "scope-revoked-confirm", `"1"`, 403); e != nil {
			return e
		}
		for _, key := range []string{"scope-revoked-propose", "scope-revoked-new"} {
			if _, e = h.propose(revoked, key, revoked.proposal, 403); e != nil {
				return e
			}
		}
		return nil
	}); err != nil {
		return err
	}
	if err := h.check("revocation after confirmation preserves audit identity but blocks binding and hides proposal content", func() error {
		if _, e := h.sourceReq("POST", f.sourcePaths[0]+"/revoke", h.tokenA, map[string]string{"reason": "Synthetic post-confirmation permission withdrawal"}, "scope-revoke-confirmed", `"1"`, 201); e != nil {
			return e
		}
		r, e := h.sourceReq("GET", proposalPath, h.tokenA, nil, "", "", 200)
		if e != nil {
			return e
		}
		p, e := decode[scopeProposal](r)
		if e != nil {
			return e
		}
		original, e := decode[scopeProposal](confirmed)
		if e != nil {
			return e
		}
		var beforeLinks, afterLinks map[string]any
		if e = json.Unmarshal(original.Confirmation, &beforeLinks); e != nil {
			return e
		}
		if e = json.Unmarshal(p.Confirmation, &afterLinks); e != nil {
			return e
		}
		delete(beforeLinks, "review_note")
		delete(afterLinks, "review_note")
		beforeBytes, _ := json.Marshal(beforeLinks)
		afterBytes, _ := json.Marshal(afterLinks)
		if !equalJSON(beforeBytes, afterBytes) || len(p.Blockers) == 0 {
			return fmt.Errorf("confirmation lost or revoked binding not blocked")
		}
		if string(p.Input) != "null" && len(p.Input) > 0 {
			return fmt.Errorf("revoked proposal still exposes copied identity content: %s", p.Input)
		}
		return nil
	}); err != nil {
		return err
	}
	return h.runAgentQueue()
}
