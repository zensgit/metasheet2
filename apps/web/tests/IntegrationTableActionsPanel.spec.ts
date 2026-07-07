import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick, type App as VueApp, type Component } from 'vue'
import IntegrationTableActionsPanel from '../src/components/integration/IntegrationTableActionsPanel.vue'
import type { IntegrationTableActionMetadata } from '../src/services/integration/workbench'
import type { DuplicateExpandedGroupView } from '../src/components/integration/integrationWorkbenchSectionTypes'

// IU-2d (docs/development/integration-ux-workbench-redesign-design-lock-20260706.md §2 IU-2,
// stage D — run-push decomposition): structural smoke test for the extracted parameterized
// table-actions panel (dry-run token flow + duplicate-policy sub-editor).

describe('IntegrationTableActionsPanel (unit)', () => {
  let app: VueApp<Element> | null = null
  let container: HTMLDivElement | null = null

  afterEach(() => {
    if (app) app.unmount()
    if (container) container.remove()
    app = null
    container = null
  })

  async function mountPanel(props: Record<string, unknown>): Promise<void> {
    container = document.createElement('div')
    document.body.appendChild(container)
    const Host = defineComponent({
      setup() {
        return () => h(IntegrationTableActionsPanel as unknown as Component, props)
      },
    })
    app = createApp(Host)
    app.mount(container)
    await nextTick()
  }

  const bi = (zh: string, _en: string): string => zh
  const noopFn = (..._args: unknown[]): unknown => undefined

  const sampleAction = {
    actionId: 'plm.stock-preparation.pull-bom.v1',
    configured: true,
  } as unknown as IntegrationTableActionMetadata

  const sampleGroup: DuplicateExpandedGroupView = {
    ordinal: '1',
    fingerprint: 'fp-1',
    rowCount: '2',
    parentShape: 'same_parent',
    quantityShape: 'varied',
    attributeShape: 'same',
    stableDiscriminator: 'yes',
    currentPolicy: 'hold',
    currentScope: 'default',
    draftPolicy: 'hold',
    resolutionLabel: 'held · default',
  }

  function baseProps(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      tableActions: [] as IntegrationTableActionMetadata[],
      bi,
      tableActionOptionLabel: (_action: IntegrationTableActionMetadata) => '拉取 BOM',
      tableActionDisplayContextItems: [] as string[],
      tableActionCanDryRun: false,
      runningTableAction: '',
      tableActionCanApply: false,
      tableActionApplyCommandLabel: 'Apply 表动作',
      tableActionDryRunResult: null,
      tableActionReviewSummary: '',
      tableActionCounts: {},
      tableActionLargeBomBounded: false,
      tableActionBoundedPreviewMetrics: [],
      tableActionBoundedErrorTypes: [] as string[],
      tableActionDuplicateDiagnostics: null,
      tableActionDuplicateMetrics: [],
      tableActionDuplicatePolicies: [] as string[],
      tableActionStoredConflictPolicyCount: 0,
      tableActionResolvedDuplicateGroupCount: 0,
      tableActionHeldDuplicateGroupCount: 0,
      tableActionHeldReasonMetrics: [],
      tableActionDuplicateGroups: [] as DuplicateExpandedGroupView[],
      tableActionConflictPolicySaving: '',
      tableActionDryRunToken: '',
      tableActionManualConfirmCount: 0,
      tableActionApplyResult: null,
      tableActionEvidenceText: '',
      hasPermission: (_permission: string) => false,
      dryRunTableAction: vi.fn(noopFn),
      applyTableAction: vi.fn(noopFn),
      onDuplicatePolicyDraftChange: vi.fn(noopFn),
      setDuplicateRunOnlyPolicy: vi.fn(noopFn),
      saveDuplicateTableScopePolicy: vi.fn(noopFn),
      revokeDuplicateTableScopePolicy: vi.fn(noopFn),
      selectedTableActionId: '',
      tableActionProjectNo: '',
      tableActionAcceptManualConfirmHold: false,
      tableActionAcceptDuplicateResolution: false,
      'onUpdate:tableActionProjectNo': vi.fn(noopFn),
      ...overrides,
    }
  }

  it('renders the IU-6 guided empty state (what + first-step sub-testids non-empty) when no actions are exposed', async () => {
    await mountPanel(baseProps())
    expect(container?.querySelector('[data-testid="table-action-panel"]')).toBeTruthy()
    expect(container?.querySelector('[data-testid="table-action-empty"]')).toBeTruthy()
    // Pin the IU-6 guided empty-state copy at component level (the parent view spec doesn't
    // assert these two sub-testids directly).
    expect(container?.querySelector('[data-testid="table-action-empty-what"]')?.textContent?.trim().length ?? 0).toBeGreaterThan(0)
    expect(container?.querySelector('[data-testid="table-action-empty-first-step"]')?.textContent?.trim().length ?? 0).toBeGreaterThan(0)
    expect(container?.querySelector('[data-testid="table-action-id"]')).toBeNull()
  })

  it('renders the action form when actions exist and forwards the dry-run click', async () => {
    const dryRunTableAction = vi.fn(noopFn)
    await mountPanel(baseProps({
      tableActions: [sampleAction],
      selectedTableActionId: sampleAction.actionId,
      tableActionCanDryRun: true,
      dryRunTableAction,
    }))
    expect(container?.querySelector('[data-testid="table-action-empty"]')).toBeNull()
    expect(container?.querySelector('[data-testid="table-action-id"]')).toBeTruthy()
    expect(container?.querySelector('[data-testid="table-action-boundary"]')?.textContent).toContain('不提供 raw SQL')
    const button = container?.querySelector<HTMLButtonElement>('[data-testid="table-action-dry-run"]')
    expect(button?.disabled).toBe(false)
    button?.click()
    await nextTick()
    expect(dryRunTableAction).toHaveBeenCalledTimes(1)
  })

  it('gates the duplicate-policy table-scope save/revoke buttons on integration:admin (negative + positive)', async () => {
    const dryRunResult = { status: 'ok', counts: {} }
    const dupProps = {
      tableActions: [sampleAction],
      selectedTableActionId: sampleAction.actionId,
      tableActionDryRunResult: dryRunResult,
      tableActionDuplicateDiagnostics: { conflictType: 'duplicate_expanded_key' },
      tableActionDuplicatePolicies: ['hold', 'accept_all'],
      tableActionDuplicateGroups: [sampleGroup],
    }
    // negative: no integration:admin → run-only button present, table-scope save/revoke absent
    await mountPanel(baseProps({ ...dupProps, hasPermission: () => false }))
    expect(container?.querySelector('[data-testid="table-action-duplicate-run-only"]')).toBeTruthy()
    expect(container?.querySelector('[data-testid="table-action-duplicate-table-save"]')).toBeNull()
    expect(container?.querySelector('[data-testid="table-action-duplicate-table-revoke"]')).toBeNull()

    // positive: with integration:admin both buttons appear and the exact permission is queried
    const hasPermission = vi.fn((permission: string) => permission === 'integration:admin')
    await mountPanel(baseProps({ ...dupProps, hasPermission }))
    expect(container?.querySelector('[data-testid="table-action-duplicate-table-save"]')).toBeTruthy()
    expect(container?.querySelector('[data-testid="table-action-duplicate-table-revoke"]')).toBeTruthy()
    expect(hasPermission).toHaveBeenCalledWith('integration:admin')
  })

  it('forwards project-no input through update:tableActionProjectNo (defineModel wiring)', async () => {
    const onUpdateProjectNo = vi.fn(noopFn)
    await mountPanel(baseProps({
      tableActions: [sampleAction],
      selectedTableActionId: sampleAction.actionId,
      'onUpdate:tableActionProjectNo': onUpdateProjectNo,
    }))
    const input = container?.querySelector<HTMLInputElement>('[data-testid="table-action-project-no"]')
    expect(input).toBeTruthy()
    if (input) {
      input.value = 'P2026-001'
      input.dispatchEvent(new Event('input'))
    }
    await nextTick()
    expect(onUpdateProjectNo).toHaveBeenCalledWith('P2026-001')
  })
})
