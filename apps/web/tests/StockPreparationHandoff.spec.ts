import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, ref, type App as VueApp, type Component } from 'vue'

// 通知下一步 — the light multi-person handoff on the confirmation-queue workbench.
//
// WHAT THIS SUITE IS FOR. Several people each fill their own fields on a project's prep rows, in
// order. Whoever finishes presses 通知下一步; the turn moves on one notch and the group chat is told
// who is up. The last step additionally tells 仓库/采购.
//
// THE CONTROL IS A TURN SIGNAL, NOT A GUARD — the server re-checks the caller is the current handler
// and answers 403 regardless of what the template rendered. That is precisely why this file has to
// exist rather than leaning on the F-04 permission matrix: `handoff.read`/`handoff.advance` carry
// `control: null` in the shared manifest because their visibility is gated on RUNTIME TURN STATE as
// well as on permission, so "rendered == granted" is FALSE for them by design (a permitted principal
// who is not whose-turn-it-is correctly sees nothing). F-04 would red for a correct UI. The ten
// witnesses below cover what F-04 cannot:
//
//   H-01 not the current handler ⇒ no button, even holding read+operate
//   H-02 current handler + read+operate ⇒ button
//   H-03 read-only ⇒ no button, even when it IS their turn
//   H-04 a deployment with no chain configured ⇒ no button and no status line
//   H-05 a successful advance speaks a sentence, not an enum
//   H-06 an idempotent replay reads as a replay, not as an error
//   H-07 403 NOT_CURRENT_HANDLER renders its plain sentence, code subordinate
//   H-08 notifyOutcome 'failed' says the turn MOVED and the message did NOT go out
//   H-09 the terminal step's label names 仓库/采购
//   H-10 a rejected status read leaves the queue working and the control gone (fail soft)

const h = vi.hoisted(() => ({
  locale: 'zh-CN' as string,
  permissions: [] as string[],
  roles: [] as string[],
  apiFetch: vi.fn(),
}))

vi.mock('../src/composables/useLocale', () => ({
  useLocale: () => ({
    locale: ref(h.locale),
    isZh: ref(h.locale === 'zh-CN'),
    setLocale: vi.fn(),
  }),
}))

// The REAL `useAuth().hasPermission` semantics over an injectable snapshot, reproduced verbatim from
// stockPrepPermissionMatrix.spec.ts rather than stubbed to a constant: the operate tier is a
// CONJUNCTION (operate AND read), and H-03's whole point is that a read-only principal fails it.
// A constant probe would make that witness vacuous.
function realHasPermission(required: string): boolean {
  const normalized = String(required || '').trim()
  if (!normalized) return true
  const isAdmin = h.roles.includes('admin')
    || h.permissions.includes('*:*')
    || h.permissions.includes('admin:all')
  if (isAdmin || h.roles.includes('admin')) return true
  if (h.permissions.includes(normalized) || h.permissions.includes('*:*')) return true
  const [resource, action] = normalized.split(':')
  if (!resource || !action) return false
  if (h.permissions.includes(`${resource}:*`)) return true
  if (h.permissions.includes(`${resource}:admin`) && action !== 'admin') return true
  if (action === 'read' && h.permissions.includes(`${resource}:write`)) return true
  return false
}

vi.mock('../src/composables/useAuth', () => ({
  useAuth: () => ({
    hasPermission: (permission: string) => realHasPermission(permission),
    hasAdminAccess: () => h.roles.includes('admin'),
    getAccessSnapshot: () => ({ isAdmin: h.roles.includes('admin'), roles: h.roles, permissions: h.permissions }),
  }),
}))

// The network is mocked at the SAME boundary stockPreparationConfirmationQueue.spec.ts uses —
// `apiFetch` in utils/api — so the real confirmationQueue.ts client (its URL building, its envelope
// parsing and its error clamping) is under test rather than stubbed out from underneath.
vi.mock('../src/utils/api', async () => {
  const actual = await vi.importActual<typeof import('../src/utils/api')>('../src/utils/api')
  return { ...actual, apiFetch: h.apiFetch }
})

import {
  STOCK_PREP_ADMIN,
  STOCK_PREP_OPERATE,
  STOCK_PREP_READ,
  STOCK_PREP_WORKBENCH_CAPABILITIES,
} from '../src/services/integration/stockPreparation/workbenchAccess'
import {
  STOCK_PREP_ERROR_PLAIN,
  STOCK_PREP_HANDOFF_OUTCOME_PLAIN,
  STOCK_PREP_HANDOFF_STEP_PLAIN,
} from '../src/services/integration/stockPreparation/plainLanguage'
import StockPreparationConfirmationQueueView from '../src/components/integration/stockPreparation/StockPreparationConfirmationQueueView.vue'

const SCOPE = { tenantId: 'tenant-a', workspaceId: 'workspace-default' }
const PROJECT_NO = '230920006'

const ADVANCE_PATH = '/stock-preparation/handoff/advance'
const HANDOFF_PATH = '/stock-preparation/handoff'

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status })
}

/** One pending decision, values-free — enough for the queue to be POPULATED, which H-10 leans on. */
function queuePayload(): Record<string, unknown> {
  return {
    rowCount: 1,
    byStatus: { pending: 1 },
    byResolutionAction: {},
    parkedCount: 0,
    rows: [{
      decisionId: 'decision_1',
      conflictType: 'duplicate_expanded_key',
      status: 'pending',
      resolutionAction: null,
      inputFingerprint: 'sha16:0123456789abcdef',
      sourceRevisionPresent: true,
      confirmedByPresent: false,
      confirmedAtPresent: false,
      notesPresent: false,
      resolvedValuePresent: false,
      resolvedAuxValuePresent: false,
    }],
  }
}

/** The GET /handoff shape. Values-free: step keys, indices, booleans and a handler COUNT. */
function handoffStatus(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    configured: true,
    projectNo: PROJECT_NO,
    steps: [
      { key: 'prep_entry', order: 0, handlerCount: 1 },
      { key: 'process', order: 1, handlerCount: 2 },
      { key: 'final_review', order: 2, handlerCount: 1 },
    ],
    stepCount: 3,
    stepIndex: 0,
    currentStepKey: 'prep_entry',
    terminal: false,
    completed: false,
    isCurrentHandler: true,
    notifiedStepIndex: null,
    ...overrides,
  }
}

/** The contract's inert answer: a deployment that has never set a chain up. Still a 200. */
function handoffNotConfigured(): Record<string, unknown> {
  return {
    configured: false,
    projectNo: PROJECT_NO,
    steps: [],
    stepCount: 0,
    stepIndex: null,
    currentStepKey: null,
    terminal: false,
    completed: false,
    isCurrentHandler: false,
    notifiedStepIndex: null,
  }
}

function advanceResult(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    projectNo: PROJECT_NO,
    fromStepKey: 'prep_entry',
    currentStepKey: 'process',
    stepIndex: 1,
    stepCount: 3,
    changed: true,
    terminal: false,
    notified: true,
    notifyOutcome: 'sent',
    ...overrides,
  }
}

interface ServeConfig {
  /** Called once per GET /handoff, in order; the LAST entry serves every further call. */
  handoff?: Array<() => Response | Promise<Response>>
  advance?: () => Response | Promise<Response>
}

function serve(config: ServeConfig): void {
  let handoffCall = 0
  h.apiFetch.mockImplementation(async (url: string) => {
    const target = String(url)
    if (target.includes(ADVANCE_PATH)) {
      if (!config.advance) throw new Error(`unexpected advance call: ${target}`)
      return config.advance()
    }
    if (target.includes(HANDOFF_PATH)) {
      const steps = config.handoff ?? [() => json({ ok: true, data: handoffStatus() })]
      const step = steps[Math.min(handoffCall, steps.length - 1)]
      handoffCall += 1
      return step()
    }
    return json({ ok: true, data: queuePayload() })
  })
}

/** Drain the pending fetch/microtask chain and the Vue render queue. */
async function flush(): Promise<void> {
  for (let turn = 0; turn < 5; turn += 1) {
    await new Promise((done) => { setTimeout(done, 0) })
    await nextTick()
  }
}

describe('通知下一步 — the multi-person handoff on the confirmation queue', () => {
  let app: VueApp | null = null
  let container: HTMLDivElement | null = null

  beforeEach(() => {
    h.locale = 'zh-CN'
    h.roles = []
    h.permissions = []
    h.apiFetch.mockReset()
    serve({})
    container = document.createElement('div')
    document.body.appendChild(container)
  })

  afterEach(() => {
    if (app) app.unmount()
    if (container) container.remove()
    app = null
    container = null
    vi.clearAllMocks()
  })

  function asActor(permissions: string[]): void {
    h.roles = []
    h.permissions = [...permissions]
  }

  /**
   * Mount and drive the view to its LOADED state. The turn signal rides the queue refresh — this
   * view has no watcher and no onMounted, it loads when the operator presses 刷新列表 — so pressing
   * refresh is what makes the handoff status known, exactly as it is in the app.
   */
  async function render(): Promise<HTMLElement> {
    app = createApp(StockPreparationConfirmationQueueView as Component, { scope: SCOPE, projectNo: PROJECT_NO })
    app.mount(container!)
    await nextTick()
    await pressRefresh()
    return container!
  }

  async function pressRefresh(): Promise<void> {
    const refresh = container!.querySelector('[data-testid="stock-prep-confirmation-queue-refresh"]') as HTMLButtonElement | null
    expect(refresh, 'the queue refresh control must exist — every actor in this suite holds stock-prep:read').not.toBeNull()
    refresh!.click()
    await flush()
  }

  function advanceButton(): HTMLButtonElement | null {
    return container!.querySelector('[data-testid="stock-prep-handoff-advance"]') as HTMLButtonElement | null
  }

  function statusLine(): HTMLElement | null {
    return container!.querySelector('[data-testid="stock-prep-handoff-status"]') as HTMLElement | null
  }

  function noticeLine(): HTMLElement | null {
    return container!.querySelector('[data-testid="stock-prep-handoff-notice"]') as HTMLElement | null
  }

  function errorLine(): HTMLElement | null {
    return container!.querySelector('[data-testid="stock-prep-confirmation-error"]') as HTMLElement | null
  }

  function rowCount(): number {
    return container!.querySelectorAll('[data-testid="stock-prep-confirmation-row"]').length
  }

  // ---------------------------------------------------------------------------
  // The manifest pair the F-04 matrix cannot measure
  // ---------------------------------------------------------------------------

  it('H-00: the two handoff capabilities are in the shared manifest with control: null (F-04 cannot measure a runtime-gated control)', () => {
    const read = STOCK_PREP_WORKBENCH_CAPABILITIES.find((capability) => capability.capability === 'handoff.read')
    const advance = STOCK_PREP_WORKBENCH_CAPABILITIES.find((capability) => capability.capability === 'handoff.advance')
    expect(read).toBeDefined()
    expect(advance).toBeDefined()
    expect(read).toMatchObject({
      code: STOCK_PREP_READ,
      method: 'GET',
      path: '/api/integration/stock-preparation/handoff',
      control: null,
    })
    expect(advance).toMatchObject({
      code: STOCK_PREP_OPERATE,
      method: 'POST',
      path: '/api/integration/stock-preparation/handoff/advance',
      control: null,
    })
  })

  // ---------------------------------------------------------------------------
  // H-01 .. H-04 — who sees the button
  // ---------------------------------------------------------------------------

  it('H-01: the button is ABSENT when it is not the caller’s turn, even holding stock-prep read+operate', async () => {
    asActor([STOCK_PREP_READ, STOCK_PREP_OPERATE])
    serve({ handoff: [() => json({ ok: true, data: handoffStatus({ isCurrentHandler: false, currentStepKey: 'process', stepIndex: 1 }) })] })
    await render()

    // Positive control: the status DID load and the chain IS configured, so the absence below is the
    // turn state at work and not an unloaded page.
    expect(statusLine(), 'the status line must render for anyone who can read the turn').not.toBeNull()
    expect(statusLine()!.textContent).toContain(STOCK_PREP_HANDOFF_STEP_PLAIN.process.zh)

    expect(advanceButton(), 'a permitted principal who is not the current handler must see no button').toBeNull()
  })

  it('H-02: the button is PRESENT when it IS the caller’s turn and they hold read+operate', async () => {
    asActor([STOCK_PREP_READ, STOCK_PREP_OPERATE])
    serve({ handoff: [() => json({ ok: true, data: handoffStatus() })] })
    await render()

    const button = advanceButton()
    expect(button).not.toBeNull()
    expect(button!.textContent).toContain('通知下一步')
    expect(statusLine()!.textContent).toContain(STOCK_PREP_HANDOFF_STEP_PLAIN.prep_entry.zh)
  })

  it('H-03: the button is ABSENT for a read-only principal even when it IS their turn', async () => {
    asActor([STOCK_PREP_READ])
    serve({ handoff: [() => json({ ok: true, data: handoffStatus({ isCurrentHandler: true }) })] })
    await render()

    // Positive control again: this actor CAN read the turn, so the status renders...
    expect(statusLine(), 'stock-prep:read alone still reads the turn signal').not.toBeNull()
    // ...and the advance, which is the OPERATE tier (a conjunction of operate AND read), does not.
    expect(advanceButton(), 'stock-prep:read alone must not offer the advance').toBeNull()
  })

  it('H-04: a deployment with NO chain configured renders neither the button nor a status line', async () => {
    asActor([STOCK_PREP_READ, STOCK_PREP_OPERATE])
    serve({ handoff: [() => json({ ok: true, data: handoffNotConfigured() })] })
    await render()

    expect(statusLine(), 'configured:false must render no turn line at all').toBeNull()
    expect(advanceButton(), 'configured:false must render no control').toBeNull()
    // ...and the queue itself is untouched by the feature being inert.
    expect(rowCount()).toBe(1)
  })

  // ---------------------------------------------------------------------------
  // H-05 .. H-08 — what the operator is told afterwards
  // ---------------------------------------------------------------------------

  it('H-05: a successful advance renders a plain-language notice — a sentence, never a bare enum', async () => {
    asActor([STOCK_PREP_READ, STOCK_PREP_OPERATE])
    serve({
      handoff: [
        () => json({ ok: true, data: handoffStatus() }),
        () => json({ ok: true, data: handoffStatus({ stepIndex: 1, currentStepKey: 'process', isCurrentHandler: false }) }),
      ],
      advance: () => json({ ok: true, data: advanceResult({ notifyOutcome: 'sent' }) }),
    })
    await render()
    advanceButton()!.click()
    await flush()

    const notice = noticeLine()
    expect(notice).not.toBeNull()
    const text = notice!.textContent ?? ''
    expect(text).toContain(STOCK_PREP_HANDOFF_OUTCOME_PLAIN.sent.zh)
    // The enum is present but SUBORDINATE — inside a <code>, never the whole of the message.
    expect(text.trim()).not.toBe('sent')
    expect(notice!.querySelector('code')?.textContent).toBe('sent')
    expect(errorLine(), 'a successful advance is not an error').toBeNull()

    // The turn moved on, so the button is gone and the status line follows the re-read.
    expect(statusLine()!.textContent).toContain(STOCK_PREP_HANDOFF_STEP_PLAIN.process.zh)
    expect(advanceButton()).toBeNull()
  })

  it('H-06: an idempotent replay (changed: false) reads as a replay, not as an error', async () => {
    asActor([STOCK_PREP_READ, STOCK_PREP_OPERATE])
    serve({
      handoff: [() => json({ ok: true, data: handoffStatus() })],
      advance: () => json({ ok: true, data: advanceResult({ changed: false, notified: false, notifyOutcome: 'skipped' }) }),
    })
    await render()
    advanceButton()!.click()
    await flush()

    const notice = noticeLine()
    expect(notice).not.toBeNull()
    expect(notice!.textContent).toContain('这一步之前已经交接过了,没有重复通知。')
    expect(errorLine(), 'a replay is not a failure and must not render as one').toBeNull()
  })

  it('H-07: a 403 NOT_CURRENT_HANDLER renders its plain sentence, with the code kept subordinate', async () => {
    asActor([STOCK_PREP_READ, STOCK_PREP_OPERATE])
    serve({
      handoff: [() => json({ ok: true, data: handoffStatus() })],
      advance: () => json({
        ok: false,
        error: { code: 'STOCK_PREPARATION_HANDOFF_NOT_CURRENT_HANDLER', message: 'not the current handler', details: {} },
      }, 403),
    })
    await render()
    advanceButton()!.click()
    await flush()

    const error = errorLine()
    expect(error).not.toBeNull()
    const text = error!.textContent ?? ''
    expect(text).toContain(STOCK_PREP_ERROR_PLAIN.STOCK_PREPARATION_HANDOFF_NOT_CURRENT_HANDLER.zh)
    expect(text).toContain('现在不是您这一步')
    // The code a person quotes when asking us for help — present, and subordinate to the sentence.
    expect(error!.querySelector('code')?.textContent).toBe('STOCK_PREPARATION_HANDOFF_NOT_CURRENT_HANDLER')
    expect(noticeLine(), 'a refused advance must not also claim a handoff happened').toBeNull()
  })

  it('H-08: notifyOutcome "failed" says the turn DID move and the message did NOT go out', async () => {
    asActor([STOCK_PREP_READ, STOCK_PREP_OPERATE])
    serve({
      handoff: [
        () => json({ ok: true, data: handoffStatus() }),
        () => json({ ok: true, data: handoffStatus({ stepIndex: 1, currentStepKey: 'process', isCurrentHandler: false }) }),
      ],
      advance: () => json({ ok: true, data: advanceResult({ notified: false, notifyOutcome: 'failed' }) }),
    })
    await render()
    advanceButton()!.click()
    await flush()

    const text = noticeLine()?.textContent ?? ''
    // BOTH halves, specifically. "通知失败" alone would read as "the handoff did not happen" and the
    // operator would press the button again; the honest sentence has to separate the two facts.
    expect(text).toContain('已经交给下一步了')
    expect(text).toContain('群里的消息没有发出去')
    expect(text).toContain('请您自己跟下一位说一声')
    expect(text).not.toBe('failed')
  })

  // ---------------------------------------------------------------------------
  // H-09 the last step, H-10 fail-soft
  // ---------------------------------------------------------------------------

  it('H-09: the terminal step’s label names 仓库/采购, not "the next person"', async () => {
    asActor([STOCK_PREP_READ, STOCK_PREP_OPERATE])
    serve({
      handoff: [() => json({
        ok: true,
        data: handoffStatus({ stepIndex: 2, currentStepKey: 'final_review', terminal: true }),
      })],
    })
    await render()

    const label = advanceButton()?.textContent ?? ''
    expect(label).toContain('仓库')
    expect(label).toContain('采购')
    expect(label).not.toContain('通知下一步')
  })

  it('H-10: a REJECTED handoff read leaves the queue working and the control gone (fail soft)', async () => {
    asActor([STOCK_PREP_READ, STOCK_PREP_OPERATE])

    // (a) The very first read blows up — a backend that predates this route, or a bad minute.
    serve({ handoff: [() => { throw new Error('handoff endpoint exploded') }] })
    await render()
    expect(rowCount(), 'the only page a floor operator has must keep working').toBe(1)
    expect(container!.querySelector('[data-testid="stock-prep-confirmation-counts"]')).not.toBeNull()
    expect(statusLine()).toBeNull()
    expect(advanceButton()).toBeNull()
    expect(errorLine(), 'an absent turn signal is not a queue error').toBeNull()

    // (b) ...and a read that fails AFTER a good one resets to inert rather than leaving a stale
    // control on screen that the operator would press against state nobody can vouch for.
    serve({
      handoff: [
        () => json({ ok: true, data: handoffStatus() }),
        () => { throw new Error('handoff endpoint exploded') },
      ],
    })
    await pressRefresh()
    expect(advanceButton(), 'the good read must render the control').not.toBeNull()
    await pressRefresh()
    expect(advanceButton(), 'the failed re-read must clear it, not keep the stale one').toBeNull()
    expect(statusLine()).toBeNull()
    expect(rowCount()).toBe(1)
  })

  // ---------------------------------------------------------------------------
  // The request the advance actually sends
  // ---------------------------------------------------------------------------

  it('H-11: the advance POSTs exactly the four allowlisted body keys (the server REFUSES extras, 400)', async () => {
    asActor([STOCK_PREP_READ, STOCK_PREP_OPERATE])
    serve({
      handoff: [() => json({ ok: true, data: handoffStatus() })],
      advance: () => json({ ok: true, data: advanceResult() }),
    })
    await render()
    advanceButton()!.click()
    await flush()

    const call = h.apiFetch.mock.calls.find(([url]) => String(url).includes(ADVANCE_PATH))
    expect(call).toBeDefined()
    const options = call![1] as { method?: string; body?: string }
    expect(options.method).toBe('POST')
    const body = JSON.parse(String(options.body)) as Record<string, unknown>
    expect(Object.keys(body).sort()).toEqual(['fromStepKey', 'projectNo', 'tenantId', 'workspaceId'])
    expect(body.projectNo).toBe(PROJECT_NO)
    expect(body.fromStepKey).toBe('prep_entry')

    // ...and the read is a plain GET whose query is separated from the path by "?" (the O1 bug).
    const readCall = h.apiFetch.mock.calls.find(([url]) => {
      const target = String(url)
      return target.includes(HANDOFF_PATH) && !target.includes(ADVANCE_PATH)
    })
    expect(String(readCall![0])).toContain('/api/integration/stock-preparation/handoff?')
    expect(String(readCall![0])).toContain(`projectNo=${PROJECT_NO}`)
    expect(readCall![1]).toBeUndefined()
  })

  /**
   * P3 pin. H-11 above asserts `fromStepKey === 'prep_entry'` — which is also the FIXTURE DEFAULT,
   * so a regression that hard-coded the first step (or read `steps[0].key`) would sail past it. The
   * whole compare-and-set story depends on this being the step the SERVER currently holds: send the
   * wrong one and the server answers 409 STEP_MISMATCH for a click that was perfectly legitimate,
   * or — worse, if the chain happened to be there — advances a step the operator was not on.
   * So: drive the view at a chain that is at `process`, and require the body to say `process`.
   */
  it('H-14: the advance sends the CURRENT step key, not a constant that happens to match', async () => {
    asActor([STOCK_PREP_READ, STOCK_PREP_OPERATE])
    serve({
      handoff: [() => json({
        ok: true,
        data: handoffStatus({ stepIndex: 1, currentStepKey: 'process', isCurrentHandler: true }),
      })],
      advance: () => json({ ok: true, data: advanceResult({ fromStepKey: 'process' }) }),
    })
    await render()
    advanceButton()!.click()
    await flush()

    const call = h.apiFetch.mock.calls.find(([url]) => String(url).includes(ADVANCE_PATH))
    expect(call, 'the advance was actually POSTed').toBeDefined()
    const body = JSON.parse(String((call![1] as { body?: string }).body)) as Record<string, unknown>
    expect(body.fromStepKey).toBe('process')
  })

  it('H-13: a COMPLETED chain says so in words and offers no further advance', async () => {
    asActor([STOCK_PREP_READ, STOCK_PREP_OPERATE])
    serve({
      handoff: [() => json({
        ok: true,
        // The contract's end state: past the last step. `isCurrentHandler` stays true here on
        // purpose — the ONLY thing withholding the button must be `completed`.
        data: handoffStatus({
          stepIndex: 2,
          currentStepKey: 'final_review',
          terminal: true,
          completed: true,
          isCurrentHandler: true,
        }),
      })],
    })
    await render()

    expect(statusLine()!.textContent).toContain('这个项目的备料接力已经走完。')
    expect(advanceButton(), 'a finished chain must not offer another advance').toBeNull()
  })

  it('H-12: a workbench admin (stock-prep:admin) satisfies both tiers and sees the control on their turn', async () => {
    asActor([STOCK_PREP_ADMIN])
    serve({ handoff: [() => json({ ok: true, data: handoffStatus() })] })
    await render()
    expect(advanceButton()).not.toBeNull()
  })
})
