# Segment-window selection and unresolved outcomes — Draft design lock (2026-10-27)

Refs #4556 parent §7.2 CALC05/06. Existing locked capability; no new product denominator or owner acceptance.

Base is the freshly fetched main in source-preflight.json. Independent owned copy only. Existing canonical rollout/reference posture must remain fail-closed; default/OFF legacy behavior and public W2 null-segmentIndex DTO must not change.

## Intended result and discriminator

Same-day slot selection must be based on the actual containing segment window, not assignment row order or a split shift's first-to-last envelope. A slot0 split shift08–09 plus16–17 and slot1 shift13–15 at13:00 discriminates the implementation: slot1 contains the instant, slot0's envelope alone must not make it win or make a false tie. Reversed candidate input order must preserve the winner. If several actual windows contain the instant, retain the ratified ambiguity; when none matches retain the ratified unresolved outcome, with no guessed identity. Existing overnight/open-record precedence, post-shift tail/approved-overtime semantics, frozen-context identity, org/user isolation and public response shapes are retained; do not invent per-segment tails or replacement semantics.

An envelope-only W2 resolver case cannot prove the whole segment-aware parent clause. Read the actual canonical HTTP candidate/frozen-context path and obtain an actual discriminating reproduction before changing runtime. Source-only theories and tests of one frozen shift are not delivery proof.

## Work and gates

1. Add exact no-window response/no winner and exact three-candidate ambiguity/reversed native-row-order assertions to the two existing W2 DB cases. Retain every existing assertion, hook and budget; correct only the directly contradicted old ambiguity comment.
2. Trace and reproduce real published split-segment versus later-slot selection through the existing HTTP/PG host in an isolated synthetic org under the existing canonical test posture. If current runtime already meets it, add durable proof only; if not, fix the minimum producer/resolver seam only after the reproduction. Do not weaken a DB/pointer/source gate.
3. Add actual overlapping-window and no-window discriminators at the scope the existing locked contract supports; preserve the original unresolved/ambiguous union and frozen/legacy qualification. Do not label a legacy-envelope discriminator as canonical segment proof.
4. Match scoped negative controls to each changed selection/classification guard; restore runtime bytes exactly. No unchanged-green replay for receipts.
5. Explicit changed-file lint with same-path baseline; type/validate quality appropriate to changed runtime. Independent source review plus main native assertion/log audit. Filtered/skipped/TODO never count as pass.
6. Normal own-branch push, Draft PR, exact head/source/body readback; fresh exact-head required CI and actual newly registered named execution before final evidence.

No result/calculation/segment-snapshot writes to fabricate expected output. Synthetic source shifts/assignments and normal authenticated HTTP fixture entry are allowed; existing RBAC_BYPASS qualification must be explicit if used. No claim of real-auth, UAT, provider traffic or performance acceptance.

Separate pending correction replacement/missing-boundary target decision remains untouched. No correction/OT bridge implementation by this slice. All PR Draft/HOLD; no merge/deploy/R71/tag/release/business-config changes; Stream/lifecycle OFF; real UAT/50004 excluded; historical08PUT INCONCLUSIVE. Formal parent/W8/owner/manual/live acceptance is separate.

## Bounded implementation interpretation

Actual-containing selection is a preference within the existing attribution contract. Zero actual-segment hits retain original envelope/gap/tail/approved-overtime behavior; CALC06 exact no-window proof refers to the original W2 no-match union and does not redefine every internal split gap as unresolved. Unused candidate rows are not a second issued context; the distinct-issued-context fingerprint refusal remains mandatory. Enabled-timezone verification must cover the selected complete original window, including gaps and policy partitions whose reconstructed window moves elsewhere. No new authority or owner acceptance is granted by this clarification.
