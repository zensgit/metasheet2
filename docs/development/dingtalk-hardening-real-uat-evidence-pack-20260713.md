# DingTalk Hardening — Real UAT Evidence Pack (DT-CLOSE-03)

Date: 2026-07-13
Status: **BLANK SCAFFOLD.** Nothing in this document, as shipped, is evidence of anything.
It is a template for **owner/ops to execute against the deployed SHA** and fill in. Until
every checkbox below is ticked with a captured result, **DingTalk Sync Hardening v1
Wave 1 is not done** — do not read a filled-in copy of this template as complete unless
every section's "Executed by / date / SHA" line is filled and every row has a captured
result, not a projection.

> **Sandbox cannot execute any part of this document.** It cannot reach the deploy host
> (`23.254.236.11`) or a real DingTalk corp. Every row here requires either a live deployed
> backend, a real DingTalk tenant with Stream credentials, or both. This is why it is a
> scaffold, not a report.

## 0. Scope and cross-references

This is Wave 1 of **DingTalk Sync Hardening v1** (Waves 0–2) — a separate milestone from
**Canonical Org & Provider Transfer v1** (Waves 3–4, design-only). Completing this pack does
not close the Transfer milestone and does not by itself close Hardening v1 either — Wave 2
(`dingtalk-hardening-switch-ruling-ledger-20260713.md`, DT-CLOSE-04) is the sibling
blocker.

- Roll-up: `dingtalk-sync-org-transfer-line-design-and-verification-20260712.md` §5.2/§8.
- Canonical interactive-card UAT script (source of truth for U1–U13 procedure detail, in
  Chinese, with exact click sequences): `approval-dingtalk-slice-b-uat-checklist-20260710.md`.
  Section A below is an English enumeration of **what each U-item proves**, for evidence-pack
  bookkeeping — execute against the canonical script, not a re-derivation of it.
- Switch ledger (what "default-off" means per switch, evidence-to-flip criteria):
  `dingtalk-hardening-switch-ruling-ledger-20260713.md` (DT-CLOSE-04).
- Corp-anchor real-callback tooling this pack exercises: #4171 (merged `663511527`),
  `interactive-card-callback.ts` `readCallbackCorpAnchor`.

## 1. Preconditions (must all be true before starting)

| # | Precondition | Status |
| --- | --- | --- |
| P1 | Deploy-host disk resolved (#159 — **CLOSED** 2026-07-12, storage-health recovery confirmed) | done (infra only — does not itself satisfy P2/P3) |
| P2 | The exact target SHA is deployed and its identity is confirmable (`git rev-parse HEAD` on the deploy host, or the image tag) | ⬜ record SHA: `______` |
| P3 | Access to a real DingTalk corp (staging tenant or an authorized customer sandbox) with: an admin account, Stream app credentials, an interactive-card template, and **at least two** local accounts bound to DingTalk (one designated approval assignee "A", one non-assignee "B") | ⬜ |
| P4 | `LOG_LEVEL=info` (or `debug`) on the deployed instance — **not** `warn`/`error`. `scripts/dev-optimized-start.sh` defaults to `warn`, which silently swallows the corp-anchor probe log line and makes "no log line" ambiguous between "prod-safe default silence" and "the probe never fired." Confirm before Section C. | ⬜ |

**Executed by:** ______  **Date:** ______  **Target SHA:** ______

## 2. Values-free evidence rules (apply to every section below)

- **No PII.** No real names, phone numbers, emails, DingTalk `userid`/`unionId` values, or
  form field contents may be written into this pack or attached screenshots. If a screenshot
  would show any of these, redact before attaching or describe the result in words instead.
- Corp id / integration id (uuid) are **not** PII and may be recorded — they identify a
  tenant/config, not a person.
- Capture **counts, booleans, HTTP status codes, and enum reason-codes** (e.g.
  `corp_anchor_absent`, `container_login_disabled`, `env_disabled`) — never the underlying
  values that produced them.
- If a step's "expected result" in the canonical UAT script already specifies a values-free
  log shape (e.g. U11-a's `headerEventCorpIdPresent`/`bodyCorpIdPresent` booleans), capture
  exactly that shape and nothing more.
- Any evidence file (log excerpt, screenshot, env dump) attached to this pack's execution
  record must be reviewed against this section **before** attaching, not after.

## 3. Section A — Default-off smoke test

Confirm every switch in the DT-CLOSE-04 ledger is at its documented default on the deployed
SHA, **before** touching Section B/C (which deliberately flips switch #3 in a controlled
window). Evidence = the observed behavior when the gated action is attempted, not just "the
env var is unset" (a wrong assumption about default-parsing is exactly the kind of bug this
smoke test exists to catch).

| # | Switch | Expected (default) | How to observe | Result |
| --- | --- | --- | --- | --- |
| S1 | `DIRECTORY_DEPROVISION_ENABLED` | off — a sync run's absence sweep reports candidates but writes nothing | Run one directory sync; confirm the run report shows `applied: false` and no account transitioned to inactive by the deprovision path (existing absence-marking behavior, if any, is unaffected) | ⬜ |
| S2 | `DIRECTORY_PRIMARY_DEPT_FROM_ORDER` | off — primary department still resolves via legacy `departmentIds[0]` | Inspect one multi-department account's resolved primary department before/after; unchanged | ⬜ |
| S3 | `DINGTALK_INTERACTIVE_CARD_STREAM_ENABLED` | off — worker never starts, no client created | Deploy logs show no "Stream worker started" line; `resolveDingTalkInteractiveCardStreamConfig` would report `reason: 'env_disabled'` if queried | ⬜ |
| S4 | `DINGTALK_OAUTH_REQUIRE_SHARED_STATE_STORE` | off — OAuth login works via in-process state (single replica) or is known-risky (multi-replica, tracked separately in DT-CLOSE-04) | One OAuth login round-trip succeeds | ⬜ |
| S5 | `DINGTALK_GROUP_DELIVERY_RETENTION_DAYS` family | sweep **enabled** at 90-day default (this one is on-by-default, not off — confirm the *value*, not that it's disabled) | Confirm scheduler log shows a sweep tick; confirm no `_DISABLED=1` set | ⬜ |
| S6 | `DIRECTORY_SYNC_ALERT_WEBHOOK` | off (unset) — no alert channel configured, sync failures do not page anyone yet | Confirm var is unset in the deployed env (redacted dump, presence/absence only — never print the value) | ⬜ |
| S7 | `DINGTALK_CONTAINER_LOGIN_ENABLED` | off — `POST /login/dingtalk/container` returns 404 `container_login_disabled` | One curl/Postman call to that path, capture status code + `code` field only | ⬜ |
| S8 | `DINGTALK_ALLOWED_CORP_IDS` | deployment-specific — confirm it matches the ledger's row for this env (staging template ships `replace-me`, must be a real corp id list before use) | Confirm the deployed value is a real corp id set, not the placeholder | ⬜ |

**Executed by:** ______  **Date:** ______

## 4. Section B — Interactive-card U1–U13 (execute via the canonical script)

Execute `approval-dingtalk-slice-b-uat-checklist-20260710.md` in full — including its own §0
(env prep) and §0-a (the hard precondition, folded into Section C below) — with
`DINGTALK_INTERACTIVE_CARD_STREAM_ENABLED=1` set **only** in this controlled UAT window, per
that script's own instruction. What each item proves, for this pack's bookkeeping:

| # | Proves | Expected result | Evidence to capture | Pass/Fail |
| --- | --- | --- | --- | --- |
| U1 | Full-config send path delivers a real interactive card | Card reaches assignee A; ledger row `delivery_kind='interactive_card'`, `send_status='sent'` | ledger row snapshot (ids/status/kind only) | ⬜ |
| U2 | Incomplete config fails closed to the OA fallback, not an error | OA ActionCard sent instead; no exception | ledger row `work_notice_action_card` | ⬜ |
| U3 | Card body carries no form data | Only title/ticket-no/node/status visible | screenshot (redacted of any PII) | ⬜ |
| U3-a | `cardTypeId`/spaceType casing (`IM_ROBOT`, #4118) is accepted by the real API | Card delivered using the uppercase form; report if the real API instead only accepts lowercase | pass/fail + note if casing assumption was wrong | ⬜ |
| U4 | Approve-click reaches the approval engine correctly attributed | Engine records approve; audit actor = A's local account; ledger callback result `executed` | audit log actor-id + result enum only | ⬜ |
| U5 | Duplicate callback is idempotent | No second engine write; card shows the real terminal state | count of engine writes (must be 1) | ⬜ |
| U6 | Non-assignee click on a forwarded card is rejected | Engine 403 `APPROVAL_ASSIGNMENT_REQUIRED`; **zero** approval writes | status code + error code | ⬜ |
| U7 | An operator with no DingTalk binding cannot act via the card | No engine call; card shows "bind DingTalk first" message | pass/fail | ⬜ |
| U8 | Reject routes to the structured decision page (deep link), not an inline reject | Deep link opens; comment required before reject succeeds | pass/fail | ⬜ |
| U9 | Terminal-state display uses the server's local display name, not an echoed DingTalk payload value | Card shows "approved by \<A's server-side local display name\> · \<time\>" | pass/fail (do not record the name itself) | ⬜ |
| U10 | A card-update-API failure does not roll back an already-submitted approval | Approval stands; error logged values-free; a later click converges to the true terminal state via stale-summary handling | pass/fail | ⬜ |
| U11 | Forged/expired `outTrackId` callback is indistinguishable (byte-for-byte) from an unresolved-operator case — no existence oracle | Neutral card-face message, same as the unresolved case | pass/fail | ⬜ |
| U11-a | **The real-callback corp-anchor test** — a real approve-click carries an actual corp identifier the cross-corp gate can read | A real click **passes** the gate (not rejected as `corp_mismatch`); worker log shows the gate read an anchor matching the ledger's `integration_id`'s corp | see Section C — this is the load-bearing row of the whole pack | ⬜ |
| U11-b | Retention-swept ("expired") cards are inert (only relevant if `DINGTALK_GROUP_DELIVERY_RETENTION_DAYS` sweep already ran on that card) | Clicking an expired card: no engine write, stale terminal-state message | pass/fail (n/a if not exercised) | ⬜ |
| U12 | Clean shutdown, including a shutdown mid-`initialize()` | No half-open connection left; worker status reaches a consistent terminal state | worker status enum before/after | ⬜ |
| U13 | Turning the flag back off actually stops the worker | After flag off + restart, worker never reconnects; all sends fall back to OA; this matches the intended prod-default-safe posture | pass/fail | ⬜ |

**Pass standard (per the canonical script's own §5):** U1–U13 all green = the Slice-B design
lock's UAT gate is met. **That still does not itself flip
`DINGTALK_INTERACTIVE_CARD_STREAM_ENABLED` to on in prod** — per DT-CLOSE-04, that is a
separate, explicit owner/ops decision made *after* this evidence exists. Any red item: record
the values-free symptom, assign it to its owning layer (B-2 send / B-3 callback / B-4 card
lifecycle / SDK), and leave the flag off.

**Executed by:** ______  **Date:** ______

## 5. Section C — The real-callback corp-anchor test (U11-a, detailed)

This is the thing #4171's probe can **observe**, not prove alone — it only becomes proof once
a real click is captured and read. Do not skip straight to U11-a without the self-check below;
"no log line" is ambiguous between "the real frame has no corp anchor" (⇒ close the flag) and
"the log level ate it" (⇒ fix config, nothing else) unless the self-check has already ruled
the second one out.

1. ⬜ Confirm `LOG_LEVEL=info` on the UAT instance (Precondition P4). If not set, fix and
   redeploy/restart before continuing — do not interpret silence yet.
2. ⬜ Perform **one known-good click** that is expected to reach the cross-corp gate (e.g. a
   normal approve by assignee A on a freshly delivered card). Confirm the log line
   `DingTalk interactive-card callback corp anchor` appears, with fields `deliveryId`,
   `headerEventCorpIdPresent`, `bodyCorpIdPresent`. **If this line does not appear, the probe
   itself is not firing (config/deploy problem) — stop and fix that before drawing any
   conclusion about real frame shape.**
3. ⬜ From that captured line, record (booleans only, never the corp id value itself):
   - `headerEventCorpIdPresent` = ⬜ true / ⬜ false
   - `bodyCorpIdPresent` = ⬜ true / ⬜ false
4. ⬜ Record the gate's refusal/success outcome for that same click:
   - ⬜ succeeded (gate passed — U11-a proof condition met)
   - ⬜ `corp_mismatch` (a genuine cross-corp click — should not happen on a same-corp
     known-good click; if it does, treat as a configuration bug, not proof either way)
   - ⬜ `corp_anchor_absent` — **both fields false. STOP. Do not enable the flag in prod.**
     The real frame carries no corp identifier the gate can read; enabling
     `DINGTALK_INTERACTIVE_CARD_STREAM_ENABLED` on this basis would make every real click
     dead-on-arrival.
   - ⬜ `corp_anchor_conflict` — both present but disagree; investigate the adapter/gateway,
     do not treat as "absent."
   - ⬜ `delivery_corp_unresolved` — this deployment's own `directory_integrations.corp_id`
     configuration is the problem, not the real frame's shape; fix that config and repeat.
5. ⬜ **Verdict**: real frames DO / DO NOT (circle one) carry a usable corp anchor. If DO
   NOT, this is a hard blocker on Wave 2's switch #3 flip (DT-CLOSE-04) regardless of how
   many other U-items pass — record that explicitly here, do not let it get lost in a
   green-looking U1–U13 table.
6. ⬜ If DO: update `interactive-card-callback.ts`'s `readCallbackCorpAnchor` doc comment
   from "unverified assumption" to "verified against a real frame on \<date\>," per the
   canonical script's own instruction — this pack's result is the source for that doc update,
   not a duplicate of it.

**Executed by:** ______  **Date:** ______  **Verdict:** ______

## 6. Sign-off

This pack is complete only when every section above has an "Executed by / Date" filled in,
every row has a captured (not projected) result, and Section C has an explicit DO/DO-NOT
verdict. Completion of this pack satisfies the Wave-1 half of DingTalk Sync Hardening v1's
运行态收官 (operational-closeout) requirement; it does **not** by itself authorize flipping
any switch — that is DT-CLOSE-04's ledger, ruled by the owner, using this pack's evidence
where required.

| Role | Name / 负责人 | Date | Verdict |
| --- | --- | --- | --- |
| Executor (ops) | ______ | ______ | ______ |
| Reviewer (owner) | ______ | ______ | ______ |
