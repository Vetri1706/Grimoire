package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"strings"
)

type sourceInput struct {
	Title           string `json:"title"`
	Origin          string `json:"origin"`
	Owner           string `json:"owner"`
	Synthetic       bool   `json:"synthetic"`
	SourceText      string `json:"source_text"`
	RightsStatus    string `json:"rights_status"`
	PermissionBasis string `json:"permission_basis"`
	PermittedUse    string `json:"permitted_use"`
	ChangeSummary   string `json:"change_summary"`
}

type sourceReceipt struct {
	SourceID string `json:"source_id"`
	Number   int    `json:"number"`
}

type sourceSummary struct {
	ID               string  `json:"id"`
	ScionID          string  `json:"scion_id"`
	ScionRevision    int     `json:"scion_revision"`
	CurrentRevision  int     `json:"current_revision"`
	Title            string  `json:"title"`
	Origin           string  `json:"origin"`
	Owner            string  `json:"owner"`
	ContentSHA256    string  `json:"content_sha256"`
	RightsStatus     string  `json:"rights_status"`
	PermissionBasis  string  `json:"permission_basis"`
	PermittedUse     string  `json:"permitted_use"`
	Synthetic        bool    `json:"synthetic"`
	ClaimCount       int     `json:"claim_count"`
	RevocationReason *string `json:"revocation_reason"`
}

type sourceList struct {
	Sources          []sourceSummary   `json:"sources"`
	VerifiedFacts    []json.RawMessage `json:"verified_facts"`
	ExtractionStatus string            `json:"extraction_status"`
}

type claimLocator struct {
	StartByte int    `json:"start_byte"`
	EndByte   int    `json:"end_byte"`
	Quote     string `json:"quote"`
}

type claimInput struct {
	Statement string       `json:"statement"`
	Locator   claimLocator `json:"locator"`
}

type sourceClaim struct {
	ID                 string       `json:"id"`
	SourceID           string       `json:"source_id"`
	SourceRevision     int          `json:"source_revision"`
	Statement          string       `json:"statement"`
	Locator            claimLocator `json:"locator"`
	Authority          string       `json:"authority"`
	VerificationStatus string       `json:"verification_status"`
	CreatedAt          string       `json:"created_at"`
	CreatedBy          string       `json:"created_by"`
}

// Layer 2 requests have the same real HTTP boundary as Layer 1. In particular,
// this helper does not read SQL tables or reproduce authorization in Go.
func (h *harness) sourceReq(method, path, token string, body any, key, match string, status int) (response, error) {
	res, err := h.req(method, path, token, body, key, match, status)
	if err == nil && !strings.Contains(strings.ToLower(res.header.Get("Cache-Control")), "no-store") {
		err = fmt.Errorf("%s %s lacks Cache-Control: no-store", method, path)
	}
	return res, err
}

func objectMap(value any) map[string]any {
	data, _ := json.Marshal(value)
	var result map[string]any
	_ = json.Unmarshal(data, &result)
	return result
}

func rejectContentFields(data []byte) error {
	var value any
	if err := json.Unmarshal(data, &value); err != nil {
		return err
	}
	var walk func(any) error
	walk = func(value any) error {
		switch item := value.(type) {
		case map[string]any:
			for key, nested := range item {
				if key == "source_text" || key == "statement" || key == "quote" || key == "locator" {
					return fmt.Errorf("metadata/receipt exposed content field %q", key)
				}
				if err := walk(nested); err != nil {
					return err
				}
			}
		case []any:
			for _, nested := range item {
				if err := walk(nested); err != nil {
					return err
				}
			}
		}
		return nil
	}
	return walk(value)
}

func (h *harness) sourceHistory(path string, inputs []sourceInput, known map[int]json.RawMessage) error {
	res, err := h.sourceReq("GET", path+"/revisions", h.tokenA, nil, "", "", 200)
	if err != nil {
		return err
	}
	history, err := decode[struct {
		Revisions []json.RawMessage `json:"revisions"`
	}](res)
	if err != nil {
		return err
	}
	if len(history.Revisions) != len(inputs) {
		return fmt.Errorf("source revision count=%d, want %d", len(history.Revisions), len(inputs))
	}
	seen := map[int]bool{}
	for _, raw := range history.Revisions {
		var revision struct {
			sourceInput
			SourceID      string `json:"source_id"`
			Number        int    `json:"number"`
			ContentSHA256 string `json:"content_sha256"`
			ByteLength    int    `json:"byte_length"`
			CreatedAt     string `json:"created_at"`
			CreatedBy     string `json:"created_by"`
		}
		if err := json.Unmarshal(raw, &revision); err != nil {
			return err
		}
		if revision.Number < 1 || revision.Number > len(inputs) || seen[revision.Number] {
			return fmt.Errorf("invalid/duplicate source revision number %d", revision.Number)
		}
		seen[revision.Number] = true
		want := inputs[revision.Number-1]
		if revision.sourceInput != want || revision.SourceID != path[strings.LastIndex(path, "/")+1:] {
			return fmt.Errorf("source revision %d changed supplied source text or provenance", revision.Number)
		}
		if revision.ContentSHA256 != fmt.Sprintf("%x", sha256.Sum256([]byte(want.SourceText))) || revision.ByteLength != len([]byte(want.SourceText)) {
			return fmt.Errorf("source revision %d hash/length differs from exact UTF-8 bytes", revision.Number)
		}
		if revision.CreatedAt == "" || h.expectedAuthors[revision.CreatedBy] == "" {
			return fmt.Errorf("source revision lacks authenticated author and timestamp")
		}
		if previous, exists := known[revision.Number]; exists && !equalJSON(previous, raw) {
			return fmt.Errorf("immutable source revision %d changed", revision.Number)
		}
		known[revision.Number] = append(json.RawMessage(nil), raw...)
		single, err := h.sourceReq("GET", fmt.Sprintf("%s/revisions/%d", path, revision.Number), h.tokenA, nil, "", "", 200)
		if err != nil {
			return err
		}
		if !equalJSON(single.body, raw) || single.header.Get("ETag") != fmt.Sprintf(`"%d"`, revision.Number) {
			return fmt.Errorf("source revision %d differs between detail and history", revision.Number)
		}
	}
	return nil
}

func (h *harness) sourceClaims(path string, number int, want claimInput) (response, error) {
	res, err := h.sourceReq("GET", fmt.Sprintf("%s/revisions/%d/claims", path, number), h.tokenA, nil, "", "", 200)
	if err != nil {
		return res, err
	}
	claims, err := decode[struct {
		Claims []sourceClaim `json:"claims"`
	}](res)
	if err != nil {
		return res, err
	}
	if len(claims.Claims) != 1 {
		return res, fmt.Errorf("expected exactly one claim on source revision %d", number)
	}
	claim := claims.Claims[0]
	if claim.ID == "" || claim.SourceID != path[strings.LastIndex(path, "/")+1:] || claim.SourceRevision != number || claim.Statement != want.Statement || claim.Locator != want.Locator {
		return res, fmt.Errorf("claim does not identify its exact source revision, statement, and locator")
	}
	if claim.Authority != "handler_entered" || claim.VerificationStatus != "unverified" || claim.CreatedAt == "" || h.expectedAuthors[claim.CreatedBy] == "" {
		return res, fmt.Errorf("manual claim must remain unverified and retain Handler attribution")
	}
	return res, nil
}

func (h *harness) restartSources() error {
	oldPID := h.process.cmd.Process.Pid
	if err := h.process.stop(); err != nil {
		return err
	}
	if err := h.process.start(h.client); err != nil {
		return err
	}
	newPID := h.process.cmd.Process.Pid
	fmt.Printf("Layer 2 Rust restart: PID %d terminated; PID %d started\n", oldPID, newPID)
	if oldPID == newPID {
		return fmt.Errorf("could not establish distinct Rust processes")
	}
	return h.verifyDatabase()
}

func (h *harness) runLayer2() error {
	input := sourceInput{
		Title: "Synthetic source " + h.runID, Origin: "synthetic://handler/" + h.runID,
		Owner: "Synthetic Handler", Synthetic: true,
		SourceText:   "Synthetic note: café enclosure target is 120 mm.\r\n",
		RightsStatus: "granted", PermissionBasis: "I authored this synthetic test note and permit local review.",
		PermittedUse: "scion_review", ChangeSummary: "Initial synthetic source",
	}
	quote := "enclosure target is 120 mm"
	start := strings.Index(input.SourceText, quote)
	claim := claimInput{Statement: "The synthetic note states a 120 mm target; this has not been verified.", Locator: claimLocator{StartByte: start, EndByte: start + len(quote), Quote: quote}}
	var draft scion
	if err := h.check("Layer 2 uses a separate synthetic Scion intake draft", func() error {
		res, err := h.req("POST", "/api/scions", h.tokenA, intake{Name: "Synthetic source intake " + h.runID, ProductCategory: "physical", ChangeSummary: "Source-link test draft"}, "source-scion", "", 201)
		if err != nil {
			return err
		}
		draft, err = decode[scion](res)
		return err
	}); err != nil {
		return err
	}
	scionPath := "/api/scions/" + draft.ID
	listPath := scionPath + "/sources"
	if err := h.check("missing/denied rights, missing basis, or unauthorized use deny source processing without a write", func() error {
		before, err := h.sourceReq("GET", listPath, h.tokenA, nil, "", "", 200)
		if err != nil {
			return err
		}
		for index, mutate := range []func(map[string]any){
			func(v map[string]any) { delete(v, "rights_status") },
			func(v map[string]any) { v["rights_status"] = nil },
			func(v map[string]any) { v["rights_status"] = "denied" },
			func(v map[string]any) { v["rights_status"] = "missing" },
			func(v map[string]any) { delete(v, "permission_basis") },
			func(v map[string]any) { v["permission_basis"] = " \t" },
			func(v map[string]any) { delete(v, "permitted_use") },
			func(v map[string]any) { v["permitted_use"] = "supplier_outreach" },
		} {
			payload := objectMap(input)
			mutate(payload)
			denied, err := h.sourceReq("POST", listPath, h.tokenA, payload, fmt.Sprintf("rights-denied-%d", index), `"1"`, 403)
			if err != nil {
				return err
			}
			if err := rejectContentFields(denied.body); err != nil {
				return err
			}
			after, err := h.sourceReq("GET", listPath, h.tokenA, nil, "", "", 200)
			if err != nil || !equalJSON(before.body, after.body) {
				return fmt.Errorf("denied rights attempt %d changed source list: %v", index, err)
			}
		}
		return nil
	}); err != nil {
		return err
	}
	if err := h.check("source links require current Scion If-Match and reject client hashes/non-synthetic inputs", func() error {
		for _, test := range []struct {
			body   any
			match  string
			status int
		}{{input, "", 428}, {input, `"2"`, 412}} {
			if _, err := h.sourceReq("POST", listPath, h.tokenA, test.body, "source-precondition", test.match, test.status); err != nil {
				return err
			}
		}
		for index, field := range []string{"content_sha256", "synthetic"} {
			payload := objectMap(input)
			if field == "synthetic" {
				payload[field] = false
			} else {
				payload[field] = strings.Repeat("0", 64)
			}
			if _, err := h.sourceReq("POST", listPath, h.tokenA, payload, fmt.Sprintf("source-forged-%d", index), `"1"`, 422); err != nil {
				return err
			}
		}
		return nil
	}); err != nil {
		return err
	}
	var created response
	var receipt sourceReceipt
	var sourcePath string
	known := map[int]json.RawMessage{}
	if err := h.check("link permitted synthetic source with exact UTF-8 SHA-256 and pinned Scion revision", func() error {
		var err error
		created, err = h.sourceReq("POST", listPath, h.tokenA, input, "source-create", `"1"`, 201)
		if err != nil {
			return err
		}
		receipt, err = decode[sourceReceipt](created)
		if err != nil {
			return err
		}
		if receipt.SourceID == "" || receipt.Number != 1 || created.header.Get("ETag") != `"1"` {
			return fmt.Errorf("source create must return revision 1 receipt and ETag")
		}
		if err := rejectContentFields(created.body); err != nil {
			return err
		}
		sourcePath = listPath + "/" + receipt.SourceID
		res, err := h.sourceReq("GET", listPath, h.tokenA, nil, "", "", 200)
		if err != nil {
			return err
		}
		list, err := decode[sourceList](res)
		if err != nil {
			return err
		}
		if len(list.Sources) != 1 || list.VerifiedFacts == nil || len(list.VerifiedFacts) != 0 || list.ExtractionStatus != "not_implemented" {
			return fmt.Errorf("source text, manual claims, extraction status, and verified facts must remain distinct")
		}
		source := list.Sources[0]
		if source.ID != receipt.SourceID || source.ScionID != draft.ID || source.ScionRevision != 1 || source.CurrentRevision != 1 || source.Title != input.Title || source.Origin != input.Origin || source.Owner != input.Owner || source.ContentSHA256 != fmt.Sprintf("%x", sha256.Sum256([]byte(input.SourceText))) || source.RightsStatus != "granted" || source.PermissionBasis != input.PermissionBasis || source.PermittedUse != input.PermittedUse || !source.Synthetic || source.ClaimCount != 0 || source.RevocationReason != nil {
			return fmt.Errorf("source summary lacks exact provenance/rights or immutable Scion linkage")
		}
		if err := rejectContentFields(res.body); err != nil {
			return err
		}
		return h.sourceHistory(sourcePath, []sourceInput{input}, known)
	}); err != nil {
		return err
	}
	claimPath := sourcePath + "/revisions/1/claims"
	if err := h.check("source-create receipt retries exactly; conflicting payloads cannot reuse keys", func() error {
		replay, err := h.sourceReq("POST", listPath, h.tokenA, input, "source-create", `"1"`, 201)
		if err != nil {
			return err
		}
		if err := equalReplay(created, replay); err != nil {
			return err
		}
		changed := input
		changed.SourceText += "Conflicting content."
		_, err = h.sourceReq("POST", listPath, h.tokenA, changed, "source-create", `"1"`, 409)
		return err
	}); err != nil {
		return err
	}
	if err := h.check("claim locators reject split UTF-8, mismatched quotes, empty/reversed/out-of-range ranges", func() error {
		unicodeStart := strings.Index(input.SourceText, "é")
		invalid := []claimLocator{
			{StartByte: unicodeStart + 1, EndByte: unicodeStart + 2, Quote: "é"},
			{StartByte: unicodeStart, EndByte: unicodeStart + 1, Quote: "é"},
			{StartByte: start, EndByte: start + len(quote), Quote: "enclosure target is 999 mm"},
			{StartByte: start, EndByte: start, Quote: ""},
			{StartByte: start + 1, EndByte: start, Quote: "x"},
			{StartByte: 0, EndByte: len([]byte(input.SourceText)) + 1, Quote: input.SourceText},
		}
		for index, locator := range invalid {
			payload := claim
			payload.Locator = locator
			if _, err := h.sourceReq("POST", claimPath, h.tokenA, payload, fmt.Sprintf("bad-locator-%d", index), "", 422); err != nil {
				return err
			}
		}
		res, err := h.sourceReq("GET", claimPath, h.tokenA, nil, "", "", 200)
		if err != nil {
			return err
		}
		list, err := decode[struct {
			Claims []sourceClaim `json:"claims"`
		}](res)
		if err != nil || len(list.Claims) != 0 {
			return fmt.Errorf("invalid locator stored a claim: %v", err)
		}
		return nil
	}); err != nil {
		return err
	}
	if err := h.check("claim requests cannot forge verification, extracted authority, or approval", func() error {
		for _, field := range []string{"verification_status", "authority", "approved"} {
			payload := objectMap(claim)
			payload[field] = "verified"
			if _, err := h.sourceReq("POST", claimPath, h.tokenA, payload, "forged-claim-"+field, "", 422); err != nil {
				return err
			}
		}
		return nil
	}); err != nil {
		return err
	}
	var claimCreated, claimSnapshot response
	if err := h.check("Handler-entered claim remains unverified and records one exact immutable source revision", func() error {
		var err error
		claimCreated, err = h.sourceReq("POST", claimPath, h.tokenA, claim, "source-claim", "", 201)
		if err != nil {
			return err
		}
		if err := rejectContentFields(claimCreated.body); err != nil {
			return err
		}
		claimSnapshot, err = h.sourceClaims(sourcePath, 1, claim)
		return err
	}); err != nil {
		return err
	}
	if err := h.check("claim retry replays receipt; second or changed claim cannot mutate the original", func() error {
		replay, err := h.sourceReq("POST", claimPath, h.tokenA, claim, "source-claim", "", 201)
		if err != nil {
			return err
		}
		if err := equalReplay(claimCreated, replay); err != nil {
			return err
		}
		changed := claim
		changed.Statement = "A different Handler-entered claim."
		for _, key := range []string{"source-claim", "source-second-claim"} {
			if _, err := h.sourceReq("POST", claimPath, h.tokenA, changed, key, "", 409); err != nil {
				return err
			}
		}
		after, err := h.sourceClaims(sourcePath, 1, claim)
		if err != nil || !equalJSON(claimSnapshot.body, after.body) {
			return fmt.Errorf("immutable claim changed after rejected writes: %v", err)
		}
		return nil
	}); err != nil {
		return err
	}
	second := input
	second.SourceText = strings.Replace(input.SourceText, "120", "125", 1)
	second.ChangeSummary = "Handler corrected synthetic target; prior revision retained"
	var revised response
	if err := h.check("new source revision preserves prior bytes and claim locator without rewriting intake", func() error {
		var err error
		revised, err = h.sourceReq("POST", sourcePath+"/revisions", h.tokenA, second, "source-revision-two", `"1"`, 201)
		if err != nil {
			return err
		}
		receipt, err := decode[sourceReceipt](revised)
		if err != nil || receipt.Number != 2 || revised.header.Get("ETag") != `"2"` {
			return fmt.Errorf("source revision did not advance to revision 2: %v", err)
		}
		if err := h.sourceHistory(sourcePath, []sourceInput{input, second}, known); err != nil {
			return err
		}
		after, err := h.sourceClaims(sourcePath, 1, claim)
		if err != nil || !equalJSON(claimSnapshot.body, after.body) {
			return fmt.Errorf("new source revision rewrote old claim: %v", err)
		}
		scionResponse, err := h.req("GET", scionPath, h.tokenA, nil, "", "", 200)
		if err != nil {
			return err
		}
		current, err := decode[scion](scionResponse)
		if err != nil || current.CurrentRevision != 1 || !equalJSON(current.Revision, draft.Revision) {
			return fmt.Errorf("linking a source rewrote the Scion intake: %v", err)
		}
		return nil
	}); err != nil {
		return err
	}
	if err := h.check("source revision missing/stale If-Match or missing rights leaves history immutable", func() error {
		for _, test := range []struct {
			match  string
			status int
		}{{"", 428}, {`"1"`, 412}} {
			if _, err := h.sourceReq("POST", sourcePath+"/revisions", h.tokenA, second, "source-stale", test.match, test.status); err != nil {
				return err
			}
		}
		denied := objectMap(second)
		delete(denied, "rights_status")
		if _, err := h.sourceReq("POST", sourcePath+"/revisions", h.tokenA, denied, "source-revision-denied", `"2"`, 403); err != nil {
			return err
		}
		return h.sourceHistory(sourcePath, []sourceInput{input, second}, known)
	}); err != nil {
		return err
	}
	secondClaim := claim
	secondClaim.Statement = "The corrected synthetic note states 125 mm; this remains unverified."
	secondClaim.Locator.Quote = strings.Replace(quote, "120", "125", 1)
	if err := h.check("claim locators are checked against the named source revision, not the latest source", func() error {
		path := sourcePath + "/revisions/2/claims"
		if _, err := h.sourceReq("POST", path, h.tokenA, claim, "source-wrong-revision-claim", "", 422); err != nil {
			return err
		}
		if _, err := h.sourceReq("POST", path, h.tokenA, secondClaim, "source-claim-two", "", 201); err != nil {
			return err
		}
		_, err := h.sourceClaims(sourcePath, 2, secondClaim)
		return err
	}); err != nil {
		return err
	}
	if err := h.check("source endpoints hide foreign Scions and source IDs without metadata or count leakage", func() error {
		return h.sourceHiding(scionPath, sourcePath, input, claim)
	}); err != nil {
		return err
	}
	if err := h.check("all source, history, locator, and mutation endpoints require authentication", func() error {
		for _, endpoint := range sourceEndpoints(scionPath, sourcePath, input, claim) {
			for _, token := range []string{"", "invalid-" + h.runID} {
				res, err := h.sourceReq(endpoint.method, endpoint.path, token, endpoint.body, "source-unauthorized", `"2"`, 401)
				if err != nil {
					return err
				}
				if err := rejectContentFields(res.body); err != nil {
					return err
				}
			}
		}
		return nil
	}); err != nil {
		return err
	}
	if err := h.check("source revisions, claims, and retry receipts persist after actual Rust restart", func() error {
		before, err := h.sourceReq("GET", sourcePath, h.tokenA, nil, "", "", 200)
		if err != nil {
			return err
		}
		if err := h.restartSources(); err != nil {
			return err
		}
		after, err := h.sourceReq("GET", sourcePath, h.tokenA, nil, "", "", 200)
		if err != nil || !equalJSON(before.body, after.body) {
			return fmt.Errorf("source detail changed after restart: %v", err)
		}
		if err := h.sourceHistory(sourcePath, []sourceInput{input, second}, known); err != nil {
			return err
		}
		for number, want := range []claimInput{claim, secondClaim} {
			if _, err := h.sourceClaims(sourcePath, number+1, want); err != nil {
				return err
			}
		}
		replay, err := h.sourceReq("POST", sourcePath+"/revisions", h.tokenA, second, "source-revision-two", `"1"`, 201)
		if err != nil {
			return err
		}
		if err := equalReplay(revised, replay); err != nil {
			return err
		}
		replay, err = h.sourceReq("POST", claimPath, h.tokenA, claim, "source-claim", "", 201)
		if err != nil {
			return err
		}
		return equalReplay(claimCreated, replay)
	}); err != nil {
		return err
	}
	reason := "Synthetic permission withdrawn for this harness run."
	revokeBody := map[string]string{"reason": reason}
	var revoked response
	if err := h.check("revocation requires current source revision and is terminal with an auditable reason", func() error {
		for _, test := range []struct {
			match  string
			status int
		}{{"", 428}, {`"1"`, 412}} {
			if _, err := h.sourceReq("POST", sourcePath+"/revoke", h.tokenA, revokeBody, "revoke-stale", test.match, test.status); err != nil {
				return err
			}
		}
		var err error
		revoked, err = h.sourceReq("POST", sourcePath+"/revoke", h.tokenA, revokeBody, "source-revoke", `"2"`, 201)
		if err != nil {
			return err
		}
		status, err := decode[struct {
			SourceID     string `json:"source_id"`
			RightsStatus string `json:"rights_status"`
		}](revoked)
		if err != nil || status.SourceID != receipt.SourceID || status.RightsStatus != "revoked" {
			return fmt.Errorf("revocation returned an invalid receipt: %v", err)
		}
		return rejectContentFields(revoked.body)
	}); err != nil {
		return err
	}
	checkRevoked := func() error {
		for _, suffix := range []string{"", "/revisions", "/revisions/1", "/revisions/2", "/revisions/1/claims", "/revisions/2/claims"} {
			res, err := h.sourceReq("GET", sourcePath+suffix, h.tokenA, nil, "", "", 403)
			if err != nil {
				return err
			}
			if err := rejectContentFields(res.body); err != nil {
				return err
			}
		}
		for _, key := range []string{"source-revision-two", "source-new-after-revoke"} {
			if _, err := h.sourceReq("POST", sourcePath+"/revisions", h.tokenA, second, key, `"1"`, 403); err != nil {
				return err
			}
		}
		for _, key := range []string{"source-claim", "source-claim-after-revoke"} {
			if _, err := h.sourceReq("POST", claimPath, h.tokenA, claim, key, "", 403); err != nil {
				return err
			}
		}
		res, err := h.sourceReq("GET", listPath, h.tokenA, nil, "", "", 200)
		if err != nil {
			return err
		}
		list, err := decode[sourceList](res)
		if err != nil || len(list.Sources) != 1 {
			return fmt.Errorf("revoked source lost its audit metadata: %v", err)
		}
		meta := list.Sources[0]
		if meta.ID != receipt.SourceID || meta.RightsStatus != "revoked" || meta.RevocationReason == nil || *meta.RevocationReason != reason || meta.CurrentRevision != 2 || meta.ClaimCount != 2 || len(list.VerifiedFacts) != 0 || list.ExtractionStatus != "not_implemented" {
			return fmt.Errorf("revoked source metadata or evidence state is incorrect")
		}
		return rejectContentFields(res.body)
	}
	if err := h.check("revocation blocks source/claim content, processing, and old retry receipts; audit metadata stays content-free", checkRevoked); err != nil {
		return err
	}
	if err := h.check("revocation and safe source-create receipt retries cannot restore content access", func() error {
		replay, err := h.sourceReq("POST", sourcePath+"/revoke", h.tokenA, revokeBody, "source-revoke", `"2"`, 201)
		if err != nil {
			return err
		}
		if err := equalReplay(revoked, replay); err != nil {
			return err
		}
		replay, err = h.sourceReq("POST", listPath, h.tokenA, input, "source-create", `"1"`, 201)
		if err != nil {
			return err
		}
		if err := equalReplay(created, replay); err != nil {
			return err
		}
		if err := rejectContentFields(replay.body); err != nil {
			return err
		}
		if _, err := h.sourceReq("POST", sourcePath+"/revoke", h.tokenA, revokeBody, "source-revoke-again", `"2"`, 403); err != nil {
			return err
		}
		return checkRevoked()
	}); err != nil {
		return err
	}
	return h.check("revocation persists after Rust restart and foreign organizations still receive identical 404s", func() error {
		if err := h.restartSources(); err != nil {
			return err
		}
		if err := checkRevoked(); err != nil {
			return err
		}
		return h.sourceHiding(scionPath, sourcePath, input, claim)
	})
}

type sourceEndpoint struct {
	method string
	path   string
	body   any
}

func sourceEndpoints(scionPath, sourcePath string, input sourceInput, claim claimInput) []sourceEndpoint {
	return []sourceEndpoint{
		{"GET", scionPath + "/sources", nil},
		{"POST", scionPath + "/sources", input},
		{"GET", sourcePath, nil},
		{"GET", sourcePath + "/revisions", nil},
		{"GET", sourcePath + "/revisions/1", nil},
		{"GET", sourcePath + "/revisions/1/claims", nil},
		{"POST", sourcePath + "/revisions", input},
		{"POST", sourcePath + "/revisions/1/claims", claim},
		{"POST", sourcePath + "/revoke", map[string]string{"reason": "Unauthorized request"}},
	}
}

func (h *harness) sourceHiding(scionPath, sourcePath string, input sourceInput, claim claimInput) error {
	unknownScion := "/api/scions/00000000-0000-4000-8000-000000000000"
	unknownSource := scionPath + "/sources/00000000-0000-4000-8000-000000000000"
	// A foreign source ID must also stay hidden when nested under a Scion that
	// organization B actually owns; checking only foreign Scion paths is weaker.
	owned, err := h.req("POST", "/api/scions", h.tokenB, intake{Name: "Source isolation draft " + h.runID, ProductCategory: "physical", ChangeSummary: "Test nested source ownership"}, "source-hiding-scion", "", 201)
	if err != nil {
		return err
	}
	other, err := decode[scion](owned)
	if err != nil {
		return err
	}
	otherPath := "/api/scions/" + other.ID
	for index, endpoint := range sourceEndpoints(scionPath, sourcePath, input, claim) {
		foreign, err := h.sourceReq(endpoint.method, endpoint.path, h.tokenB, endpoint.body, fmt.Sprintf("foreign-source-%d", index), `"2"`, 404)
		if err != nil {
			return err
		}
		missing, err := h.sourceReq(endpoint.method, strings.Replace(endpoint.path, scionPath, unknownScion, 1), h.tokenB, endpoint.body, fmt.Sprintf("unknown-source-%d", index), `"2"`, 404)
		if err != nil {
			return err
		}
		if !bytes.Equal(foreign.body, missing.body) {
			return fmt.Errorf("foreign endpoint %s %s differs from unknown Scion response", endpoint.method, endpoint.path)
		}
		for _, header := range []string{"ETag", "Location", "Content-Range", "X-Total-Count"} {
			if foreign.header.Get(header) != "" || missing.header.Get(header) != "" {
				return fmt.Errorf("foreign source leaked existence through %s", header)
			}
		}
		if err := rejectContentFields(foreign.body); err != nil {
			return err
		}
		if err := h.rejectAuthorMetadata(foreign); err != nil {
			return err
		}
		var payload map[string]json.RawMessage
		if err := json.Unmarshal(foreign.body, &payload); err != nil {
			return err
		}
		for _, key := range []string{"sources", "claims", "revisions", "source_id", "claim_count", "content_sha256", "owner", "title"} {
			if _, leaked := payload[key]; leaked {
				return fmt.Errorf("denied source exposed %s", key)
			}
		}
		if strings.HasPrefix(endpoint.path, sourcePath) {
			misnested, err := h.sourceReq(endpoint.method, strings.Replace(endpoint.path, scionPath, otherPath, 1), h.tokenB, endpoint.body, fmt.Sprintf("misnested-source-%d", index), `"2"`, 404)
			if err != nil {
				return err
			}
			if !bytes.Equal(foreign.body, misnested.body) {
				return fmt.Errorf("foreign source ID nested under an owned Scion leaked existence")
			}
			missingSource, err := h.sourceReq(endpoint.method, strings.Replace(endpoint.path, sourcePath, unknownSource, 1), h.tokenA, endpoint.body, fmt.Sprintf("missing-id-%d", index), `"2"`, 404)
			if err != nil {
				return err
			}
			if !bytes.Equal(foreign.body, missingSource.body) {
				return fmt.Errorf("foreign source differs from missing source under an owned Scion")
			}
		}
	}
	return nil
}
