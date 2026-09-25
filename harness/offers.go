package main

// Synthetic quotes are authored here as test input, not fetched from suppliers.
// All assertions use the real HTTP API; no database or object-store substitutes.
import (
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"math/big"
	"strings"
	"sync"
)

type offerRevision struct {
	ID               string            `json:"id"`
	Number           int               `json:"number"`
	Input            json.RawMessage   `json:"input"`
	Missing          []string          `json:"missing_fields"`
	GovernedRevision *string           `json:"governed_offer_revision_id"`
	GovernedLine     *string           `json:"governed_offer_line_id"`
	Governed         json.RawMessage   `json:"governed"`
	Blockers         []json.RawMessage `json:"blockers"`
	Redacted         bool              `json:"content_redacted"`
}
type offerView struct {
	ID        string          `json:"id"`
	Current   int             `json:"current_revision"`
	Revision  offerRevision   `json:"revision"`
	Revisions []offerRevision `json:"revisions"`
}
type comparisonLine struct {
	OfferRevision string   `json:"offer_revision_id"`
	State         string   `json:"state"`
	Reasons       []string `json:"exclusion_reasons"`
	Price         *string  `json:"normalized_unit_price"`
	Extended      *string  `json:"extended_price"`
	Currency      string   `json:"currency"`
}
type comparisonView struct {
	ID           string            `json:"id"`
	Input        json.RawMessage   `json:"input"`
	Snapshot     json.RawMessage   `json:"snapshot"`
	Confirmation json.RawMessage   `json:"confirmation"`
	Blockers     []json.RawMessage `json:"blockers"`
	Redacted     bool              `json:"content_redacted"`
}
type offerFixture struct {
	scopeFixture
	scopeID      string
	offers       []offerView
	inputs       []map[string]any
	offerSources []string
}

func (h *harness) newOfferFixture(label string) (offerFixture, error) {
	f := offerFixture{}
	var err error
	f.scopeFixture, err = h.newScopeFixture("offers-" + label)
	if err != nil {
		return f, err
	}
	r, err := h.propose(f.scopeFixture, "offers-"+label+"-scope", f.proposal, 201)
	if err != nil {
		return f, err
	}
	p, err := decode[scopeProposal](r)
	if err != nil {
		return f, err
	}
	f.scopeID = p.ID
	_, err = h.sourceReq("POST", f.path+"/scope/proposals/"+p.ID+"/confirm", h.reviewer, confirmationBody(), "offers-"+label+"-scope-confirm", `"1"`, 201)
	return f, err
}
func (h *harness) offerInput(f *offerFixture, label string, overrides map[string]any) (map[string]any, error) {
	suffix := h.runID + "-" + label
	p := map[string]any{
		"synthetic": true, "scion_revision": 1, "scope_proposal_id": f.scopeID,
		"supplier":  map[string]any{"legal_name": "Synthetic supplier " + label, "jurisdiction": "SYNTHETIC-US-DE", "registration_ref": "SYN-REG-" + suffix, "site_code": "SYN-SITE-" + suffix, "country_code": "US", "account_ref": "SYN-ACCOUNT-" + suffix},
		"offer_ref": "SYN-QUOTE-" + suffix, "identity_match": "exact", "offered_manufacturer": "Synthetic manufacturer", "offered_part_number": "SYN-PART-001",
		"quantity": "2", "uom": "EA", "unit_price": "12.50", "currency": "USD", "destination": "Synthetic test lab", "incoterm": "EXW", "payment_terms": "Synthetic net 30",
		"quoted_at": "2026-09-26T00:00:00Z", "valid_from": "2026-09-26T00:00:00Z", "valid_until": "2026-10-26T00:00:00Z", "lead_time_days": 7, "change_summary": "Record explicit synthetic quote for local tests only",
	}
	for k, v := range overrides {
		p[k] = v
	}
	// The exact quote includes every entered supplier/part/term, with absent fields
	// represented by null. Its byte locator pins the entire authored statement.
	raw, _ := json.Marshal(p)
	quote := string(raw)
	prefix := "SYNTHETIC SUPPLIER QUOTE — not a real offer.\n"
	text := prefix + quote + "\n"
	src := sourceInput{Title: "SYNTHETIC quote " + label, Origin: "Go harness authored synthetic quote", Owner: "Synthetic test owner", Synthetic: true, SourceText: text, RightsStatus: "granted", PermissionBasis: "Synthetic author permits local review", PermittedUse: "scion_review", ChangeSummary: "Initial synthetic quote"}
	r, err := h.sourceReq("POST", f.path+"/sources", h.tokenA, src, "offer-source-"+label, `"1"`, 201)
	if err != nil {
		return nil, err
	}
	receipt, err := decode[sourceReceipt](r)
	if err != nil {
		return nil, err
	}
	path := f.path + "/sources/" + receipt.SourceID
	start := len([]byte(prefix))
	end := start + len([]byte(quote))
	_, err = h.sourceReq("POST", path+"/revisions/1/claims", h.tokenA, claimInput{Statement: quote, Locator: claimLocator{StartByte: start, EndByte: end, Quote: quote}}, "offer-claim-"+label, "", 201)
	if err != nil {
		return nil, err
	}
	r, err = h.sourceReq("GET", path+"/revisions/1/claims", h.tokenA, nil, "", "", 200)
	if err != nil {
		return nil, err
	}
	claims, err := decode[struct {
		Claims []sourceClaim `json:"claims"`
	}](r)
	if err != nil || len(claims.Claims) != 1 {
		return nil, fmt.Errorf("offer source claim: %v", err)
	}
	p["source"] = map[string]any{"source_id": receipt.SourceID, "source_revision": 1, "claim_id": claims.Claims[0].ID, "content_sha256": fmt.Sprintf("%x", sha256.Sum256([]byte(text))), "start_byte": start, "end_byte": end}
	f.offerSources = append(f.offerSources, path)
	return p, nil
}
func (h *harness) addOffer(f *offerFixture, label string, overrides map[string]any) (offerView, error) {
	p, err := h.offerInput(f, label, overrides)
	if err != nil {
		return offerView{}, err
	}
	r, err := h.sourceReq("POST", f.path+"/offers", h.tokenA, p, "offer-"+label, `"1"`, 201)
	if err != nil {
		return offerView{}, err
	}
	v, err := decode[offerView](r)
	if err == nil {
		f.offers = append(f.offers, v)
		f.inputs = append(f.inputs, p)
	}
	return v, err
}
func compareInput(f offerFixture, ids ...string) map[string]any {
	if len(ids) == 0 {
		for _, o := range f.offers {
			ids = append(ids, o.Revision.ID)
		}
	}
	return map[string]any{"synthetic": true, "scope_proposal_id": f.scopeID, "offer_revision_ids": ids, "basis": map[string]any{"quantity": "2", "uom": "EA", "currency": "USD", "destination": "Synthetic test lab", "incoterm": "EXW", "payment_terms": "Synthetic net 30", "as_of": "2026-09-26T00:00:00Z", "valid_from": "2026-09-26T00:00:00Z", "valid_until": "2026-10-01T00:00:00Z"}, "change_summary": "Propose explicit exact synthetic comparison for independent review"}
}
func compareConfirm() map[string]any {
	return map[string]any{"confirm_synthetic_normalization": true, "review_note": "Synthetic engineering role reviewed only exact identity and arithmetic. This is not supplier selection or commercial approval."}
}
func (h *harness) proposeComparison(f offerFixture, p map[string]any, key string) (comparisonView, error) {
	r, e := h.sourceReq("POST", f.path+"/comparisons/proposals", h.tokenA, p, key, `"1"`, 201)
	if e != nil {
		return comparisonView{}, e
	}
	return decode[comparisonView](r)
}
func linesOf(c comparisonView) ([]comparisonLine, error) {
	var lines []comparisonLine
	if e := json.Unmarshal(c.Snapshot, &lines); e == nil {
		return lines, nil
	}
	var object struct {
		Lines []comparisonLine `json:"lines"`
	}
	e := json.Unmarshal(c.Snapshot, &object)
	return object.Lines, e
}
func exactDecimal(got *string, want string) bool {
	if got == nil {
		return false
	}
	a, ok := new(big.Rat).SetString(*got)
	b, _ := new(big.Rat).SetString(want)
	return ok && a.Cmp(b) == 0
}
func (h *harness) runOffers() error {
	var f offerFixture
	if e := h.check("two synthetic supplier offers bind complete exact scope and private source revisions", func() error {
		var e error
		f, e = h.newOfferFixture("main")
		if e != nil {
			return e
		}
		for i, price := range []string{"12.50", "11.75"} {
			v, e := h.addOffer(&f, fmt.Sprintf("main-%d", i), map[string]any{"unit_price": price})
			if e != nil {
				return e
			}
			if v.ID == "" || v.Revision.ID == "" || v.Current != 1 || v.Revision.GovernedRevision == nil || v.Revision.GovernedLine == nil || len(v.Revision.Missing) != 0 {
				return fmt.Errorf("offer not materialized: %+v", v)
			}
			var canonical map[string]any
			if e = json.Unmarshal(v.Revision.Governed, &canonical); e != nil {
				return e
			}
			for _, key := range []string{"sourcing_case_id", "source_revision_id", "supplier_entity_id", "supplier_site_id", "supplier_account_id", "occurrence_revision_id", "source_version_id"} {
				if id, ok := canonical[key].(string); !ok || id == "" {
					return fmt.Errorf("missing persisted %s", key)
				}
			}
			if canonical["source_sha256"] != f.inputs[i]["source"].(map[string]any)["content_sha256"] {
				return fmt.Errorf("canonical source hash differs from exact intake source")
			}
		}
		return nil
	}); e != nil {
		return e
	}
	if e := h.check("offer idempotent retry preserves identity; duplicates and stale writes rejected", func() error {
		r, e := h.sourceReq("POST", f.path+"/offers", h.tokenA, f.inputs[0], "offer-main-0", `"1"`, 201)
		if e != nil {
			return e
		}
		v, e := decode[offerView](r)
		if e != nil {
			return e
		}
		if v.ID != f.offers[0].ID {
			return fmt.Errorf("retry duplicated offer")
		}
		if _, e = h.sourceReq("POST", f.path+"/offers", h.tokenA, f.inputs[0], "offer-duplicate", `"1"`, 409); e != nil {
			return e
		}
		_, e = h.sourceReq("POST", f.path+"/offers", h.tokenA, f.inputs[1], "offer-stale", `"2"`, 412)
		return e
	}); e != nil {
		return e
	}
	var cmp comparisonView
	input := compareInput(f)
	if e := h.check("exact decimal comparison preserves quoted prices and quantity totals without selecting supplier", func() error {
		var e error
		cmp, e = h.proposeComparison(f, input, "compare-main")
		if e != nil {
			return e
		}
		ls, e := linesOf(cmp)
		if e != nil {
			return e
		}
		if len(ls) != 2 || string(cmp.Confirmation) != "null" {
			return fmt.Errorf("invalid proposal: %s", cmp.Snapshot)
		}
		for _, line := range ls {
			index := 0
			if line.OfferRevision == f.offers[1].Revision.ID {
				index = 1
			}
			if line.State != "comparable" || len(line.Reasons) != 0 || !exactDecimal(line.Price, []string{"12.50", "11.75"}[index]) || !exactDecimal(line.Extended, []string{"25.00", "23.50"}[index]) {
				return fmt.Errorf("invalid exact arithmetic: %+v", line)
			}
		}
		return nil
	}); e != nil {
		return e
	}
	cmpPath := f.path + "/comparisons/proposals/" + cmp.ID
	if e := h.check("duplicate comparison lines cannot masquerade as two suppliers", func() error {
		_, e := h.sourceReq("POST", f.path+"/comparisons/proposals", h.tokenA, compareInput(f, f.offers[0].Revision.ID, f.offers[0].Revision.ID), "compare-dup-line", `"1"`, 422)
		return e
	}); e != nil {
		return e
	}
	if e := h.check("offer and comparison endpoints hide organization resources including histories and review", func() error {
		for _, path := range []string{f.path + "/offers", f.path + "/offers/" + f.offers[0].ID, f.path + "/comparisons", cmpPath} {
			if _, e := h.sourceReq("GET", path, h.tokenB, nil, "", "", 404); e != nil {
				return e
			}
		}
		if _, e := h.sourceReq("POST", cmpPath+"/confirm", h.tokenB, compareConfirm(), "offer-foreign-confirm", `"1"`, 404); e != nil {
			return e
		}
		if _, e := h.sourceReq("POST", f.path+"/offers", h.tokenB, f.inputs[0], "offer-foreign-create", `"1"`, 404); e != nil {
			return e
		}
		for i, token := range []string{h.tokenA, h.agent} {
			if _, e := h.sourceReq("POST", cmpPath+"/confirm", token, compareConfirm(), fmt.Sprintf("compare-deny-%d", i), `"1"`, 403); e != nil {
				return e
			}
		}
		return nil
	}); e != nil {
		return e
	}
	var confirmed comparisonView
	if e := h.check("concurrent independent review creates one canonical GG-40 comparison without commercial approval", func() error {
		rs := make([]response, 2)
		errs := make([]error, 2)
		var wg sync.WaitGroup
		start := make(chan struct{})
		for i := range rs {
			wg.Add(1)
			go func(i int) {
				defer wg.Done()
				<-start
				rs[i], errs[i] = h.client.request("POST", cmpPath+"/confirm", h.reviewer, compareConfirm(), map[string]string{"If-Match": `"1"`, "Idempotency-Key": h.runID + fmt.Sprintf("-compare-race-%d", i)})
			}(i)
		}
		close(start)
		wg.Wait()
		wins := 0
		for i, r := range rs {
			if errs[i] != nil {
				return errs[i]
			}
			if r.status == 201 {
				wins++
				var e error
				confirmed, e = decode[comparisonView](r)
				if e != nil {
					return e
				}
			} else if r.status != 409 {
				return fmt.Errorf("race HTTP%d: %s", r.status, r.body)
			}
		}
		if wins != 1 {
			return fmt.Errorf("%d review winners", wins)
		}
		var c map[string]any
		if e := json.Unmarshal(confirmed.Confirmation, &c); e != nil {
			return e
		}
		for _, key := range []string{"comparison_revision_id", "artifact_id", "sourcing_case_revision_id", "requirement_revision_id", "confirmed_by"} {
			if v, ok := c[key].(string); !ok || v == "" {
				return fmt.Errorf("missing canonical %s", key)
			}
		}
		governed, ok := c["governed"].(map[string]any)
		if !ok || governed["artifact_valid"] != true || governed["table"] != "comparison_revisions" {
			return fmt.Errorf("canonical comparison readback missing")
		}
		lines, ok := governed["lines"].([]any)
		if !ok || len(lines) != 2 {
			return fmt.Errorf("expected exactly two persisted normalized lines")
		}
		for _, item := range lines {
			line := item.(map[string]any)
			fx, ok := line["fx_rate"].(string)
			if !ok || !exactDecimal(&fx, "1") || line["normalization_evidence_id"] != nil || line["state"] != "comparable" {
				return fmt.Errorf("invented normalization in canonical line: %+v", line)
			}
		}
		return nil
	}); e != nil {
		return e
	}
	if e := h.check("offer revisions and confirmed comparison snapshots survive actual Rust restart unchanged", func() error {
		before, e := h.sourceReq("GET", cmpPath, h.tokenA, nil, "", "", 200)
		if e != nil {
			return e
		}
		oBefore, e := h.sourceReq("GET", f.path+"/offers/"+f.offers[0].ID, h.tokenA, nil, "", "", 200)
		if e != nil {
			return e
		}
		if e = h.process.stop(); e != nil {
			return e
		}
		if e = h.process.start(h.client); e != nil {
			return e
		}
		after, e := h.sourceReq("GET", cmpPath, h.tokenA, nil, "", "", 200)
		if e != nil {
			return e
		}
		oAfter, e := h.sourceReq("GET", f.path+"/offers/"+f.offers[0].ID, h.tokenA, nil, "", "", 200)
		if e != nil {
			return e
		}
		if !equalJSON(before.body, after.body) || !equalJSON(oBefore.body, oAfter.body) {
			return fmt.Errorf("offer/comparison changed after restart")
		}
		return nil
	}); e != nil {
		return e
	}
	if e := h.runNormalizationTask(f); e != nil {
		return e
	}
	if e := h.check("wrong-case offer revision and exact source locator substitution are rejected", func() error {
		g, e := h.newOfferFixture("cross-case")
		if e != nil {
			return e
		}
		v, e := h.addOffer(&g, "cross-case", nil)
		if e != nil {
			return e
		}
		if _, e = h.sourceReq("POST", f.path+"/comparisons/proposals", h.tokenA, compareInput(f, f.offers[0].Revision.ID, v.Revision.ID), "compare-wrong-case", `"1"`, 404); e != nil {
			return e
		}
		bad := cloneScope(f.inputs[0])
		bad["source"].(map[string]any)["content_sha256"] = strings.Repeat("0", 64)
		_, e = h.sourceReq("POST", f.path+"/offers", h.tokenA, bad, "offer-wrong-hash", `"1"`, 422)
		return e
	}); e != nil {
		return e
	}
	if e := h.check("wrong part and missing price remain visible exclusions with no normalized price", func() error {
		g, e := h.newOfferFixture("excluded")
		if e != nil {
			return e
		}
		if _, e = h.addOffer(&g, "wrong-part", map[string]any{"offered_part_number": "SYN-WRONG-PART"}); e != nil {
			return e
		}
		v, e := h.addOffer(&g, "missing-price", map[string]any{"unit_price": nil})
		if e != nil {
			return e
		}
		if len(v.Revision.Missing) == 0 || v.Revision.GovernedLine != nil {
			return fmt.Errorf("missing price fabricated into governed offer")
		}
		c, e := h.proposeComparison(g, compareInput(g), "compare-excluded")
		if e != nil {
			return e
		}
		ls, e := linesOf(c)
		if e != nil {
			return e
		}
		if len(ls) != 2 {
			return fmt.Errorf("missing exclusion lines")
		}
		for _, l := range ls {
			if l.State != "excluded" || len(l.Reasons) == 0 || l.Price != nil || l.Extended != nil {
				return fmt.Errorf("excluded offer has normalized price: %+v", l)
			}
		}
		return nil
	}); e != nil {
		return e
	}
	if e := h.check("different currency, UOM and commercial basis are excluded instead of invented conversions", func() error {
		for i, change := range []map[string]any{{"currency": "EUR"}, {"uom": "BOX"}, {"destination": "Elsewhere"}, {"incoterm": "FCA"}, {"payment_terms": "Prepayment"}, {"quantity": "3"}} {
			p := cloneScope(input)
			basis := p["basis"].(map[string]any)
			for k, v := range change {
				basis[k] = v
			}
			c, e := h.proposeComparison(f, p, fmt.Sprintf("compare-basis-%d", i))
			if e != nil {
				return e
			}
			ls, e := linesOf(c)
			if e != nil {
				return e
			}
			for _, l := range ls {
				if l.State != "excluded" || l.Price != nil || len(l.Reasons) == 0 {
					return fmt.Errorf("basis mismatch comparable: %+v", l)
				}
			}
		}
		return nil
	}); e != nil {
		return e
	}
	if e := h.check("appended offer revision preserves old input and blocks stale comparison review", func() error {
		c, e := h.proposeComparison(f, input, "compare-before-revision")
		if e != nil {
			return e
		}
		changed, e := h.offerInput(&f, "main-revised", map[string]any{"unit_price": "12.60", "supplier": f.inputs[0]["supplier"], "offer_ref": f.inputs[0]["offer_ref"]})
		if e != nil {
			return e
		}
		changed["change_summary"] = "Synthetic correction creates immutable new submission revision"
		r, e := h.sourceReq("POST", f.path+"/offers/"+f.offers[0].ID+"/revisions", h.tokenA, changed, "offer-new-revision", `"1"`, 201)
		if e != nil {
			return e
		}
		v, e := decode[offerView](r)
		if e != nil {
			return e
		}
		if v.Current != 2 || v.Revision.ID == f.offers[0].Revision.ID {
			return fmt.Errorf("revision not appended")
		}
		r, e = h.sourceReq("GET", f.path+"/offers/"+f.offers[0].ID, h.tokenA, nil, "", "", 200)
		if e != nil {
			return e
		}
		v, e = decode[offerView](r)
		if e != nil {
			return e
		}
		found := false
		for _, rev := range v.Revisions {
			if rev.ID == f.offers[0].Revision.ID {
				found = true
				if !equalJSON(rev.Input, f.offers[0].Revision.Input) {
					return fmt.Errorf("old offer input mutated")
				}
			}
		}
		if !found {
			return fmt.Errorf("old revision missing from history")
		}
		_, e = h.sourceReq("POST", f.path+"/comparisons/proposals/"+c.ID+"/confirm", h.reviewer, compareConfirm(), "compare-stale-offer-confirm", `"1"`, 409)
		return e
	}); e != nil {
		return e
	}
	if e := h.check("revoked supplier evidence hides offer history and comparison content while retaining review audit", func() error {
		if _, e := h.sourceReq("POST", f.offerSources[0]+"/revoke", h.tokenA, map[string]string{"reason": "Synthetic supplier evidence permission withdrawn"}, "offer-revoke", `"1"`, 201); e != nil {
			return e
		}
		r, e := h.sourceReq("GET", f.path+"/offers/"+f.offers[0].ID, h.tokenA, nil, "", "", 200)
		if e != nil {
			return e
		}
		v, e := decode[offerView](r)
		if e != nil {
			return e
		}
		for _, rev := range append(v.Revisions, v.Revision) {
			if rev.Number == 1 && (!rev.Redacted || string(rev.Input) != "null") {
				return fmt.Errorf("revoked offer input visible")
			}
			if rev.Number == 2 && rev.Redacted {
				return fmt.Errorf("independent new source incorrectly revoked")
			}
		}
		r, e = h.sourceReq("GET", cmpPath, h.tokenA, nil, "", "", 200)
		if e != nil {
			return e
		}
		c, e := decode[comparisonView](r)
		if e != nil {
			return e
		}
		if !c.Redacted || string(c.Input) != "null" || string(c.Snapshot) != "null" || string(c.Confirmation) == "null" || len(c.Blockers) == 0 {
			return fmt.Errorf("revoked comparison content visible or audit missing: %s", r.body)
		}
		for _, text := range []string{"Synthetic supplier main", "12.50", "Synthetic engineering role reviewed"} {
			if strings.Contains(string(r.body), text) {
				return fmt.Errorf("revoked derived content leaked")
			}
		}
		_, e = h.sourceReq("POST", f.path+"/offers", h.tokenA, f.inputs[0], "offer-revoked-create", `"1"`, 403)
		return e
	}); e != nil {
		return e
	}
	if e := h.check("new intake revision makes the old confirmed scope ineligible for another offer", func() error {
		g, e := h.newOfferFixture("stale-scion")
		if e != nil {
			return e
		}
		input, e := h.offerInput(&g, "stale-scion", nil)
		if e != nil {
			return e
		}
		if _, e = h.req("POST", g.path+"/revisions", h.tokenA, g.draft, "offer-scion-edit", `"1"`, 201); e != nil {
			return e
		}
		input["scion_revision"] = 2
		_, e = h.sourceReq("POST", g.path+"/offers", h.tokenA, input, "offer-stale-scope", `"2"`, 412)
		return e
	}); e != nil {
		return e
	}
	if e := h.check("new supplier source revision excludes the earlier quoted revision and blocks its pending review", func() error {
		g, e := h.newOfferFixture("stale-source")
		if e != nil {
			return e
		}
		for _, side := range []string{"a", "b"} {
			if _, e = h.addOffer(&g, "stale-source-"+side, nil); e != nil {
				return e
			}
		}
		candidate := compareInput(g)
		before, e := h.proposeComparison(g, candidate, "stale-source-comparison-before")
		if e != nil {
			return e
		}
		revised := sourceInput{Title: "SYNTHETIC quote revision 2", Origin: "Local synthetic harness", Owner: "Synthetic test owner", Synthetic: true, SourceText: "SYNTHETIC revision 2 supersedes earlier quote; revised terms are not supplied.\n", RightsStatus: "granted", PermissionBasis: "Synthetic test author permits local review", PermittedUse: "scion_review", ChangeSummary: "Supersede synthetic quote source without inventing new terms"}
		if _, e = h.sourceReq("POST", g.offerSources[0]+"/revisions", h.tokenA, revised, "offer-source-new-revision", `"1"`, 201); e != nil {
			return e
		}
		if _, e = h.sourceReq("POST", g.path+"/comparisons/proposals/"+before.ID+"/confirm", h.reviewer, compareConfirm(), "compare-stale-source-confirm", `"1"`, 409); e != nil {
			return e
		}
		after, e := h.proposeComparison(g, candidate, "stale-source-comparison-after")
		if e != nil {
			return e
		}
		lines, e := linesOf(after)
		if e != nil {
			return e
		}
		found := false
		for _, line := range lines {
			if line.OfferRevision == g.offers[0].Revision.ID {
				found = true
				if line.State != "excluded" || line.Price != nil || !strings.Contains(strings.Join(line.Reasons, " "), "stale") {
					return fmt.Errorf("stale source not excluded: %+v", line)
				}
			}
		}
		if !found {
			return fmt.Errorf("missing stale source line")
		}
		return nil
	}); e != nil {
		return e
	}
	if e := h.check("revoked physical scope evidence blocks a confirmed comparison and preserves its human audit", func() error {
		g, e := h.newOfferFixture("scope-revoked")
		if e != nil {
			return e
		}
		for _, side := range []string{"a", "b"} {
			if _, e = h.addOffer(&g, "scope-revoked-"+side, nil); e != nil {
				return e
			}
		}
		c, e := h.proposeComparison(g, compareInput(g), "scope-revoked-comparison")
		if e != nil {
			return e
		}
		path := g.path + "/comparisons/proposals/" + c.ID
		if _, e = h.sourceReq("POST", path+"/confirm", h.reviewer, compareConfirm(), "scope-revoked-comparison-confirm", `"1"`, 201); e != nil {
			return e
		}
		if _, e = h.sourceReq("POST", g.sourcePaths[0]+"/revoke", h.tokenA, map[string]string{"reason": "Synthetic configuration evidence withdrawn"}, "scope-comparison-revoke", `"1"`, 201); e != nil {
			return e
		}
		r, e := h.sourceReq("GET", path, h.tokenA, nil, "", "", 200)
		if e != nil {
			return e
		}
		c, e = decode[comparisonView](r)
		if e != nil {
			return e
		}
		if !c.Redacted || len(c.Blockers) == 0 || string(c.Snapshot) != "null" || string(c.Confirmation) == "null" {
			return fmt.Errorf("comparison remains usable after scope evidence revocation")
		}
		return nil
	}); e != nil {
		return e
	}
	return nil
}

func (h *harness) runNormalizationTask(f offerFixture) error {
	candidate := compareInput(f)
	var task agentTask
	var proposal comparisonView
	if e := h.check("normalization agent requires a dispatched leased task and cannot alter pinned terms", func() error {
		if _, err := h.sourceReq("POST", f.path+"/comparisons/proposals", h.agent, candidate, "normalization-no-task", `"1"`, 409); err != nil {
			return err
		}
		r, err := h.sourceReq("POST", f.path+"/agent-tasks", h.tokenA, map[string]any{"task_kind": "prepare_offer_normalization", "candidate_proposal": candidate, "timeout_seconds": 30}, "normalization-task", `"1"`, 201)
		if err != nil {
			return err
		}
		task, err = decode[agentTask](r)
		if err != nil {
			return err
		}
		if err = h.dispatchTask(f.path, task.ID); err != nil {
			return err
		}
		r, err = h.sourceReq("POST", "/api/agent/tasks/"+task.ID+"/claim", h.agent, nil, "", "", 200)
		if err != nil {
			return err
		}
		task, err = decode[agentTask](r)
		if err != nil {
			return err
		}
		altered := cloneScope(candidate)
		altered["basis"].(map[string]any)["quantity"] = "3"
		if _, err = h.agentProposal(f.path+"/comparisons/proposals", altered, "normalization-altered", task, 409); err != nil {
			return err
		}
		r, err = h.agentProposal(f.path+"/comparisons/proposals", candidate, "normalization-proposal", task, 201)
		if err != nil {
			return err
		}
		proposal, err = decode[comparisonView](r)
		if err != nil {
			return err
		}
		if string(proposal.Confirmation) != "null" {
			return fmt.Errorf("agent proposal became confirmation")
		}
		return nil
	}); e != nil {
		return e
	}
	if e := h.check("agent completion records proposal provenance while a separate human reviews normalization", func() error {
		result := map[string]any{"proposal_id": proposal.ID, "provider_run_id": "go-protocol-normalization-no-llm", "output_sha256": strings.Repeat("1", 64), "preparation_note": "Protocol fixture; actual Codex execution checked separately."}
		for i := 0; i < 2; i++ {
			r, err := h.client.request("POST", "/api/agent/tasks/"+task.ID+"/result", h.agent, result, map[string]string{"X-Grimoire-Task-Lease": task.Lease})
			if err != nil {
				return err
			}
			if err = expectStatus(r, 200); err != nil {
				return err
			}
		}
		path := f.path + "/comparisons/proposals/" + proposal.ID
		if _, err := h.sourceReq("POST", path+"/confirm", h.agent, compareConfirm(), "normalization-agent-confirm", `"1"`, 403); err != nil {
			return err
		}
		r, err := h.sourceReq("GET", path, h.tokenA, nil, "", "", 200)
		if err != nil {
			return err
		}
		c, err := decode[comparisonView](r)
		if err != nil {
			return err
		}
		if string(c.Confirmation) != "null" {
			return fmt.Errorf("completion incorrectly approved comparison")
		}
		_, err = h.sourceReq("POST", path+"/confirm", h.reviewer, compareConfirm(), "normalization-human-confirm", `"1"`, 201)
		return err
	}); e != nil {
		return e
	}
	return nil
}
