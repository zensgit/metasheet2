/**
 * G05 — the rule-driven `send_webhook` action is SSRF-gated (the "刀 0" prerequisite of the
 * trigger-port design #5615).
 *
 * WHAT WAS WRONG: `checkWebhookTargetUrl` (the resolve-then-pin egress guard) existed and was wired
 * into exactly ONE call site — the button-field route. The automation-RULE path took `config.url`
 * straight from the rule's JSON to `fetch`, with the rule's `config.headers` (typically a long-lived
 * `Authorization: Bearer …`) attached. Anyone who could edit a rule could therefore aim the server's
 * stored credentials at loopback / RFC1918 / the cloud metadata address.
 *
 * THE LOAD-BEARING ASSERTION in every refusal case below is `expect(fetch).toHaveBeenCalledTimes(0)`.
 * "Refused" is only worth anything if NOTHING left the process: that single assertion is simultaneously
 * the SSRF property AND the credential-non-emission property (we do not scrub the Authorization header
 * for an internal target — we never dispatch the request that would carry it).
 *
 * Both dispatch paths are covered: the legacy in-call retry loop, and the #4196 class-B two-phase path
 * (flag ON + execution identity), which must be refused BEFORE its Tx A intent claim.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  AutomationExecutor,
  type AutomationDeps,
  type AutomationRule,
} from '../../src/multitable/automation-executor'
import { EventBus } from '../../src/integration/events/event-bus'
import { Logger } from '../../src/core/logger'
import { checkWebhookTargetUrl, type SsrfLookupFn } from '../../src/multitable/webhook-ssrf-guard'
import { classifyWebhookRefusal } from '../../src/multitable/webhook-refusal-class'

const CLASSB_FLAG = 'AUTOMATION_CLASSB_OUTBOUND_ENABLED'
const ROOT = 'exec_root_ssrf'
const TRIGGER = { recordId: 'rec_1', sheetId: 'sheet_1', actorId: 'user_1', data: {} }

/** TEST-NET-3 (RFC 5737): documentation-only, not routable. Public as far as the guard is concerned. */
const PUBLIC_ADDR = '203.0.113.10'
const PUBLIC_URL = `https://${PUBLIC_ADDR}/hook` // an IP LITERAL → the guard needs no DNS at all
const publicLookup: SsrfLookupFn = async () => [{ address: PUBLIC_ADDR, family: 4 }]

interface Harness {
  deps: AutomationDeps
  fetch: ReturnType<typeof vi.fn>
  /** Every SQL statement the executor issued — used to prove Tx A never ran on a refusal. */
  sql: string[]
  intentInserts: () => number
}

function makeHarness(opts: { lookup?: SsrfLookupFn; status?: number } = {}): Harness {
  const sql: string[] = []
  let intentInserts = 0
  const fetchSpy = vi.fn(async () => ({
    ok: (opts.status ?? 200) >= 200 && (opts.status ?? 200) < 300,
    status: opts.status ?? 200,
  }) as unknown as Response)
  const queryFn = vi.fn(async (text: string) => {
    const s = String(text)
    sql.push(s)
    if (/meta_automation_outbound_intent/i.test(s)) {
      if (/^\s*INSERT INTO/i.test(s)) {
        intentInserts++
        return { rows: [], rowCount: 1 } // claim succeeds → 'proceed'
      }
      return { rows: [], rowCount: 1 }
    }
    return { rows: [], rowCount: 0 }
  }) as unknown as AutomationDeps['queryFn']
  return {
    deps: {
      eventBus: new EventBus(),
      queryFn,
      fetchFn: fetchSpy as unknown as typeof fetch,
      ssrfLookupFn: opts.lookup ?? publicLookup,
    },
    fetch: fetchSpy,
    sql,
    intentInserts: () => intentInserts,
  }
}

function webhookRule(config: Record<string, unknown>): AutomationRule {
  return {
    id: 'rule_ssrf',
    name: 'SSRF rule',
    sheetId: 'sheet_1',
    trigger: { type: 'record.created', config: {} },
    actions: [{ type: 'send_webhook', config } as never],
    enabled: true,
    createdBy: 'user_1',
    createdAt: '2026-01-01T00:00:00Z',
  } as AutomationRule
}

async function runWebhook(h: Harness, config: Record<string, unknown>, rootId?: string) {
  const exec = await new AutomationExecutor(h.deps).execute(webhookRule(config), TRIGGER, undefined, rootId)
  return exec.steps[0]
}

/** Assert a refusal: failed step, coded error, the expected values-free class — and ZERO egress. */
function expectRefused(
  step: { status?: string; error?: string; output?: Record<string, unknown> } | undefined,
  h: Harness,
  refusalClass: string,
  hostFamily?: string,
) {
  expect(step?.status).toBe('failed')
  expect(step?.error).toBe(`WEBHOOK_TARGET_REJECTED:${refusalClass}`)
  expect(step?.output).toMatchObject({
    code: 'WEBHOOK_TARGET_REJECTED',
    refusalClass,
    dispatched: false,
  })
  if (hostFamily) expect(step?.output?.hostFamily).toBe(hostFamily)
  // THE assertion: nothing left the process.
  expect(h.fetch).toHaveBeenCalledTimes(0)
}

beforeEach(() => {
  delete process.env[CLASSB_FLAG]
})
afterEach(() => {
  delete process.env[CLASSB_FLAG]
  vi.restoreAllMocks()
})

describe('send_webhook SSRF gate — loopback targets are refused with zero egress', () => {
  it('refuses the IPv4 loopback literal 127.0.0.1 and never calls fetch', async () => {
    const h = makeHarness()
    expectRefused(await runWebhook(h, { url: 'https://127.0.0.1/hook' }), h, 'loopback', 'ipv4')
  })

  it('refuses a non-127.0.0.1 address inside 127/8 (the whole block, not just the canonical address)', async () => {
    const h = makeHarness()
    expectRefused(await runWebhook(h, { url: 'https://127.9.9.9/hook' }), h, 'loopback', 'ipv4')
  })

  it('refuses the name `localhost` without resolving it, and never calls fetch', async () => {
    const lookup = vi.fn(async () => [{ address: PUBLIC_ADDR, family: 4 }])
    const h = makeHarness({ lookup })
    expectRefused(await runWebhook(h, { url: 'https://localhost/hook' }), h, 'loopback', 'name')
    // Name-blocked BEFORE DNS: a resolver that lies about localhost cannot buy an egress.
    expect(lookup).toHaveBeenCalledTimes(0)
  })

  it('refuses the IPv6 loopback [::1] and never calls fetch', async () => {
    const h = makeHarness()
    expectRefused(await runWebhook(h, { url: 'https://[::1]/hook' }), h, 'loopback', 'ipv6')
  })
})

describe('send_webhook SSRF gate — private / link-local ranges are refused with zero egress', () => {
  it('refuses RFC1918 10/8 and never calls fetch', async () => {
    const h = makeHarness()
    expectRefused(await runWebhook(h, { url: 'https://10.1.2.3/hook' }), h, 'private', 'ipv4')
  })

  it('refuses RFC1918 172.16/12 and never calls fetch', async () => {
    const h = makeHarness()
    expectRefused(await runWebhook(h, { url: 'https://172.16.0.9/hook' }), h, 'private', 'ipv4')
  })

  it('refuses RFC1918 192.168/16 and never calls fetch', async () => {
    const h = makeHarness()
    expectRefused(await runWebhook(h, { url: 'https://192.168.1.10/hook' }), h, 'private', 'ipv4')
  })

  it('refuses the cloud metadata address 169.254.169.254 (link-local) and never calls fetch', async () => {
    const h = makeHarness()
    expectRefused(await runWebhook(h, { url: 'https://169.254.169.254/latest/meta-data/' }), h, 'link-local', 'ipv4')
  })

  it('refuses 0.0.0.0/8 "this host" and never calls fetch', async () => {
    const h = makeHarness()
    expectRefused(await runWebhook(h, { url: 'https://0.0.0.0/hook' }), h, 'unspecified', 'ipv4')
  })
})

describe('send_webhook SSRF gate — IPv6 unique-local, link-local and IPv4-mapped smuggling', () => {
  it('refuses IPv6 unique-local fc00::/7 and never calls fetch', async () => {
    const h = makeHarness()
    expectRefused(await runWebhook(h, { url: 'https://[fd00::1]/hook' }), h, 'unique-local', 'ipv6')
  })

  it('refuses IPv6 link-local fe80::/10 and never calls fetch', async () => {
    const h = makeHarness()
    expectRefused(await runWebhook(h, { url: 'https://[fe80::1]/hook' }), h, 'link-local', 'ipv6')
  })

  it('refuses a loopback IPv4 smuggled as an IPv4-mapped IPv6 literal, and labels the mapped family', async () => {
    const h = makeHarness()
    // Node normalises `::ffff:127.0.0.1` to the hex form `::ffff:7f00:1` — both the guard and the
    // classifier unwrap it, so the mapped form buys nothing.
    expectRefused(await runWebhook(h, { url: 'https://[::ffff:127.0.0.1]/hook' }), h, 'loopback', 'ipv4-mapped-ipv6')
  })

  it('refuses an RFC1918 address smuggled as an IPv4-mapped IPv6 literal', async () => {
    const h = makeHarness()
    expectRefused(await runWebhook(h, { url: 'https://[::ffff:10.0.0.5]/hook' }), h, 'private', 'ipv4-mapped-ipv6')
  })
})

describe('send_webhook SSRF gate — DNS-decided refusals', () => {
  it('refuses a public-looking name that RESOLVES to an internal address (fetch never called)', async () => {
    const lookup = vi.fn(async () => [{ address: '10.0.0.5', family: 4 }])
    const h = makeHarness({ lookup })
    expectRefused(await runWebhook(h, { url: 'https://hooks.example.com/x' }), h, 'dns-resolved-internal', 'name')
    expect(lookup).toHaveBeenCalledTimes(1) // it really did go through DNS to decide
  })

  it('refuses when only ONE of several resolved records is internal (multi-record names)', async () => {
    const lookup = vi.fn(async () => [
      { address: PUBLIC_ADDR, family: 4 },
      { address: '169.254.169.254', family: 4 },
    ])
    const h = makeHarness({ lookup })
    expectRefused(await runWebhook(h, { url: 'https://hooks.example.com/x' }), h, 'dns-resolved-internal', 'name')
  })

  it('refuses a name that resolves to an IPv4-mapped loopback record', async () => {
    const h = makeHarness({ lookup: async () => [{ address: '::ffff:127.0.0.1', family: 6 }] })
    expectRefused(await runWebhook(h, { url: 'https://hooks.example.com/x' }), h, 'dns-resolved-internal', 'name')
  })

  it('fails CLOSED when the name does not resolve at all (no send to an unknown target)', async () => {
    const h = makeHarness({ lookup: async () => { throw new Error('ENOTFOUND') } })
    expectRefused(await runWebhook(h, { url: 'https://nope.example.com/x' }), h, 'dns-unresolved', 'name')
  })

  it('fails CLOSED when the resolver returns an empty record set', async () => {
    const h = makeHarness({ lookup: async () => [] })
    expectRefused(await runWebhook(h, { url: 'https://nope.example.com/x' }), h, 'dns-unresolved', 'name')
  })
})

describe('send_webhook SSRF gate — malformed and non-https targets', () => {
  it('refuses a malformed URL and never calls fetch', async () => {
    const h = makeHarness()
    expectRefused(await runWebhook(h, { url: 'not a url' }), h, 'invalid-url', 'none')
  })

  it('refuses a non-string url and never calls fetch', async () => {
    const h = makeHarness()
    expectRefused(await runWebhook(h, { url: 12345 }), h, 'invalid-url', 'none')
  })

  it('refuses a non-https scheme on a public host (https-only, both egress paths)', async () => {
    const h = makeHarness()
    expectRefused(await runWebhook(h, { url: 'http://hooks.example.com/x' }), h, 'scheme-not-allowed', 'name')
  })

  it('labels `http://127.0.0.1` by its HOST SHAPE (loopback), the operator-actionable fact', async () => {
    const h = makeHarness()
    expectRefused(await runWebhook(h, { url: 'http://127.0.0.1/hook' }), h, 'loopback', 'ipv4')
  })

  it('refuses a non-http(s) scheme (file:) and never calls fetch', async () => {
    const h = makeHarness()
    const step = await runWebhook(h, { url: 'file:///etc/passwd' })
    expect(step?.status).toBe('failed')
    expect(step?.error).toMatch(/^WEBHOOK_TARGET_REJECTED:/)
    expect(h.fetch).toHaveBeenCalledTimes(0)
  })

  it('refuses an internal-by-name host (*.internal) without resolving it', async () => {
    const lookup = vi.fn(async () => [{ address: PUBLIC_ADDR, family: 4 }])
    const h = makeHarness({ lookup })
    expectRefused(await runWebhook(h, { url: 'https://vault.internal/hook' }), h, 'internal-name', 'name')
    expect(lookup).toHaveBeenCalledTimes(0)
  })
})

describe('send_webhook SSRF gate — POSITIVE control: a public target is still dispatched unchanged', () => {
  it('sends to a public IP literal exactly once, with the configured headers and body verbatim', async () => {
    const h = makeHarness()
    const step = await runWebhook(h, {
      url: PUBLIC_URL,
      method: 'PUT',
      headers: { Authorization: 'Bearer PUBLIC-OK-TOKEN', 'X-Custom': 'keep-me' },
      body: { hello: 'world' },
    })

    expect(step?.status).toBe('success')
    expect(h.fetch).toHaveBeenCalledTimes(1)
    const [calledUrl, init] = h.fetch.mock.calls[0] as unknown as [string, RequestInit]
    expect(calledUrl).toBe(PUBLIC_URL)
    expect(init.method).toBe('PUT')
    // Headers pass through byte-for-byte — the gate decides WHETHER to send, never rewrites what is sent.
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer PUBLIC-OK-TOKEN')
    expect((init.headers as Record<string, string>)['X-Custom']).toBe('keep-me')
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json')
    expect(init.body).toBe(JSON.stringify({ hello: 'world' }))
  })

  it('sends to a public NAME whose every resolved record is public (one fetch, one lookup)', async () => {
    const lookup = vi.fn(async () => [{ address: PUBLIC_ADDR, family: 4 }, { address: '2606:4700::1111', family: 6 }])
    const h = makeHarness({ lookup })
    const step = await runWebhook(h, { url: 'https://hooks.example.com/x' })
    expect(step?.status).toBe('success')
    expect(h.fetch).toHaveBeenCalledTimes(1)
    expect(lookup).toHaveBeenCalledTimes(1)
  })
})

describe('send_webhook SSRF gate — stored credentials are never emitted at an internal target', () => {
  const CREDENTIALED = {
    url: 'https://user:pw@127.0.0.1:8443/internal/hook?token=SUPERSECRETQUERY',
    headers: { Authorization: 'Bearer LEAKME-TOKEN-123', Cookie: 'session=LEAKME-COOKIE' },
    secret: 'HMAC-LEAKME-SECRET',
  }
  /** Everything that must never appear in a log line or in the persisted step result. */
  const FORBIDDEN = [
    '127.0.0.1',
    'SUPERSECRETQUERY',
    'LEAKME-TOKEN-123',
    'LEAKME-COOKIE',
    'HMAC-LEAKME-SECRET',
    'user:pw',
    'internal/hook',
    'Bearer',
    '8443',
  ]

  it('does not call fetch at all — so the Authorization/Cookie headers are never dispatched', async () => {
    const h = makeHarness()
    const step = await runWebhook(h, CREDENTIALED)
    expect(step?.status).toBe('failed')
    expect(h.fetch).toHaveBeenCalledTimes(0)
    expect(h.fetch.mock.calls).toHaveLength(0)
  })

  it('VALUES-FREE: the refusal log carries only the code + host shape, never the URL or a header value', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined)
    const h = makeHarness()
    await runWebhook(h, CREDENTIALED)

    const refusalLogs = warn.mock.calls.filter((c) => String(c[0]).includes('send_webhook.refused'))
    expect(refusalLogs).toHaveLength(1)
    const serialized = JSON.stringify(refusalLogs[0])
    for (const secret of FORBIDDEN) expect(serialized).not.toContain(secret)
    // ...and it is still USEFUL: code + class are present, so an operator can triage without the value.
    expect(serialized).toContain('WEBHOOK_TARGET_REJECTED')
    expect(serialized).toContain('loopback')
  })

  it('VALUES-FREE: the persisted step result carries only the code + host shape', async () => {
    const h = makeHarness()
    const step = await runWebhook(h, CREDENTIALED)
    const serialized = JSON.stringify(step)
    for (const secret of FORBIDDEN) expect(serialized).not.toContain(secret)
    expect(serialized).toContain('WEBHOOK_TARGET_REJECTED')
    expect(serialized).toContain('loopback')
  })

  /**
   * SCOPED DELIBERATELY — do NOT widen this to `JSON.stringify(exec)`. The execution object also carries
   * `ruleSnapshot`, i.e. the rule EXACTLY as supplied, so the raw `config.url` / `config.headers` are in
   * there. That carrier is pre-existing and unrelated to this gate (it is populated on every run,
   * refused or not) and is scrubbed by `redactValue` at persist time
   * (`automation-log-service.ts` → `rule_snapshot`). Asserting "the whole object leaks nothing" would be
   * a false claim about code this change does not own; assert what the gate DOES own instead, and pin
   * that the raw values do not spread anywhere ELSE in the execution.
   */
  it('VALUES-FREE: the gate-owned surfaces (steps + run error + triggerEvent) leak nothing', async () => {
    const h = makeHarness()
    const exec = await new AutomationExecutor(h.deps).execute(webhookRule(CREDENTIALED), TRIGGER)

    const owned = JSON.stringify({
      steps: exec.steps,
      status: exec.status,
      error: (exec as { error?: string }).error,
    })
    for (const secret of FORBIDDEN) expect(owned).not.toContain(secret)

    // Everything in the execution EXCEPT the pre-existing rule snapshot must also be clean — so a future
    // change that starts copying the target URL into a step/output/trigger field reds this test.
    const withoutSnapshot = JSON.stringify({ ...exec, ruleSnapshot: undefined })
    for (const secret of FORBIDDEN) expect(withoutSnapshot).not.toContain(secret)
  })
})

describe('send_webhook SSRF gate — the class-B two-phase path (#4196) is gated too', () => {
  beforeEach(() => {
    process.env[CLASSB_FLAG] = 'true'
  })

  it('POSITIVE control: flag ON + identity + public target → intent claimed (Tx A) and one fetch', async () => {
    const h = makeHarness()
    const step = await runWebhook(h, { url: PUBLIC_URL }, ROOT)
    expect(step?.status).toBe('success')
    expect(h.fetch).toHaveBeenCalledTimes(1)
    expect(h.intentInserts()).toBe(1) // proves this harness DOES reach Tx A when not refused
  })

  it('refuses an internal target BEFORE Tx A: no intent row claimed, no fetch', async () => {
    const h = makeHarness()
    const step = await runWebhook(h, { url: 'https://10.1.2.3/hook' }, ROOT)
    expectRefused(step, h, 'private', 'ipv4')
    // Refused before the outbound-intent claim — a refusal must not burn an at-most-once claim, or a
    // later (legitimately re-pointed) rule run would be short-circuited as "already attempted".
    expect(h.intentInserts()).toBe(0)
    expect(h.sql.filter((s) => /meta_automation_outbound_intent/i.test(s))).toHaveLength(0)
  })

  it('refuses a DNS-resolved-internal target on the two-phase path too, before Tx A', async () => {
    const h = makeHarness({ lookup: async () => [{ address: '192.168.0.7', family: 4 }] })
    const step = await runWebhook(h, { url: 'https://hooks.example.com/x' }, ROOT)
    expectRefused(step, h, 'dns-resolved-internal', 'name')
    expect(h.intentInserts()).toBe(0)
  })

  it('refuses loopback on the two-phase path with the credentialed config, still zero egress', async () => {
    const h = makeHarness()
    const step = await runWebhook(
      h,
      { url: 'https://127.0.0.1/hook', headers: { Authorization: 'Bearer LEAKME' } },
      ROOT,
    )
    expectRefused(step, h, 'loopback', 'ipv4')
    expect(h.intentInserts()).toBe(0)
  })
})

describe('send_webhook SSRF gate — refusal is terminal (no retry loop re-attempt)', () => {
  it('does not re-attempt a refused target even though the legacy path retries transport failures', async () => {
    const h = makeHarness({ status: 500 })
    // Control: a 500 on a PUBLIC target exercises the retry loop (more than one fetch).
    const ok = await runWebhook(h, { url: PUBLIC_URL })
    expect(ok?.status).toBe('failed')
    expect(h.fetch.mock.calls.length).toBeGreaterThan(1)

    // Refusal: not one attempt, let alone retries.
    const h2 = makeHarness({ status: 500 })
    expectRefused(await runWebhook(h2, { url: 'https://10.0.0.1/hook' }), h2, 'private', 'ipv4')
  })
})

/**
 * COUPLING TRIPWIRE. The classifier maps the guard's rejection `reason` strings for the two outcomes it
 * cannot read off the URL (scheme / DNS). If the guard reworded those strings, the classifier would
 * silently degrade to `internal-other` and the refusal-class table in the docs would rot — while every
 * test above still passed, because the REFUSAL itself would be unchanged. Pin the strings.
 */
describe('send_webhook SSRF gate — guard/classifier contract', () => {
  const noLookup: SsrfLookupFn = async () => {
    throw new Error('lookup must not be called')
  }

  it('pins the guard reason strings the classifier depends on', async () => {
    const scheme = await checkWebhookTargetUrl('http://hooks.example.com/x', noLookup)
    expect((scheme as { reason: string }).reason.startsWith('scheme not allowed')).toBe(true)

    const unresolved = await checkWebhookTargetUrl('https://nope.example.com/x', async () => [])
    expect((unresolved as { reason: string }).reason).toBe('target host did not resolve')

    const internal = await checkWebhookTargetUrl('https://evil.example.com/x', async () => [{ address: '10.0.0.5', family: 4 }])
    expect((internal as { reason: string }).reason).toBe('target resolves to an internal address')
  })

  it('the classifier never returns anything but closed-set tokens (no free-text field to leak into)', () => {
    const CLASSES = new Set([
      'invalid-url', 'scheme-not-allowed', 'loopback', 'private', 'link-local', 'unique-local',
      'unspecified', 'internal-name', 'dns-resolved-internal', 'dns-unresolved', 'internal-other',
    ])
    const FAMILIES = new Set(['ipv4', 'ipv6', 'ipv4-mapped-ipv6', 'name', 'none'])
    const samples: Array<[unknown, string | undefined]> = [
      ['https://user:pw@127.0.0.1/secret?token=abc', 'target IP is internal'],
      ['https://[fd00::1]/x', 'target IP is internal'],
      ['https://hooks.example.com/x', 'target resolves to an internal address'],
      ['http://hooks.example.com/x', 'scheme not allowed: http: (https only)'],
      ['not a url', 'URL is malformed'],
      [undefined, 'URL is required'],
      ['https://weird.example.com/x', 'a reason nobody has written yet'],
    ]
    for (const [url, reason] of samples) {
      const r = classifyWebhookRefusal(url, reason)
      expect(Object.keys(r).sort()).toEqual(['code', 'hostFamily', 'refusalClass'])
      expect(r.code).toBe('WEBHOOK_TARGET_REJECTED')
      expect(CLASSES.has(r.refusalClass)).toBe(true)
      expect(FAMILIES.has(r.hostFamily)).toBe(true)
      // Nothing from the input survives into the label.
      expect(JSON.stringify(r)).not.toContain('token=abc')
      expect(JSON.stringify(r)).not.toContain('user:pw')
    }
    // An unrecognised guard reason degrades the LABEL only — it is still a refusal.
    expect(classifyWebhookRefusal('https://weird.example.com/x', 'brand new reason').refusalClass)
      .toBe('internal-other')
  })
})
