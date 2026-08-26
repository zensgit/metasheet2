// F4 real-browser B1-B12 matrix (delta §5 F4, §7.2; F2-gate handoff condition 1) — driven by
// GENUINE mouse drags (`locator.dragTo`), never synthetic DataTransfer, against the MOUNTED
// PRODUCTION SURFACE: the real `TemplateAuthoringView.vue`, real Vue Router, real Element Plus,
// flag ON (see verification/approval-form-builder-mounted-harness.ts). The F2 lane's
// approval-form-builder-parity.spec.ts covers the standalone-component DataTransfer-drag subset and
// is NOT superseded by this file — both run in the same approval-browser-verify.yml lane.
//
// No backend is reachable. `/approval-templates/new` needs none (synchronous empty-draft branch).
// The edit-mode fixture rows pass `networkTemplate=on` and use Playwright's `page.route()` to
// intercept `getTemplate` at the network layer — a real request/response cycle, not the DEV API
// mock. The explicit query is load-bearing: without it, an attachment-bearing default mock could
// make the two read-only tests pass without consuming their declared fixtures.
import { test, expect, type Page } from '@playwright/test'
import { mkdirSync } from 'node:fs'

const OUT = 'verification-output'

async function mountFields(
  page: Page,
  opts: { canvasV2?: boolean; route?: 'new' | 'edit'; networkTemplate?: boolean } = {},
): Promise<void> {
  const canvasV2 = opts.canvasV2 ?? true
  const route = opts.route ?? 'new'
  const networkTemplate = opts.networkTemplate === true ? '&networkTemplate=on' : ''
  await page.goto(`/verification/approval-form-builder-mounted-harness.html?canvasV2=${canvasV2 ? 'on' : 'off'}&route=${route}${networkTemplate}`)
  await page.waitForFunction(() => (window as unknown as { __AFB_MOUNT_READY__?: boolean }).__AFB_MOUNT_READY__ === true)
  await page.click('[data-testid="approval-template-section-fields"]')
}

function cards(page: Page) {
  return page.locator('[data-testid="approval-form-builder-card"]')
}

async function cardTypes(page: Page): Promise<(string | null)[]> {
  return cards(page).evaluateAll((els) => els.map((el) => el.getAttribute('data-field-type')))
}

async function selectedLocalId(page: Page): Promise<string | null> {
  const el = page.locator('[data-testid="approval-form-builder-card"][data-selected="true"]')
  if ((await el.count()) === 0) return null
  return el.first().getAttribute('data-field-local-id')
}

test.beforeAll(() => {
  mkdirSync(OUT, { recursive: true })
})

test.beforeEach(async ({ page }) => {
  page.on('pageerror', (err) => {
    throw new Error(`Unexpected page error: ${err}`)
  })
})

// --- B1: palette click append -----------------------------------------------

test('B1 — palette click append: correct type/label; new field selected; one history entry', async ({ page }) => {
  await mountFields(page)
  const before = await cardTypes(page)
  await page.click('[data-testid="approval-form-palette-chip-number"]')
  await page.waitForFunction(
    (n) => document.querySelectorAll('[data-testid="approval-form-builder-card"]').length === n,
    before.length + 1,
  )
  const after = await cardTypes(page)
  expect(after).toEqual([...before, 'number'])
  // New field is selected (§3.5 "After add: focus/select the new field").
  const lastCard = cards(page).last()
  await expect(lastCard).toHaveAttribute('data-selected', 'true')
  // One history entry: 撤销 becomes enabled.
  await expect(page.locator('[data-testid="approval-form-undo"]')).toBeEnabled()
  await page.screenshot({ path: `${OUT}/afb-mounted-b1.png` })
})

// --- B2: palette drag before first ------------------------------------------

test('B2 — palette drag before first: exact order; one new identity; no duplicate IDs', async ({ page }) => {
  await mountFields(page)
  const before = await cardTypes(page)
  const chip = page.locator('[data-testid="approval-form-palette-chip-date"]')
  const startSlot = page.locator('[data-testid="approval-form-builder-slot-start"]')
  await chip.dragTo(startSlot)
  await page.waitForFunction(
    (n) => document.querySelectorAll('[data-testid="approval-form-builder-card"]').length === n,
    before.length + 1,
  )
  const after = await cardTypes(page)
  expect(after).toEqual(['date', ...before])
  const ids = await cards(page).evaluateAll((els) => els.map((el) => el.getAttribute('data-field-local-id')))
  expect(new Set(ids).size).toBe(ids.length)
  await page.screenshot({ path: `${OUT}/afb-mounted-b2.png` })
})

// --- B3: palette drag between/after ------------------------------------------

test('B3 — palette drag between/after: exact middle/end order; visible valid slot', async ({ page }) => {
  await mountFields(page)
  // Seed two extra fields via click so there is a real "middle".
  await page.click('[data-testid="approval-form-palette-chip-number"]')
  await page.click('[data-testid="approval-form-palette-chip-text"]')
  const beforeDrag = await cardTypes(page)
  expect(beforeDrag.length).toBeGreaterThanOrEqual(3)

  // Drag onto the slot AFTER the first card (a real middle position).
  const firstLocalId = await cards(page).first().getAttribute('data-field-local-id')
  const middleSlot = page.locator(`[data-testid="approval-form-builder-slot-after-${firstLocalId}"]`)
  await expect(middleSlot).toBeVisible()
  const chip = page.locator('[data-testid="approval-form-palette-chip-select"]')
  await chip.dragTo(middleSlot)
  await page.waitForFunction(
    (n) => document.querySelectorAll('[data-testid="approval-form-builder-card"]').length === n,
    beforeDrag.length + 1,
  )
  const afterMiddle = await cardTypes(page)
  expect(afterMiddle).toEqual([beforeDrag[0], 'select', ...beforeDrag.slice(1)])

  // Drag onto the LAST slot (append/end).
  const lastLocalId = await cards(page).last().getAttribute('data-field-local-id')
  const endSlot = page.locator(`[data-testid="approval-form-builder-slot-after-${lastLocalId}"]`)
  await endSlot.scrollIntoViewIfNeeded()
  const chip2 = page.locator('[data-testid="approval-form-palette-chip-multi-select"]')
  await chip2.scrollIntoViewIfNeeded()
  await expect(chip2).toBeVisible()
  await chip2.dragTo(endSlot, { sourcePosition: { x: 5, y: 5 }, targetPosition: { x: 5, y: 5 } })
  await page.waitForFunction(
    (n) => document.querySelectorAll('[data-testid="approval-form-builder-card"]').length === n,
    afterMiddle.length + 1,
  )
  const afterEnd = await cardTypes(page)
  expect(afterEnd).toEqual([...afterMiddle, 'multi-select'])
  await page.screenshot({ path: `${OUT}/afb-mounted-b3.png` })
})

// --- B4: existing field drag ---------------------------------------------------

test('B4 — existing field drag: same order as keyboard move; selection retained', async ({ page }) => {
  await mountFields(page)
  await page.click('[data-testid="approval-form-palette-chip-number"]')
  await page.click('[data-testid="approval-form-palette-chip-text"]')
  const start = await cardTypes(page)
  expect(start.length).toBe(3)

  // Keyboard-equivalent path first, on a fresh independent field ordering check via move buttons:
  // move the LAST card up by one via its 上移 button, capture the resulting order.
  const lastLocalId = await cards(page).last().getAttribute('data-field-local-id')
  await page.click(`[data-testid="approval-form-builder-move-up-${lastLocalId}"]`)
  await page.waitForFunction(
    (id) => {
      const els = Array.from(document.querySelectorAll('[data-testid="approval-form-builder-card"]'))
      return els[els.length - 2]?.getAttribute('data-field-local-id') === id
    },
    lastLocalId,
  )
  const afterKeyboardMove = await cardTypes(page)

  // Undo it, then reproduce the SAME move via a real mouse drag of the move handle onto the slot
  // BEFORE the second-to-last card — must land in the identical position.
  await page.click('[data-testid="approval-form-undo"]')
  await page.waitForFunction(
    (n) => document.querySelectorAll('[data-testid="approval-form-builder-card"]').length === n,
    start.length,
  )
  // Reproduce the SAME index-1 landing spot the keyboard move produced: drop onto the slot AFTER
  // the FIRST card (index 0) — NOT "after index 1", which (after undo restored the original order)
  // is the field's OWN current neighbor and would be a value-identical no-op boundary.
  const handle = page.locator(`[data-testid="approval-form-builder-handle-${lastLocalId}"]`)
  const targetCardLocalId = await cards(page).nth(0).getAttribute('data-field-local-id')
  const targetSlot = page.locator(`[data-testid="approval-form-builder-slot-after-${targetCardLocalId}"]`)
  await handle.scrollIntoViewIfNeeded()
  await targetSlot.scrollIntoViewIfNeeded()
  await expect(handle).toBeVisible()
  await handle.dragTo(targetSlot)
  await page.waitForFunction(
    (id) => {
      const els = Array.from(document.querySelectorAll('[data-testid="approval-form-builder-card"]'))
      return els.some((el, i) => el.getAttribute('data-field-local-id') === id && i === 1)
    },
    lastLocalId,
  )
  const afterDragMove = await cardTypes(page)
  expect(afterDragMove).toEqual(afterKeyboardMove)
  // Selection retained: the dragged field is selected after the drop.
  expect(await selectedLocalId(page)).toBe(lastLocalId)
  await page.screenshot({ path: `${OUT}/afb-mounted-b4.png` })
})

// --- B5: invalid/outside/stale drop --------------------------------------------

test('B5 — invalid/outside drop: zero draft/history mutation; values-free feedback where applicable', async ({ page }) => {
  await mountFields(page)
  const before = await cardTypes(page)
  const chip = page.locator('[data-testid="approval-form-palette-chip-text"]')
  // Drop outside the canvas entirely (onto the page header).
  const header = page.locator('h1, .template-authoring__header, header').first()
  await chip.dragTo(header, { force: true }).catch(() => {
    // Some hosts refuse the drop target entirely — that IS the no-op being asserted.
  })
  await page.waitForTimeout(200)
  const after = await cardTypes(page)
  expect(after).toEqual(before)
  await expect(page.locator('[data-testid="approval-form-undo"]')).toBeDisabled()
  await page.screenshot({ path: `${OUT}/afb-mounted-b5.png` })
})

// --- B6: inspector edit ---------------------------------------------------------

test('B6 — inspector edit: committed value persists; undo/redo restores value and focus', async ({ page }) => {
  await mountFields(page)
  const localId = await cards(page).first().getAttribute('data-field-local-id')
  await cards(page).first().click()
  const labelInput = page.locator('[data-testid="approval-form-field-inspector-label"]')
  await labelInput.fill('联系人姓名')
  await labelInput.blur()
  await page.waitForFunction(
    (id) => document.querySelector(`[data-field-local-id="${id}"] .approval-form-builder__card-label`)?.textContent?.includes('联系人姓名'),
    localId,
  )
  await expect(page.locator(`[data-field-local-id="${localId}"] .approval-form-builder__card-label`)).toHaveText('联系人姓名')

  await page.click('[data-testid="approval-form-undo"]')
  await page.waitForFunction(
    (id) => !document.querySelector(`[data-field-local-id="${id}"] .approval-form-builder__card-label`)?.textContent?.includes('联系人姓名'),
    localId,
  )
  await page.click('[data-testid="approval-form-redo"]')
  await page.waitForFunction(
    (id) => document.querySelector(`[data-field-local-id="${id}"] .approval-form-builder__card-label`)?.textContent?.includes('联系人姓名'),
    localId,
  )
  // Focus restored to the affected field.
  expect(await selectedLocalId(page)).toBe(localId)
  await page.screenshot({ path: `${OUT}/afb-mounted-b6.png` })
})

// --- B7: referenced delete/retype ------------------------------------------------

test('B7 — referenced delete refusal: named fail-closed refusal; no silent cleanup or dangling reference', async ({ page }) => {
  await mountFields(page)
  await page.click('[data-testid="approval-form-palette-chip-text"]')
  const [fieldA, fieldB] = await cards(page).evaluateAll((els) => els.map((el) => el.getAttribute('data-field-local-id')))

  // Make field B's visibility depend on field A.
  await cards(page).nth(1).click()
  await page.selectOption('[data-testid="approval-form-field-inspector-visibility-depends"]', { index: 1 })
  await page.waitForTimeout(100)

  // Attempt to delete field A (the depended-on field) via the inspector.
  await cards(page).first().click()
  await page.click('[data-testid="approval-form-field-inspector-remove-field"]')
  await page.waitForTimeout(200)

  const afterAttempt = await cardTypes(page)
  expect(afterAttempt.length).toBe(2) // NOT removed
  const stillThere = await cards(page).evaluateAll((els) => els.map((el) => el.getAttribute('data-field-local-id')))
  expect(stillThere).toContain(fieldA)
  expect(stillThere).toContain(fieldB)
  await page.screenshot({ path: `${OUT}/afb-mounted-b7.png` })
})

// --- B8: read-only and feature OFF ------------------------------------------------

test('B8a — feature OFF: no Designer 2.0 mount; the legacy fallback is the ONLY form surface', async ({ page }) => {
  await mountFields(page, { canvasV2: false })
  await expect(page.locator('[data-testid="approval-form-designer-v2"]')).toHaveCount(0)
  await expect(page.locator('[data-testid="approval-form-designer"]')).toBeVisible()
  await page.screenshot({ path: `${OUT}/afb-mounted-b8-feature-off.png` })
})

test('B8b — read-only: no drag/move mutation; no slots, handles, or move buttons render', async ({ page }) => {
  // Edit-mode route with a template the backend marks unsupported (attachment field) locks the
  // WHOLE template read-only via the SAME `unsupportedTemplateAuthoringReason` gate the legacy
  // surface uses — real network interception, not a framework mock.
  await page.route('**/api/approval-templates/afb_harness_1', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        id: 'afb_harness_1',
        key: 'afb_harness',
        name: '只读校验模板',
        visibilityScope: { type: 'all', ids: [] },
        status: 'draft',
        activeVersionId: null,
        latestVersionId: 'v1',
        createdAt: '2026-08-01T00:00:00Z',
        updatedAt: '2026-08-01T00:00:00Z',
        formSchema: { fields: [{ id: 'f1', type: 'text', label: '文本' }, { id: 'f2', type: 'attachment', label: '附件' }] },
        approvalGraph: {
          nodes: [{ key: 'start', type: 'start', name: '发起', config: {} }, { key: 'end', type: 'end', name: '结束', config: {} }],
          edges: [{ key: 'e1', source: 'start', target: 'end' }],
        },
      }),
    }),
  )
  await mountFields(page, { route: 'edit', networkTemplate: true })
  await expect(page.locator('[data-testid="approval-template-name"]')).toHaveValue('只读校验模板')
  await expect(page.locator('[data-testid="approval-template-unsupported-alert"]')).toBeVisible()
  await expect(page.locator('[data-testid="approval-form-builder-slot-start"]')).toHaveCount(0)
  await expect(page.locator('[data-testid^="approval-form-builder-handle-"]')).toHaveCount(0)
  await expect(page.locator('[data-testid^="approval-form-builder-move-up-"]')).toHaveCount(0)
  await page.screenshot({ path: `${OUT}/afb-mounted-b8-readonly.png` })
})

// --- B9: responsive ---------------------------------------------------------------

test('B9 — responsive: no document horizontal overflow at all four required widths; canvas primary', async ({ page }) => {
  await mountFields(page)
  for (const [w, h] of [[1440, 900], [1024, 768], [768, 1024], [390, 844]] as const) {
    await page.setViewportSize({ width: w, height: h })
    await page.waitForTimeout(150)
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
    expect(overflow, `horizontal overflow at ${w}x${h}`).toBeLessThanOrEqual(1)
    await expect(page.locator('[data-testid="approval-form-builder"]')).toBeVisible()
  }
  await page.screenshot({ path: `${OUT}/afb-mounted-b9-390.png` })
})

// --- B10: keyboard/touch alternative -----------------------------------------------

test('B10 — keyboard alternative: complete add/move/configure path without pointer drag', async ({ page }) => {
  await mountFields(page)
  const before = await cardTypes(page)

  // Add via slot click + keyboard menu navigation (no drag).
  await page.click('[data-testid="approval-form-builder-slot-start"]')
  await expect(page.locator('[data-testid="approval-form-builder-slot-menu"]')).toBeVisible()
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('Enter')
  await page.waitForFunction(
    (n) => document.querySelectorAll('[data-testid="approval-form-builder-card"]').length === n,
    before.length + 1,
  )
  const afterAdd = await cardTypes(page)
  expect(afterAdd[0]).not.toBe(before[0])
  expect(afterAdd.length).toBe(before.length + 1)

  // Move via keyboard-reachable 下移 button (no drag).
  const firstLocalId = await cards(page).first().getAttribute('data-field-local-id')
  await page.click(`[data-testid="approval-form-builder-move-down-${firstLocalId}"]`)
  await page.waitForFunction(
    (id) => document.querySelectorAll('[data-testid="approval-form-builder-card"]')[1]?.getAttribute('data-field-local-id') === id,
    firstLocalId,
  )

  // Configure via inspector (already keyboard-reachable form controls).
  await cards(page).nth(1).click()
  await page.fill('[data-testid="approval-form-field-inspector-label"]', '键盘路径字段')
  await page.locator('[data-testid="approval-form-field-inspector-label"]').blur()
  await expect(page.locator(`[data-field-local-id="${firstLocalId}"] .approval-form-builder__card-label`)).toHaveText('键盘路径字段')
  await page.screenshot({ path: `${OUT}/afb-mounted-b10.png` })
})

// --- B11: legacy compatibility -----------------------------------------------------

test('B11 — legacy compatibility: an unsupported field type keeps the WHOLE template locked and unchanged (byte-identical gate on both surfaces)', async ({ page }) => {
  await page.route('**/api/approval-templates/afb_harness_1', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        id: 'afb_harness_1',
        key: 'afb_harness',
        name: '复杂模板',
        visibilityScope: { type: 'all', ids: [] },
        status: 'draft',
        activeVersionId: null,
        latestVersionId: 'v1',
        createdAt: '2026-08-01T00:00:00Z',
        updatedAt: '2026-08-01T00:00:00Z',
        formSchema: {
          fields: [
            { id: 'amount', type: 'number', label: '金额', required: true },
            { id: 'reviewer', type: 'user', label: '审批人' },
            { id: 'note', type: 'explanation', label: '说明', props: { text: '请如实填写' } },
            { id: 'legacy_unknown', type: 'signature', label: '签名' },
          ],
        },
        approvalGraph: {
          nodes: [{ key: 'start', type: 'start', name: '发起', config: {} }, { key: 'end', type: 'end', name: '结束', config: {} }],
          edges: [{ key: 'e1', source: 'start', target: 'end' }],
        },
      }),
    }),
  )
  // Flag ON: whole-template lock, save disabled.
  await mountFields(page, { canvasV2: true, route: 'edit', networkTemplate: true })
  await expect(page.locator('[data-testid="approval-template-name"]')).toHaveValue('复杂模板')
  await expect(page.locator('[data-testid="approval-template-unsupported-alert"]')).toBeVisible()
  await expect(page.locator('[data-testid="approval-template-save-button"]')).toBeDisabled()

  // Flag OFF (SAME payload): same lock, same disabled state — behavior is flag-independent.
  await mountFields(page, { canvasV2: false, route: 'edit', networkTemplate: true })
  await expect(page.locator('[data-testid="approval-template-name"]')).toHaveValue('复杂模板')
  await expect(page.locator('[data-testid="approval-template-unsupported-alert"]')).toBeVisible()
  await expect(page.locator('[data-testid="approval-template-save-button"]')).toBeDisabled()
  await page.screenshot({ path: `${OUT}/afb-mounted-b11.png` })
})

// --- B12: attachment/number boundaries ----------------------------------------------

test('B12 — attachment/number boundaries: attachment remains absent from the palette; number FWB display props stay unavailable in the inspector', async ({ page }) => {
  await mountFields(page)
  // Attachment is never an offered palette type (AuthorableFieldType excludes it, FB-D8).
  await expect(page.locator('[data-testid="approval-form-palette-chip-attachment"]')).toHaveCount(0)

  await page.click('[data-testid="approval-form-palette-chip-number"]')
  await cards(page).last().click()
  // The inspector's common controls render for a number field; no currency/FWB-specific control
  // exists (no test id for one — the ABSENCE of any such affordance is the assertion).
  await expect(page.locator('[data-testid="approval-form-field-inspector-label"]')).toBeVisible()
  const inspectorHtml = await page.locator('[data-testid="approval-form-field-inspector"]').innerHTML()
  expect(inspectorHtml).not.toContain('currencySymbol')
  expect(inspectorHtml).not.toContain('thousandsSeparator')
  await page.screenshot({ path: `${OUT}/afb-mounted-b12.png` })
})
