# Monthly Delivery Wiring Audit — 2026-04-20

## Context

Today's Yjs internal rollout trial surfaced that the Yjs POC shipped with
a complete backend + 25+ unit tests but **no frontend wiring** — users
could never reach the feature. This was a silent gap that six rounds of
design review did not catch.

The hypothesis tested by this audit: **Yjs is not a special case. Other
recently shipped features may have the same pattern.**

Scope: all major features merged in the last ~30 days.
Tool: `docs/operations/poc-preflight-checklist.md` (item 2: frontend
wiring audit). Evidence = `grep` results + import chain traces.

---

## Summary

| Feature | Wiring | Reachable via UI | Gap Severity |
|---|---|---|---|
| Comment system (Week 1-2) | ✅ Fully wired | Yes | 0 gaps |
| API Token + Webhook Manager | ✅ Fully wired | Yes | 0 gaps |
| Public Form Share Manager | ✅ Fully wired | Yes | 0 gaps |
| DingTalk identity layer | ✅ Wired | Yes (login + admin) | 0 gaps |
| Automation rule editor | ⚠️ Partial | Partial (create works, logs broken) | **1 gap** |
| Chart / Dashboard V1 | ❌ Broken on click | No (400s immediately) | **4 gaps** |
| Field Validation Panel | ❌ Orphan | No | **3 gaps** |
| Yjs collaborative editing | ❌ Orphan | No | Documented earlier |

**Hypothesis confirmed.** Out of 8 audited feature clusters, 4 have real
production-blocking wiring issues. The Yjs finding was not an isolated
slip — the same pattern ("built but not reachable") exists in at least 3
other features shipped in the same window.

---

## 1. Chart / Dashboard V1 — broken on click (highest severity)

**User experience today:** clicking the "📊 Dashboard" button in
`MultitableWorkbench.vue` opens `MetaDashboardView.vue`, which immediately
calls `client.listDashboards(sheetId)` → **404**. The dashboard panel
shows as broken with no useful error.

**Three layers of breakage:**

### 1.1 Router never mounted

`packages/core-backend/src/routes/dashboard.ts` defines `dashboardRouter()`
at line 38. `grep -rn "dashboardRouter" packages/core-backend/src/`
returns **only the definition** — no `import { dashboardRouter }` anywhere.
The entire router of 11 endpoints is dead code.

### 1.2 URL path mismatch (would not work even if mounted)

| | Path |
|---|---|
| Router definition | `/:sheetId/charts`, `/:sheetId/dashboards` |
| Frontend `client.listCharts()` | `/api/multitable/sheets/:sheetId/charts` |

If someone mounts the router at `/api/multitable`, the URL becomes
`/api/multitable/:sheetId/charts` — missing the `sheets/` segment.

### 1.3 Response shape mismatch

| | Shape |
|---|---|
| Backend | `res.json({ items: [...] })` |
| Frontend | `parseJson<{ charts: [...] }>` / `parseJson<{ dashboards: [...] }>` |

Even if routes were mounted and paths matched, the frontend would get
`undefined` and render empty.

### 1.4 Tests do not catch this

`tests/unit/chart-dashboard.test.ts` tests `DashboardService` methods
directly against mocked DB — it does NOT test that routes are mounted or
that shapes match the frontend contract.

### Files to fix

- `packages/core-backend/src/index.ts` — mount `dashboardRouter()` at the
  right prefix
- `packages/core-backend/src/routes/dashboard.ts` — either change paths
  to include `sheets/` segment, OR
- `apps/web/src/multitable/api/client.ts` — drop `sheets/` segment, OR
- Both — pick one path convention and align
- Response shape — decide `{ items }` vs `{ charts, dashboards }` and
  align both sides

### Why this severity is "highest"

Unlike Yjs (silent no-op), the Dashboard button visibly breaks on click.
Any user exploring the workbench will hit this. It is not hidden.

---

## 2. Automation rule editor — partial (logs/stats broken)

**What works:** CRUD for automation rules lives in `univer-meta.ts` and
is fully wired. Users can create, list, edit, and delete automation
rules via the `⚡ Automations` button.

**What's broken:** the "View Logs" and stats endpoints.

### 2.1 Separate router never mounted

`packages/core-backend/src/routes/automation.ts` defines
`createAutomationRoutes()` with three endpoints:

- `POST /sheets/:sheetId/automations/:ruleId/test`
- `GET  /sheets/:sheetId/automations/:ruleId/logs`
- `GET  /sheets/:sheetId/automations/:ruleId/stats`

`grep -rn "createAutomationRoutes" packages/core-backend/src/` returns
**only the definition**. Frontend's `client.testAutomationRule()`,
`client.getAutomationLogs()`, `client.getAutomationStats()` would all
404.

### 2.2 Response shape mismatch (if it were mounted)

| | Shape |
|---|---|
| Backend | `res.json({ ok: true, data: { logs } })` |
| Frontend | Expects `{ logs }` directly |

### User impact

Clicking "View Logs" on any automation rule fails. The `MetaAutomationLogViewer`
component renders but can never populate.

### Why severity is "1 gap, not 4"

The core feature (automation rules themselves) works end-to-end via
`univer-meta.ts`. Only the observability layer (logs/stats/test-run) is
broken. Users can still use automation; they just cannot inspect what
happened.

---

## 3. Field Validation Panel — orphan + no API

Largest design gap.

### 3.1 Component is orphan

```
$ grep -rn "MetaFieldValidationPanel" apps/web/src/ --include="*.vue" --include="*.ts"
(zero results outside the file itself)
```

### 3.2 No API to get/set validation rules

- `field-validation-engine.ts` DOES run at record-submit time
  (`univer-meta.ts:6474, 7879`) — validation is enforced.
- But there is no endpoint to READ or WRITE validation rules on a field.
- `PATCH /fields/:fieldId` exists but its `sanitizeFieldProperty()`
  (`univer-meta.ts:943-1016`) does not handle validation configuration.

### 3.3 No user flow

Even if the component were wired, there is no natural home for it —
probably `MetaFieldManager` but it is not integrated there either.

### Net effect

- Admins who want a required field cannot configure it via UI
- If they set rules some other way (directly in DB?), they cannot see
  or edit those rules via UI
- Rules are enforced, but silently — failed submits show field-level
  error messages but the user has no way to know what rule failed or
  adjust it

### Cost to fix

Medium-large: needs API design (new endpoint or extend PATCH /fields),
UI placement decision (extend MetaFieldManager), persistence strategy
for the rule array, tests. Not a drop-in wire-up.

---

## 4. Yjs — already documented

See `docs/operations/yjs-internal-rollout-trial-verification-20260420.md`.

Frontend `useYjsDocument` / `useYjsTextField` exported but not imported.
Same pattern.

---

## 5. Features that passed the audit

### 5.1 Comment system (Week 1-2)

Complete wiring: MetaCommentComposer → MetaCommentsDrawer → MultitableWorkbench;
7 view components render MetaCommentAffordance. All composables
(`useMultitableComments`, presence, inbox, realtime) are imported and
called. Inbox has its own route `/multitable/comment-inbox`. Real-time
events wired. All API methods invoked.

### 5.2 API Token + Webhook Manager

Entry: "API & Webhooks" button in workbench (line 54). All 9 API
methods (`listApiTokens`, `createApiToken`, `revokeApiToken`,
`rotateApiToken`, webhooks 5 methods) called from `MetaApiTokenManager.vue`.

### 5.3 Public Form Share Manager

Entry: "Share Form" button (workbench line 53, visible only on form
view). Three API methods called and wired. Companion public route
`/multitable/public-form/:sheetId/:viewId` present.

### 5.4 DingTalk identity

Login button in `LoginView.vue` calls `/api/auth/dingtalk/launch`.
Callback handled by `DingTalkAuthCallbackView` at
`/dingtalk/callback`. Admin directory sync UI in
`DirectoryManagementView.vue` at `/admin/directory`.

---

## 6. What this means

### 6.1 The Yjs finding was not a fluke

3 out of 8 audited features have wiring gaps. We cannot trust "merged
PR + green unit tests" to mean "users can reach it".

### 6.2 Product-visible breakage exists today

Anyone clicking the Dashboard button in the workbench hits a 404. This
is not a silent issue like Yjs. Users would notice.

### 6.3 Pattern detection

All 3 broken features share a common origin: they were built in a
"backend service + frontend component" sprint where the two were
developed in separate PRs and **nobody ran the full stack to click the
button at the end**. The preflight checklist's item 1 (end-to-end real
run) would have caught all three.

### 6.4 What the preflight checklist should add

Consider adding item 8: **"There is at least one CI dispatch or manual
command that exercises the end-to-end flow against a running server
before the feature can be marked done"**. This is the step nobody did
for Yjs, Dashboard, Automation logs, or Field Validation.

---

## 7. Suggested remediation order

Smaller → larger:

1. **Dashboard wiring fix (~1 hour)**: mount router, align path prefix,
   align response shape. Highest user-visible value per unit effort.

2. **Automation logs wiring fix (~30 min)**: mount `createAutomationRoutes`,
   fix response unwrap on frontend. Unblocks "View Logs" button.

3. **Field Validation Panel (~1 day)**: design work required — API for
   rule CRUD, UI placement, tests. Not a simple wire-up.

4. **Yjs frontend integration**: separate product decision; not a fix
   but a feature commitment.

Items 1 and 2 together are < 2 hours and would close the worst visible
gaps. Items 3 and 4 need product-level decisions.

---

## 8. Evidence archive

Per audit:

- Audit scripts/commands reproducible via the commands shown inline
- Source of truth: this document + `docs/operations/poc-preflight-checklist.md`
- Verification grep commands that anyone can re-run:

```bash
grep -rn "dashboardRouter"             packages/core-backend/src/
grep -rn "createAutomationRoutes"      packages/core-backend/src/
grep -rn "MetaFieldValidationPanel"    apps/web/src/
grep -rn "useYjsDocument|useYjsTextField" apps/web/src/
```

If any of these return only the original definition site (no import),
that feature has the wiring gap described in this audit.
