# Approval Parity Execution Ledger (2026-08-17)

**Status:** LIVING - planning ledger only; no new runtime phase is authorized by this file
**Master design:** `approval-parity-master-design-lock-20260817.md`
**Verification record:** `approval-parity-final-verification-20260817.md`
**Initial baseline:** `origin/main@d33a6a0fa120452b721ea76d449dfa1463727463` (superseding the
2026-08-17 planning-audit baseline `b84c30db97`, which lost exact-head qualification when main advanced)

## 0. Ledger rules

1. Record source SHA, review SHA, landing SHA, and merged-main verification SHA separately.
2. `CI green`, `review approved`, `merged`, `deployed`, `UAT passed`, and `flag enabled` are distinct.
3. A review is valid only for its recorded SHA. Rebase or conflict resolution requires requalification.
4. A Draft/PROPOSED row is not authorized runtime work unless the owner-decision column names the
   ratified lock or explicit implementation authorization.
5. Flags remain OFF unless a row records environment, approver, time, evidence, and rollback result.
6. Do not store secrets, tenant data, form values, user identities, or private security detail here.

## 1. Existing foundations

| Foundation | State | Evidence / boundary |
|---|---|---|
| Canvas V2 interaction lock | RATIFIED | `approval-canvas-v2-interaction-design-lock-20260721.md`; O3 deferred |
| Canvas engineering stack | on main | default OFF; tenant S1-S12 not yet recorded complete |
| Version diff and restore | on main | immutable published version; restore creates a new draft |
| Durable approval event delivery | on main | independent activation history; do not infer current environment flag |
| Attachment runtime | on main | independent flag and UAT |
| FWB create/update/decision values | on main | independent flag and UAT; number mapping unavailable |
| Form-builder delta #4866 @ `80d33cbefa` | PR-local Draft / stale baseline | not present on main; range-diff and refresh required before ratification or implementation |
| Form command substrate | on main, not mounted | pure insert-after/append, identity, and reference commands plus required unit tests exist; production view does not call them and exact start/between/end slots are still P0 work; there is NO retype/update command in the substrate — it is new P0 command work (PR #4866 F3), not a mount |
| Current three-region form UI | on main, incomplete | palette/preview/inspector and drag affordance exist; palette drop remains append-only, structural field-list operations have history, and direct inspector property edits have none |
| Approval detail/center | on main, partial | preserve shipped timeline, summary, aging, batch approve/reject, and retry; only residual chrome belongs in P5-C |

## 2. Phase ledger

Use one row per PR. Split a row before implementation if it contains more than one independently
reviewable behavior.

| ID | Phase | Slice | Lock / decision | PR | Head SHA | State | Required evidence | Owner gate |
|---|---|---|---|---|---|---|---|---|
| P0-A | P0 | Refresh form-builder delta against current shell | #4866 revision | #4866 | `80d33cbefa...` old | NEEDS-REFRESH | range-diff, current file anchors, adversarial design review | ratify revised delta |
| P0-B1 | P0 | Extract flag-OFF fallback | revised #4866 | — | — | NOT STARTED | byte-equivalent mounted tests | implementation authorization |
| P0-B2 | P0 | Mount existing command substrate + authoritative opaque identity/reference providers | revised #4866 | — | — | NOT STARTED | production import/call proof; duplicate-ID, incomplete-history, and collision mutations | same |
| P0-B3 | P0 | Replace append-only drop with exact slots + typed drag codec | revised #4866 | — | — | NOT STARTED | start/middle/end, cancel/dragend/Escape/navigation/read-only, malformed/stale payload, browser geometry | same |
| P0-B4 | P0 | Property commits in one history + dependency-safe delete + NEW typed retype command (not a mount) | revised #4866 | — | — | NOT STARTED | one-command history; complete visibility/condition/permission/graph/mapping/detail reference negatives; retype ID-preservation and refusal negatives | same |
| P0-B5 | P0 | Production mount behind Canvas flag | revised #4866 | — | — | NOT STARTED | flag-OFF equivalence, flag-ON browser tests | same |
| P1-A0 | P1 | Basic-information typed controls + live validation count | Lock-0 | — | — | NOT DRAFTED | no raw comma-separated IDs; browser/a11y; old draft round-trip | ratify delta |
| P1-A | P1 | D0 inspector presentation cleanup | Lock-0 | — | — | NOT DRAFTED | named presentations; immediate commands; no scrim/Save transaction; readonly honesty copy retained | ratify delta |
| P1-B | P1 | Existing multi-source inspector | existing runtime + D0 delta | — | — | NOT STARTED | remove single-source lock; shipped union exact-set; all sources round-trip; no flatten | implementation authorization |
| P1-C | P1 | Shipped timeout + threshold frontend compatibility | D3-p/G1-p bounded owner decision | — | — | NOT STARTED | prevent mode flatten; types/allowlists/node-edit/summary/restore/linear-only/dynamic-M tests | ratify bounded decision |
| P1-D | P1 | Canvas residual + editor version entry | D0 delta | — | — | NOT STARTED | migrate shipped type ribbons to the ratified flat-card grammar; browser/a11y; no graph semantic delta | implementation authorization |
| P2-A | P2 | New enterprise assignee semantics | Lock-1 (PROPOSED, `approval-lock1-enterprise-assignees-20260817.md`) | #4940 | `7fb53514d7...` docs-only | LOCK PROPOSED — NOT RATIFIED | directory/corp/empty-resolution matrix; §3 gates G-1..G-20; OD-L1-1..7 owner decisions | ratify lock |
| P2-B | P2 | Department/contact fields and routing | Lock-2 | — | — | LOCK RATIFIED — implementation NOT STARTED | field schema plus routing, snapshot/live, corp, authz tests | implementation authorization |
| P3-A | P3 | Missing flow policies only; preserve shipped merge flags | Lock-4 | — | — | NOT DRAFTED | server-enforced fallback/automatic-decision/departure-policy mutations plus merge non-regression | ratify lock |
| P3-B | P3 | More settings first functional group | D0 delta + Lock-4 + selected Lock-6 subset | — | — | BLOCKED ON P3-A + GLOBAL POLICY | no inert controls, browser tests | selected global capability landed |
| P4-A | P4 | Handler node | Lock-3 | — | — | NOT DRAFTED | all graph walks, txn rollback, version tests | ratify lock |
| P4-B | P4 | Runtime readonly/editable enforcement | Lock-7 + named edit surface | — | — | BLOCKED ON EDIT SURFACE | HTTP bypass negatives, transaction tests | ratify lock and edit surface |
| P5-A | P5 | Per-node operation policies | Lock-5 | — | — | NOT DRAFTED | UI/server agreement, role matrix | ratify lock |
| P5-B | P5 | Requester/global policies | Lock-6 | — | — | NOT DRAFTED | direct API negatives, time bounds | ratify lock |
| P5-C | P5 | Shared dialogs, detail table/tabs, center master-detail | landed policy subsets | — | — | NOT STARTED | existing timeline/summary/aging/batch/retry do not regress; mounted/browser/mobile/a11y | matching capability landed |
| P6-A | P6 | Additional bounded form controls excluding department/contact | Lock-8 subsets | — | — | NOT DRAFTED | schema/runtime/round-trip per field | ratify each subset |
| P7-A | P7 | Exact merged-main full verification | all landed phases | — | — | BLOCKED | verification document complete | owner review |
| P7-B | P7 | Canvas tenant acceptance | P0-P5 merged + P7-A | — | — | BLOCKED | S1-S12 on exact deployed SHA | owner UAT |
| P7-C | P7 | FWB UAT | durable delivery + FWB line + P7-B | — | — | BLOCKED | durable and FWB flags recorded; create/update/decision, net-effect-once | owner UAT |
| P7-D | P7 | Attachment UAT | attachment line + P7-C | — | — | BLOCKED | authz, bind, download, GC | owner UAT |
| P7-E | P7 | Staged flag enablement | owner handoff + P7-D | — | — | BLOCKED ON P7-D | Canvas, durable prerequisite, FWB, then attachment rollout/rollback observations | owner operation |

## 3. Decision ledger

| Decision | Current value | Authority / evidence | Reopen condition |
|---|---|---|---|
| Renderer | bespoke deterministic canvas | RATIFIED D0; O3 DEFER | measured 100+ node failure or owner decision |
| Free-form wiring | not supported | graph safety boundary | new graph-model lock |
| Accessible list fallback | retained | S12 equivalence not proven | S12 + owner fallback window |
| Form identity | opaque allocator for new builder | proposed #4866 | owner ratification |
| Identity/reference provider | unresolved between PR #4866 proposal and current command API | current source audit | revised #4866 ratification |
| Multi-source runtime | existing union + identity dedup | resolver and backend normalization | runtime defect evidence |
| Timeout/threshold | backend persists/executes; frontend over-locks affected graphs and can flatten unsupported mode in linear hydration | current source contract | P1-C completion |
| More settings | not mounted empty | master M7 | first functional policy group |
| Handler | missing | requires Lock-3 | ratify + implement |
| Readonly/editable | runtime-inert | existing type comments | handler/edit path + Lock-7 |
| Action attachments | not part of dialog-only work | master M9 | separate capability lock |
| Number FWB | fail-closed | existing FWB contract | independent exact-number decision |
| Flag order | Canvas, durable prerequisite plus FWB, attachments | owner handoff plus production FWB dependency | explicit owner change |
| Private release prerequisites | tracked outside public repository artifacts | disclosure discipline | owner records closure out of band |

## 4. Evidence ledger template

Append one row for every review or verification event. Never edit an old verdict to cover a new SHA.

| Date | Slice / PR | Exact SHA | Evidence type | Command / probe | Result | Reviewer | Residual |
|---|---|---|---|---|---|---|---|
| 2026-08-17 | historical plan input | `38ac9178f4...` | reported prior evidence | form/node/history 35; resolver 27 | NOT RE-RUN; historical only | prior review | does not qualify current baseline |
| 2026-08-17 | current planning-source audit | `b84c30db97...` | full proposal + source + cross-lock + CI-file review | production entrypoints, pure command substrate, backend contracts, Feishu offline corpus | PLAN CORRECTED; no runtime/browser qualification | Codex + independent Grok | P0/P1 scope corrected; private release details remain out of band |
| 2026-08-17 | docs REV-2: rebase + owner review fixes | this commit @ `d33a6a0fa1` base | owner REQUEST-CHANGES (2 P2 + 2 P3) + independent claim verification (V1-V8: 6 confirmed, 2 nuanced) | rebase to current main; M3/P0-B4 retype split; P1-C flatten-reachability wording; §0.2 provenance; baseline refresh | APPLIED; docs-only, no runtime change | Claude (fix round) after Codex + Claude cross-review | ratify remains owner-only on the new single-commit SHA |
| 2026-08-17 | master lock ratification | reviewed `217b56137e`; merged `5b31cb4349` (#4935, blob-identical) | owner decision record | §9 filled; Status PROPOSED → RATIFIED; required checks 14/14 green on the reviewed head; owner merged #4935 personally | RATIFIED (design program only) | owner (explicit in-session instruction); recorded by Claude | runtime/UAT/deployment/flags remain individually gated; next actionable = P0-A refresh of PR #4866 |
| 2026-08-17 | Lock-0 D0 interaction delta ratification | drafted `88ff0ff037` + record commit | independent fable review of opus draft; owner goal-instruction provenance | six deltas L0-1..L0-6 accepted with dispositions D1-D6; master §3 Lock-0 row + §4 UI-0 row updated in the same PR | RATIFIED (P1-A design only) | Claude after opus draft | P1-A0/A/B/D unblocked pending P0 hot-file handoff; route-preview debt tracked on UI-0 |
| 2026-08-17 | Lock-8 field-vocabulary ratification | drafted `cbf1014a65` + record commit | independent fable review of opus draft (spot-verified executor fail-open default + two task-premise corrections); owner goal-instruction provenance | L8-A 说明/L8-B date_range/L8-C formatted-number-as-props/L8-D formula deferred; nine ODs per recommendation; no-print-substrate exclusion; census-not-checklist doctrine | RATIFIED (design only) | Claude after opus draft | P6-A slices unblocked after P0 completes; L8-C rides the existing number type |
| 2026-08-17 | Lock-6 requester/global-policy ratification | drafted `1653922682` + record commit | independent fable review of opus draft (spot-verified L6-P1 shipped defect: policy carrier destroyed on republish); owner goal-instruction provenance | L6-A dedup-tier = first global policy + fifth-step activator; v1 = L6-A + L6-P1 prerequisite; FWB revoke seam = reject-when-fired; ten ODs per recommendation | RATIFIED (design only) | Claude after opus draft | L6-P1 is a shipped-defect prerequisite (API-set policy.autoApproval destroyed by editor publish); L6-E moved to Lock-5 |
| 2026-08-17 | Lock-2 org-controls/field-routing ratification | drafted `a30970af13` + review round `a1a932ddc3` + record commit | independent adversarial review (REQUEST-CHANGES: 1 P1 Lock-1 §K4 disposition re-open, 1 P2 OD-L2-8(a) cost omission, 1 P3, 4 NITs — all closed in review round; 15 load-bearing claim groups spot-verified, zero code claims refuted); owner goal-instruction provenance | dept value = local uuid; props allowlist on shipped `user`; UNION + publish maxSelections pin; required-pin retrofit at next save/publish; no-visibilityRule pin + create-time 422; cc rows deferred; multi-selection lands with prop or publish rejects; dept check on every field vs create anchor with unlinked-requester cost accepted | RATIFIED (design only) | Claude (opus draft, fable review) | Lock-1 §K4 erratum candidate recorded (citation imprecision only, posture binding); form_field_user publish pin checks neither required nor visibility — closure is Lock-2's own §2.7 finding |
| 2026-08-17 | Lock-5 node-operation-policy ratification | drafted `799a3a6efa` + record commit | independent fable review of opus draft (spot-verified add-sign placebo + rejectCommentRequired double-hardcode); owner goal-instruction provenance | eleven ODs per recommendation (nodeOperationPolicy object / absent≡allowed / after-sign = deferred same-node round / unified commentRequired / policy_denied row) | RATIFIED (design only) | Claude after opus draft | 前加签 honesty fix (B-1/B-2) is a P5 early slice; signaturePolicy stays declared-inert with named owner slice |
| 2026-08-17 | Lock-1 enterprise-assignee semantics ratification | drafted `02e80020c2` + record commit | independent fable review of opus draft; owner goal-instruction provenance | K1-K6 contracts; seven ODs recorded per recommendation (EAGER/curated-binding/latest-epoch/empty-policy/level-first/termination-field/cc-widen); G-1..G-20 gate table | RATIFIED (design only) | Claude after opus draft | P2 K-slices unblocked serially; K6 FE after P1-C; group endpoint deferred pending K1 landing |
| 2026-08-17 | Lock-4 flow-policies ratification | drafted `a56882775c` + record commit | independent fable review of opus draft; owner goal-instruction provenance | F4-A..E contracts; ten ODs per recommendation; return-nullification hazard locked (OD-L4-10) with D-3 gate; auto_reject deferred as recorded residual | RATIFIED (design only) | Claude after opus draft | P3-A slices unblocked (Lock-1 landed via #4940; K3 seam condition satisfied); P3-B nominee = template-level dedup tier |
| 2026-08-17 | Lock-3 handler-node ratification | drafted `2e850553c1` + record commit | independent fable review of opus draft (spot-verified org-detector keying + partial-index correction); owner goal-instruction provenance | handler node contract + 25-row blast radius + Lock-7 seam; seven ODs per recommendation (linear-only/no-fallback-key/opinion-optional/metrics-split/handler-ordinal/7-of-8/submit-only) | RATIFIED (design only) | Claude after opus draft | P4-A slice unblocked after P0-P1 hot files free; field-write key 422 until Lock-7 |
| 2026-08-17 | P1-A gate review adjudication (#4944, Lock-0 L0-1/L0-2/L0-6) | reviewed `347c8035ef` (pre-fix-round head) | independent adversarial gate (refute-first); 14 mutation/instrumentation probes + real-Chrome mechanism probe; gate MD `/tmp/pr4944-review-claude-20260817.md` | full gate report §4 "Adjudication of the four self-reported deviations" plus the A-12/A-1 gate-verdict rows in §2 | REQUEST-CHANGES at reviewed head (1 P1, 3 P2); five deviations adjudicated and recorded here per the gate's item 7 requirement: (1) A-8 "exactly one undo entry" literal is UNMET at this baseline — ACCEPTABLE-WITH-LEDGER; named follow-up = "route node-config commits through the canvas authoring history" (touches `TemplateAuthoringView.vue` + the commands module, a distinct slice from P1-A); (2) A-4's anti-flatten guard (`complexNodeConfigHasBackendDrop`/`unsupportedTemplateAuthoringReason`) is template-wide, not node-scoped — ACCEPTABLE-WITH-LEDGER, component-only scope directly verified (all 8 radios `disabled===true` in the unknown-kind fixture via the pre-existing upstream guard); named follow-up = node-scoped read-only degradation; (3) A-12 "the toolbar owns Left/Right within itself" is FALSE (no toolbar keydown handler exists) — recorded PARTIAL, not PASS; corrected widget census for the panel = THREE arrow-key-relevant controls (tablist roving-tabindex, the L0-2 roster `role=radiogroup`, and the toolbar whose claimed-but-absent arrow handling the lock text overstated), not the two the parent lock's A-12 wording implied; (4) A-1 "always present on approval nodes" is narrowed to approval nodes WITH editable config (`hasEditableApprovalConfig`, `ApprovalCanvasNodeInspector.vue`) — a legacy approval node with no seeded edit keeps the pre-L0-1 flat read-only summary instead of an empty tab strip; recorded as a Lock-0 §-note (contract-legitimate per the lock's own anti-"empty tab theater" clause), not left as undocumented implementation lore; (5) the shared assignee-source picker component change (L0-2 radio grid + D1 labels superseding the committed `el-select`) reaches the `辅助编辑模式` (accessible list/flat) surface too, not only the canvas tabbed presentation — L0-2's "one picker component" contract clause authorizes exactly this shared change, but the PR body must state it, not imply the flat surface untouched. The P1-1 (destructive roster kind-switch)/P2-1 (D5 false remediation)/P2-2 (unpinned D1 labels)/P2-3 (untested flat-mode visibility + tab content-membership)/A-9 (substring hint pin) blocking findings from the same review were fixed in this PR's gate fix round (see PR body "Gate fix round" section for the new head SHA and probe re-run results) | Claude (Opus 5), independent adversarial gate; fix round by Claude (Sonnet 5) | owner ratification of this adjudication (and of the fix round) remains outstanding; A-8's route-through-history fix and A-4's node-scoped degradation remain unscheduled follow-up slices, not this PR's scope |

## 5. Required evidence by change class

| Change class | Minimum evidence |
|---|---|
| Docs/lock | cross-lock contradiction scan; current-main source anchors; disclosure scan; owner status unchanged |
| Pure form/graph command | focused unit tests; positive controls; mutation or equivalent discriminating negative |
| Mounted Vue editor | mounted spec added to `apps/web/scripts/run-required-web-tests.sh` and therefore the always-on `.github/workflows/web-tests.yml`; if approval guard scope changes, both PR/push filters and its exact Vitest command; a11y assertions |
| Drag-and-drop editor | mounted test plus real Chromium DataTransfer/pointer geometry; pure function or source-scan tests are insufficient |
| Browser geometry | real Chromium at 1440, 1024, and 390; screenshots; overlap/focus/scroll checks |
| Assignee/directory | real-DB or production-equivalent directory fixture; corp isolation; empty and duplicate resolution |
| Approval runtime | real DB; transaction rollback; deterministic interleaving for races; direct API negative |
| Version/migration | old-schema upgrade path, not fresh-only; restore conflict and immutable version proof |
| FWB/attachments | crash windows, authorization, idempotency, GC/bind races, flag-OFF positive control |

## 6. Parallel execution register

Before starting parallel work, add a row and name the file lock. Empty ownership means work must stay
serial.

| Lane | Allowed scope | Excluded hot files | Depends on | Active owner/session |
|---|---|---|---|---|
| Docs | three master documents and bounded child locks | runtime source | current source audit | — |
| Form extraction | new form components + one integration owner | node inspector, backend runtime | P0-A | — |
| Node inspector | extracted inspector/registry after ownership handoff | form builder hot section | P0 extraction + P1-A | — |
| Browser/a11y | tests and evidence only | product code unless finding accepted | fixed target SHA | — |
| Runtime capability | one lock-defined backend slice | unrelated UI/runtime families | ratified lock | — |

## 7. Flag and environment ledger

Initial values are policy assertions, not live-environment observations. Fill environment evidence only
during an authorized UAT or rollout.

| Capability | Code default | Staging observed | Production observed | Enable authorization | Rollback verified |
|---|---|---|---|---|---|
| Canvas V2 | OFF | NOT RECORDED | NOT RECORDED | NO | NOT RUN |
| Durable delivery | explicit env gate | NOT RECORDED | NOT RECORDED | NO | NOT RUN |
| Class A action ledger | explicit env gate | NOT RECORDED | NOT RECORDED | NO | NOT RUN |
| Class B action ledger | explicit env gate | NOT RECORDED | NOT RECORDED | NO | NOT RUN |
| FWB | OFF | NOT RECORDED | NOT RECORDED | NO | NOT RUN |
| Attachments | OFF | NOT RECORDED | NOT RECORDED | NO | NOT RUN |

## 8. Closeout rule

This ledger may say `ENGINEERING COMPLETE` only when implementation rows P0-P6 are merged and P7-A is
green. `CORE-PARITY` additionally requires P7-B, Canvas-relevant private prerequisites recorded closed
outside this public ledger, and owner sign-off.
`DATA-CLOSURE` additionally requires the P6 exact DATA matrix, P7-C/P7-D, their capability-relevant
private prerequisites, and owner sign-off. It may
say `PRODUCT FINAL` only after P7-E records staged enablement, rollback evidence, accepted residuals,
and explicit owner sign-off.
