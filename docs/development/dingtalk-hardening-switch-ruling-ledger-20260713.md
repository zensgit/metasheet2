# DingTalk Hardening — Switch Ruling Ledger (DT-CLOSE-04)

Date: 2026-07-13
Status: **Wave 2 tracking document** for `dingtalk-sync-org-transfer-line-design-and-verification-20260712.md`
§6/§8. **DingTalk Sync Hardening v1** (Waves 0–2) is code-complete but NOT 运行态收官
(operationally closed) — this ledger is one of the two blockers to that closeout (the other
is the Wave-1 UAT evidence pack, DT-CLOSE-03). This is a **separate milestone** from
**Canonical Org & Provider Transfer v1** (Waves 3–4, design-only, core impl not started) —
never conflate the two.

## Purpose

Every env-gated switch this line ships must land on one of two ruled states, never on an
unowned default:

- **explicitly-deferred** — stays at its shipped default (off, in every case on this line)
  until a named precondition is met. The precondition is the flip criterion, not a date.
- **must-verify-enabled** — the mechanism is already on by default (or must be turned on
  before another switch is safe to flip), but its *correctness* for this deployment has not
  been demonstrated. "Verified-enabled" requires evidence, not just "it's set."

No row in this ledger may read "default off, no ruling" — that is the exact failure mode
this ledger exists to close out.

All defaults below were read from the code at `origin/main` (post-#4228/#4218,
`4157205ce`/`f0ce863ea`) on 2026-07-13, not copied from an earlier doc — cited by file and
symbol so they can be re-checked at any later SHA.

## 1. Primary safety switches (the six owner-named)

| # | Switch(es) | Bucket | Current default (code) | Shipped in a config template? | Owner ruling (verbatim) |
| --- | --- | --- | --- | --- | --- |
| 1 | `DIRECTORY_DEPROVISION_ENABLED` + `DIRECTORY_DEPROVISION_MAX_BATCH` | **explicitly-deferred** | `DEPROVISION_ENABLED`: **off** (`isDirectoryDeprovisionEnabled()`, `directory-sync.ts` ~L1186 — only `'true'/'1'/'yes'` enable it, unset ⇒ false). `MAX_BATCH`: **25** (`DIRECTORY_DEPROVISION_MAX_BATCH`, ~L1246 — any non-finite/non-positive input falls back to 25; this is the circuit-breaker's safe value). | **Now in both deploy templates** (`docker/app.env.example` + `docker/app.staging.env.example`) via #4240 — `DIRECTORY_DEPROVISION_ENABLED=false`, `DIRECTORY_DEPROVISION_MAX_BATCH=25`, each with a DANGER comment (stale pre-#4240 "not in template" claim corrected in DT-CLOSE-02B). | "stays OFF until audited reactivation/rollback + real-data preview + small canary. DANGER: enabling makes the next sync's absence sweep actually deprovision (mass login revocation) instead of just stranding." |
| 2 | `DIRECTORY_PRIMARY_DEPT_FROM_ORDER` | **explicitly-deferred** | **off** (`isDirectoryPrimaryDepartmentFromOrderEnabled()`, `directory-sync.ts` ~L881 — same true/1/yes gate; unset ⇒ legacy `departmentIds[0]` inference). | **Now in both deploy templates** via #4240 (`=false`, DANGER comment; stale pre-#4240 claim corrected in DT-CLOSE-02B). | "OFF; verify real dept_order_list + dry-run first; prefer PER-INTEGRATION over a global env. DANGER: flips how the primary department is inferred for every synced account." |
| 3 | `DINGTALK_INTERACTIVE_CARD_STREAM_ENABLED` | **explicitly-deferred** | **off** (`resolveDingTalkInteractiveCardStreamConfig()`, `interactive-card-stream.ts` ~L119-136 — `enabled` requires the literal string `'1'`/`'true'`; unset ⇒ `{ enabled: false, reason: 'env_disabled' }`, and the client factory is never invoked). | The **enable switch** is now in both deploy templates via #4240 (`DINGTALK_INTERACTIVE_CARD_STREAM_ENABLED=false`, DANGER comment). The activation creds (client id/secret/template id/integration id) are NOT templated — deliberately, since the feature is deferred until U1-U13 (stale pre-#4240 claim corrected in DT-CLOSE-02B). | "stays OFF until U1-U13 all green + #4171 real-callback anchor proof. DANGER: turns on the interactive-card Stream client before real-callback validation." |
| 4 | `DINGTALK_OAUTH_REQUIRE_SHARED_STATE_STORE` | **must-verify-enabled** | **off** (`isDingTalkOAuthSharedStateStoreRequired()`, `dingtalk-oauth.ts` ~L119 — unset ⇒ single-replica in-process `Map` fallback is silently accepted). | **Now in both deploy templates** via #4240 (`=false`, DANGER comment; stale pre-#4240 claim corrected in DT-CLOSE-02B). | "MUST be ON + Redis-verified for multi-replica deploys; single-replica may defer. DANGER if OFF on multi-replica: OAuth state (CSRF nonce) not shared across replicas → login failures/state-forgery window." |
| 5 | `DINGTALK_GROUP_DELIVERY_RETENTION_DAYS` family (`_DISABLED`, `_MIN_DAYS`\*, `_DEFAULT_DAYS`\*, `_SCHEDULER_INTERVAL_MS`, `_LEADER_LOCK_TTL_MS`, `_LEADER_LOCK_RETRY_MS`) | **must-verify-enabled** | Sweep is **enabled by default** (`dingtalk-group-delivery-retention-scheduler.ts` ~L43 — only `DINGTALK_GROUP_DELIVERY_RETENTION_DISABLED=1` turns it off). `_DAYS` defaults to **90**, floored at `_MIN_DAYS`=**7** (`dingtalk-group-delivery-retention.ts` ~L44-74, both `\*` are code constants, not envs). `_SCHEDULER_INTERVAL_MS` defaults to **21,600,000 ms** (6h), floored at 60,000 ms (`LedgerRetentionScheduler.ts` ~L38-39). Leader lock is **opt-in** via `ENABLE_DINGTALK_GROUP_DELIVERY_RETENTION_LEADER_LOCK=true` (default off — single instance sweeps unlocked, which is safe: the sweep is idempotent); when enabled, `_LEADER_LOCK_TTL_MS` defaults **30,000 ms** and `_LEADER_LOCK_RETRY_MS` defaults **max(1000, ttl/3) = 10,000 ms**. | **Now in both deploy templates** via #4240 (`_DAYS=90`, `_DISABLED=0`, `_SCHEDULER_INTERVAL_MS=21600000`, `_LEADER_LOCK_TTL_MS=30000`, `_LEADER_LOCK_RETRY_MS`, `ENABLE_..._LEADER_LOCK` sample), each with a DANGER comment (stale pre-#4240 "not in template" claim corrected in DT-CLOSE-02B). | **DT-CLOSE-02B correction:** this family governs the **GROUP WEBHOOK** delivery ledger (`dingtalk_group_deliveries` — automation-rule group-message firings), **NOT** approval cards. Too short deletes group-delivery diagnostic/audit history. The earlier "retention > approval SLA / in-flight approval card" framing (DT-CLOSE-02) was **wrong** — approval-card/person delivery retention is a separate, **already-implemented, disabled-by-default** family (`DINGTALK_DELIVERY_RETENTION_*`, #4142) — see §1.2. |
| 6 | `DIRECTORY_SYNC_ALERT_WEBHOOK` + `DIRECTORY_SYNC_ALERT_WEBHOOK_SECRET` | **must-verify-enabled** | **unset = off** (`directory-sync-alert-delivery.ts` ~L37 — no channel exists until a valid DingTalk robot URL is configured; an invalid URL throws rather than silently degrading). | **Now in both deploy templates** via #4240 (`DIRECTORY_SYNC_ALERT_WEBHOOK=` + `_SECRET=` blank, DANGER comment; stale pre-#4240 claim corrected in DT-CLOSE-02B). | (No literal "owner:" sentence on file for this one; framed by the closeout brief as must-verify-enabled alongside OAuth shared-state and retention.) "must be configured for prod or sync failures go unnoticed (this is the egress-guarded channel)." |

\* `_MIN_DAYS` (7) and `_DEFAULT_DAYS` (90) are **not themselves env vars** — they are the
code-level floor/default that `_DAYS` resolves against. Listed here because the ENV-KEYS
inventory that scoped this ledger named them as part of "the family."

### 1.1 Evidence required to flip, and rollback action

| # | Switch | Evidence required to flip | Rollback action |
| --- | --- | --- | --- |
| 1 | `DIRECTORY_DEPROVISION_ENABLED` | (a) An audited reactivation/rollback path exists and is tested — there is currently **no product path to reverse a deprovision** once it fires (this is why it gates the flip, not just documents it). (b) A real-data **preview** run (`DIRECTORY_DEPROVISION_ENABLED` left off, sync run inspected) shows the exact *count* and *policy* (`manual_review`/`disable_grant_only`/`mark_inactive`) of who WOULD be deprovisioned, values-free. (c) A small **canary**: enable for one low-risk integration only, run one full sync cycle, confirm only the previewed candidates were affected. `DIRECTORY_DEPROVISION_MAX_BATCH` (default 25) is not itself a flip decision — raise it only after (a)-(c) pass and the org's genuine daily-leaver count routinely exceeds 25 (i.e. the circuit breaker is aborting legitimate runs); lower it for a smaller blast radius. | Unset (or set to any non-`true/1/yes` value) — takes effect on the **next sync run**, stops future deprovisioning immediately. Does **not** undo accounts already deprovisioned in a prior run; that requires the (currently nonexistent) reactivation path from evidence item (a) — which is exactly why (a) is a precondition, not an afterthought. |
| 2 | `DIRECTORY_PRIMARY_DEPT_FROM_ORDER` | A real `topapi/v2/user/get` response from a real tenant showing `dept_order_list` is populated, and its lowest-`order` entry cross-checked against that tenant's own understanding of the employee's primary department (DingTalk does not contractually document `order`'s semantics). A dry-run diff against the current `departmentIds[0]` inference, reviewed for how many accounts' primary department (and therefore `direct_manager`/`continuous_managers` routing) would change. Per-integration override implemented (owner preference) before a global flip — this is a design gap, not just an ops step. | Unset — reverts to the legacy `departmentIds[0]` inference on the **next sync read**; stateless flag, no data migration, no residual state. |
| 3 | `DINGTALK_INTERACTIVE_CARD_STREAM_ENABLED` | **Both**, jointly: (a) the full U1-U13 checklist green (canonical script: `approval-dingtalk-slice-b-uat-checklist-20260710.md`; execution scaffold: DT-CLOSE-03 `dingtalk-hardening-real-uat-evidence-pack-20260713.md`), and (b) the #4171 real-callback corp-anchor probe observing an actual captured frame with `headerEventCorpIdPresent`/`bodyCorpIdPresent` — not merely that the probe code exists. | Unset — `resolveDingTalkInteractiveCardStreamConfig()` returns `{ enabled: false }` on the next read, so the client factory is never invoked. **Caveat**: the Stream worker's `initialize()` (`interactive-card-stream.ts` ~L234) resolves this config **once** at call time and does not appear to be re-polled while `active`; an already-running worker needs an explicit `shutdown()`/process restart to actually stop, not just the env flip. |
| 4 | `DINGTALK_OAUTH_REQUIRE_SHARED_STATE_STORE` | Confirm deployment topology has >1 replica. Confirm Redis is reachable from **every** replica (`getRedisClient()` resolves non-null on each). Run a login round-trip where the OAuth callback is deliberately routed to a **different** replica than the one that issued the launch `state`, and confirm success. Separately confirm `DingTalkOAuthStateStoreUnavailableError` (503) fires when Redis is down (proves fail-closed, not fail-open, once the flag is on). | Unset — falls back to the in-process `Map`. This is a **fail-open** rollback: on a single-replica deployment it is inert, but reverting it on a still-multi-replica deployment **reintroduces** the state-not-shared risk it exists to close, it does not just "undo a change." |
| 5 | `DINGTALK_GROUP_DELIVERY_RETENTION_DAYS` family | Confirm `_DAYS` meets this deployment's **group-delivery diagnostic/audit** retention need (there is **no** approval-SLA coupling — that was the DT-CLOSE-02 error; this sweeps `dingtalk_group_deliveries`, not approval cards). Confirm the sweep is not `_DISABLED=1` (i.e. actually running). A short window deletes GROUP-webhook delivery history (`dingtalk_group_deliveries`) — **not** approval cards (DT-CLOSE-02B correction; approval-card/person retention is a separate, already-implemented, disabled-by-default family — see §1.2). | Raise `_DAYS` back up, or set `_DISABLED=1` to pause the sweep entirely if group-delivery rows are being deleted prematurely. `_MIN_DAYS`=7 is a hard floor regardless of misconfiguration, so a bad value cannot go to zero/negative. |
| 6 | `DIRECTORY_SYNC_ALERT_WEBHOOK` (+`_SECRET`) | Configure a valid DingTalk robot URL (an invalid one throws at read time rather than silently no-op'ing) + secret if the robot requires signing. Trigger a deliberate sync failure in a non-prod environment and confirm the alert is delivered to the target DingTalk group. Confirm the send path goes through the existing egress-guarded channel (pinned-egress guard on `send_webhook`/`webhook-service.ts`), not a bypass. | Unset both — the channel silently goes back to "no channel configured" (`unset = off`, matching the code's own documented convention); the sync continues unaffected, only the notification is lost. Inert rollback. |

### 1.2 `DINGTALK_DELIVERY_RETENTION_DAYS` family — approval-card / person delivery retention (DT-CLOSE-02B correction)

**Correction:** an earlier revision of this ledger filed this as "§1.2 GAP: unimplemented." That
was **wrong** — the grep behind it ran on a stale base that predated #4142. This family **is
implemented**: `packages/core-backend/src/services/dingtalk-card-person-delivery-retention.ts`
(the two sub-sweeps + `resolveDingTalkDeliveryRetentionConfig`) and its
`dingtalk-card-person-delivery-retention-scheduler.ts` sibling. It sweeps
`dingtalk_person_deliveries` (bounded batch `DELETE`, same ctid-subselect shape as the group
sweep — full message `content` + raw `response_body` TEXT, so this is the sensitive-payload
ledger) and `dingtalk_approval_card_deliveries` (`card_state='sent'` rows past the window move to
`card_state='expired'` — **never deleted**; `acted_*`/`task_id` provenance of who approved/rejected
via which card is preserved). It is a **separate control plane** from switch #5
(`DINGTALK_GROUP_DELIVERY_RETENTION_*`, §1 row 5 above) — that family only touches
`dingtalk_group_deliveries`; setting it does **nothing** for these two tables and vice versa.

**Bucket: must-verify-enabled** — with the **inverse default** of switch #5. This sweep is
**DISABLED BY DEFAULT** (a deliberate owner-facing judgment call documented in the module
docstring: these two ledgers sit closer to the approval security boundary — a `card_state='sent'`
row plus a valid deep-link token is independently actionable — and to raw message content than
the group-robot telemetry table does). Leaving `DINGTALK_DELIVERY_RETENTION_DAYS` unset/blank
means both tables grow **UNBOUNDED**. Card inertness once expired is enforced independently by
`ApprovalProductService.dispatchAction`'s in-transaction row lock (`card_state='sent'` gate), not
by this sweep — the sweep only produces the `expired` state, it is not what makes an expired card
unclaimable.

| Key(s) | Current default (code) | Shipped in a config template? | Owner ruling |
| --- | --- | --- | --- |
| `DINGTALK_DELIVERY_RETENTION_DAYS` (+`_DISABLED`, `_SCHEDULER_INTERVAL_MS`, `ENABLE_..._LEADER_LOCK`, `_LEADER_LOCK_TTL_MS`, `_LEADER_LOCK_RETRY_MS`) | **Disabled by default** (`resolveDingTalkDeliveryRetentionConfig()`, `dingtalk-card-person-delivery-retention.ts` ~L110-121 — enabled only when `_DAYS` parses to a finite positive number, then floored at `_MIN_DAYS`=**7** (~L87); unset/non-numeric/≤0 stays disabled and does **not** fall back to a default window). `_DEFAULT_DAYS`=**90** (~L84) is a **compiled-in reference constant only** — it is never applied automatically when `_DAYS` is unset (that branch is dead: `disabled=true` short-circuits every sweep function before `retentionDays` is read). The scheduler ALWAYS starts at boot regardless of `_DAYS` (unconfigured ⇒ every tick sweeps 0 rows, a harmless no-op timer) — only `_DISABLED=1` stops the scheduler itself (`dingtalk-card-person-delivery-retention-scheduler.ts` ~L46-49). `_SCHEDULER_INTERVAL_MS` defaults **21,600,000 ms** (6h), floored at 60,000 ms (shared `LedgerRetentionScheduler.ts` ~L38-39). Leader lock opt-in via `ENABLE_DINGTALK_DELIVERY_RETENTION_LEADER_LOCK=true` (default off); `_LEADER_LOCK_TTL_MS` defaults **30,000 ms** (~L35), `_LEADER_LOCK_RETRY_MS` defaults **max(1000, ttl/3) = 10,000 ms** (`LedgerRetentionScheduler.ts` ~L154). | **Now in both deploy templates** (DT-CLOSE-02B) — `DINGTALK_DELIVERY_RETENTION_DAYS` shipped **blank/commented** (preserves disabled-by-default; contract test pins a live positive value red), the other five keys shipped at their code defaults (`_DISABLED=0`, `_SCHEDULER_INTERVAL_MS=21600000`, `_LEADER_LOCK_TTL_MS=30000`, `_LEADER_LOCK_RETRY_MS=10000`, `ENABLE_..._LEADER_LOCK` commented sample). | **must-verify-enabled**: an operator must explicitly decide and set a retention window ≥7 days before this sweep does anything at all; until then `dingtalk_approval_card_deliveries` + `dingtalk_person_deliveries` grow unbounded. Evidence to flip: confirm the chosen window exceeds this deployment's longest approval-instance turnaround — a card still `sent` past the window is expired (loses its one-tap deep link; the approval decision itself is not lost, the approver falls back to the web page). **Set this BEFORE enabling interactive cards** (switch #3) in production. Rollback: `DINGTALK_DELIVERY_RETENTION_DISABLED=1` (kill switch, stops the scheduler outright) or unset/blank `_DAYS` (next config read makes every tick a no-op; no data is un-expired or un-deleted by rollback — this is a stop-going-forward control, same as switch #5). Owner/负责人: _TBD_. |

## 2. Supporting env keys (not one of the six; included so nothing is left unowned)

These were in the same ENV-KEYS inventory that scoped this ledger but are tuning knobs or
already-adopted allowlists rather than independent safety gates. Listed here — each with an
owner placeholder — specifically so none of them silently reads as "an unowned default-off."

| Key(s) | Current default (code) | Shipped in a config template? | Ruling |
| --- | --- | --- | --- |
| `DIRECTORY_INACTIVE_LINKED_ALERT_DAYS` | **unset = off** (`readDirectoryInactiveLinkedAlertThresholdDays()`, `directory-sync-alert-delivery.ts` ~L349 — a non-positive/non-integer value is treated as unset and logged once, not silently clamped). Gates a best-effort, never-throws informational alert; also requires switch #6 (`DIRECTORY_SYNC_ALERT_WEBHOOK`) to actually deliver. | In both deploy templates via #4240. | **must-verify-enabled** (paired with #6): configure a threshold once #6's delivery channel is verified; until then this is inert (no channel to send through) rather than dangerous. |
| `DIRECTORY_SYNC_HEARTBEAT_INTERVAL_MS`, `DIRECTORY_SYNC_LEASE_STALE_MINUTES` | Heartbeat defaults **60,000 ms**; any value `< 5,000 ms` or non-finite is ignored entirely, not floored (`directory-sync.ts` ~L2795). Lease-stale defaults **10 min**, clamped to at least `5 × heartbeat / 60,000` minutes so a slow beat cannot cause a false reclaim (~L2809). | In both deploy templates via #4240. | **tuning-only** — the defaults are self-protecting (non-clampable to unsafe values) and were not called out by name in the owner's switch rulings. No flip decision needed; keep at code defaults unless a specific multi-replica lease-contention symptom is observed. |
| `DINGTALK_ALLOWED_CORP_IDS` | **unset = unscoped allowlist** (`readDingTalkAllowedCorpIds()`, `runtime-policy.ts` ~L18 — empty list makes `isDingTalkCorpAllowed` permissive; `isCorpAllowlistConfigured()` gates auto-provisioning specifically on this being non-empty, DT-HARDEN-09). | **Now in both deploy templates** via #4240 — `docker/app.env.example` (blank, DANGER comment), `docker/app.staging.env.example` (pre-filled `replace-me`, deployment-specific). Not in root `.env.example`. | **must-verify-enabled** for any deployment that turns on `DINGTALK_AUTH_AUTO_PROVISION` — an unscoped allowlist + auto-provision is refused by the code itself (DT-HARDEN-09), so this is close to self-enforcing, but the allowlist's *contents* (which corp ids) still need an explicit owner confirmation per deployment. |
| `DINGTALK_CONTAINER_LOGIN_ENABLED` | **off** (`routes/auth.ts` ~L1329 — unset ⇒ `POST /login/dingtalk/container` 404s with `container_login_disabled`). | **Now in both deploy templates** via #4240 — `docker/app.env.example` (`=false`, DANGER comment), `docker/app.staging.env.example` (`=false`). Not in root `.env.example`. | **explicitly-deferred**, same posture as E1 elsewhere on this line: default off, enable only for a deployment that actually ships the in-container 免登 frontend flow. |

**Correction to the closeout brief's gap analysis (DT-CLOSE-02B, re-verified 2026-07-13 against
the current templates on this branch):** the earlier claim that `DINGTALK_ALLOWED_CORP_IDS` /
`DINGTALK_CONTAINER_LOGIN_ENABLED` are staging-only, and that `docker/app.env.example` (the prod
template, then 37 lines) had **no** `DINGTALK_*`/`DIRECTORY_*` entries at all, is **stale** — it
predates #4240, which added the full closeout block (deprovision, primary-dept, OAuth
shared-state, interactive-card stream, group-delivery retention, sync alert/heartbeat/lease,
corp allowlist, container login) to `docker/app.env.example`. The prod template now carries
both keys (rows above). The two templates are aligned on closeout-switch
keys; the remaining difference is that staging also pre-fills deployment-specific values
(`DINGTALK_CLIENT_ID`, `DINGTALK_CORP_ID`, etc.) that a per-tenant staging deploy needs, which
the prod template deliberately leaves for the operator to fill in at deploy time.

## 3. Owner / 负责人 assignment

Every row above needs a named owner before Wave 2 can be called closed. **Placeholder —
not yet assigned:**

| Switch / family | Owner / 负责人 | Assigned date |
| --- | --- | --- |
| `DIRECTORY_DEPROVISION_ENABLED` + `_MAX_BATCH` | _TBD_ | _TBD_ |
| `DIRECTORY_PRIMARY_DEPT_FROM_ORDER` | _TBD_ | _TBD_ |
| `DINGTALK_INTERACTIVE_CARD_STREAM_ENABLED` | _TBD_ | _TBD_ |
| `DINGTALK_OAUTH_REQUIRE_SHARED_STATE_STORE` | _TBD_ | _TBD_ |
| `DINGTALK_GROUP_DELIVERY_RETENTION_DAYS` family | _TBD_ | _TBD_ |
| `DINGTALK_DELIVERY_RETENTION_DAYS` family (approval-card/person, §1.2) | _TBD_ | _TBD_ |
| `DIRECTORY_SYNC_ALERT_WEBHOOK` (+`_SECRET`) | _TBD_ | _TBD_ |
| `DIRECTORY_INACTIVE_LINKED_ALERT_DAYS` | _TBD_ | _TBD_ |
| `DIRECTORY_SYNC_HEARTBEAT_INTERVAL_MS` / `_LEASE_STALE_MINUTES` | _TBD_ | _TBD_ |
| `DINGTALK_ALLOWED_CORP_IDS` | _TBD_ | _TBD_ |
| `DINGTALK_CONTAINER_LOGIN_ENABLED` | _TBD_ | _TBD_ |

This ledger does not itself close Wave 2 — it makes the decision **shape** explicit
(default / precondition / evidence / rollback / owner) so the owner ruling, once given per
row, is a one-line fill-in rather than a re-derivation. No row here is closed until its
Owner/负责人 cell is filled and, for the must-verify-enabled rows, its evidence has actually
been captured (see DT-CLOSE-03 for the UAT evidence-pack mechanics that produce that
evidence for switch #3, and analogous ad hoc capture for #4/#5/#6).

## 4. Cross-references

- Roll-up: `dingtalk-sync-org-transfer-line-design-and-verification-20260712.md` §6/§8
  (DT-CLOSE-05 errata, 2026-07-13).
- UAT execution scaffold: `dingtalk-hardening-real-uat-evidence-pack-20260713.md`
  (DT-CLOSE-03) — produces the evidence switch #3 needs.
- Corp-anchor real-callback proof tooling: #4171 (merged `663511527`),
  `interactive-card-callback.ts` `readCallbackCorpAnchor`.
- DingTalk hardening ticket set (17/17 landed): `attendance-dingtalk-benchmark-tracker.md`.
- §1.2 source: #4142, `packages/core-backend/src/services/dingtalk-card-person-delivery-retention.ts`
  + `-scheduler.ts`.
