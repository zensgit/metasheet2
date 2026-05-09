# DingTalk Final Closeout — Development

- Date: 2026-05-08
- Branch: `codex/dingtalk-final-closeout-20260508` (PR #1443)
- PR head before operator rebase: `e5787cf8d3deeb38bb0d0bd6d9b973bda8cd92c0`
- origin/main HEAD after operator rebase: `c74c15a2b`
- Main commit deployed on 142 (observed 2026-05-08 at this update): `08c6036284bf975dc1396c752d07f44486c7d4b2`
- Scope: consolidate the DingTalk feature line into a single closeout, close the
  rule-creator failure-alert runtime gap, triage the open PR backlog, and capture
  the operational TODO that remains before delivery is declared closed.

## Merge / Deploy Status (2026-05-08 final update)

- PR #1443 is **NOT MERGED**. Before this operator update, GitHub reported
  `mergeable=MERGEABLE`, `mergeStateStatus=BEHIND`, and
  `reviewDecision=REVIEW_REQUIRED`. Codex then rebased this branch onto
  `origin/main` at `c74c15a2b`; GitHub will recompute mergeability after the
  updated branch is pushed. Only bot reviewers (`gemini-code-assist`,
  `copilot-pull-request-reviewer`) had posted `COMMENTED` reviews at the
  Claude evidence handoff; no human approval was recorded.
- 142 currently runs `08c603628…` for both backend and web (1 commit behind
  `origin/main`, and ahead of the prior `34d731670…` snapshot referenced in
  earlier evidence). The new failure-alert runtime path introduced by this PR
  is therefore **not live on 142** at the time of writing.
- Per repository review policy and the explicit conditional in the closeout
  task ("merge only if authorized and repository rules are satisfied"), the
  closeout cannot transition to PASS for the merge-dependent rows until: (1)
  PR #1443 receives an approving human review, (2) it merges, and (3) 142
  auto-deploys the resulting `main` HEAD.

## Implemented Capability Summary

The following product capabilities are present in the deployed `main` image and
covered by tests / earlier verification docs:

- Multiple DingTalk groups bindable per table; group robot binding UI + API.
- Organization-scoped DingTalk group destination catalog v1.
- Group automation with form links; person messaging recipients across users,
  member groups, and dynamic fields.
- Form access modes `public`, `dingtalk`, and `dingtalk_granted` plus an
  explicit local user / member-group allowlist for DingTalk-protected forms.
- DingTalk directory sync account list; admin "create + bind" path for synced
  DingTalk users that arrive without an email.
- Delivery history for both group sends and person sends.
- New in this branch (NOT yet on 142): failed `send_dingtalk_group_message`
  automation steps now attempt a default DingTalk work-notification alert to
  the rule creator and write the alert attempt into
  `dingtalk_person_deliveries`. If the creator is not linked to DingTalk, the
  alert is recorded as `skipped` without hiding the original group-send
  failure.
- Work-notification Agent ID admin configuration (status / test / save
  endpoints + directory-management Agent ID UI), shipped to `main` via the
  Agent ID mainline integration (PR #1430).
- P4 closeout tooling: smoke session, evidence recorder, status TODO, strict
  finalize, final handoff packet, release-ready gate, regression gate
  (ops + product profiles), redacted JSON / MD summaries, and a one-command
  `dingtalk-p4-final-closeout.mjs` wrapper.
- Mobile signoff wired into the final closeout flow (PR #1239).

## PR Triage

All open DingTalk PRs in scope of this closeout are CI-green at the time of
writing. They are bucketed by whether they must land before the delivery
blocker policy can be declared satisfied.

### Must merge before closeout (delivery-critical)

| PR | Title | Reason it is on the critical path |
| --- | --- | --- |
| #1443 | fix(dingtalk): notify rule creator on group delivery failure | failure-alert runtime path |
| #1269 | fix(dingtalk): redact final secret assignments | "no secret leakage" gate |
| #1366 | fix(dingtalk): scan large evidence files for secrets | "no secret leakage" gate |
| #1272 | fix(dingtalk): redact gate secret assignments | "no secret leakage" gate |
| #1267 | fix(dingtalk): redact spaced secret assignments in smoke logs | "no secret leakage" gate |
| #1265 | fix(dingtalk): catch spaced secret assignments in evidence | "no secret leakage" gate |
| #1263 | chore(dingtalk): harden env secret setters | "no secret leakage" gate |
| #1260 | chore(dingtalk): scan packet secret assignments | "no secret leakage" gate |
| #1274 | fix(dingtalk): harden live smoke preflight and robot delivery | A/B group robot delivery + preflight reliability |
| #1239 | feat(dingtalk): wire mobile signoff into final closeout | mobile signoff completeness |
| #1253 | test(dingtalk): include public form checks in P4 gate | `public` / `dingtalk` / `dingtalk_granted` form path gate |
| #1256 | feat(dingtalk): expose final input blocked count | preflight visibility for the final input gate |
| #1248 | feat(dingtalk): add public form bind recovery CTA | public form path UX recovery |
| #1251 | test(dingtalk): cover public form unbound users | public form path coverage |

### Can defer (non-blocking polish)

| PR | Title | Reason it is deferrable |
| --- | --- | --- |
| #1259 | feat(dingtalk): break down smoke todo progress | UX summary on existing TODO output |
| #1261 | feat(dingtalk): summarize preflight check totals | UX summary on existing preflight output |
| #1264 | feat(dingtalk): summarize release readiness gates | UX summary on existing readiness output |

### Archive (out of scope)

- Shared org-level group robot catalog.
- Row / column-level fill assignment.
- Finer DingTalk org governance UI.
- Screenshot-only archive.

## Runtime Patch In This Branch

- `AutomationExecutor` now calls a redaction-safe rule-creator alert path after
  a DingTalk group automation action fails.
- The alert resolves the rule creator through the existing DingTalk directory
  account link path and sends a work notification through the runtime Agent ID
  config.
- Alert send success/failure/skipped state is written to person delivery
  history and summarized under the failed step output as `failureAlert`.
- Alert failures never convert the original group delivery result into success
  and never print webhook, token, `SEC...`, JWT, Agent ID, or recipient values.

## Branch Validation Completed

- Backend DingTalk target suite passed: 11 files / 232 tests.
- Frontend DingTalk target suite passed: 4 files / 58 tests.
- Backend typecheck and backend build passed.
- Web build passed with only existing Vite chunk warnings.
- `git diff --check` passed.
- Strict branch secret scan passed; the only broader-scan hits were fixed dummy
  test values such as `dt-app-secret`, not real credentials.

## Remaining Operational TODO

1. Obtain human review approval on PR #1443 (and on remaining "must merge"
   PRs above), then `git rebase origin/main` and squash-merge per repository
   policy.
2. Wait for 142 to auto-deploy the post-merge `main` HEAD; record the new
   image SHA in the verification doc.
3. Re-run on the new 142 image:
   - `dingtalk-work-notification-admin-agent-id.mjs --save` and real-send
     (`--recipient-user-id-file`) → both `status=pass`,
     `agent_value_printed=false`, `recipient_value_printed=false`.
   - `dingtalk-p4-release-readiness.mjs --run-smoke-session` followed by
     `dingtalk-p4-final-closeout.mjs` → confirm
     `closeout-summary.json` shows `overallStatus=pass`,
     `finalStrictStatus=pass`, no pending checks.
4. Trigger a real failed `send_dingtalk_group_message` automation step on the
   new image and confirm:
   - new `dingtalk_group_deliveries` row recorded as failure;
   - new `dingtalk_person_deliveries` row created for the rule creator with
     the `failureAlert` shape;
   - work notification reaches the creator.
5. Confirm 142 health remains 200 on `/api/health` and `/` after each step,
   and that the deployed image SHA matches the post-merge `main` HEAD.
6. After delivery declaration, re-evaluate the "can defer" PR set and either
   merge or close them; update the archive list above if anything moves.

## Out of Scope

- Any change to the K3 PoC stage-1 lock or integration-core surface.
- Multitable / Feishu / field-type work.
- Reading or printing any secret value, webhook URL, robot `SEC...`, admin
  JWT, Agent ID value, recipient user id list, or temporary password.
