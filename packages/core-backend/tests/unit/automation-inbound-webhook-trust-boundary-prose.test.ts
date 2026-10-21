/**
 * Inbound webhook trust boundary: the written claims must match the mounted gate (#5803 review).
 *
 * `POST /api/multitable/automation/webhooks/:ruleId` sits behind the global session gate in index.ts. The
 * handler then IGNORES that session, and only the per-rule secret (a verified signature) authorizes
 * delivery. Three texts describe this boundary, and until #5803 all three called the caller "anonymous" /
 * "unauthenticated":
 *   - the `handleInboundWebhook` doc comment (automation-service.ts),
 *   - the T1-2 design & verification record (docs/development/...-dev-verification-20260702.md),
 *   - the real-DB suite header (tests/integration/multitable-inbound-webhook-trigger.test.ts).
 * The verification record's reject list also did not name the #5803 `sheet_deleted` reason.
 *
 * What is pinned:
 *   1. THE FACT: the webhook path is an API path, is not a declared gate exception, and matches neither
 *      request-based exception (public-form token, OAPI `mst_` allowlist). The chain below is built from the
 *      same predicates index.ts calls. If this goes red, the route really has become sessionless: the
 *      three texts (and the security posture) need a fresh review.
 *   2. THE TEXTS: none of the three repeats the anonymous/unauthenticated claim, and each states the gate.
 *   3. THE REJECT LIST: every member of `InboundWebhookRejectReason` (read from the source with the
 *      TypeScript parser) is named, backticked, in the verification record, and `sheet_deleted` is
 *      described as decided only after the signature verifies.
 *
 * Zero-DB, no HTTP.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

import { isApiPath, isGateException, matchGateException } from '../../src/auth/api-path-policy'
import { isPublicFormAuthBypass } from '../../src/auth/jwt-middleware'
import { isOapiAllowlistRequest } from '../../src/multitable/oapi-read-allowlist'

const REPO_ROOT = join(__dirname, '..', '..', '..', '..')

const SERVICE_FILE = 'packages/core-backend/src/multitable/automation-service.ts'
const REASON_FILE = 'packages/core-backend/src/multitable/automation-inbound-webhook.ts'
const ROUTES_FILE = 'packages/core-backend/src/routes/automation.ts'
const INDEX_FILE = 'packages/core-backend/src/index.ts'
const DOC_FILE = 'docs/development/approval-automation-t1-2-inbound-webhook-dev-verification-20260702.md'
const REALDB_SUITE_FILE = 'packages/core-backend/tests/integration/multitable-inbound-webhook-trigger.test.ts'

/** Repo file as text, line endings normalized (the Windows checkout is CRLF, CI is LF). */
function readRepoText(rel: string): string {
  return readFileSync(join(REPO_ROOT, rel), 'utf8').replace(/\r\n/g, '\n')
}

/** The comment-free text of `/* ... *\/` or `//` prose, joined into one line (so wrapping does not matter). */
function flattenProse(text: string): string {
  return text
    .split('\n')
    .map((line) => line.replace(/^\s*(\/\*\*?|\*\/|\*|\/\/)\s?/, ''))
    .join(' ')
    .replace(/\s+/g, ' ')
}

const WEBHOOK_MOUNT = '/api/multitable'
const WEBHOOK_ROUTE = '/automation/webhooks/:ruleId'
const WEBHOOK_PATH = `${WEBHOOK_MOUNT}/automation/webhooks/rule_probe`

/**
 * The global gate's dispatch, from the SAME predicates index.ts calls (`isWhitelisted` is a thin wrapper
 * over `isGateException`). Mirrors the replica in api-path-policy.test.ts; the order is pinned against
 * index.ts in the first test below.
 */
function gateOutcome(req: {
  method: string
  path: string
  query?: Record<string, unknown>
  body?: Record<string, unknown>
  authorization?: string
}): 'exception' | 'gate' | 'not-api' {
  if (isGateException(req.path)) return 'exception'
  if (isPublicFormAuthBypass({ method: req.method, path: req.path, query: req.query ?? {}, body: req.body ?? {} } as never)) {
    return 'exception'
  }
  if (isOapiAllowlistRequest(req.method, req.path, req.authorization)) return 'exception'
  if (isApiPath(req.path)) return 'gate'
  return 'not-api'
}

describe('inbound webhook: the mounted route is behind the global session gate', () => {
  it('the route is what this test probes: mounted under /api/multitable, and index.ts gates with the same predicates', () => {
    const routes = readRepoText(ROUTES_FILE)
    expect(routes).toContain(`'${WEBHOOK_ROUTE}'`)
    const index = readRepoText(INDEX_FILE)
    expect(index).toContain(`this.app.use('${WEBHOOK_MOUNT}', createAutomationRoutes(`)
    const gateStart = index.indexOf('if (isWhitelisted(req.path)) return next()')
    expect(gateStart).toBeGreaterThan(0)
    const gate = index.slice(gateStart, index.indexOf('return next()\n    })', gateStart))
    const order = [
      'if (isPublicFormAuthBypass(req))',
      'if (isOapiAllowlistRequest(req.method, req.path, req.headers.authorization)) return next()',
      'if (isApiPath(req.path)) return jwtAuthMiddleware(req, res, next)',
    ].map((needle) => gate.indexOf(needle))
    expect(order.every((at) => at > 0)).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
    // The routers are mounted after the gate, so the gate sees the webhook request first.
    expect(index.indexOf(`this.app.use('${WEBHOOK_MOUNT}', createAutomationRoutes(`)).toBeGreaterThan(gateStart)
  })

  it('the webhook path is gated: not a declared exception, not a request-based exception', () => {
    expect(isApiPath(WEBHOOK_PATH)).toBe(true)
    expect(matchGateException(WEBHOOK_PATH)).toBeNull()
    for (const path of [WEBHOOK_PATH, WEBHOOK_PATH.toUpperCase(), `${WEBHOOK_PATH}/`]) {
      expect(gateOutcome({ method: 'POST', path }), path).toBe('gate')
      // A public-form token does not open it (that bypass is for form-context / views/:id/submit only).
      expect(gateOutcome({ method: 'POST', path, query: { publicToken: 'probe' }, body: { publicToken: 'probe' } }), path).toBe('gate')
      // An `mst_` API-token bearer does not open it (not on the OAPI method-bound allowlist).
      expect(gateOutcome({ method: 'POST', path, authorization: 'Bearer mst_probe' }), path).toBe('gate')
    }
  })
})

describe('inbound webhook: the three texts describe that boundary', () => {
  const ANONYMOUS_CLAIMS: readonly RegExp[] = [
    /caller is anonymous/i,
    /anonymous caller/i,
    /public unauthenticated/i,
    /unauthenticated route/i,
  ]

  it('the handleInboundWebhook doc comment says the caller is not anonymous and the session is ignored', () => {
    const service = readRepoText(SERVICE_FILE)
    const end = service.indexOf('  async handleInboundWebhook(')
    const start = service.lastIndexOf('/**', end)
    expect(start).toBeGreaterThan(0)
    const doc = flattenProse(service.slice(start, end))
    for (const claim of ANONYMOUS_CLAIMS) expect(doc, String(claim)).not.toMatch(claim)
    expect(doc).toContain('The caller is NOT anonymous as mounted')
    expect(doc).toContain('GLOBAL_GATE_EXCEPTIONS')
    expect(doc).toMatch(/session is then IGNORED/)
  })

  it('the verification record says a valid session is required but ignored', () => {
    const doc = readRepoText(DOC_FILE)
    const start = doc.indexOf('## Trust Boundary')
    const end = doc.indexOf('\n## ', start + 1)
    expect(start).toBeGreaterThan(0)
    const section = flattenProse(doc.slice(start, end))
    for (const claim of ANONYMOUS_CLAIMS) {
      // The one allowed mention is the dated correction note, which quotes the old claim as wrong.
      const withoutCorrection = section.replace(/\(Correction, #5803:[^)]*\)/, '')
      expect(withoutCorrection, String(claim)).not.toMatch(claim)
    }
    expect(section).toContain('requires a valid session, but the handler ignores that session')
    expect(section).toContain('GLOBAL_GATE_EXCEPTIONS')
    expect(section).toContain('only the per-rule secret (a verified signature) authorizes delivery')
  })

  it('the real-DB suite header says the route is gated in production and the harness mounts it without the gate', () => {
    const suite = readRepoText(REALDB_SUITE_FILE)
    const header = flattenProse(suite.slice(0, suite.indexOf('*/')))
    for (const claim of ANONYMOUS_CLAIMS) expect(header, String(claim)).not.toMatch(claim)
    expect(header).toContain('behind the global session gate')
    expect(header).toContain('WITHOUT that gate')
  })
})

describe('inbound webhook: the verification record lists every reject reason', () => {
  function rejectReasonsFromSource(): string[] {
    const source = ts.createSourceFile(REASON_FILE, readRepoText(REASON_FILE), ts.ScriptTarget.Latest, true)
    const alias = source.statements.find(
      (s): s is ts.TypeAliasDeclaration => ts.isTypeAliasDeclaration(s) && s.name.text === 'InboundWebhookRejectReason',
    )
    if (!alias || !ts.isUnionTypeNode(alias.type)) throw new Error('InboundWebhookRejectReason is no longer a union alias')
    return alias.type.types.map((member) => {
      if (!ts.isLiteralTypeNode(member) || !ts.isStringLiteral(member.literal)) {
        throw new Error(`InboundWebhookRejectReason has a non-string-literal member: ${member.getText(source)}`)
      }
      return member.literal.text
    })
  }

  it('reads the union (sanity: the parse found the known members)', () => {
    const reasons = rejectReasonsFromSource()
    expect(reasons).toContain('unknown_rule')
    expect(reasons).toContain('bad_signature')
    expect(reasons).toContain('sheet_deleted')
    expect(new Set(reasons).size).toBe(reasons.length)
  })

  it('every reason is named in the Reject posture bullet, and sheet_deleted is marked post-signature', () => {
    const doc = readRepoText(DOC_FILE)
    const bullet = doc.split('\n').find((line) => line.startsWith('- Reject posture:'))
    expect(bullet).toBeDefined()
    for (const reason of rejectReasonsFromSource()) {
      expect(bullet, reason).toContain(`\`${reason}\``)
    }
    expect(bullet).toContain('401 { ok:false }')
    const afterSheetDeleted = bullet!.slice(bullet!.indexOf('`sheet_deleted`'))
    expect(afterSheetDeleted).toContain('decided only after the signature verifies')
    expect(afterSheetDeleted).toContain('never in the response')
  })
})
