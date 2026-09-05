// stock-preparation-scheduled-pull.mjs — the OPS-SIDE half of scheduled 「从 PLM 拉取」.
//
// WHY THIS LIVES OUTSIDE THE PRODUCT, NOT AS A NEW SCHEDULER OR ACTION TYPE.
//
// There is no in-process way to drive this pull on a timer without opening a new authorization
// surface. Three facts, checked against this repo rather than assumed:
//   (1) plugin-integration-core has no scheduler at all — the string 'cron' appears exactly once in
//       the whole plugin, as a vocabulary entry in pipelines.cjs, and no code anywhere produces
//       `triggeredBy: 'cron'` (pipeline-runner.cjs defaults to 'manual'; every http-routes.cjs caller
//       passes 'api').
//   (2) the platform DOES have a scheduler (packages/core-backend/src/multitable/automation-scheduler.ts,
//       cron + leader lock), but its action-type table has no "call a plugin route" entry
//       (automation-actions.ts only knows send_webhook and friends) — adding one is a core change,
//       not an ops script.
//   (3) the pull-bom dry-run/apply routes are shaped around an HTTP request end to end —
//       requireTableActionAccess, assertB2aStockPreparationReadAuthorized and scopedInput all take the
//       request object as their input. An in-process caller with no `req` could only fabricate one,
//       which is a new authorization-bypass surface, not a scheduling feature.
//
// So this script does the only thing that adds NO new authorization surface: it is an ordinary HTTP
// client, invoked by whatever the deployment's OS already runs on a timer (Windows Task Scheduler,
// cron, systemd timer — see the runbook section this script is documented alongside). It carries no
// capability the two existing routes do not already grant a human clicking the same buttons.
//
// DEFAULT IS DRY-RUN ONLY. `apply` writes to the sandbox table (or, on a deployment with a time-boxed
// production policy, further than that) with nobody watching. The design record for this script
// (docs/development/takeover-beiliao-20260821/project-subtree-bridge-design-20260905.md §2.2) says
// this in as many words: "无人值守 apply 会写沙箱表 ... 强烈建议第一波只定时 dry-run,把「有变化」当提
// 醒,apply 仍由人按。" So `--apply` must be typed explicitly; every other invocation only ever POSTs
// dry-run and reports what it found.
//
// THE TOKEN MUST BE A TENANT-BOUND SERVICE ACCOUNT'S, NOT A TENANTLESS PLATFORM ADMIN'S. This is a
// SECURITY-LOAD-BEARING requirement, not a style note. `requireTableActionAccess`
// (plugins/plugin-integration-core/lib/http-routes.cjs) returns immediately when the caller holds the
// action's legacy read/write/admin permission, WITHOUT going through `resolveOperatorValueScope`'s
// tenant checks — and `resolveTenantId` then trusts `req.query.tenantId` / `x-tenant-id` outright for
// any principal without its own `tenantId` claim (the "tenantless platform admin" branch). A token
// with no `tenantId` claim, pointed at a `tenantId=` query param or `x-tenant-id` header this script
// controls, would let a compromised or merely misconfigured cron job read and write ANY tenant's data
// — the same cross-tenant hole the operator-scope work exists to close, reopened by a scheduled job
// nobody is watching in real time.
//
// This script therefore decodes (never verifies — it has no key to verify with, and does not need
// one: it only needs to refuse to RUN, not to re-implement authentication) the JWT payload and refuses
// to proceed unless it carries a non-empty `tenantId` claim, UNLESS the operator explicitly passes
// `--allow-tenantless` (default off). The decode reads the EXISTENCE of that one claim only — never
// its value, and never any other claim — and nothing decoded is ever printed, logged, or included in
// any output line this script produces.
//
// OUTPUT IS VALUES-FREE. One JSON line per project (project number — a config identifier the operator
// already typed into MS_PROJECT_NOS, not a row value — status, counts, what happened, how long it
// took), one summary line at the end. Never a response's row data. Never the token, in any form, in
// any output.
//
// INPUTS ARE ENVIRONMENT VARIABLES ONLY — nothing is read from a file, so there is no token-bearing
// file for this script to leak or for a stray `git add` to catch:
//   MS_API           base URL, e.g. http://127.0.0.1:8900         (required)
//   MS_TOKEN         admin Bearer token, tenant-bound (see above)  (required)
//   MS_TENANT_ID     tenant id to operate on                       (optional, default 'default')
//   MS_PROJECT_NOS   comma-separated project numbers               (required)

import { pathToFileURL } from 'node:url'

const PULL_ACTION_ID = 'plm.stock-preparation.pull-bom.v1'
const REQUIRED_ENV_VARS = ['MS_API', 'MS_TOKEN', 'MS_PROJECT_NOS']

const HELP_TEXT = `stock-preparation-scheduled-pull.mjs — ops-side scheduled PLM pull for stock-prep.

Usage:
  MS_API=http://127.0.0.1:8900 MS_TOKEN=*** MS_TENANT_ID=tenant-a MS_PROJECT_NOS=P-1,P-2 \\
    node scripts/ops/stock-preparation-scheduled-pull.mjs [--apply] [--dry-run-only] [--allow-tenantless]

Required environment variables:
  MS_API          base URL of the MetaSheet API, e.g. http://127.0.0.1:8900
  MS_TOKEN        a Bearer token for an admin service account, BOUND TO THE TARGET TENANT
                   (a tenantless platform-admin token is refused by default — see --allow-tenantless)
  MS_PROJECT_NOS  comma-separated project numbers to pull, e.g. "2-20231625,230920006"

Optional environment variables:
  MS_TENANT_ID    tenant id to operate on (default: "default")

Flags:
  --dry-run-only      only POST dry-run for every project (this is the default even with no flags)
  --apply             when a project's dry-run reports status "ready" and canApply=true, immediately
                       POST apply in the SAME run using the dry-run token it just received (the token
                       is one-shot and expires in ~30 minutes, so this can never be split across runs)
  --allow-tenantless  proceed even when MS_TOKEN does not carry a tenantId claim — DANGEROUS, see the
                       header comment; only for a deployment that has deliberately chosen to run this
                       under a tenantless platform admin and has accepted the cross-tenant exposure
  --help, -h          print this text and exit 0

Exit code is non-zero if any project's dry-run (or apply) failed outright — never for a project that
was simply skipped as manual_confirm_required, large_bom_bounded, not_found, or (without --apply)
ready-but-not-applied.

Prints exactly one JSON line per project, then one summary JSON line. Never prints MS_TOKEN, any
decoded token claim, or any row value from a response.
`

export class UsageError extends Error {}
export class ConfigError extends Error {}

export function parseArgs(argv) {
  const flags = { apply: false, dryRunOnly: false, allowTenantless: false, help: false }
  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') flags.help = true
    else if (arg === '--apply') flags.apply = true
    else if (arg === '--dry-run-only') flags.dryRunOnly = true
    else if (arg === '--allow-tenantless') flags.allowTenantless = true
    else throw new UsageError(`unknown argument: ${arg} (see --help)`)
  }
  return flags
}

export function readConfig(env) {
  const missing = REQUIRED_ENV_VARS.filter((name) => !(env[name] && String(env[name]).trim()))
  if (missing.length > 0) {
    throw new ConfigError(`missing required environment variable(s): ${missing.join(', ')}`)
  }
  const apiBase = String(env.MS_API).trim().replace(/\/+$/, '')
  const token = String(env.MS_TOKEN)
  const tenantId = (env.MS_TENANT_ID && String(env.MS_TENANT_ID).trim()) || 'default'
  const projectNos = String(env.MS_PROJECT_NOS)
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
  if (projectNos.length === 0) {
    throw new ConfigError('MS_PROJECT_NOS must list at least one project number')
  }
  return { apiBase, token, tenantId, projectNos }
}

// ---------------------------------------------------------------------------
// THE TENANT-BINDING CHECK — reads ONE claim's presence, never a value.
// ---------------------------------------------------------------------------

function base64UrlDecode(segment) {
  const padded = segment.replace(/-/g, '+').replace(/_/g, '/')
  const padLength = padded.length % 4 === 0 ? 0 : 4 - (padded.length % 4)
  return Buffer.from(padded + '='.repeat(padLength), 'base64').toString('utf8')
}

/**
 * Tri-state, never a value: `true` means the JWT payload carries a non-empty string `tenantId` claim
 * (tenant-bound); `false` means it decodes but carries no such claim; `null` means MS_TOKEN is not a
 * decodable 3-part JWT at all (opaque token, or malformed). The caller treats `false` and `null` the
 * same way (refuse unless overridden) — the distinction exists only for the operator-facing message.
 *
 * NEVER returns, logs, or prints any claim VALUE — including the tenantId itself. Only this
 * true/false/null existence fact leaves this function.
 */
export function jwtHasTenantClaim(token) {
  if (typeof token !== 'string') return null
  const parts = token.split('.')
  if (parts.length !== 3) return null
  try {
    const payload = JSON.parse(base64UrlDecode(parts[1]))
    if (!payload || typeof payload !== 'object') return false
    return typeof payload.tenantId === 'string' && payload.tenantId.trim().length > 0
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

function dryRunUrl(apiBase, tenantId) {
  return `${apiBase}/api/integration/table-actions/${PULL_ACTION_ID}/dry-run?tenantId=${encodeURIComponent(tenantId)}`
}

function applyUrl(apiBase, tenantId) {
  return `${apiBase}/api/integration/table-actions/${PULL_ACTION_ID}/apply?tenantId=${encodeURIComponent(tenantId)}`
}

async function postJson(url, { token, tenantId, body }) {
  const startedAt = Date.now()
  let response
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
        'x-tenant-id': tenantId,
      },
      body: JSON.stringify(body),
    })
  } catch (error) {
    return {
      ok: false,
      networkError: true,
      message: error && error.message ? error.message : String(error),
      durationMs: Date.now() - startedAt,
    }
  }
  let json = null
  let parseError = null
  try {
    json = await response.json()
  } catch (error) {
    parseError = error && error.message ? error.message : String(error)
  }
  return { ok: response.ok, httpStatus: response.status, json, parseError, durationMs: Date.now() - startedAt }
}

function errorCodeOf(envelope) {
  return envelope && envelope.json && envelope.json.error && envelope.json.error.code
    ? String(envelope.json.error.code)
    : null
}

/**
 * Pull ONE project: dry-run, and — only when `applyFlag` and the dry-run says it may — apply, in the
 * SAME call, using the dry-run token this same response just returned. See the module header for why
 * the two must never be split across separate invocations (the token is one-shot, ~30 min TTL).
 *
 * Returns a VALUES-FREE record: project number (a config identifier the caller supplied, not a row
 * value), status, counts (tallies, never row data), what action this script took or why it did not,
 * and elapsed time. `failed: true` marks the outcomes that should make the whole run exit non-zero —
 * a genuine dry-run/apply failure, never a legitimate "needs a human" outcome.
 */
export async function pullOneProject({ apiBase, token, tenantId, projectNo, applyFlag }) {
  const startedAt = Date.now()
  const record = { projectNo }

  const dryRun = await postJson(dryRunUrl(apiBase, tenantId), {
    token,
    tenantId,
    body: { parameters: { projectNo } },
  })
  record.dryRunHttpStatus = dryRun.httpStatus ?? null

  if (dryRun.networkError) {
    return { ...record, action: 'error', error: `dry-run network error: ${dryRun.message}`, failed: true, durationMs: Date.now() - startedAt }
  }
  if (!dryRun.ok || dryRun.parseError || !dryRun.json || dryRun.json.ok !== true || !dryRun.json.data) {
    const code = errorCodeOf(dryRun)
    return {
      ...record,
      action: 'error',
      error: code || `dry-run failed with HTTP ${dryRun.httpStatus ?? 'unknown'}`,
      failed: true,
      durationMs: Date.now() - startedAt,
    }
  }

  const data = dryRun.json.data
  record.status = data.status
  record.canApply = data.canApply === true
  record.largeBom = data.largeBom === true
  record.counts = data.counts && typeof data.counts === 'object' ? data.counts : null

  if (data.status === 'not_found') {
    return { ...record, action: 'skipped_not_found', durationMs: Date.now() - startedAt }
  }
  if (data.status === 'large_bom_bounded') {
    return {
      ...record,
      action: 'skipped_large_bom_bounded',
      note: 'requires the background large-BOM job flow (human-driven, one POST at a time) — not retried here',
      durationMs: Date.now() - startedAt,
    }
  }
  if (data.status === 'manual_confirm_required') {
    return { ...record, action: 'skipped_manual_confirm_required', durationMs: Date.now() - startedAt }
  }
  if (data.status !== 'ready') {
    return { ...record, action: 'error', error: `unexpected dry-run status: ${data.status}`, failed: true, durationMs: Date.now() - startedAt }
  }

  // status === 'ready'
  if (!applyFlag) {
    return { ...record, action: 'skipped_dry_run_only', durationMs: Date.now() - startedAt }
  }
  if (data.canApply !== true) {
    return { ...record, action: 'skipped_ready_not_applicable', durationMs: Date.now() - startedAt }
  }
  if (!data.dryRunToken) {
    return { ...record, action: 'error', error: 'dry-run reported ready+canApply but returned no dryRunToken', failed: true, durationMs: Date.now() - startedAt }
  }

  const apply = await postJson(applyUrl(apiBase, tenantId), {
    token,
    tenantId,
    body: {
      parameters: { projectNo },
      confirm: { dryRunToken: data.dryRunToken, dryRunRevision: data.revision },
    },
  })
  record.applyHttpStatus = apply.httpStatus ?? null

  if (apply.networkError) {
    return { ...record, action: 'error', error: `apply network error: ${apply.message}`, failed: true, durationMs: Date.now() - startedAt }
  }
  if (!apply.ok || apply.parseError || !apply.json || apply.json.ok !== true) {
    const code = errorCodeOf(apply)
    return {
      ...record,
      action: 'error',
      error: code || `apply failed with HTTP ${apply.httpStatus ?? 'unknown'}`,
      failed: true,
      durationMs: Date.now() - startedAt,
    }
  }
  const applyData = apply.json.data
  record.applyCounts = applyData && applyData.counts && typeof applyData.counts === 'object' ? applyData.counts : null
  return { ...record, action: 'applied', durationMs: Date.now() - startedAt }
}

export function summarize(results, applyFlag) {
  const count = (action) => results.filter((r) => r.action === action).length
  return {
    projectCount: results.length,
    mode: applyFlag ? 'apply' : 'dry-run-only',
    applied: count('applied'),
    skippedManualConfirmRequired: count('skipped_manual_confirm_required'),
    skippedLargeBomBounded: count('skipped_large_bom_bounded'),
    skippedNotFound: count('skipped_not_found'),
    skippedDryRunOnly: count('skipped_dry_run_only'),
    skippedReadyNotApplicable: count('skipped_ready_not_applicable'),
    failed: results.filter((r) => r.failed === true).length,
  }
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

export async function main(argv, env) {
  let flags
  try {
    flags = parseArgs(argv)
  } catch (error) {
    process.stderr.write(`${error.message}\n`)
    return 1
  }
  if (flags.help) {
    process.stdout.write(HELP_TEXT)
    return 0
  }

  let config
  try {
    config = readConfig(env)
  } catch (error) {
    process.stderr.write(`${error.message}\n`)
    return 1
  }

  const tenantClaimPresent = jwtHasTenantClaim(config.token)
  if (tenantClaimPresent !== true) {
    if (!flags.allowTenantless) {
      process.stderr.write(
        'MS_TOKEN does not carry a tenantId claim. Refusing to run: a token without one may be a '
        + 'tenantless platform-admin token, and this pull authorizes through a path that lets an '
        + 'untenanted caller pick its target tenant via tenantId/x-tenant-id — the exact cross-tenant '
        + 'hole operator-scope exists to close. Mint MS_TOKEN from an admin service account BOUND TO '
        + 'the target tenant, or pass --allow-tenantless to proceed anyway (not recommended).\n',
      )
      return 1
    }
    process.stderr.write(
      'warning: MS_TOKEN does not declare a tenantId claim; proceeding only because --allow-tenantless '
      + 'was passed. This run has the same authority as a tenantless platform admin scoped by '
      + `MS_TENANT_ID=${config.tenantId} — verify that scoping is enforced server-side for this token.\n`,
    )
  }

  const applyFlag = flags.apply === true && flags.dryRunOnly !== true
  const results = []
  for (const projectNo of config.projectNos) {
    const result = await pullOneProject({
      apiBase: config.apiBase,
      token: config.token,
      tenantId: config.tenantId,
      projectNo,
      applyFlag,
    })
    results.push(result)
    process.stdout.write(`${JSON.stringify(result)}\n`)
  }

  const summary = summarize(results, applyFlag)
  process.stdout.write(`${JSON.stringify({ summary })}\n`)
  return summary.failed > 0 ? 1 : 0
}

// ONLY run when this file is the process entry point — never on `import` (the test suite imports
// `main`/`pullOneProject`/etc. directly and drives them with a mocked `fetch`, and an unconditional
// auto-run here would call `process.exit` out from under that import).
const isEntryPoint = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href

if (isEntryPoint) {
  // `process.exit(code)` rather than only `process.exitCode = code`: Node's built-in `fetch` pools
  // keep-alive HTTP/1.1 connections, and a server that does not close its end (every ordinary Express-
  // style server, including this repo's) leaves a socket the event loop waits on — the process would
  // otherwise hang past its last line of output until that socket times out. Every write above this
  // point uses `process.stdout.write`/`process.stderr.write` synchronously, so nothing is dropped by
  // exiting immediately once the exit code is known.
  main(process.argv.slice(2), process.env)
    .then((code) => { process.exit(code) })
    .catch((error) => {
      process.stderr.write(`${error && error.stack ? error.stack : String(error)}\n`)
      process.exit(1)
    })
}
