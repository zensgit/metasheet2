import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

// BOM备料 INSTALL RUN — the pure half.
//
// The install page's run is a UI over routes that already exist, and its ONE piece of real logic is
// how it decides OK / SKIP / FAIL. That decision is what this suite drives, with no DOM and no fetch.
//
// Guards (each RED-witnessed by mutation; see the PR body's mutation table):
//   I-01 the step ORDER is the bootstrap script's STEP_PLAN order, extracted from that file — so the
//        load-bearing placement of `confirmation-queue` BEFORE the acceptance trio cannot be
//        reordered here without reddening
//   I-02 a HELD step is always SKIP — never OK (which would hide outstanding human work) and never
//        FAIL (which would invent a failure that did not happen)
//   I-03 the preflight classification: ready -> OK, route absent -> SKIP, http-fixable blockers ->
//        SKIP (the very ensures the next steps make), any env/deployment-data blocker -> FAIL
//   I-04 `fix.run` lines are carried through VERBATIM
//   I-05 an empty pack catalog SKIPs both provisioning steps and the run still PASSES
//   I-06 the run stops at the first FAIL and returns everything that completed
//   I-07 a run of nothing but SKIPs passes — held is not broken
//   I-08 VALUES-FREE: business values planted on every response never reach a step result

import {
  STOCK_PREPARATION_INSTALL_STEPS,
  classifyPreflightStep,
  heldStepResult,
  runStockPreparationInstall,
  summarizeInstallRun,
  StockPreparationInstallCallError,
  type StockPreparationInstallApi,
  type StockPreparationInstallStepResult,
} from '../src/services/integration/stockPreparation/installRun'
import type { StockPreparationPreflight } from '../src/services/integration/stockPreparation/installPlan'

const REPO_ROOT = resolve(__dirname, '..', '..', '..')
const BOOTSTRAP_SOURCE = readFileSync(
  resolve(REPO_ROOT, 'scripts/ops/stock-prep-acceptance-bootstrap.mjs'),
  'utf8',
)

/** Planted business values. A values-free run renders NONE of them. */
const PLANTED_DRAWING_NO = 'DWG-77213-B'
const PLANTED_MATERIAL_CODE = 'MAT-QQ4410'
const PLANTED_PROJECT_NAME = '涡轮增压器总成'
const PLANTED_SECRET = 'pg://user:hunter2@10.0.0.9/plm'
const FORBIDDEN = [PLANTED_DRAWING_NO, PLANTED_MATERIAL_CODE, PLANTED_PROJECT_NAME, PLANTED_SECRET]

function preflight(overrides: Partial<StockPreparationPreflight> = {}): StockPreparationPreflight {
  return {
    ready: true,
    blockerCount: 0,
    blockers: [],
    posture: {
      productionApply: { state: 'closed' },
      k3ExternalWrite: { state: 'permanently_disabled' },
      b2aTrialRegistry: { state: 'dormant', envVar: 'INTEGRATION_CORE_B2A_REGISTRY_PATH' },
      outboundHttpWrite: { state: 'unset', envVar: 'INTEGRATION_CORE_OUTBOUND_HTTP_WRITE_TARGETS' },
    },
    ...overrides,
  }
}

const HTTP_BLOCKER = {
  code: 'STOCK_PREP_CONFIRMATION_LEDGER_NOT_READY',
  what: 'the confirmation-decision ledger table does not exist yet',
  fix: {
    kind: 'http' as const,
    method: 'POST',
    path: '/api/integration/stock-preparation/confirmation-decisions/ensure',
    run: 'POST /api/integration/stock-preparation/confirmation-decisions/ensure {}',
  },
}

const ENV_BLOCKER = {
  code: 'STOCK_PREP_CUSTOMER_PACK_NOT_CONFIGURED',
  what: 'no customer pack is configured',
  fix: {
    kind: 'env' as const,
    name: 'INTEGRATION_CORE_STOCK_PREPARATION_CUSTOMER_PACKS_PATH',
    placeholder: true,
    run: 'INTEGRATION_CORE_STOCK_PREPARATION_CUSTOMER_PACKS_PATH=<absolute path to the packs file>',
  },
}

/** A fully green API double. Every response carries planted business values (I-08). */
function greenApi(overrides: Partial<StockPreparationInstallApi> = {}): StockPreparationInstallApi {
  return {
    readPreflight: vi.fn(async () => ({ preflight: preflight(), routeAbsent: false, status: 200 })),
    ensureConfirmationLedger: vi.fn(async () => ({ mode: 'exists', projectName: PLANTED_PROJECT_NAME } as never)),
    listCustomerPacks: vi.fn(async () => ({
      packCount: 1,
      packs: [{
        packId: 'factory-a',
        packVersion: '1',
        targetObjectId: 'plm_stock_preparation_sandbox_a',
        extensionFields: [{ id: 'ext_material_type' }],
        drawingNo: PLANTED_DRAWING_NO,
      }],
    } as never)),
    ensureSandboxTarget: vi.fn(async () => ({ mode: 'exists', ready: true, dsn: PLANTED_SECRET } as never)),
    dryRunCustomerPack: vi.fn(async () => ({ canInstall: true, materialCode: PLANTED_MATERIAL_CODE } as never)),
    installCustomerPack: vi.fn(async () => ({ createdFields: [], stampedFields: ['ext_material_type'] })),
    ...overrides,
  }
}

function statusById(steps: StockPreparationInstallStepResult[]): Record<string, string> {
  return Object.fromEntries(steps.map((step) => [step.id, step.status]))
}

describe('BOM备料 install run — the plan', () => {
  // -------------------------------------------------------------------------
  // I-01 the order is not this file's, nor installRun.ts's
  // -------------------------------------------------------------------------
  it("I-01: steps 1-8 are the bootstrap script's STEP_PLAN, in its order", () => {
    // Extracted from the script rather than restated: `id: 'x',` inside its STEP_PLAN block. The
    // script is the contract (its own header says so), so a reorder there must redden here.
    const planBlock = BOOTSTRAP_SOURCE.slice(
      BOOTSTRAP_SOURCE.indexOf('const STEP_PLAN = Object.freeze(['),
      BOOTSTRAP_SOURCE.indexOf('const STEP_COUNT = STEP_PLAN.length'),
    )
    const bootstrapIds = [...planBlock.matchAll(/^\s{4}id: '([a-z-]+)',$/gm)].map((match) => match[1])

    expect(bootstrapIds.length, 'the extractor found the bootstrap plan').toBe(8)
    expect(STOCK_PREPARATION_INSTALL_STEPS.slice(0, 8).map((step) => step.id)).toEqual(bootstrapIds)

    // ORDER IS LOAD-BEARING: leftover holds make the plan manual_confirm_required, no dry-run token
    // is minted and apply answers 409 — so the queue is drained BEFORE acceptance, never after.
    const ids = STOCK_PREPARATION_INSTALL_STEPS.map((step) => step.id)
    expect(ids.indexOf('confirmation-queue')).toBeLessThan(ids.indexOf('acceptance-dry-run'))
    expect(ids.indexOf('confirmation-queue')).toBeLessThan(ids.indexOf('acceptance-apply'))

    // The one step this page adds beyond the script, and it is last and read-only.
    expect(ids[ids.length - 1]).toBe('preflight-recheck')
  })

  it('I-01: exactly three steps are driven from the browser; every held step says why', () => {
    const driven = STOCK_PREPARATION_INSTALL_STEPS.filter((step) => step.driven).map((step) => step.id)
    expect(driven).toEqual(['preflight', 'managed-tables', 'customer-pack', 'preflight-recheck'])

    for (const step of STOCK_PREPARATION_INSTALL_STEPS.filter((entry) => !entry.driven)) {
      expect(step.heldZh, `${step.id} must state why it is held (zh)`).toBeTruthy()
      expect(step.heldEn, `${step.id} must state why it is held (en)`).toBeTruthy()
    }
  })

  // -------------------------------------------------------------------------
  // I-02 held is SKIP, always
  // -------------------------------------------------------------------------
  it('I-02: a held step is SKIP — never OK, never FAIL', () => {
    for (const [index, descriptor] of STOCK_PREPARATION_INSTALL_STEPS.entries()) {
      if (descriptor.driven) continue
      const step = heldStepResult(index + 1, descriptor)
      expect(step.status, `${descriptor.id}`).toBe('skip')
      expect(step.reason).toBe('HELD_FOR_OPERATOR')
      expect(step.fixes).toEqual([])
    }
  })

  // -------------------------------------------------------------------------
  // I-03 / I-04 the preflight classification
  // -------------------------------------------------------------------------
  it('I-03: ready is OK, an absent route is SKIP, a failed read is FAIL', () => {
    expect(classifyPreflightStep(1, preflight()).status).toBe('ok')
    expect(classifyPreflightStep(1, preflight()).reason).toBe('PREFLIGHT_READY')

    const absent = classifyPreflightStep(1, null, { routeAbsent: true, status: 404 })
    expect(absent.status).toBe('skip')
    expect(absent.reason).toBe('PREFLIGHT_ROUTE_ABSENT')

    const broken = classifyPreflightStep(1, null, { status: 500 })
    expect(broken.status).toBe('fail')
    expect(broken.reason).toBe('PREFLIGHT_READ_FAILED')
  })

  it('I-03: blockers whose fixes are all HTTP calls are SKIP — the next steps make those calls', () => {
    // This is the case that decides whether the button can bootstrap a fresh deployment at all: the
    // ledger-not-ready blocker's own fix IS the managed-tables step's first call, so failing here
    // would make the install page permanently useless on exactly the deployment it exists for.
    const step = classifyPreflightStep(1, preflight({
      ready: false,
      blockerCount: 1,
      blockers: [HTTP_BLOCKER],
    }))
    expect(step.status).toBe('skip')
    expect(step.reason).toBe('PREFLIGHT_BLOCKERS_PROVISIONED_BELOW')
    expect(step.detail.blockerCount).toBe(1)
    expect(step.detail.codes).toBe('STOCK_PREP_CONFIRMATION_LEDGER_NOT_READY')
  })

  it('I-03: any blocker needing deployment data is FAIL — this page has no env field', () => {
    const step = classifyPreflightStep(1, preflight({
      ready: false,
      blockerCount: 2,
      blockers: [HTTP_BLOCKER, ENV_BLOCKER],
    }))
    expect(step.status).toBe('fail')
    expect(step.reason).toBe('PREFLIGHT_BLOCKERS_DEPLOYMENT_DATA')

    // A blocker with NO fix at all reads the same way: nothing here can clear it.
    const noFix = classifyPreflightStep(1, preflight({
      ready: false,
      blockerCount: 1,
      blockers: [{ code: 'STOCK_PREP_PACK_TARGET_MISSING', what: 'the declared target does not exist' }],
    }))
    expect(noFix.status).toBe('fail')
  })

  it('I-04: fix.run lines are carried through verbatim', () => {
    const step = classifyPreflightStep(1, preflight({
      ready: false,
      blockerCount: 2,
      blockers: [HTTP_BLOCKER, ENV_BLOCKER],
    }))
    expect(step.fixes).toEqual([HTTP_BLOCKER.fix.run, ENV_BLOCKER.fix.run])
  })

  it('I-03: the recheck never FAILs — remaining blockers are outstanding work, not a broken run', () => {
    const blocked = classifyPreflightStep(9, preflight({
      ready: false,
      blockerCount: 1,
      blockers: [ENV_BLOCKER],
    }), { recheck: true })
    expect(blocked.id).toBe('preflight-recheck')
    expect(blocked.status).toBe('skip')
    expect(blocked.reason).toBe('RECHECK_STILL_BLOCKED')
    expect(blocked.fixes).toEqual([ENV_BLOCKER.fix.run])

    expect(classifyPreflightStep(9, preflight(), { recheck: true }).reason).toBe('RECHECK_READY')
  })
})

describe('BOM备料 install run — the walk', () => {
  it('walks the whole plan on a green deployment: 3 driven OK, 5 held SKIP, and it passes', async () => {
    const api = greenApi()
    const report = await runStockPreparationInstall(api)

    expect(statusById(report.steps)).toEqual({
      'preflight': 'ok',
      'managed-tables': 'ok',
      'customer-pack': 'ok',
      'source-wiring': 'skip',
      'confirmation-queue': 'skip',
      'acceptance-dry-run': 'skip',
      'acceptance-apply': 'skip',
      'acceptance-idempotent': 'skip',
      'preflight-recheck': 'ok',
    })
    expect(report.pass).toBe(true)
    expect(report.okCount).toBe(4)
    expect(report.skipCount).toBe(5)
    expect(report.failCount).toBe(0)
    expect(report.completedSteps).toBe(report.totalSteps)

    // The sandbox objectId came off the PACK, never from anywhere else.
    expect(api.ensureSandboxTarget).toHaveBeenCalledWith('plm_stock_preparation_sandbox_a')
    // Install runs TWICE, and the second pass is the idempotence assertion, not a retry.
    expect(api.installCustomerPack).toHaveBeenCalledTimes(2)
  })

  // -------------------------------------------------------------------------
  // I-05 the SKIP that matters most: deployment data not supplied yet
  // -------------------------------------------------------------------------
  it('I-05: an empty pack catalog SKIPs both provisioning steps and the run still PASSES', async () => {
    const api = greenApi({
      readPreflight: vi.fn(async () => ({ preflight: null, routeAbsent: true, status: 404 })),
      listCustomerPacks: vi.fn(async () => ({ packCount: 0, packs: [] })),
    })
    const report = await runStockPreparationInstall(api)

    const managed = report.steps.find((step) => step.id === 'managed-tables')!
    expect(managed.status).toBe('skip')
    expect(managed.reason).toBe('PACK_CATALOG_EMPTY')
    // The ledger WAS provisioned — reporting a half-done step as a blank failure is how an operator
    // re-runs work that is already done.
    expect(managed.detail.ledgerMode).toBe('exists')

    const pack = report.steps.find((step) => step.id === 'customer-pack')!
    expect(pack.status).toBe('skip')

    expect(api.ensureSandboxTarget).not.toHaveBeenCalled()
    expect(api.installCustomerPack).not.toHaveBeenCalled()
    expect(report.pass).toBe(true)
    expect(report.failCount).toBe(0)
  })

  it('I-05: more than one configured pack is a SKIP, not a guess', async () => {
    const api = greenApi({
      listCustomerPacks: vi.fn(async () => ({
        packCount: 2,
        packs: [
          { packId: 'factory-a', targetObjectId: 'plm_stock_preparation_sandbox_a' },
          { packId: 'factory-b', targetObjectId: 'plm_stock_preparation_sandbox_b' },
        ],
      })),
    })
    const report = await runStockPreparationInstall(api)

    const managed = report.steps.find((step) => step.id === 'managed-tables')!
    expect(managed.status).toBe('skip')
    expect(managed.reason).toBe('PACK_CATALOG_AMBIGUOUS')
    expect(managed.detail.packCount).toBe(2)
    expect(api.ensureSandboxTarget).not.toHaveBeenCalled()
    expect(report.pass).toBe(true)
  })

  // -------------------------------------------------------------------------
  // I-06 stop on the first FAIL, keep what completed
  // -------------------------------------------------------------------------
  it('I-06: stops at the first FAIL and returns every step that completed', async () => {
    const api = greenApi({
      ensureConfirmationLedger: vi.fn(async () => {
        throw new StockPreparationInstallCallError(403, '/ensure')
      }),
    })
    const report = await runStockPreparationInstall(api)

    expect(report.steps.map((step) => step.id)).toEqual(['preflight', 'managed-tables'])
    expect(report.steps[0].status).toBe('ok')
    expect(report.steps[1].status).toBe('fail')
    expect(report.steps[1].reason).toBe('LEDGER_ENSURE_FAILED')
    expect(report.steps[1].detail.status).toBe(403)
    expect(report.pass).toBe(false)
    expect(report.failedStepId).toBe('managed-tables')
    // The later steps were never called — no parallelism, no "run the rest anyway".
    expect(api.listCustomerPacks).not.toHaveBeenCalled()
  })

  it('I-06: an ownership conflict in the pack dry-run FAILs before anything is written', async () => {
    const api = greenApi({
      dryRunCustomerPack: vi.fn(async () => ({
        canInstall: false,
        conflictingFieldIds: ['ext_material_type', 'ext_blank_type'],
      })),
    })
    const report = await runStockPreparationInstall(api)

    const pack = report.steps.find((step) => step.id === 'customer-pack')!
    expect(pack.status).toBe('fail')
    expect(pack.reason).toBe('PACK_DRY_RUN_CONFLICTS')
    expect(pack.detail.conflictCount).toBe(2)
    expect(api.installCustomerPack).not.toHaveBeenCalled()
  })

  it('I-06: a second install that creates fields again is a FAIL — install is declared idempotent', async () => {
    const installCustomerPack = vi.fn()
      .mockResolvedValueOnce({ createdFields: ['ext_material_type'] })
      .mockResolvedValueOnce({ createdFields: ['ext_material_type'] })
    const report = await runStockPreparationInstall(greenApi({ installCustomerPack }))

    const pack = report.steps.find((step) => step.id === 'customer-pack')!
    expect(pack.status).toBe('fail')
    expect(pack.reason).toBe('PACK_INSTALL_NOT_IDEMPOTENT')
    expect(pack.detail.secondCreatedCount).toBe(1)
  })

  it('reports progress step by step, in order, as each one lands', async () => {
    const seen: string[] = []
    await runStockPreparationInstall(greenApi(), (step) => { seen.push(`${step.id}:${step.status}`) })
    expect(seen[0]).toBe('preflight:ok')
    expect(seen).toHaveLength(9)
    expect(seen[seen.length - 1]).toBe('preflight-recheck:ok')
  })

  // -------------------------------------------------------------------------
  // I-07 / I-08
  // -------------------------------------------------------------------------
  it('I-07: a run of nothing but SKIPs passes — held is not broken', () => {
    const allSkip = STOCK_PREPARATION_INSTALL_STEPS.map((descriptor, index) => heldStepResult(index + 1, descriptor))
    const report = summarizeInstallRun(allSkip)
    expect(report.pass).toBe(true)
    expect(report.failCount).toBe(0)
    expect(report.skipCount).toBe(STOCK_PREPARATION_INSTALL_STEPS.length)
    expect(report.failedStepId).toBeNull()
  })

  it('I-08: no planted business value survives into any step result', async () => {
    const report = await runStockPreparationInstall(greenApi())
    const serialized = JSON.stringify(report)
    for (const forbidden of FORBIDDEN) {
      expect(serialized, `values-free: "${forbidden}" leaked into the run report`).not.toContain(forbidden)
    }
    // Positive control: the report is NOT empty, so the assertion above is not vacuous.
    expect(serialized).toContain('plm_stock_preparation_sandbox_a')
    expect(serialized).toContain('factory-a')
  })
})
