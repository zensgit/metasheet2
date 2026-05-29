# Attendance Group Punch-Method Configuration Design

Date: 2026-05-29
Branch: `codex/attendance-group-punch-method-config-design-20260529`
Status: design lock only

## 1. Purpose

The attendance group admin now reads like a real admin console: one list-detail surface, Basic info + People as the only write areas, read-only summary cards for adjacent capabilities, and a landed group fixed-schedule path (preview/apply/rebuild/clear with provenance). The Punch method summary card today shows static copy and a link to Settings.

This document locks how punch / check-in method configuration should evolve **inside the attendance group detail**, grounded in how punch policy is actually modeled and enforced today. It does not authorize runtime, frontend, backend, schema, migration, route, permission, or OpenAPI changes. A future runtime slice is a separate explicit opt-in.

The product goal is the admin-console feel: an operator looking at a group should understand the punch policy that applies, without the UI pretending the group owns settings it does not, and without inventing controls (Wi-Fi, geofence, device, photo, face) that the system cannot honor.

## 2. Lineage

| Link | State | Relevance |
| --- | --- | --- |
| `docs/development/attendance-group-admin-ux-parity-design-20260527.md` | merged design lock | Set the list-detail direction; **open question #2 — "Should punch methods ever be group-specific, or stay global/workspace-level?" — is the question this document answers.** Its V1 disposition was "show global setting summary; no new group-specific punch schema." |
| `#1965` (Slice C) | merged runtime | Added the read-only Punch method summary card that currently says "Workspace settings only in group settings V1" and links to Settings. |
| `#1994` / `#2019` (fixed schedule) | merged runtime | Established the group-detail pattern for safe, gated, transactional group operations; this document follows the same discipline for punch policy. |

This document does not modify any of the above. It references the current code state and chooses a conservative V1.

## 3. Current Baseline

All code citations were verified on `origin/main` at `d1e445fc5`.

| Area | Current state | Evidence |
| --- | --- | --- |
| Group shape | `attendance_groups` exposes `id`, `orgId`, `name`, `code`, `timezone`, `ruleSetId`, `description`, timestamps. **It has no punch-method field of any kind.** | `plugins/plugin-attendance/index.cjs:7275` |
| Punch policy fields exist | `ipAllowlist`, `geoFence`, and `minPunchIntervalMinutes` exist as settings fields with concrete defaults (`ipAllowlist: []`, `geoFence: null`, `minPunchIntervalMinutes: 1`). | `plugins/plugin-attendance/index.cjs:90`, `:91`, `:92` |
| Punch policy is **org-global** | The effective settings come from `getSettings(db)`, which takes only `db` (no `orgId`, no `groupId`) and returns a single process-cached settings object. There is no per-group or per-rule-set resolution. | `plugins/plugin-attendance/index.cjs:10690`, `normalizeSettings` `:10505`/`:10514`/`:10606` |
| Punch policy is **enforced, not vestigial** | `enforcePunchConstraints({ … settings … })` rejects punches that fail the IP allowlist, the geofence, or the minimum punch interval, using the org-global settings. | `plugins/plugin-attendance/index.cjs:14156`, `:14157` (`isIpAllowed` `:5486`), `:14164` (`isGeoAllowed` `:5526`), `:14175`–`:14190` |
| Punch facts tables (do not touch) | The punch route writes raw clock events to `attendance_events` and updates the daily `attendance_records` summary via `upsertAttendanceRecord`; punch-method validation runs **before** the transaction, so a rejected punch writes neither event nor record. | `plugins/plugin-attendance/index.cjs:17291` (route), `:17314`–`:17323` (enforce), `:17351`–`:17383` (`attendance_events` insert + `upsertAttendanceRecord` call), `upsertAttendanceRecord` `:13128` / `:13175`–`:13192` (`attendance_records` upsert) |
| Settings read path (the wire) | `GET /api/attendance/settings` is guarded by `attendance:admin` (the same permission the group admin uses) and returns `data: settings` — the full normalized object, **including `ipAllowlist`, `geoFence`, `minPunchIntervalMinutes`, with no redaction.** | `plugins/plugin-attendance/index.cjs:28960` |
| Settings write path | `PUT /api/attendance/settings` (`attendance:admin`) validates against `settingsSchema`, which accepts `ipAllowlist` / `geoFence` / `minPunchIntervalMinutes`, and emits `attendance.settings.updated`. | `plugins/plugin-attendance/index.cjs:28978`, schema `:14871`–`:14877` |
| Frontend already loads settings | `AttendanceView.vue` already fetches `/api/attendance/settings` via `loadSettings()` during admin load, with an `AttendanceSettings` interface and `applySettingsToForm`. The punch fields are already client-side in the admin context. | `apps/web/src/views/AttendanceView.vue:14520`, `:14523`, called at `:17079`; interface `:6192`; `applySettingsToForm` `:14424` |
| Current Punch method card | The Slice C card shows static copy "Workspace settings only in group settings V1" + "Group-specific Wi-Fi, location, hardware, photo, and face verification are not configured here" and links to Settings. | `apps/web/src/views/AttendanceView.vue:8246`–`8249` |
| Rule set boundary | Groups reference a rule set via `ruleSetId`; rule sets (`attendance_rule_sets`, `/api/attendance/rule-sets`) carry scheduling/formula/engine config (`ruleSetConfigSchema`, `validateEngineConfig`). Punch enforcement reads org settings, **not** the group's rule set. | `plugins/plugin-attendance/index.cjs:20491`, group link `:7275` |

### 3.1 The decisive facts

1. Punch policy that exists today = **IP allowlist, geofence, minimum punch interval**. These are **org-global** and **actively enforced** at punch time.
2. There is **no per-group punch policy** and the group's rule set does not carry punch enforcement. The current Slice C card ("workspace settings only") is therefore **accurate**.
3. The capabilities the card names as deferred — **Wi-Fi, hardware/device, photo, face** — **do not exist in the model at all** (no fields, no enforcement).

## 4. Capability Tiers

To avoid lumping unlike things together, classify every punch-method capability into one of three tiers. The V1 decision applies differently to each.

| Tier | Capabilities | Reality | V1 treatment |
| --- | --- | --- | --- |
| **T1 — exists, enforced, org-global** | IP allowlist, geofence, minimum punch interval | Stored in settings, enforced at `enforcePunchConstraints`, on the wire via `GET /api/attendance/settings` | **Surfaceable read-only** in the group detail, explicitly labeled workspace-level |
| **T2 — named but nonexistent** | Wi-Fi binding, hardware/device enrollment, photo, face verification | No fields, no enforcement, no data source | **Honest "not available" copy only — never a control, never a disabled-looking form** |
| **T3 — per-group override of T1** | Group-specific IP allowlist / geofence / interval | Not modeled; would require enforcement-path changes | **Deferred** — separate design + opt-in (see §6.3) |

## 5. Design Decision (V1 Scope)

V1 is **read-only**. It does not add per-group punch storage or change enforcement. Three candidate scopes were considered:

| Scope | What it does | Cost | Honesty |
| --- | --- | --- | --- |
| **V1-min** | Keep the current static Punch method card unchanged; defer everything. | ~0 | Honest (already says workspace-level). The honest floor. |
| **V1-enrich (recommended)** | Replace the card's static copy with the **live org policy values** already loaded client-side (IP allowlist count, geofence on/off, min interval), with a **loud workspace-level label** and the existing Settings link. | Frontend-only; reuses the already-fetched settings; no new fetch, route, schema, or enforcement change. | Honest **only if** framed as "applies to all groups / workspace-level"; see §5.1. |
| **V1-config** | Per-group punch overrides. | Schema + hot-path enforcement change + migration. | Deferred — §6.3. |

**Recommendation: V1-enrich, conditional on the workspace-level framing in §5.1; otherwise V1-min.** The reachability is confirmed (T1 fields are on the wire under `attendance:admin` and the frontend already loads them), so V1-enrich is genuinely frontend-only. The win is modest — with defaults `geoFence: null` / `ipAllowlist: []`, the common display is "no geofence / no IP restriction / 1-minute interval" — but showing the real resolved policy beats generic copy, and it does so without inventing anything.

### 5.1 The honesty constraint (most important rule)

Rendering org-global values **inside a specific group's detail** risks implying they are group-scoped — the exact false impression the current card deliberately guards against. V1-enrich is only acceptable if it is unmistakably framed as workspace-level:

- The card must say the policy is **workspace-level and applies to all attendance groups**, not "this group's punch policy."
- It must keep the **Settings** link as the single edit path; the group detail must not present any punch input, toggle, or save control.
- If that framing cannot be made unambiguous in the available space, fall back to **V1-min** (the current copy is already the honest floor — do not regress honesty for a cosmetic upgrade).

## 6. Hard Boundaries

The future runtime slice must stay inside these boundaries unless a later design explicitly changes them:

1. No new `attendance_groups` punch column, no new punch table, no JSON punch field on the group.
2. No migration in V1.
3. No change to `enforcePunchConstraints` or any punch-time resolution. Enforcement stays org-global.
4. No new route, no new permission, no OpenAPI change. V1 reads the existing `GET /api/attendance/settings` data already loaded by `AttendanceView`.
5. No write path from the group detail to punch policy. Editing stays at `PUT /api/attendance/settings` via the existing Settings surface.
6. **No fake controls (T2).** Wi-Fi, hardware/device, photo, and face verification must read as "not available," never as disabled-looking inputs.
7. No mobile-client capability is designed or promised here (no device binding, no app-side geofence, no camera/biometric capture).
8. No change to `attendance_events` (raw clock events) or `attendance_records` (daily summary), or any recorded clock/check-in fact. V1 touches policy display only, never event facts.
9. No `attendance_schedule_groups` reuse and no punch semantics added to the rule set.
10. No owner/sub-owner, delegated-admin, export/copy, weekly matrix, multi-shift, or comprehensive-hours work.

This document is docs-only and authorizes none of the above; the runtime slice is a separate explicit opt-in.

### 6.3 Per-group punch policy (T3) — deferred, and why it is a track not a slice

If a future product decision wants group-specific punch policy, the gating reason is **not** "we need a column." It is the **enforcement path**:

- Today `/api/attendance/punch` resolves a single org-global settings object (`getSettings(db)`) and enforces against it, with no group lookup.
- Per-group enforcement means: at punch time, resolve the punching user's attendance group(s), load that group's override, merge it over the org defaults, then enforce — **on the hot punch path**, plus a membership→group resolution that punch does not do today. Ambiguity (a user in multiple groups; a user in none) must be defined.
- That is a runtime + enforcement + migration change, not a config-UI slice. It also reopens the honesty question for recorded events (does an event record which policy applied?).

**Storage tradeoffs for T3 (recommendation, for the future design — not decided here):**

| Option | Pros | Cons |
| --- | --- | --- |
| Column(s) on `attendance_groups` | Simple join at resolution | Pollutes the membership/policy group shape; only fits flat scalar policy; awkward for structured geofence |
| New `attendance_group_punch_overrides` table (scoped override layer) | Clean separation; nullable/sparse; structured geofence; mirrors the provenance-on-existing-table discipline without overloading the group | One more table + migration; resolution/merge logic to design |
| Extend the rule set | Reuses the existing group→ruleSet link | **Breaks the attendance↔rule-set boundary** (rule sets are scheduling/formula/engine, not punch enforcement); couples punch to scheduling identity |

**Lean: a scoped override layer (override table), resolved at punch time and merged over org defaults — not a rule-set field (preserves the boundary) and not a new event-fact table (punch facts stay in `attendance_events` / `attendance_records`).** This is a recommendation to be ratified by the T3 design lock, not a commitment.

## 7. V1 UX Contract (read-only)

When the V1-enrich runtime slice is explicitly opted in:

- The Punch method card in the selected group detail shows the **live org policy**, derived from settings already loaded by `loadSettings()`:
  - IP allowlist: "No IP restriction" when empty, else "Restricted to N address ranges" (count only; do not necessarily render raw ranges if that is a leakage concern — show count and link to Settings).
  - Geofence: "No geofence" when `null`, else "Geofence enabled" (+ an optional label/radius if already present in the value).
  - Minimum punch interval: "N minute(s)" from `minPunchIntervalMinutes`.
- A persistent **workspace-level label** (§5.1) and the existing **Open Settings** link.
- T2 capabilities (Wi-Fi, device, photo, face) remain a short "not available in attendance / configured per workspace where applicable" line — **no controls**.
- No input, toggle, or save control anywhere in the group-detail punch card.
- Unsaved/unselected group: keep the existing "choose or save a group first" behavior; punch policy is workspace-level so it may still display, but must not imply group context.

### 7.1 Slice C card reconciliation (wire-consistency)

If V1-enrich lands, the Slice C card copy at `AttendanceView.vue:8246`–`8249` changes from static "workspace settings only" text to the live-values + workspace-level framing. The runtime slice **must update that card copy in the same change** and update any test asserting the old copy — the copy and the rendered values must not drift. If V1-min is chosen, the card is unchanged and this section is moot.

## 8. Proposed Runtime Slice Shape

A future V1-enrich runtime PR should be one frontend-only PR:

| Change | Allowed implementation |
| --- | --- |
| Live punch summary | Read `ipAllowlist` / `geoFence` / `minPunchIntervalMinutes` from the already-loaded settings; render read-only in the Punch method card. |
| Workspace-level framing | Static label making clear the policy applies to all groups; keep the Settings link. |
| T2 honesty | Keep "not available" copy; assert no controls render. |
| Tests | Extend `attendance-admin-regressions.spec.ts` around the group-detail Punch method card. |

Do not touch `plugins/plugin-attendance/index.cjs`, settings routes, `enforcePunchConstraints`, migrations, OpenAPI, the rule set, or the punch fact tables (`attendance_events` / `attendance_records`) in the V1 runtime PR.

## 9. Test Matrix (for the future runtime slice)

| ID | Requirement | Test target |
| --- | --- | --- |
| PM1 | The Punch method card renders live `ipAllowlist` / `geoFence` / `minPunchIntervalMinutes` from loaded settings. | Frontend test with mocked settings. |
| PM2 | The card is explicitly workspace-level; copy does not claim the values are group-specific. | Frontend text assertion. |
| PM3 | Empty defaults render honest copy ("No IP restriction" / "No geofence" / "1 minute"). | Frontend test with `DEFAULT_SETTINGS`-shaped fixture. |
| PM4 | No input/select/toggle/save control exists in the group-detail punch card. | Scoped DOM control-absence assertion. |
| PM5 | T2 (Wi-Fi/device/photo/face) renders "not available" text, never a control. | Frontend assertion. |
| PM6 | The group detail issues no write to `/api/attendance/settings` and no punch-policy POST/PUT. | Mocked `apiFetch` call-count assertion. |
| PM7 | No backend, route, schema, migration, OpenAPI, or `enforcePunchConstraints` diff. | Reviewer diff check. |
| PM8 | Slice C card copy and its existing test are updated in lockstep with the rendered values. | Reviewer diff check + updated regression test. |
| PM9 | No `attendance_events` / `attendance_records` / clock-event read or write is introduced. | Source grep / reviewer diff check. |

## 10. Explicitly Deferred

Each is a separate design-lock-first opt-in:

- per-group punch policy / overrides (T3, §6.3) — needs enforcement-path change + migration;
- Wi-Fi binding, hardware/device enrollment, photo capture, face verification (T2) — net-new model + enforcement + client/device integration;
- mobile-client punch capabilities;
- punch-method semantics on the rule set or `attendance_schedule_groups`;
- owner/sub-owner or delegated punch administration;
- export/copy of punch policy;
- weekly schedule matrix, multiple shifts per weekday;
- comprehensive-hours writes from the group detail;
- any change to `attendance_events` / `attendance_records` or recorded clock/check-in facts.

## 11. Acceptance For This Design

This design lock is complete when:

- it records that punch policy (IP allowlist / geofence / min interval) is org-global and enforced today, with no per-group path;
- it separates capabilities into exists-and-enforced (T1), named-but-nonexistent (T2), and per-group-override (T3);
- it answers `#1946` open question #2 for V1: punch method stays workspace-level; the group detail surfaces it read-only, honestly framed;
- it forbids fake Wi-Fi/location/device/photo/face controls and mobile promises;
- it states the no-new-table / no-migration / no-enforcement-change V1 path and gives the T3 storage tradeoffs with a recommendation;
- it confirms recorded clock/check-in facts (`attendance_events` / `attendance_records`) are never touched;
- it provides a runtime slice shape and test matrix;
- it adds no runtime code, tests, schema, migrations, routes, permissions, OpenAPI, ops scripts, or production writes.
