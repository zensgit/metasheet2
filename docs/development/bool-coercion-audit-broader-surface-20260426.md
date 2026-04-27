# Boolean Coercion Bug Class · Broader-Surface Audit Report

> Date: 2026-04-26
> Trigger: customer GATE wait extended; productive use of time
> Predecessor work: integration-core safety audit complete (PRs #1168 / #1169 / #1175 / #1176 / #1177 / #1182 / #1183 / #1184)

## Question

After today's 8-PR sweep hardened every customer/operator-typed boolean string path in `integration-core`, does the same bug class exist elsewhere in metasheet2?

The bug class (recap):
- `value === true` / `value !== false` strict-equality checks
- against fields that arrive over JSON REST APIs, hand-edited configs, or spreadsheet exports
- where the unsafe direction is operator's intent silently ignored, or worse, opposite-of-intent behavior

## Method

Searched 4 surfaces with `grep -rnE '=== true|=== false|!== true|!== false'`:

1. **`packages/core-backend/src/routes/approval-*.ts`** + **`services/Approval*.ts`**
2. **`packages/core-backend/src/routes/automation.ts`** + **`workflow*.ts`**
3. **`plugins/plugin-after-sales/lib/`**
4. **`plugins/plugin-attendance/`** (top-level `index.cjs` + `engine/`)
5. **`plugins/plugin-integration-core/lib/adapters/plm-yuantus-wrapper.cjs`**

For each hit, classified the source of the value (REST API request body, DB-stored row, internal Map/object, install-time config) and the safety direction (UX-only / safety-relevant / both directions safe).

## Findings

### Surface 1 — approval routes + services

| File | Sites | Verdict |
|---|---|---|
| `routes/approval-history.ts` / `approval-metrics.ts` / `approvals.ts` | **0** | Routes use Zod schemas upstream; raw bool checks don't exist at the route layer |
| `services/ApprovalBridgeService.ts` | 2 | `options?.includeExternalTabSources === true` (internal API call options); `policy_snapshot?.rejectCommentRequired !== false` (DB-stored JSON, server-authored on template publish) |
| `services/ApprovalGraphExecutor.ts` | 1 | `visibility.get(field.id) !== false` (internal Map, server-controlled) |

The closest-to-real candidate (`rejectCommentRequired !== false`): admin would need to hand-edit `policy_snapshot.rejectCommentRequired` to `"false"` (string) via direct DB write or a future template editor that doesn't validate types. Even then, the bug direction is **safe** (default = require comment); admin's hand-edit to disable is silently ignored, but no destructive action fires.

**Conclusion: no PR.**

### Surface 2 — automation + workflow routes

| File | Sites | Verdict |
|---|---|---|
| `routes/automation.ts` | **0** | All bool fields validated by Zod before reaching handlers |
| `routes/workflow.ts` | **0** | Same |
| `routes/workflow-designer.ts` | **0** | Same |

**Conclusion: no PR.**

### Surface 3 — plugin-after-sales

| File:Line | Pattern | Source | Verdict |
|---|---|---|---|
| `runtime-admin.cjs:57` | `rule && rule.enabled !== false` | DB-stored rule config | Server-controlled |
| `runtime-admin.cjs:65` | `rule.enabled !== false` | Same | Server-controlled |
| `installer.cjs:278` | `obj.provisioning.multitable === true` | Plugin manifest at install-time | Manifest authored by us |
| `workflow-adapter.cjs:259` | `match.enabled !== false` | DB-stored | Server-controlled |

All sites read from values we control (DB rows the plugin wrote, manifest we ship). No customer/operator typing path.

**Conclusion: no PR.**

### Surface 4 — plugin-attendance

20+ sites, classified:

- **Holiday config / DB rows** (`holiday.isWorkingDay === true`, `row.is_working_day === true`, `storedIsWorkday !== false`, etc.) — server-controlled, no risk
- **Callback return values** (`onRow(row, idx) !== false` — caller decides) — by-design API contract
- **Overnight inference** (`explicitOvernight === false / === true`) — internal computed
- **`normalizeGroupSyncOptions(groupSync, ...)` line 2884-2885** — `groupSync.autoCreate === true` and `groupSync.autoAssignMembers === true`. **One real candidate of the bug class.** If admin hand-edits the groupSync options blob to `autoCreate: "true"` (string), the strict check fails, function returns `null` (no sync), admin's intent silently ignored. UX-impacting.

**Conclusion**: 1 candidate in `normalizeGroupSyncOptions`, but:
- Blast radius unclear without tracing callers (`groupSync` source could be REST API or server-internal config)
- Bug direction is safe (admin's auto-create flag silently ignored, no accidental syncs)
- Plugin-attendance is unrelated to the K3 PoC scope the user is currently focused on
- A speculative PR here would be scope creep against the user's explicit "PoC readiness, no new platform capabilities" framing

**Recommendation: do NOT open a PR for this site.** Document it here so future sessions can pick it up if attendance hand-edit complaints surface.

### Surface 5 — PLM Yuantus wrapper

| File | Sites | Verdict |
|---|---|---|
| `plugins/plugin-integration-core/lib/adapters/plm-yuantus-wrapper.cjs` | **0** | Clean; the wrapper transforms data but doesn't strict-check booleans on customer input |

**Conclusion: no PR.**

## Overall conclusion

**The bug class is confined to integration-core.** Today's 8-PR sweep was thorough; the remaining strict-equality patterns elsewhere in the codebase are either:

- Server-controlled values (DB rows, internal Maps, install-time manifests)
- By-design API contracts (callback return values)
- UX-only safe-direction issues (admin's flag silently ignored, no destructive consequence)

No follow-up PRs are warranted. This audit closes the broader-surface check.

## What this means for the M2 GATE wait

- **Do NOT open more bool-coercion PRs.** The bug class is exhausted.
- If new audit lanes are needed during the wait, they should target a **different bug class** (e.g., race conditions in concurrent runs, missing tenant_id scoping, payload truncation handling) rather than continuing the bool-coercion theme.
- The PoC is ready (#1185 mock chain + runbook); customer GATE answer is the real next gate.

## One known follow-up to track (low priority)

`plugins/plugin-attendance/index.cjs:2884-2885` — `groupSync.autoCreate === true` / `groupSync.autoAssignMembers === true`. If the attendance team reports user complaints about "I enabled auto-create but it didn't work", check whether `groupSync` is being supplied as JSON-string booleans somewhere. Otherwise, ignore.

## Cross-references

- Integration-core audit series: PR #1168 / #1169 (preflight), #1175 / #1176 / #1177 / #1182 (evidence), #1183 (K3 adapter), #1184 (pipeline-runner)
- PoC readiness: PR #1185
- Memory note on audit-PR series pattern: `~/.claude/projects/-Users-chouhua-Downloads-Github/memory/feedback_audit_pr_series_pattern.md`
