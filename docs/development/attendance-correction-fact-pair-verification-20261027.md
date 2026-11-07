# Directional correction fact pairs verification — 2026-10-27

Refs #4556. Design lock: attendance-correction-fact-pair-design-lock-20261027.md. Fresh main base b9bccade372e0bf339df2ea66211fb0e20d58861. Draft/HOLD only.

This is a pure calculation prerequisite. It consumes already-resolved correction facts with exact evidence refs; it does not implement the approval-to-canonical bridge, choose replacement/missing-cell targets, write a DB, enable features, or repair the separately observed private-combination approval500.

| Gate | Actual evidence |
|---|---|
| G1 original reproduction | Original calculator with the new valid opposite-direction pair:1 matching input_schema_invalid red; existing single-direction correction control:1 passed;91 filtered exclusions. Raw diff contains the exact reason. |
| G2 affected files | Full calculator94/94, existing fingerprint golden4/4 and fingerprint gates9/9:107 actual passed, zero skip. The original76 calculator cases/hooks are byte-identical;18 cases added. |
| G3 binding/cardinality | Four mixed immutable binding fields rejected in both input orders; duplicate same-direction facts rejected; distinct requests can retain independent bindings; original leave/overtime/outdoor cardinality remains rejected with corresponding positive controls. |
| G4 matching mutations | Original directional deduplication restored:2 matching reds/92 filtered. Four binding comparisons removed:4 matching reds/90 filtered. Direction tie fallback reverted:1 matching fingerprint red/93 filtered. Exact request-identity guard removed:1 matching compatibility red/93 filtered. Both runtime files exactly restored after each phase; no full-green replay for receipts. |
| G5 quality | Explicit changed runtime/test lint exit0. Actual pnpm validate:all exit0, including production lint/types. Independent source review is recorded separately before publication. |
| G6 current-head CI | Pending publication/current-head required terminal success and actual calculator94 plus fingerprint execution. No base, sibling or parent green substitutes for this gate. |

A valid adjacent-segment control calculates180 and360 minutes with same-request out/in facts at the same12:00 instant. The old comparator left them tied; reversing the facts changed the semantic fingerprint. Only the final complete tie for correction facts now uses the existing direction discriminator. Earlier tuple keys, other kinds, closed field validation and fingerprint domains remain unchanged. Original golden vectors pass.

Two reproduction controllers initially marked their postchecks failed because Vitest1.6.1 JSON failure messages elided the reason/full hashes. Actual assertionResults still recorded the matching failures; the complete raw diffs independently prove input_schema_invalid and the two distinct hashes. Those artifacts are retained. Only the missing later phase ran; neither reproduction was replayed to repair a receipt.

All dependencies/test/build artifacts are in an owned isolated copy. No real provider/customer I/O, schema/OpenAPI/SDK, flags, workflow registration or dependencies changed. Stream/lifecycle OFF; no merge/deploy/R71/tag/release/business config; real UAT/business50004 excluded; historical08PUTINCONCLUSIVE. Parent/W8/owner/manual/live acceptance remains independent.

## Independent review P2 and final source

The first106-pass candidate was not final. Review identified a pure accepted-input compatibility defect: Unicode-collation-equivalent but byte-distinct request IDs could reach the direction fallback. The new named regression actually failed on that candidate and passed with both original runtime modules (each1 selected/93filtered). The final fallback additionally requires exact request ID and textual immutable binding equality; numeric versions already compare exactly earlier. Original calculator-valid inputs cannot contain two correction facts for one exact request ID, so their sort order is preserved. Review source followup closed the P2 with no new confirmed P1/P2. Current affected3files were rerun because production fingerprint code changed:107actual passed, plus all four matching mutations and current lint/validate:all0. Initial106 and originalHOLD artifacts remain historical, not final-green evidence. No real UUID adapter reachability of that counterexample was claimed.
