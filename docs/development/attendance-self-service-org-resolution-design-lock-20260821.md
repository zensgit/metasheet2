# Attendance Self-Service Org Resolution Design Lock (D6)

Status: **DRAFT — NOT RATIFIED.** No part of this document authorizes runtime
behaviour change, feature-flag enablement, merge, deployment, customer data,
production data, or closing #4556. It exists because the shipped shadow-audit
feature (#5064, #5073) currently has **no governing text in this repository** —
its only prior references were a PR body and session notes.

- Baseline: `5e9a15f02e7f3971b34f3b768c064cd27491d947` (all cited line numbers
  read against this commit unless stated otherwise).
- Scope: how the **self-service attendance routes** resolve an org when the
  request supplies none. Owns nothing else.
- Related but separate: `attendance-issue-4556-w4-segment-calculation-design-lock-20260724.md` owns the
  W4 calculation boundary and its canonical org-key domain. This lock must not
  invent or duplicate that contract; §5 records where the two meet.
- Ratification placeholder: **§8**. A ratify record must cite an owner-authored
  artifact (an issue/PR comment written by the owner). This document must never
  paraphrase or pre-write that text.

## 1. Problem statement

`getOrgId(req)` (`plugins/plugin-attendance/index.cjs:6318-6326`, `DEFAULT_ORG_ID` at `:49`) resolves
`body.orgId ?? query.orgId ?? user.orgId ?? user.workspaceId ?? x-org-id ??
DEFAULT_ORG_ID`. It never reads the session's org claim. The self-service
front-end sends no `orgId` for a normal punch
(`apps/web/src/views/AttendanceView.vue`, punch payload is
`{ eventType, timezone, orgId? }` with `orgId` empty unless the user types into
the history-filter Org ID box), and `jwt-middleware` puts the session org on
`req.authenticatedTenantId` only — never on `req.user.orgId`
(`packages/core-backend/src/auth/jwt-middleware.ts:100-111`).

Consequence: a normal browser punch resolves to `DEFAULT_ORG_ID` (`'default'`)
regardless of the user's actual memberships. Reads on the same UI
(`punch/events`, `records`/`calendar`, `summary`, request lists) resolve the same
way, so for a default-shaped session the write and the reads agree and the user sees
their own data. The defect is that the agreement is coincidental, not derived from
identity — and it is already incomplete: `GET /api/attendance/punch/events` does not
forward the Org ID box, so a user who types an org there splits write from read today.

## 2. Facts that constrain any solution

- **F1 — a `'default'` session claim does not mean the user chose an org.**
  The web client persists a tenant hint and injects it as `x-tenant-id` on every
  request *including login* (`apps/web/src/utils/api.ts` `authHeaders`,
  `apps/web/src/composables/useAuth.ts` `persistTenantHint`);
  `AuthService.resolveSessionTenantId` accepts it after verifying membership, and
  `'default'` is a legal membership for every user backfilled by
  `zzzz20260114110000_create_user_orgs_table.ts` (it inserts a `'default'` row for
  every then-active user). A minted `'default'` claim is therefore not evidence
  of user intent.
- **F2 — attendance data is org-sharded with no cross-org fallback.**
  `attendance_records`, leave types and annual accrual are filtered by `org_id`;
  only `loadDefaultRule` has a fallback. Changing an existing user's resolved org
  therefore *relocates* them: history, balances, leave types and pending requests
  stop being visible unless data moves with them.
- **F3 — the resolved org is the W4 boundary key.**
  `parseCanonicalAttendanceRolloutOrgKeyV1`
  (`packages/core-backend/src/attendance/w4c0-identity.ts:158`) delegates to
  `parseOrgKeyLexical` (`:143-146`), which accepts the exact ASCII sentinel
  `'default'` (no whitespace or case alias) or UUID syntax, and otherwise throws
  `W4C0_ROLLOUT_ORG_KEY_INVALID` — while `user_orgs.org_id` is free text. The W4
  rollout allowlist is indexed by the resolved key. Changing resolution changes
  which key the W4 machine sees, so this lock cannot claim "no W4 impact".
- **F4 — per-org gating of this decision is circular.** The org is the *output*
  of the rule being gated, so an org allowlist cannot select the code path that
  decides the org. Gating must be global (plus an explicit user-id canary).
- **F5 — `req.user.tenantId` is not a reliable name for "the token claim":**
  `jwt-middleware` backfills it from the `x-tenant-id` header when the token has
  no claim. Text in this lock always says `req.authenticatedTenantId` when it
  means the token claim.

## 3. Current state (shipped, behaviour-inert)

- `ATTENDANCE_SELF_SERVICE_ORG_RESOLUTION_V1` is a tri-state parsed once at plugin
  start: unset/`off` (default) → the recorder is never called and issues zero
  queries; `shadow` → one audit row per punch ATTEMPT (written before validation and
  geofence, so the table counts attempts, not accepted punches), response unchanged;
  any other
  value → the plugin fails to activate (an enum must reject unknown values rather
  than silently degrade).
- `shadow` writes to `attendance_org_resolution_shadow` (#5064): the org the route
  actually used, the token claim, membership counts, the org the proposed rule
  would choose, whether they agree, and which rule fired.
- The recorder is response-non-blocking and DB-bounded (#5073): fire-and-forget at
  the call site; both statements inside one transaction opened with
  `SET LOCAL statement_timeout`; an in-flight cap that drops (and counts) excess
  samples instead of queueing; counters `attempted/written/abandoned/dropped/failed`
  with a sum invariant. The JS watch timer is **observability only** — it cancels
  nothing and releases no connection; server-side cancellation comes from
  `statement_timeout`, and it is per statement.

## 4. Open contract questions (what this lock must decide before `enforce` exists)

- **Q1** When the request supplies no org: session claim, sole non-`'default'`
  membership, or refuse ambiguity? What does a multi-membership user without a
  usable claim get — today's silent `'default'`, or a visible error?
- **Q2** Does changing an existing user's resolution require a one-time data
  relocation (F2), or is "the new org starts empty" an accepted product outcome?
  A lock that leaves this blank is not ratifiable.
- **Q3** Must the resolver's output be constrained to the W4 canonical domain (F3),
  and what happens for an org id outside it — fail closed, or resolve elsewhere?
  Any answer amends `attendance-issue-4556-w4-segment-calculation-design-lock-20260724.md`.
- **Q4** Does a `'default'` membership count when deciding "sole membership"?
  (Login's `resolveSessionTenantId` currently counts it; two different definitions
  of "sole membership" in one system would be a defect.)

## 5. Staged path

- **R0 — shadow audit (shipped, off).** Enable, accumulate, and read the
  disagreement distribution. R0 changes no behaviour and answers Q1/Q2 with counts
  instead of estimates.
- **R1 — session-org semantics.** An org switcher plus a login rule that does not
  treat a persisted `'default'` hint as a choice (F1). This is Canonical-Org-line
  work; attendance is a consumer.
- **R2 — joint lock.** Q2's data decision, Q3's amendment to the W4 lock, and the
  criteria for any `enforce` mode. This DRAFT governs nothing, so it does not forbid
  anything; it records the author's position that `enforce` code written before R2
  would be built against undecided semantics.

## 6. Enablement preconditions for R0 (staging)

1. The recorder must be non-blocking and bounded — satisfied by #5073.
2. Confirm the running staging backend's actual `DB_POOL_MAX` (do not rely on the
   default) and record the ratio against the in-flight cap; the recorder shares
   the application pool.
3. Watch pool wait time plus the `dropped/failed/abandoned` counters for the whole
   window; a silent sample gap during an incident invalidates the audit.
4. Production enablement is **out of scope here** and needs its own decision on
   pool isolation or a lower share cap.

## 7. Non-goals

Changing `getOrgId` itself (it is read by most attendance routes — on the baseline commit, 97 distinct routes across 106 call sites); changing the W4 boundary or
operation registry; changing login's tenant resolution (R1 owns that); enabling
any flag.

## 8. Ratification record

*(empty — to be filled with the identifier of an owner-authored comment and the
scope that comment grants. Until then this document is DRAFT and governs nothing.)*
