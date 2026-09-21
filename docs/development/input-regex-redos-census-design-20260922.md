# Input-regex ReDoS census — design (slice H-3)

**Status: PROPOSED.** Date: 2026-09-22. Base: `origin/main` @ `cd42eaf7455f03dd99021a02c47c42f1f3db6484`.
Branch: `fix/input-regex-redos-candidates`. Candidate only — not merged, not undrafted, no DDL.

## 0. Scope

Mechanical census of every regular expression evaluated in
`packages/core-backend/src`, `apps/web/src`, and `plugins/*/index.cjs`, with a
concurrent-timing probe for the shapes a static grader flags as super-linear, and
a candidate fix for the one site with **measured cross-tenant event-loop
blocking**.

Motivation (private): a custom edge-trim regex candidate (`NAME_EDGE_TRIM_PATTERN`,
approval template groups name-rule) was measured freezing an unrelated tenant's
request for 15.01s. That candidate is not on `origin/main`; this census asks
whether any regex **already on `origin/main`** has the same property against
user-controlled input.

### In scope
- Regex **literals** and `new RegExp(...)` on user input, classified by shape.
- Two distinct bug classes: (1) user input as the **subject** of a constant
  regex (the precedent's shape); (2) user input as the **pattern** itself.
- Backend cross-tenant severity (shared single-threaded event loop) vs frontend
  single-session self-DoS (one browser tab).

### Not in scope / deferred to owner
- Any merge / undraft / migration.
- The definitive fix for user-supplied regex (linear-time engine such as RE2, or
  a step-budgeted / interruptible matcher). The candidate here is a **partial**
  guard; the complete fix is a dependency/contract decision.
- Per-site cross-tenant HTTP proof for the 13 literal candidates (only
  microbenchmarked; reachability marked UNVERIFIED where not traced).

## 1. Method (four stages, cheap→expensive, each gating the next)

1. **AST extraction** (`ts` compiler API) — every regex site, no judgment.
2. **Static grade** — drop sites with no unbounded quantifier; dedupe the rest
   into distinct `(pattern, flags, call-method)` jobs.
3. **Pump-fuzz** each job in an isolated, killable child process at N =
   1e3/1e4/1e5 with three subject shapes per quantified atom (member-run;
   member-run + non-member tail; non-member head + member-run + tail). Super-linear
   growth (≥25× per 10× N, or a child that cannot finish in 20s) escalates.
4. **Out-of-band concurrent probe** (real Express, real event loop, one-shot DB
   `metasheet2_h3_20260922`) — only for a site with confirmed reachable
   user-controlled input, to measure **victim-request** latency (the criterion
   that makes it a P1, not a slow endpoint).

Instrument validity is asserted by a control battery (§ verification MD): the
real `NAME_EDGE_TRIM_PATTERN` must grade super-linear or every "linear" verdict is
vacuous.

## 2. Census table — the 14 super-linear-flagged shapes + the class-two finding

`file:line` / input source / shape / measured (microbench) / disposition.
Full site lists for the two multi-site shapes are in § 2.1.

| # | file:line | input source | shape | measured | disposition |
|---|---|---|---|---|---|
| **L** | `formula/engine.ts:330/333/336` (REGEXMATCH/EXTRACT/REPLACE) + `:183` (SUBSTITUTE) | **user supplies the PATTERN** via a formula expression | class-two; nested-quantifier `new RegExp(userStr)` | **20.4s in-process @58-char expr; 55.0s cross-tenant victim GET (OOB)** | **LIVE, CONFIRMED cross-tenant. FIXED on branch (2 commits, PROPOSED).** |
| 1 | `attendance/w7-shadow-expected-differences.ts:287` | `ratifiedBy` from W7 expected-shadow roster config | `/[\w-]+\.md\b/` `.test` | ratio 101, 5.1s @1e5 | internal domain config, not HTTP body → UNVERIFIED reachable; no fix |
| 2 | `data-adapters/DataSourceManager.ts:1252` (+11 copies, § 2.1) | data-source config `value` (DataSourceManager); rest internal | `/\/+$/` `.replace` | ratio 92, 3.1s @1e5 | quadratic; needs ~1e5 `/` chars; bound not enforced but reachability UNVERIFIED; no fix |
| 3 | `data-adapters/PLMAdapter.ts:15`, `services/ai-provider-client.ts:55` | adapter error/log text (URL userinfo redaction) | `/([a-z][a-z0-9+.-]*:\/\/)[^/\s]*@/gi` `.replace` | ratio 97, 5.1s @1e5 | quadratic; input = error text, not direct body; UNVERIFIED; no fix |
| 4 | `routes/univer-meta.ts:5247` (+8 copies, § 2.1) | `sheetName` (export filename) | `/^_+|_+$/g` `.replace` | ratio 92, 3.1s @1e5 | **BOUNDED — not a finding**: `name: z.string().max(255)` (`:8056/:13469/:14397`) before regex |
| 5 | `multitable/approval-form-value-mapping.ts:75` | decimal number lexeme from approval form | `/0+$/` `.replace` | ratio 102, 3.2s @1e5 | needs ~1e5 trailing zeros; bounded by numeric field precision in practice; UNVERIFIED; no fix |
| 6 | `multitable/automation-log-redact.ts:108` (backend) + `apps/web/.../automation-log-redact.ts:108` | automation-log content (host parsed from DB-URL-in-log) | `/\d+\.\d+\.\d+\.\d+/` `.test` | **UNFINISHED >20s** | backend copy = cross-tenant weight; ReDoS-shaped; reachability UNVERIFIED → **owner-review candidate**, no speculative fix. FE copy = single-session |
| 7 | `sandbox/SecurityPolicy.ts:250` | sandbox script (user automation code) | `/\w+\s*\(/g` `.match` | ratio 94, 3.9s @1e5 | quadratic; sandbox analysis path; gating UNVERIFIED; no fix |
| 8 | `services/AttendanceNotificationDeliveryWorker.ts:1126/1220` | DingTalk error text | `/(?:https?:\/\/)?(?:[a-z0-9-]+\.)+[a-z]{2,}…/gi` `.replace` | **UNFINISHED >20s** | **precedent antipattern**: truncates to 240 *after* the regex (`normalizeErrorText`); background worker; attacker-control UNVERIFIED → **owner-review candidate** |
| 9 | `workflow/BPMNWorkflowEngine.ts:1266` | BPMN condition expression `cond` | `/^(.+?)\s*(===|…)\s*(.+)$/` `.match` | **UNFINISHED >20s** | author-supplied workflow definition; ReDoS-shaped → **owner-review candidate** |
| 10 | `workflow/bpmnCompilePreview.ts:865` | automation condition `raw` | `/\s*\}$/` `.replace` | ratio 98, 5.1s @1e5 | author-supplied; quadratic; UNVERIFIED; no fix |
| 11 | `apps/web/src/multitable/import/delimited.ts:94` | CSV cell content (import) | `/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/ig` `.match` | **UNFINISHED >20s** | **FE → single-session self-DoS** (importer's own tab); not cross-tenant |
| 12 | `apps/web/src/multitable/import/xlsx-mapping.ts:135` | sheet name | `/^'+|'+$/g` `.replace` | ratio 92, 3.2s @1e5 | **BOUNDED — not a finding**: `.slice(0,31)` before regex; FE anyway |
| 13 | `apps/web/.../automation-log-support-packet.ts:134`, `plugins/plugin-attendance/index.cjs:5858/:22616` | filename seed from `profile.id/source` | `/^-+|-+$/g` `.replace` | ratio 93, 3.2s @1e5 | bounded by profile-id length in practice; FE + plugin; UNVERIFIED; no fix |
| 14 | `apps/web/src/views/plm/plmFilterPresetUtils.ts:186` | filter-preset base64 tail | `/=+$/g` `.replace` | ratio 96, 3.2s @1e5 | **FE → single-session self-DoS**; bounded by preset content |

**Result: 1 live cross-tenant finding (formula user-supplied pattern), fixed on
branch as a PROPOSED candidate. 2 sites bounded-before-regex (not findings).
4 sites single-session FE self-DoS (lower severity, not cross-tenant). 3 sites
owner-review candidates (backend, ReDoS-shaped, reachability UNVERIFIED — no
speculative fix per "先探可达性再写紧迫性"). Remainder quadratic with
practically-bounded or unverified input.**

### 2.1 Full site lists for multi-site shapes
- `/\/+$/` `.replace` (12): DataSourceManager.ts:1252; db/migrations/zzzz20260710140000_add_files_storage_key.ts:77; integrations/dingtalk/client.ts:176,773; integrations/wecom/client.ts:84; services/ApprovalBreachNotifier.ts:287; services/AttendanceNotificationDeliveryWorker.ts:138; services/ai-provider-client.ts:257; services/dingtalk-todo-mirror-worker.ts:106; services/filesStorageKey.ts:37,64; apps/web/src/views/attendance/useAttendanceSetupReadiness.ts:45.
- `/^_+|_+$/g` `.replace` (9): directory/directory-sync.ts:756; middleware/attendance-production.ts:126; rbac/plugin-role-template.ts:26; routes/univer-meta.ts:5247; workflow/bpmnCompilePreview.ts:1039; apps/web/src/views/IntegrationWorkbenchView.vue:2534,2539; apps/web/src/views/attendance/attendanceCode.ts:17; plugins/plugin-attendance/index.cjs:1044.

## 3. The live finding — user-supplied regex in the formula engine

### 3.1 Mechanism
`REGEXMATCH(text, pattern)`, `REGEXEXTRACT`, `REGEXREPLACE` compile the
caller-authored `pattern` string into `new RegExp(String(pattern))`
(`formula/engine.ts:330/333/336`). `SUBSTITUTE(text, old, new)` compiled `old`
into `new RegExp(String(old), 'g')` (`:183`). A nested-quantifier pattern such as
`^(a+)+$` (7 characters) is exponential in the subject length; because JS regex
runs synchronously on the main thread, it blocks the event loop for **every**
concurrent request, across all tenants.

### 3.2 Two reachable paths (both CONFIRMED via the real code, not a re-implementation)
- **Dry-run (admin-triggered, one-shot):** `POST /sheets/:sheetId/formula/dry-run`
  (`routes/univer-meta.ts:16398`) takes `expression` straight off `req.body` and
  calls `dryRunFormulaEngine.dryRun(...)` (`:452`, `:16523`). The three structural
  caps — `DRY_RUN_MAX_EXPRESSION_LEN=4000` (`:454`), `MAX_PAREN_DEPTH=32` (`:456`),
  `MAX_REFERENCED_FIELDS=64` (`:455`) — **all pass** for a 58-char attack
  expression (measured, § verification). Gated by `canManageFields`.
- **Stored (any-user trigger, persistent):** a formula field's
  `property.expression` is validated only as `z.record(z.unknown())` on field
  create/update (`routes/univer-meta.ts:13471`, `:13842`) — **no length, depth,
  or content cap, and the dry-run caps do not apply here.** Once stored, every
  record write recomputes it via `recalculateFormulaFields` → `recalculateRecord­FromData` → `evaluateField` (`multitable/formula-engine.ts:339`), so an ordinary
  user with no field-management rights pays the cost on each write. This is the
  more severe variant: unbounded stored pattern, lower-privileged trigger.

### 3.3 Candidate fix (PROPOSED — 2 commits, one per site)
- **`SUBSTITUTE` → literal replacement** (`substituteLiteral`, split/join, O(n)).
  This both fixes a spec bug (Excel/Sheets SUBSTITUTE is literal, not regex) and
  removes the vector — arg-2 never reaches a regex engine. Complete fix for this
  function.
- **`REGEX*` → `assessUserPattern` guard**: reject statically-catastrophic
  patterns (nested unbounded quantifier) and over-length patterns; bound the
  subject length (`USER_REGEX_MAX_SUBJECT_LEN=5000`) for the O(n²) global-scan
  case. **PARTIAL**: a static detector cannot catch alternation-overlap ReDoS
  (`(a|a)*`). The complete fix is a linear-time engine (RE2) or a step budget —
  an owner/dependency decision. Both REGEX* and SUBSTITUTE changes alter an
  observable behaviour of the "frozen" formula core, so both are PROPOSED.

### 3.4 Owner decisions
1. Whether to land the SUBSTITUTE literal-semantics change (behaviour change, but
   toward spec-correctness).
2. Which REGEX* strategy: the partial static guard here, RE2, a step budget, or
   static rejection of all non-trivial user patterns.
3. Whether to add a length/depth cap on `property.expression` at field write
   (the stored path), mirroring the dry-run caps.
4. Disposition of the 3 owner-review candidates (rows 6, 8, 9) — confirm/deny
   reachability, then fix under the same pattern if reachable.

## 4. Seams (file:line)
- `packages/core-backend/src/formula/engine.ts:183,330,333,336` — the four sinks.
- `packages/core-backend/src/formula/regex-safety.ts` — new helper (candidate).
- `packages/core-backend/src/routes/univer-meta.ts:452,454-456,13471,13842,16398,16523` — reachability + caps.
- `packages/core-backend/src/multitable/formula-engine.ts:96,155,339` — evaluateField / dryRun / recalc.
