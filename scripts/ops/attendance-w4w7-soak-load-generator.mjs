#!/usr/bin/env node
// @ts-nocheck
/**
 * Attendance #4556 — W4+W7 COMBINED-SOAK synthetic load accelerator
 * ============================================================================
 *
 * Status: committed ops tool, promoted essentially as-is from the adversarially-reviewed
 * scratchpad draft described by the combined-soak runbook's §2A.6a (the route-field
 * verification below was performed for that draft and carries over verbatim). SHIPPING
 * THIS TOOL IS NOT RUNNING IT: executing it against any environment remains a separate,
 * per-instance owner act, per the #4556 ratification's 开工边界 ("对任何环境执行工具/CLI").
 * The sanctioned invocation path is action=soak-run of
 * .github/workflows/attendance-staging-window-runner.yml (owner-dispatched), which runs it
 * IN the staging backend container against the in-container BASE_URL. This header
 * authorizes nothing.
 *
 * PURPOSE
 * -------
 * Drives real traffic through the REAL live-punch route (POST /api/attendance/punch) over
 * HTTP, against a configurable BASE_URL, to accumulate the count-based evidence
 * SOAK-ACCEPTANCE-LEDGER-TEMPLATE-20260815.md §1 (C1-C4) needs — never a direct DB write.
 * Direct writes would bypass the DML-inventory collector and calculation-lineage triggers
 * this whole soak exists to exercise (runbook §2A.6 preamble).
 *
 * VERIFIED AGAINST THE ACTUAL ROUTE (2026-08-15, read directly, cited file:line — none of
 * the fields below were invented; this is the field-verification the task required):
 *
 *   - Route path + method: POST /api/attendance/punch
 *       plugins/plugin-attendance/index.cjs:29198 (route registration)
 *       packages/core-backend/tests/integration/attendance-plugin.test.ts:567 (real HTTP call)
 *       packages/openapi/dist-sdk/index.d.ts:941 (published contract)
 *   - Accepted body shape, `punchSchema` (plugins/plugin-attendance/index.cjs:25914-25931),
 *     NOT `.strict()` — unknown top-level fields are silently STRIPPED, not rejected, so a
 *     tag field invented here would parse but never reach the server:
 *       eventType:    'check_in' | 'check_out'   (required)
 *       operationId:  string (uuid, optional)     — IDEMPOTENCY KEY, not a tag (see below)
 *       occurredAt:   string (optional; ISO datetime)
 *       occurred_at:  string (optional; snake_case alias, same semantics)
 *       timezone:     string (optional)
 *       source:       string (optional)           — see TAGGING DECISION below
 *       location:     record<string, unknown> (optional)
 *       meta:         record<string, unknown> (optional) — NOT an inert bag, see below
 *       orgId:        string (optional)
 *       photoFileId:  string (optional)
 *   - Auth: `Authorization: Bearer <token>` header, decoded server-side into `req.user`
 *     (packages/core-backend/tests/integration/attendance-plugin.test.ts:570 and 30+ other
 *     call sites in the same file). This script never mints a token — every token is
 *     supplied pre-minted in the config file, per the task's own constraint and per this
 *     repo's standing rule ("prod token via login not minting").
 *   - orgId resolution precedence, `getOrgId` (plugins/plugin-attendance/index.cjs:6282-6290):
 *     `body.orgId ?? query.orgId ?? user.orgId ?? user.workspaceId ?? header['x-org-id'] ??
 *     DEFAULT_ORG_ID`. Body wins over the token's own org claim, and a missing/empty orgId
 *     SILENTLY falls back to a default org — this script therefore ALWAYS sends an explicit
 *     `orgId` in the body (never relies on the token) and hard-validates every configured
 *     orgId is present, non-empty, and (per §0.3 item 3's case-fold footgun) byte-exact
 *     lower-case before sending a single request.
 *   - Success response: `res.json({ ok: true, data: boundaryOutcome.response })`, implicit
 *     HTTP 200 (plugins/plugin-attendance/index.cjs:~29529). Error response:
 *     `{ ok: false, error: { code, message, ...details } }` with the HTTP status set per
 *     error kind (400/401/403/422/429/503/500) (index.cjs:29537-29556 and the thrown
 *     `HttpError`s inside `enforcePunchConstraints`, index.cjs:22248-22294).
 *
 * TAGGING DECISION — `source`, not a correlation-ID header, not an invented field
 * --------------------------------------------------------------------------------
 * The runbook's own §2A.6 step 3 flags a `[BUILD-TIME-VERIFY]`: "whether the live-punch HTTP
 * route accepts a caller-supplied correlation ID at all." This has now been checked directly
 * and the answer is NO for this route: `requestCorrelationId(req, operationId, kind)`
 * (index.cjs:32359-32366, which reads `req.correlationId` / `x-correlation-id` /
 * `x-request-id`) is only ever called on the OUTDOOR-APPROVAL request-boundary path
 * (index.cjs:29423), never on the live-punch call to `w4LiveScheduledBoundary.executeLivePunch`
 * (index.cjs:29501-29529, whose full argument list was read and contains no correlationId
 * param). The live-punch boundary derives its own correlation ID internally and
 * deterministically as `live-punch:${orgId}:${userId}:${workDate}`
 * (packages/core-backend/src/attendance/w4c2-live-scheduled-boundary.ts:1201) — not
 * client-settable. Per the runbook's own fallback instruction, tagging is therefore built on
 * the OTHER half of its step-3 design ("a closed synthetic-user-ID set") PLUS the `source`
 * field, which was independently verified safe and durable for this purpose:
 *
 *   1. `source` is persisted VERBATIM to `attendance_events.source`
 *      (INSERT INTO attendance_events ... source ..., index.cjs:22457-22474) — a real,
 *      queryable, durable column, not dropped anywhere between parse and write.
 *   2. `source`'s only behavioral branch anywhere in the punch pipeline is a single
 *      reserved-value check: `RESERVED_EVENT_SOURCES = new Set(['outdoor_approval'])`
 *      (index.cjs:131,136) — sending that literal string is rejected 422
 *      (`PUNCH_SOURCE_RESERVED`, index.cjs:29208-29212). Every OTHER string, including a
 *      distinctive synthetic tag, is treated identically to `'manual'`/`'mobile'` by the
 *      in/out merge policy, which only distinguishes "internal" vs. "the one outdoor
 *      constant" (`internalWinsOnIn`/`externalWinsOnOut`, index.cjs:19933-19935;
 *      packages/core-backend/src/attendance/w4c1-merge-policy.ts:15-17) — confirmed by
 *      reading that file directly, not inferred. A synthetic `source` value therefore
 *      exercises the exact same code path real "manual"/"mobile" traffic does; it does not
 *      silently detour into a different merge bucket.
 *   Net: this script tags every synthetic punch with `source: <SOAK_SOURCE_TAG>` (default
 *   `'synthetic_w4w7_soak_accelerator_v1'`) AND restricts all traffic to a closed,
 *   config-declared synthetic user-ID set (§2A.6 step 2) — two independent, durable,
 *   query-able signals, neither invented beyond a field the schema already accepts.
 *
 * `meta` IS NOT AN INERT BAG — do not stuff tag metadata into it. The route reads
 * `meta.outdoor` / `meta.outdoorPunch` (routes into the pending-outdoor-approval branch —
 * 202, ZERO attendance_events/attendance_records written, index.cjs:29411-29470),
 * `meta.note`, and `meta.location` (geofence input) (index.cjs:22262, 29418-29419). This
 * script sends `meta: null` unless the operator config explicitly supplies one, and never
 * writes `outdoor`/`outdoorPunch`/`note`/`location` keys into it.
 *
 * `operationId` IS AN IDEMPOTENCY KEY, NOT A TAG. Per its own schema comment
 * (index.cjs:25916-25919): "a response-loss retry with the same key and congruent payload
 * replays the stored response." This script therefore mints exactly ONE `randomUUID()` per
 * INTENDED punch (not per HTTP attempt) and reuses that same id across transport-level
 * retries (network error / timeout / 5xx) inside `sendPunchWithRetry`. Minting a fresh id per
 * attempt would risk a timed-out-but-server-committed punch being counted (or produced)
 * twice. `sendPunchWithRetry`'s own retry loop already returns exactly ONE classified outcome
 * per call (it never returns twice for the same intended punch), so the scheduler records at
 * most one tally increment per operationId structurally — no separate top-level dedup set is
 * needed within a single script run, and this file does not carry one (a prior draft of this
 * file did, and it was dead code: every scheduler iteration mints a fresh operationId, so a
 * membership check against ids minted in the same run could never hit).
 *
 * TIMEZONE — omitted from the request body unless explicitly configured, NOT defaulted to
 * UTC. The route's `resolveExplicitTimeZoneOrThrow(parsed.data.timezone, baseRule.timezone)`
 * lets an EXPLICIT `timezone` field OVERRIDE the org's own configured rule timezone. Sending
 * a blanket default (e.g. `'UTC'`) for every org would silently override org-specific
 * work-date attribution and could manufacture spurious cross-day / shadow-diff divergence on
 * any non-UTC org — exactly the kind of noise the compare window (§2's Soak-Days 2-6) exists
 * to measure honestly. This script's `timezone` config field is therefore used ONLY for its
 * own local bookkeeping (the punches-per-user-per-day calendar-day grouping, computed
 * client-side) and is sent in the request body ONLY when the config file explicitly sets one
 * — see `timezoneExplicit` / `timezoneToSend` below.
 *
 * ALTERNATION IS STRUCTURAL, NOT COSMETIC. `enforcePunchConstraints`'s
 * `minPunchIntervalMinutes` guard SHORT-CIRCUITS (returns early, allows the punch) whenever
 * the immediately-prior event's `event_type` differs from the incoming one
 * (index.cjs:22283-22285). Strict per-(org,user) check_in/check_out alternation therefore
 * structurally avoids `PUNCH_TOO_SOON` (429) for everything except a user's very FIRST
 * synthetic punch in a run, which can still collide with a pre-existing real/legacy punch of
 * the same type already in the DB for that user — this script treats that as an ordinary
 * incident (category `rate_backoff`) and lets the scheduler revisit later; it does not
 * hard-fail the run over it. A 429 on the FIRST attempt is informative: it means the DB's
 * real last event for that user already equals the type just sent, so the local alternation
 * tracker is updated exactly as a success would be (`lastEventType = eventType`) — NOT
 * flipped to the opposite — so the next scheduled attempt for that user correctly requests
 * the opposite type.
 *
 * WHAT THIS SCRIPT CANNOT SEE (named here, not silently assumed away, per this repo's own
 * "assertions must be checkable" discipline):
 *   - §2A.2's "clean punch" is a FOUR-PART DB-LEVEL PREDICATE (an `attendance_result_operations`
 *     row with entrypoint='live_punch' AND state='completed', whose joined
 *     `attendance_record_calculations` row has outcome='completed' AND
 *     shadow_diff_code IS NULL OR 'equal', deduped DISTINCT on operation_id — runbook §2A.2).
 *     No HTTP response can establish any of that. This script's own tally (HTTP 2xx +
 *     `{ok:true, data:<present>}`) is a same-run CROSS-CHECK that upper-bounds the true
 *     DB-level clean-punch count — never a substitute for the ledger's `Q1`-`Q4` queries.
 *     The final summary JSON says this explicitly (`countSemantics` field) so it cannot be
 *     read as a §2A ledger row's 实测 value by mistake.
 *   - Arm attribution (C4a W4-legacy-arm vs. C4b W7-group-arm) is a SERVER-SIDE POSTURE fact
 *     (`attendance_calculation_rollout_state.state` / `attendance_calculation_context_source_state.state`
 *     for the org). This script only knows what the config file DECLARED an org's posture to
 *     be — it never reads either table. Every arm count in stdout/summary is labeled
 *     `armAttributionSource: "config_declared"`.
 *   - §2A.4's six W7-2 diff codes and §3's 40P01/57P01 alarm conditions are DB/APM-level
 *     signals this script has no visibility into. §2A.6 step 7 ("halt on any §2A.4 code or
 *     §3 alarm firing") is therefore only PARTIALLY implemented here: this script halts on
 *     an HTTP-observable proxy (a run of consecutive non-clean responses, configurable
 *     threshold) but does NOT and CANNOT halt on a 40P01/57P01 or an off-roster shadow diff
 *     it cannot observe. This is a named gap, in the same voice the runbook itself uses for
 *     §0.2/§1.5's 【MECHANISM ABSENT】 items — not a claim that step 7 is fully satisfied.
 *   - W7-side traffic: per runbook §1.5/§2A.1, there is no W7 transition writer anywhere in
 *     the repository today, so no org can actually be in a mechanically-real
 *     `group_shadow`/`group_eligible`/`group_authoritative` posture yet. An entry configured
 *     with `posture: "both_machines_group_arm"` still sends real, valid live-punch traffic
 *     (useful for exercising the W4 side and for being ready the moment W7-2/W7-3 land), but
 *     its `w7_group_arm` count is a LABEL ONLY until that mechanism exists — this script
 *     prints a one-time warning per such entry and never claims C4b is satisfied by its own
 *     tally.
 *
 * SAFETY / NO-DESTRUCTIVE-OPS DISCIPLINE
 * ---------------------------------------
 *   - Only ever issues `POST /api/attendance/punch` HTTP requests. Never touches a database,
 *     never mutates process env, never writes anywhere except the one `--output` JSON summary
 *     file (default: alongside this script) and stdout/stderr.
 *   - Defaults to DRY RUN. Sending real traffic requires ALL THREE of:
 *       (a) `--execute` (or `SOAK_EXECUTE=true`)
 *       (b) `--confirm I_UNDERSTAND_THIS_DRIVES_SYNTHETIC_STAGING_TRAFFIC_ONLY` (exact match,
 *           mirroring the W4C-5 CLI's own confirmation-token shape,
 *           scripts/ops/attendance-w4c5-rollout-transition.ts)
 *       (c) `--confirm-org-ids <comma-separated>` whose SET exactly equals the set of orgIds
 *           found in the config file — a second, independent guard against a config-authoring
 *           mistake (e.g. a pasted production org id) silently going live, on top of (a)/(b).
 *   - Every configured orgId is validated non-empty and, if UUID-shaped, byte-exact
 *     lower-case (runbook §0.3 item 3 — an upper-cased org id silently resolves to an `off`/
 *     no-op posture with no diagnostic anywhere; this script refuses to start rather than
 *     silently drive traffic the server will silently no-op).
 *   - Every `userId` in every config entry MUST have a corresponding pre-minted token in that
 *     entry's `tokenOrCreds` map. There is no "one shared token for the whole org" fallback —
 *     identity comes from the JWT subject the token decodes to, so a shared token would
 *     collapse every punch onto one user and silently violate the closed-user-set design
 *     (§2A.6 step 2). A missing token aborts config loading entirely (fail loudly, not
 *     partially).
 *   - No login flow, no token minting, no `/api/auth/dev-token` call (that endpoint exists
 *     only in this repo's own test harness, packages/core-backend/tests/integration/
 *     attendance-plugin.test.ts:561-562, and is explicitly out of scope per the task).
 *
 * CONFIG FILE SHAPE (JSON, path via --config or SOAK_CONFIG_FILE):
 * {
 *   "baseUrl": "https://staging.example.internal",      // optional; --base-url / BASE_URL win
 *   "timezone": "Asia/Shanghai",                         // optional; default "UTC"
 *   "sourceTag": "synthetic_w4w7_soak_accelerator_v1",   // optional; see TAGGING DECISION
 *   "entries": [
 *     {
 *       "orgId": "00000000-0000-4000-8000-000000000001", // exact, lower-case, no wildcard
 *       "posture": "legacy_only",                         // legacy_only | w4_only_legacy_arm
 *                                                          //   | both_machines_group_arm
 *       "minCleanPunches": 20,                             // optional; defaults to --target-per-org
 *       "userIds": ["synth-user-1", "synth-user-2"],
 *       "tokenOrCreds": {
 *         "synth-user-1": "<pre-minted bearer token>",
 *         "synth-user-2": "<pre-minted bearer token>"
 *       }
 *     }
 *   ]
 * }
 * Three entries, one per posture, is what SOAK-ACCEPTANCE-LEDGER-TEMPLATE-20260815.md §1 (C3)
 * expects (M >= 3, one org each) — this script warns, but does not refuse to run, if fewer
 * than three distinct postures are present, since C3's own pass/fail judgment belongs to
 * whoever fills the ledger, not to this tool.
 *
 * USAGE (illustrative; 【OWNER】 to actually invoke with --execute against a real BASE_URL):
 *   node attendance-w4w7-soak-load-generator.mjs --config ./soak-config.json --base-url https://staging.example \
 *     --target-total 200 --target-per-org 20 --target-per-arm 50 \
 *     --rate-limit-per-sec 1 --punches-per-user-per-day 8 \
 *     --confirm I_UNDERSTAND_THIS_DRIVES_SYNTHETIC_STAGING_TRAFFIC_ONLY \
 *     --confirm-org-ids 00000000-0000-4000-8000-000000000001,... \
 *     --execute
 * Omit --execute (or any of the confirms) to dry-run: the scheduler and validation run in
 * full, no HTTP request is ever sent, and the summary reports `mode: "dry_run"`.
 */

import { randomUUID } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))

const RESERVED_EVENT_SOURCE = 'outdoor_approval' // index.cjs:131 — the ONLY reserved value
const CONFIRM_TOKEN_LITERAL = 'I_UNDERSTAND_THIS_DRIVES_SYNTHETIC_STAGING_TRAFFIC_ONLY'
const POSTURES = new Set(['legacy_only', 'w4_only_legacy_arm', 'both_machines_group_arm'])
const ARMS_BY_POSTURE = {
  legacy_only: [],
  w4_only_legacy_arm: ['w4_legacy_arm'],
  both_machines_group_arm: ['w4_legacy_arm', 'w7_group_arm'],
}

// -----------------------------------------------------------------------------------------
// CLI / env argument handling
// -----------------------------------------------------------------------------------------

function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (!arg.startsWith('--')) continue
    const eq = arg.indexOf('=')
    if (eq !== -1) {
      out[arg.slice(2, eq)] = arg.slice(eq + 1)
      continue
    }
    const key = arg.slice(2)
    const next = argv[i + 1]
    if (next === undefined || next.startsWith('--')) {
      out[key] = 'true' // boolean flag
    } else {
      out[key] = next
      i++
    }
  }
  return out
}

function readOpt(args, flag, envName, fallback) {
  if (Object.prototype.hasOwnProperty.call(args, flag)) return args[flag]
  if (envName && process.env[envName] !== undefined) return process.env[envName]
  return fallback
}

function readNumberOpt(args, flag, envName, fallback) {
  const raw = readOpt(args, flag, envName, undefined)
  if (raw === undefined) return fallback
  const n = Number(raw)
  if (!Number.isFinite(n)) {
    throw new ConfigError(`--${flag} must be a finite number, got ${JSON.stringify(raw)}`)
  }
  return n
}

function readBoolOpt(args, flag, envName, fallback) {
  const raw = readOpt(args, flag, envName, undefined)
  if (raw === undefined) return fallback
  const normalized = String(raw).trim().toLowerCase()
  if (['true', '1', 'yes'].includes(normalized)) return true
  if (['false', '0', 'no'].includes(normalized)) return false
  throw new ConfigError(`--${flag} must be a boolean-ish value, got ${JSON.stringify(raw)}`)
}

class ConfigError extends Error {}

function buildOptions(argv) {
  const args = parseArgs(argv)

  if (args.help === 'true' || args.h === 'true') {
    printHelpAndExit()
  }

  const configPath = readOpt(args, 'config', 'SOAK_CONFIG_FILE', undefined)
  if (!configPath) {
    throw new ConfigError('A config file is required: --config <path> or SOAK_CONFIG_FILE=<path>')
  }

  const opts = {
    configPath: path.resolve(process.cwd(), configPath),
    baseUrlOverride: readOpt(args, 'base-url', 'BASE_URL', undefined),
    execute: readBoolOpt(args, 'execute', 'SOAK_EXECUTE', false),
    confirmToken: readOpt(args, 'confirm', 'SOAK_CONFIRM', ''),
    confirmOrgIds: readOpt(args, 'confirm-org-ids', 'SOAK_CONFIRM_ORG_IDS', ''),
    rateLimitPerSec: readNumberOpt(args, 'rate-limit-per-sec', 'SOAK_RATE_LIMIT_PER_SEC', 1),
    // Default 8, per the runbook's ruled parameter row (§2A.7 recommended row, in effect per
    // §2A.9's default+veto record): 10 users/org x 3 orgs x 8 punches/user/day = 240/day, which
    // clears the ruled count criteria (N>=200 total, >=20/org, >=50/arm) inside one soak day.
    // 8/user/day = check_in/check_out pairs across 4 sessions — still a real usage shape.
    punchesPerUserPerDay: readNumberOpt(args, 'punches-per-user-per-day', 'SOAK_PUNCHES_PER_USER_PER_DAY', 8),
    targetTotal: readNumberOpt(args, 'target-total', 'SOAK_TARGET_TOTAL', 200), // §2A.3 C1
    targetPerOrg: readNumberOpt(args, 'target-per-org', 'SOAK_TARGET_PER_ORG', 20), // §2A.3 C2
    targetPerArm: readNumberOpt(args, 'target-per-arm', 'SOAK_TARGET_PER_ARM', 50), // §2A.3 C4
    durationMinutes: readNumberOpt(args, 'duration-minutes', 'SOAK_DURATION_MINUTES', undefined),
    minSecondsBetweenPunchesPerUser: readNumberOpt(
      args, 'min-seconds-between-punches-per-user', 'SOAK_MIN_SECONDS_BETWEEN_PUNCHES_PER_USER', 60
    ),
    maxConsecutiveIncidents: readNumberOpt(args, 'max-consecutive-incidents', 'SOAK_MAX_CONSECUTIVE_INCIDENTS', 5),
    requestTimeoutMs: readNumberOpt(args, 'request-timeout-ms', 'SOAK_REQUEST_TIMEOUT_MS', 10_000),
    stallTimeoutMinutes: readNumberOpt(args, 'stall-timeout-minutes', 'SOAK_STALL_TIMEOUT_MINUTES', 1560), // 26h: longer than one calendar-day daily-cap reset so it never false-fires on expected multi-day pacing
    tallyIntervalPunches: readNumberOpt(args, 'tally-interval', 'SOAK_TALLY_INTERVAL', 10),
    outputPath: readOpt(
      args, 'output', 'SOAK_OUTPUT_FILE',
      path.join(SCRIPT_DIR, `soak-load-generator-summary-${nowStampForFilename()}.json`)
    ),
    maxAttemptsSafetyMultiplier: readNumberOpt(args, 'max-attempts-multiplier', 'SOAK_MAX_ATTEMPTS_MULTIPLIER', 5),
  }

  if (opts.rateLimitPerSec <= 0 || opts.rateLimitPerSec > 1) {
    // Requirement: "rate limit (default ≤1 req/sec global)". A caller can lower it, never raise it
    // past 1 without editing this guard explicitly — this is a deliberate ceiling, not a default.
    throw new ConfigError(
      `--rate-limit-per-sec must be in (0, 1] per the runbook's default global ceiling; got ${opts.rateLimitPerSec}. `
      + 'Raising this ceiling is a load-test decision, not this accelerator\'s job (§2A.6 step 6) — edit the script deliberately if truly needed.'
    )
  }
  if (opts.targetTotal <= 0) throw new ConfigError('--target-total must be > 0')
  if (opts.targetPerOrg <= 0) throw new ConfigError('--target-per-org must be > 0')
  if (opts.punchesPerUserPerDay <= 0) throw new ConfigError('--punches-per-user-per-day must be > 0')
  if (opts.minSecondsBetweenPunchesPerUser < 0) throw new ConfigError('--min-seconds-between-punches-per-user must be >= 0')

  return opts
}

function nowStampForFilename() {
  return new Date().toISOString().replace(/[:.]/g, '-')
}

function printHelpAndExit() {
  process.stdout.write(`Attendance #4556 W4+W7 combined-soak synthetic load accelerator

Usage:
  node attendance-w4w7-soak-load-generator.mjs --config <path> [options]

Required:
  --config <path>                     JSON config file (see file header for shape)

Common options (env var fallback in parentheses):
  --base-url <url>                    (BASE_URL)
  --execute                           Actually send HTTP requests (SOAK_EXECUTE=true). Default: dry-run.
  --confirm <token>                   Must equal ${CONFIRM_TOKEN_LITERAL} to execute (SOAK_CONFIRM)
  --confirm-org-ids <csv>             Must set-equal config org ids to execute (SOAK_CONFIRM_ORG_IDS)
  --rate-limit-per-sec <n>            Global request rate ceiling, (0,1]. Default 1. (SOAK_RATE_LIMIT_PER_SEC)
  --punches-per-user-per-day <n>      Default 8 (ruled §2A.7/§2A.9 row). (SOAK_PUNCHES_PER_USER_PER_DAY)
  --target-total <n>                  §2A.3 C1. Default 200. (SOAK_TARGET_TOTAL)
  --target-per-org <n>                §2A.3 C2. Default 20. (SOAK_TARGET_PER_ORG)
  --target-per-arm <n>                §2A.3 C4a/C4b. Default 50. (SOAK_TARGET_PER_ARM)
  --duration-minutes <n>              Optional wall-clock cap in addition to targets. (SOAK_DURATION_MINUTES)
  --min-seconds-between-punches-per-user <n>  Default 60. (SOAK_MIN_SECONDS_BETWEEN_PUNCHES_PER_USER)
  --max-consecutive-incidents <n>     HTTP-observable stop-condition proxy. Default 5. (SOAK_MAX_CONSECUTIVE_INCIDENTS)
  --stall-timeout-minutes <n>         Halt if zero attempts happen for this long. Default 1560 (26h). (SOAK_STALL_TIMEOUT_MINUTES)
  --output <path>                     Final JSON summary path. (SOAK_OUTPUT_FILE)
  --help                              This message.

Note: occurredAt is never sent — every punch uses the server's own clock. Backdating is not
implemented in this draft (a bounded, config-supplied offset would be needed to avoid the
route's own FUTURE_PUNCH_NOT_ALLOWED / WORK_DATE_ATTRIBUTION_AMBIGUOUS guards; left as a named
gap rather than shipped half-working).

This script defaults to DRY RUN. See the file header "SAFETY / NO-DESTRUCTIVE-OPS DISCIPLINE"
for the three conditions required to send real traffic, and 【OWNER】 markers throughout.
`)
  process.exit(0)
}

// -----------------------------------------------------------------------------------------
// Config loading + validation (fail loudly, never partially)
// -----------------------------------------------------------------------------------------

const UUID_LIKE_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function validateOrgIdCaseFold(orgId, where) {
  // runbook §0.3 item 3: entries are trimmed but NOT case-folded server-side; an org id
  // pasted in upper case silently resolves to an off/no-op posture with no diagnostic. Refuse
  // to start rather than silently drive traffic the server would silently swallow.
  if (UUID_LIKE_RE.test(orgId) && orgId !== orgId.toLowerCase()) {
    throw new ConfigError(
      `orgId ${JSON.stringify(orgId)} (${where}) is UUID-shaped but not byte-exact lower-case. `
      + 'Per §0.3 item 3 this can silently resolve to an off/no-op posture server-side with no '
      + 'diagnostic. Fix the config to the exact lower-case value before running.'
    )
  }
}

async function loadConfig(opts) {
  let raw
  try {
    raw = await readFile(opts.configPath, 'utf8')
  } catch (err) {
    throw new ConfigError(`Could not read config file ${opts.configPath}: ${err.message}`)
  }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    throw new ConfigError(`Config file ${opts.configPath} is not valid JSON: ${err.message}`)
  }

  if (!Array.isArray(parsed.entries) || parsed.entries.length === 0) {
    throw new ConfigError('Config must have a non-empty top-level "entries" array.')
  }

  const baseUrl = opts.baseUrlOverride || parsed.baseUrl
  if (!baseUrl || typeof baseUrl !== 'string') {
    throw new ConfigError('No baseUrl: pass --base-url / BASE_URL, or set "baseUrl" in the config file.')
  }
  let baseUrlNormalized
  try {
    baseUrlNormalized = new URL(baseUrl).toString().replace(/\/$/, '')
  } catch {
    throw new ConfigError(`baseUrl ${JSON.stringify(baseUrl)} is not a valid URL.`)
  }

  // `timezoneExplicit`: only set when the config file actually declares one. Used for the
  // request body's `timezone` field (sent ONLY when explicit — see the file header's TIMEZONE
  // note: an explicit value overrides the org's own rule timezone server-side).
  // `timezone` (bookkeeping): always resolved (falls back to UTC), used ONLY for this
  // script's own local punches-per-user-per-day calendar-day grouping — never sent to the
  // server.
  const timezoneExplicit = typeof parsed.timezone === 'string' && parsed.timezone.trim() ? parsed.timezone.trim() : null
  const timezone = timezoneExplicit || 'UTC'
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone })
  } catch {
    throw new ConfigError(`timezone ${JSON.stringify(timezone)} is not a recognized IANA timezone.`)
  }

  const sourceTag = typeof parsed.sourceTag === 'string' && parsed.sourceTag.trim()
    ? parsed.sourceTag.trim()
    : 'synthetic_w4w7_soak_accelerator_v1'
  if (sourceTag === RESERVED_EVENT_SOURCE) {
    throw new ConfigError(
      `sourceTag cannot be the reserved value ${JSON.stringify(RESERVED_EVENT_SOURCE)} `
      + '(index.cjs:131,136 — server rejects it 422 PUNCH_SOURCE_RESERVED).'
    )
  }

  const seenOrgIds = new Set()
  const entries = parsed.entries.map((rawEntry, idx) => {
    const where = `entries[${idx}]`
    if (typeof rawEntry.orgId !== 'string' || !rawEntry.orgId.trim()) {
      throw new ConfigError(`${where}.orgId must be a non-empty string.`)
    }
    const orgId = rawEntry.orgId.trim()
    validateOrgIdCaseFold(orgId, where)
    if (seenOrgIds.has(orgId)) {
      throw new ConfigError(`${where}: duplicate orgId ${JSON.stringify(orgId)} — one entry per org.`)
    }
    seenOrgIds.add(orgId)

    if (!POSTURES.has(rawEntry.posture)) {
      throw new ConfigError(
        `${where}.posture must be one of ${[...POSTURES].join(', ')}; got ${JSON.stringify(rawEntry.posture)}.`
      )
    }

    if (!Array.isArray(rawEntry.userIds) || rawEntry.userIds.length === 0) {
      throw new ConfigError(`${where}.userIds must be a non-empty array of strings.`)
    }
    const userIds = rawEntry.userIds.map((u, uIdx) => {
      if (typeof u !== 'string' || !u.trim()) {
        throw new ConfigError(`${where}.userIds[${uIdx}] must be a non-empty string.`)
      }
      return u.trim()
    })
    const uniqueUserIds = new Set(userIds)
    if (uniqueUserIds.size !== userIds.length) {
      throw new ConfigError(`${where}.userIds contains duplicates — the closed user set must be distinct (§2A.6 step 2).`)
    }

    const tokenOrCreds = rawEntry.tokenOrCreds
    if (!tokenOrCreds || typeof tokenOrCreds !== 'object' || Array.isArray(tokenOrCreds)) {
      throw new ConfigError(
        `${where}.tokenOrCreds must be an object mapping each userId to its pre-minted bearer token. `
        + 'A single shared token for the whole org is not supported: identity comes from the JWT '
        + 'subject the token decodes to, so a shared token would collapse every punch onto one user.'
      )
    }
    for (const userId of userIds) {
      const token = tokenOrCreds[userId]
      if (typeof token !== 'string' || !token.trim()) {
        throw new ConfigError(
          `${where}.tokenOrCreds is missing a non-empty token for userId ${JSON.stringify(userId)}. `
          + 'Every configured user must have its own pre-minted bearer token — failing loudly rather '
          + 'than starting a partial run.'
        )
      }
    }

    const minCleanPunches = Number.isFinite(rawEntry.minCleanPunches) && rawEntry.minCleanPunches > 0
      ? rawEntry.minCleanPunches
      : opts.targetPerOrg

    const arms = ARMS_BY_POSTURE[rawEntry.posture]
    if (rawEntry.posture === 'both_machines_group_arm') {
      // eslint-disable-next-line no-console
      console.warn(
        `[config] ${where} (orgId=${orgId}) is posture="both_machines_group_arm". Per runbook §1.5/§2A.1, `
        + 'no W7 transition writer exists anywhere in the repo today, so this org cannot mechanically be '
        + 'in a real group_shadow/group_eligible/group_authoritative state yet. This script will still '
        + 'send valid live-punch traffic to it (useful for the W4 side, and ready for W7-2/W7-3), but its '
        + 'w7_group_arm count is a CONFIG-DECLARED LABEL ONLY — see armAttributionSource in the summary.'
      )
    }

    return {
      orgId,
      posture: rawEntry.posture,
      arms,
      minCleanPunches,
      userIds,
      tokenOrCreds,
    }
  })

  const postures = new Set(entries.map((e) => e.posture))
  if (postures.size < 3) {
    // eslint-disable-next-line no-console
    console.warn(
      `[config] Only ${postures.size} distinct posture(s) present (${[...postures].join(', ')}). `
      + 'SOAK-ACCEPTANCE-LEDGER-TEMPLATE-20260815.md §1 C3 expects M >= 3, one org each of '
      + 'legacy_only / w4_only_legacy_arm / both_machines_group_arm. Not a hard stop here — C3\'s own '
      + 'pass/fail belongs to whoever fills the ledger — but this run alone will not satisfy C3.'
    )
  }

  return { baseUrl: baseUrlNormalized, timezone, timezoneExplicit, sourceTag, entries }
}

function validateExecutionConfirmation(opts, config) {
  if (!opts.execute) return { willExecute: false, reason: '--execute not set (dry-run)' }
  if (opts.confirmToken !== CONFIRM_TOKEN_LITERAL) {
    throw new ConfigError(
      `--execute requires --confirm ${CONFIRM_TOKEN_LITERAL} (exact match); got ${JSON.stringify(opts.confirmToken)}.`
    )
  }
  const confirmedOrgIds = new Set(
    opts.confirmOrgIds.split(',').map((s) => s.trim()).filter(Boolean)
  )
  const configuredOrgIds = new Set(config.entries.map((e) => e.orgId))
  const missing = [...configuredOrgIds].filter((id) => !confirmedOrgIds.has(id))
  const extra = [...confirmedOrgIds].filter((id) => !configuredOrgIds.has(id))
  if (missing.length > 0 || extra.length > 0) {
    throw new ConfigError(
      '--confirm-org-ids must set-equal the orgIds in the config file exactly (no wildcard, no '
      + `subset, no extras). Missing from --confirm-org-ids: [${missing.join(', ')}]. `
      + `Present in --confirm-org-ids but not in config: [${extra.join(', ')}].`
    )
  }
  return { willExecute: true, reason: 'execute + confirm token + confirm-org-ids all matched' }
}

// -----------------------------------------------------------------------------------------
// Rate limiter (global, ≤1 req/sec by default — requirement + §2A.6 step 6)
// -----------------------------------------------------------------------------------------

function createGlobalRateLimiter(ratePerSec) {
  const minIntervalMs = 1000 / ratePerSec
  let lastAt = 0
  return async function throttle() {
    const now = Date.now()
    const elapsed = now - lastAt
    if (elapsed < minIntervalMs) {
      await sleep(minIntervalMs - elapsed)
    }
    lastAt = Date.now()
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function workDateInTimezone(date, timezone) {
  // YYYY-MM-DD in the configured timezone — used only for this script's own daily-cap
  // bookkeeping (punchesPerUserPerDay), never sent to the server as an authoritative work date.
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(date)
  const map = Object.fromEntries(parts.map((p) => [p.type, p.value]))
  return `${map.year}-${map.month}-${map.day}`
}

// -----------------------------------------------------------------------------------------
// HTTP punch call
// -----------------------------------------------------------------------------------------

function classifyResponse(status, bodyText) {
  let parsedBody = null
  let parseError = null
  if (bodyText) {
    try {
      parsedBody = JSON.parse(bodyText)
    } catch (err) {
      parseError = err.message
    }
  }

  const is2xx = status >= 200 && status < 300
  // "expected shape" for a clean punch, per this script's own HTTP-level definition (NOT the
  // §2A.2 DB-level predicate — see file header): ok:true and a present `data` payload.
  const looksClean = is2xx && parsedBody && parsedBody.ok === true && parsedBody.data !== undefined && parsedBody.data !== null

  let category
  if (looksClean) {
    category = 'clean'
  } else if (parseError) {
    category = 'unexpected_shape'
  } else if (status === 429) {
    category = 'rate_backoff'
  } else if (status >= 500) {
    category = 'server_error'
  } else if (status >= 400) {
    category = 'client_rejected'
  } else if (is2xx) {
    category = 'unexpected_shape' // 2xx but not {ok:true,data:present} — still worth a look
  } else {
    category = 'unexpected_status'
  }

  return {
    category,
    status,
    errorCode: parsedBody && parsedBody.error ? parsedBody.error.code : null,
    errorMessage: parsedBody && parsedBody.error ? parsedBody.error.message : parseError,
  }
}

async function sendPunchWithRetry({ baseUrl, entry, userId, token, eventType, operationId, opts, throttle }) {
  const body = {
    eventType,
    operationId, // idempotency key — same value reused across the retries below
    source: opts.sourceTagResolved,
    // meta intentionally omitted (null) — see "meta IS NOT AN INERT BAG" in the file header.
    orgId: entry.orgId, // always explicit — never rely on the token's own org claim (getOrgId precedence)
    // occurredAt intentionally omitted — server clock always (no backdate support in this draft).
  }
  if (opts.timezoneToSend) {
    // Only sent when the config file explicitly declared a timezone — see the file header's
    // TIMEZONE note. An explicit value overrides the org's own rule timezone server-side.
    body.timezone = opts.timezoneToSend
  }

  const url = `${baseUrl}/api/attendance/punch`
  const maxAttempts = 3 // 1 initial + 2 retries, SAME operationId each time (idempotent replay)
  let lastResult = null

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    // Every attempt — including transport-level retries, not just the first — passes through
    // the SAME global limiter. Without this, a 5xx/timeout could emit up to `maxAttempts`
    // requests inside a single throttle window, silently violating the "≤1 req/sec global"
    // requirement on exactly the runs where the server is already struggling.
    await throttle()
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), opts.requestTimeoutMs)
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      })
      const text = await res.text()
      clearTimeout(timer)
      const classified = classifyResponse(res.status, text)
      lastResult = { ...classified, attempt, networkError: null }
      if (classified.category === 'clean') return lastResult
      if (classified.category === 'server_error') {
        // Retry once more with the SAME operationId — either replays the stored response
        // (safe) or performs the operation exactly once more under the same idempotency key.
        continue
      }
      // Any other non-clean classification (client_rejected, rate_backoff, unexpected_shape,
      // unexpected_status) is NOT retried automatically — retrying a validation rejection
      // blindly would mask a real config problem rather than surface it.
      return lastResult
    } catch (err) {
      clearTimeout(timer)
      lastResult = {
        category: 'network_error',
        status: null,
        errorCode: err.name === 'AbortError' ? 'CLIENT_TIMEOUT' : 'NETWORK_ERROR',
        errorMessage: err.message,
        attempt,
        networkError: err.message,
      }
      // retry with same operationId
    }
  }
  return lastResult
}

// -----------------------------------------------------------------------------------------
// Scheduler
// -----------------------------------------------------------------------------------------

function buildUserPool(config) {
  const pool = []
  for (const entry of config.entries) {
    for (const userId of entry.userIds) {
      pool.push({
        entry,
        userId,
        token: entry.tokenOrCreds[userId],
        lastPunchAt: 0,
        lastEventType: null, // null => first punch is check_in
        dailyCounts: new Map(), // workDate(tz) -> count
      })
    }
  }
  return pool
}

function nextEventType(userState) {
  if (userState.lastEventType === 'check_in') return 'check_out'
  return 'check_in'
}

function userEligible(userState, opts, nowMs, timezone) {
  const sinceLast = (nowMs - userState.lastPunchAt) / 1000
  if (userState.lastPunchAt !== 0 && sinceLast < opts.minSecondsBetweenPunchesPerUser) return false
  const today = workDateInTimezone(new Date(nowMs), timezone)
  const countToday = userState.dailyCounts.get(today) || 0
  if (countToday >= opts.punchesPerUserPerDay) return false
  return true
}

const KNOWN_ARMS = ['w4_legacy_arm', 'w7_group_arm']

function orgArmCounts(tally, orgId) {
  return tally.perOrg[orgId] || { clean: 0, incidents: 0 }
}

function armTotalClean(tally, armName) {
  return tally.perArm[armName] ? tally.perArm[armName].clean : 0
}

function orgNeedsMorePunches(tally, entry, opts) {
  // An org still has something to contribute if ANY of: its own minimum isn't met yet, the
  // global total isn't met yet, or any arm IT declares hasn't met the per-arm target yet.
  // Skipping on org-minimum+total alone (an earlier draft's bug) could permanently strand an
  // arm target that only this org's traffic can advance, deadlocking the scheduler forever.
  if (orgArmCounts(tally, entry.orgId).clean < entry.minCleanPunches) return true
  if (tally.totalClean < opts.targetTotal) return true
  if (entry.arms.some((arm) => armTotalClean(tally, arm) < opts.targetPerArm)) return true
  return false
}

function stopConditionsMet(tally, config, opts) {
  if (tally.totalClean < opts.targetTotal) return false
  for (const entry of config.entries) {
    if (orgArmCounts(tally, entry.orgId).clean < entry.minCleanPunches) return false
  }
  const armsInPlay = new Set(config.entries.flatMap((e) => e.arms))
  for (const arm of armsInPlay) {
    if (armTotalClean(tally, arm) < opts.targetPerArm) return false
  }
  return true
}

function newTally(config) {
  const armsInPlay = new Set(config.entries.flatMap((e) => e.arms))
  const perArm = {}
  for (const arm of KNOWN_ARMS) {
    perArm[arm] = {
      clean: 0,
      incidents: 0,
      applicable: armsInPlay.has(arm),
      // §2A.1: no W7 transition writer exists today, so a config with no entry declaring
      // w7_group_arm is the EXPECTED state, not a gap in this run — the ledger template's own
      // C4b row says to record this precondition status explicitly rather than leave it blank.
      reason: armsInPlay.has(arm) ? null : (arm === 'w7_group_arm' ? '§2A.1 mechanism precondition not cleared' : 'no entry declared this arm'),
    }
  }
  return {
    totalAttempts: 0,
    totalClean: 0,
    totalIncidents: 0,
    perOrg: {}, // orgId -> {clean, incidents}
    perArm, // armName -> {clean, incidents, applicable, reason} — always both KNOWN_ARMS keys, never sparse
    perCategory: {}, // category -> count
    startedAt: new Date().toISOString(),
  }
}

function recordOutcome(tally, entry, result) {
  tally.totalAttempts++
  tally.perCategory[result.category] = (tally.perCategory[result.category] || 0) + 1

  if (!tally.perOrg[entry.orgId]) tally.perOrg[entry.orgId] = { clean: 0, incidents: 0 }

  if (result.category === 'clean') {
    tally.totalClean++
    tally.perOrg[entry.orgId].clean++
    for (const arm of entry.arms) tally.perArm[arm].clean++
  } else {
    tally.totalIncidents++
    tally.perOrg[entry.orgId].incidents++
    for (const arm of entry.arms) tally.perArm[arm].incidents++
  }
}

function printTally(tally, opts, config) {
  const lines = []
  lines.push(
    `[tally] attempts=${tally.totalAttempts} clean=${tally.totalClean}/${opts.targetTotal} `
    + `incidents=${tally.totalIncidents}`
  )
  for (const entry of config.entries) {
    const c = orgArmCounts(tally, entry.orgId)
    lines.push(`  org=${entry.orgId} posture=${entry.posture} clean=${c.clean}/${entry.minCleanPunches} incidents=${c.incidents}`)
  }
  for (const arm of KNOWN_ARMS) {
    const a = tally.perArm[arm]
    const applicability = a.applicable ? '' : ` [NOT APPLICABLE — ${a.reason}]`
    lines.push(`  arm=${arm} (armAttributionSource=config_declared) clean=${a.clean}/${opts.targetPerArm} incidents=${a.incidents}${applicability}`)
  }
  // eslint-disable-next-line no-console
  console.log(lines.join('\n'))
}

/**
 * Upfront reachability check, per the "silently unreachable config" failure mode: with the
 * configured punchesPerUserPerDay cap, how many calendar days would the BEST CASE (zero
 * incidents) take to reach targetTotal / each org's minCleanPunches? If an explicit
 * --duration-minutes was also given and it's provably shorter than that best case, the config
 * is self-contradictory — refuse before sending a single request. If no duration was given,
 * warn loudly (a multi-day run is not itself wrong — §2 of the runbook is inherently
 * multi-day — but the operator should see the implied day count, not discover it by watching
 * an apparently-stalled process).
 */
function assessFeasibility(config, opts) {
  const totalUsers = config.entries.reduce((n, e) => n + e.userIds.length, 0)
  const totalDailyCapacity = totalUsers * opts.punchesPerUserPerDay
  const totalDaysNeeded = Math.ceil(opts.targetTotal / totalDailyCapacity)

  const perOrgDays = config.entries.map((e) => ({
    orgId: e.orgId,
    daysNeeded: Math.ceil(e.minCleanPunches / (e.userIds.length * opts.punchesPerUserPerDay)),
  }))
  const slowestOrgDays = Math.max(totalDaysNeeded, ...perOrgDays.map((o) => o.daysNeeded))

  const lines = [
    `[feasibility] ${totalUsers} total users x ${opts.punchesPerUserPerDay}/day = `
    + `${totalDailyCapacity} punches/day best-case capacity`,
    `[feasibility] targetTotal=${opts.targetTotal} => best case ~${totalDaysNeeded} day(s)`,
    ...perOrgDays.map((o) => `[feasibility]   org=${o.orgId} minCleanPunches best case ~${o.daysNeeded} day(s)`),
  ]

  if (opts.durationMinutes) {
    const availableDays = opts.durationMinutes / (24 * 60)
    if (availableDays < slowestOrgDays) {
      throw new ConfigError(
        [...lines,
          `--duration-minutes=${opts.durationMinutes} (~${availableDays.toFixed(2)} day(s)) is shorter than the `
          + `best-case ${slowestOrgDays} day(s) this config needs — this run could never reach its targets even `
          + 'with zero incidents. Raise --duration-minutes, raise --punches-per-user-per-day, add more users, or '
          + 'lower the targets before running.',
        ].join('\n')
      )
    }
  } else if (slowestOrgDays > 1) {
    lines.push(
      `[feasibility] WARNING: no --duration-minutes set and best case needs ~${slowestOrgDays} day(s) — `
      + 'this run will legitimately keep polling across calendar-day boundaries (in the configured '
      + 'timezone) rather than finish quickly. That is expected multi-day soak behavior, not a stall, '
      + `but the stall guard (--stall-timeout-minutes, default ${opts.stallTimeoutMinutes}) will still `
      + 'halt the process if literally zero attempts happen for that long.'
    )
  }
  // eslint-disable-next-line no-console
  console.log(lines.join('\n'))
}

async function runScheduler({ config, opts, willExecute }) {
  const tally = newTally(config)
  const incidentLog = []
  const pool = buildUserPool(config)
  const throttle = createGlobalRateLimiter(opts.rateLimitPerSec)

  const maxAttemptsSafetyCap = opts.targetTotal * opts.maxAttemptsSafetyMultiplier
  const deadlineMs = opts.durationMinutes ? Date.now() + opts.durationMinutes * 60_000 : null
  const stallTimeoutMs = opts.stallTimeoutMinutes * 60_000

  let consecutiveIncidents = 0
  let cursor = 0
  let sinceLastPrint = 0
  let haltedReason = null
  let lastProgressAt = Date.now() // "progress" = an attempt was sent, clean or not

  while (true) {
    if (stopConditionsMet(tally, config, opts)) { haltedReason = 'targets_met'; break }
    if (deadlineMs && Date.now() >= deadlineMs) { haltedReason = 'duration_elapsed'; break }
    if (tally.totalAttempts >= maxAttemptsSafetyCap) { haltedReason = 'max_attempts_safety_cap'; break }
    if (consecutiveIncidents >= opts.maxConsecutiveIncidents) { haltedReason = 'max_consecutive_incidents'; break }
    if (Date.now() - lastProgressAt >= stallTimeoutMs) { haltedReason = 'no_eligible_users_stall_timeout'; break }

    // Round-robin scan for an eligible (org,user); if none found in a full pass, wait briefly.
    let picked = null
    for (let i = 0; i < pool.length; i++) {
      const idx = (cursor + i) % pool.length
      const candidate = pool[idx]
      if (!orgNeedsMorePunches(tally, candidate.entry, opts)) continue
      if (!userEligible(candidate, opts, Date.now(), config.timezone)) continue
      picked = candidate
      cursor = idx + 1
      break
    }
    if (!picked) {
      // Nobody eligible right now (daily caps or per-user spacing cooldown, or — see
      // assessFeasibility — a legitimate wait for the next calendar day to reset daily caps).
      // Bounded by the stall-timeout check above, which does NOT false-fire on this: it only
      // fires after opts.stallTimeoutMinutes of ZERO attempts, deliberately set longer than
      // one calendar-day daily-cap reset.
      await sleep(1000)
      continue
    }

    const eventType = nextEventType(picked)
    const operationId = randomUUID()

    let result
    if (willExecute) {
      // throttle() is called INSIDE sendPunchWithRetry, once per attempt (including
      // transport-level retries) — not here — so retries stay bounded by the same global
      // rate ceiling as first attempts.
      result = await sendPunchWithRetry({
        baseUrl: config.baseUrl,
        entry: picked.entry,
        userId: picked.userId,
        token: picked.token,
        eventType,
        operationId,
        opts,
        throttle,
      })
    } else {
      // Dry run: exercise the scheduler/tally machinery without any network call.
      result = { category: 'clean', status: 200, errorCode: null, errorMessage: null, attempt: 1, networkError: null, dryRun: true }
    }

    recordOutcome(tally, picked.entry, result)
    // Alternation tracker: ALWAYS set to the type just attempted, regardless of outcome. A
    // 429 (PUNCH_TOO_SOON) means the DB's real last event for this user already equals
    // `eventType` — recording that is exactly what makes the NEXT nextEventType() call return
    // the opposite type, resolving the collision. Flipping it instead (an earlier draft's
    // bug) would re-request the same colliding type forever.
    picked.lastEventType = eventType
    picked.lastPunchAt = Date.now()
    lastProgressAt = Date.now()

    if (result.category === 'clean') {
      consecutiveIncidents = 0
    } else {
      consecutiveIncidents++
      incidentLog.push({
        at: new Date().toISOString(),
        orgId: picked.entry.orgId,
        userId: picked.userId,
        eventType,
        operationId,
        ...result,
      })
    }

    const today = workDateInTimezone(new Date(), config.timezone)
    picked.dailyCounts.set(today, (picked.dailyCounts.get(today) || 0) + 1)

    sinceLastPrint++
    if (sinceLastPrint >= opts.tallyIntervalPunches) {
      printTally(tally, opts, config)
      sinceLastPrint = 0
    }
  }

  printTally(tally, opts, config)
  return { tally, incidentLog, haltedReason }
}

// -----------------------------------------------------------------------------------------
// main
// -----------------------------------------------------------------------------------------

async function main() {
  const opts = buildOptions(process.argv.slice(2))
  const config = await loadConfig(opts)
  const { willExecute, reason } = validateExecutionConfirmation(opts, config)

  opts.sourceTagResolved = config.sourceTag
  // Sent in the request body ONLY when the config explicitly declared a timezone — see the
  // file header's TIMEZONE note. config.timezone (always resolved, defaulting to UTC) is used
  // exclusively for this script's own local daily-cap bookkeeping, never sent to the server.
  opts.timezoneToSend = config.timezoneExplicit

  assessFeasibility(config, opts)

  // eslint-disable-next-line no-console
  console.log(
    `[start] mode=${willExecute ? 'EXECUTE (real HTTP traffic)' : 'DRY_RUN'} reason="${reason}"\n`
    + `        baseUrl=${config.baseUrl}\n`
    + `        entries=${config.entries.length} orgIds=[${config.entries.map((e) => e.orgId).join(', ')}]\n`
    + `        targetTotal=${opts.targetTotal} targetPerOrg(default)=${opts.targetPerOrg} targetPerArm=${opts.targetPerArm}\n`
    + `        rateLimitPerSec=${opts.rateLimitPerSec} punchesPerUserPerDay=${opts.punchesPerUserPerDay}\n`
    + `        sourceTag=${opts.sourceTagResolved} timezoneSentInBody=${opts.timezoneToSend || '(omitted — server clock/org-rule timezone)'}`
  )
  if (willExecute) {
    // eslint-disable-next-line no-console
    console.log('[start] 【OWNER】 EXECUTE mode confirmed — this run will send real HTTP traffic to the above baseUrl.')
  }

  const startedAt = Date.now()
  const { tally, incidentLog, haltedReason } = await runScheduler({ config, opts, willExecute })
  const finishedAt = Date.now()

  const summary = {
    schemaVersion: 1,
    generatedBy: 'scripts/ops/attendance-w4w7-soak-load-generator.mjs (combined-soak runbook §2A.6/§2A.6a)',
    mode: willExecute ? 'execute' : 'dry_run',
    haltedReason,
    startedAt: new Date(startedAt).toISOString(),
    finishedAt: new Date(finishedAt).toISOString(),
    elapsedSeconds: Math.round((finishedAt - startedAt) / 1000),
    achievedRatePerSec: tally.totalAttempts > 0 ? tally.totalAttempts / Math.max(1, (finishedAt - startedAt) / 1000) : 0,
    baseUrl: config.baseUrl,
    sourceTag: opts.sourceTagResolved,
    timezoneSentInRequestBody: opts.timezoneToSend, // null unless the config explicitly declared one — see file header TIMEZONE note
    timezoneUsedForLocalBookkeepingOnly: config.timezone,
    targets: {
      targetTotal: opts.targetTotal,
      targetPerOrgDefault: opts.targetPerOrg,
      targetPerArm: opts.targetPerArm,
    },
    tally,
    armAttributionSource: 'config_declared', // NOT verified against attendance_calculation_rollout_state / attendance_calculation_context_source_state
    countSemantics:
      'This tally is an HTTP-level cross-check (2xx + {ok:true,data:<present>}) that UPPER-BOUNDS the '
      + 'true §2A.2 DB-level "clean punch" count (attendance_result_operations.state=completed AND '
      + 'joined attendance_record_calculations.outcome=completed AND shadow_diff_code IS NULL/\'equal\', '
      + 'deduped on operation_id). It is NOT itself a ledger 实测 value for C1-C4 — use Q1-Q4 against the '
      + 'real database for that (SOAK-ACCEPTANCE-LEDGER-TEMPLATE-20260815.md §1).',
    unimplementedGaps: [
      'Cannot observe §2A.4 W7-2 diff codes (W7_CRITICAL_SHADOW_DIFF, W7_OFF_ROSTER_DIFF, etc.) — no DB access.',
      'Cannot observe §3 40P01/57P01 alarm conditions — no DB/APM access.',
      'Stop condition on those two items (§2A.6 step 7) is therefore approximated ONLY by a '
        + 'consecutive-HTTP-incident threshold (maxConsecutiveIncidents), not a true implementation of step 7.',
      'W7-side arm counts are config-declared labels, not verified server-side posture reads (§2A.1 mechanism precondition not yet cleared).',
    ],
    perOrgConfig: config.entries.map((e) => ({
      orgId: e.orgId, posture: e.posture, arms: e.arms, minCleanPunches: e.minCleanPunches, userCount: e.userIds.length,
    })),
    incidentLog,
  }

  await writeFile(opts.outputPath, JSON.stringify(summary, null, 2), 'utf8')
  // eslint-disable-next-line no-console
  console.log(`[done] halted=${haltedReason} summary written to ${opts.outputPath}`)
}

main().catch((err) => {
  if (err instanceof ConfigError) {
    // eslint-disable-next-line no-console
    console.error(`[config error] ${err.message}`)
    process.exit(2)
  }
  // eslint-disable-next-line no-console
  console.error('[fatal]', err)
  process.exit(1)
})
