// F2 real-browser verification (delta §5 F2, §7.1 item 7, §7.2 B2/B3/B5
// subset): exact insertion-slot placement via REAL DataTransfer drags,
// cancelled-drag no-ops (Escape + drop-outside), strict codec rejection of
// foreign/malformed payloads, and the stale-anchor values-free no-op — all
// asserted from DOM/session evidence, screenshots as supporting artifacts.
// The full B1-B12 width matrix runs in F4 on the assembled head.
import { test, expect, type Page } from '@playwright/test'
import { mkdirSync } from 'node:fs'

const OUT = 'verification-output'
const HARNESS = '/verification/approval-form-builder-harness.html'
// Pinned literal, asserted against the runtime module's exported constant so
// codec drift cannot silently decouple this spec from production.
const MIME = 'application/x-metasheet-approval-form'

interface AfbState {
  order: string[]
  domOrder: (string | null)[]
  slotCount: number
  historyDepth: number
  statusText: string
  activeDragKind: 'palette' | 'field' | null
  readOnly: boolean
}

async function state(page: Page): Promise<AfbState> {
  return await page.evaluate(() => window.__AFB__!.state())
}

async function settled(page: Page): Promise<AfbState> {
  // The session mutates synchronously; wait until the DOM re-render caught up.
  await page.waitForFunction(() => {
    const current = window.__AFB__!.state()
    return (
      current.domOrder.length === current.order.length &&
      current.domOrder.every((entry, index) => entry === current.order[index])
    )
  })
  return await state(page)
}

/** Real-DataTransfer drag from a palette chip onto slot `slotIndex`. */
async function dragChipToSlot(
  page: Page,
  chipType: string,
  slotIndex: number,
): Promise<void> {
  await page.evaluate(
    ({ chipType, slotIndex }) => {
      const chip = document.querySelector(
        `[data-testid="approval-form-palette-chip-${chipType}"]`,
      )!
      const dataTransfer = new DataTransfer()
      chip.dispatchEvent(
        new DragEvent('dragstart', {
          bubbles: true,
          cancelable: true,
          dataTransfer,
        }),
      )
      const slot = document.querySelectorAll('.approval-form-builder__slot')[
        slotIndex
      ]!
      slot.dispatchEvent(
        new DragEvent('dragover', {
          bubbles: true,
          cancelable: true,
          dataTransfer,
        }),
      )
      slot.dispatchEvent(
        new DragEvent('drop', {
          bubbles: true,
          cancelable: true,
          dataTransfer,
        }),
      )
      chip.dispatchEvent(
        new DragEvent('dragend', {
          bubbles: true,
          cancelable: true,
          dataTransfer,
        }),
      )
    },
    { chipType, slotIndex },
  )
}

test.beforeEach(async ({ page }) => {
  mkdirSync(OUT, { recursive: true })
  await page.goto(HARNESS, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => window.__AFB__?.ready === true)
})

test('harness pins: codec MIME and initial N+1 slot render', async ({
  page,
}) => {
  const errs: string[] = []
  page.on('console', (m) => {
    if (m.type() === 'error') errs.push(`console: ${m.text()}`)
  })
  page.on('pageerror', (e) => errs.push(`pageerror: ${String(e)}`))

  expect(await page.evaluate(() => window.__AFB__!.mime)).toBe(MIME)
  const initial = await settled(page)
  expect(initial.order).toEqual(['text', 'number', 'date'])
  expect(initial.slotCount).toBe(4) // N+1
  expect(initial.historyDepth).toBe(0)
  expect(initial.statusText).toBe('')
  await page.screenshot({ path: `${OUT}/afb-initial.png`, fullPage: true })
  expect(errs, `console/page errors:\n${errs.join('\n')}`).toEqual([])
})

test('B2/B3 — real DataTransfer drags place at the EXACT start/middle/end slots', async ({
  page,
}) => {
  // Start slot (index 0): prepend.
  await dragChipToSlot(page, 'select', 0)
  let current = await settled(page)
  expect(current.order).toEqual(['select', 'text', 'number', 'date'])
  expect(current.slotCount).toBe(5)
  expect(current.historyDepth).toBe(1)
  expect(current.activeDragKind).toBeNull() // drop + dragend cleared

  // Middle slot (index 2 = after the 2nd field): exact between placement.
  await dragChipToSlot(page, 'user', 2)
  current = await settled(page)
  expect(current.order).toEqual(['select', 'text', 'user', 'number', 'date'])
  expect(current.historyDepth).toBe(2)

  // End slot (last index): exact append.
  await dragChipToSlot(page, 'textarea', current.slotCount - 1)
  current = await settled(page)
  expect(current.order).toEqual([
    'select',
    'text',
    'user',
    'number',
    'date',
    'textarea',
  ])
  expect(current.historyDepth).toBe(3)
  await page.screenshot({ path: `${OUT}/afb-after-drags.png`, fullPage: true })
})

test('B5 — cancelled drag: Escape clears transient state with ZERO mutation', async ({
  page,
}) => {
  await page.evaluate(() => {
    const chip = document.querySelector(
      '[data-testid="approval-form-palette-chip-date"]',
    )!
    chip.dispatchEvent(
      new DragEvent('dragstart', {
        bubbles: true,
        cancelable: true,
        dataTransfer: new DataTransfer(),
      }),
    )
  })
  expect((await state(page)).activeDragKind).toBe('palette')
  await expect(
    page.locator('[data-testid="approval-form-builder"]'),
  ).toHaveAttribute('data-drag-active', 'true')

  await page.keyboard.press('Escape')
  await expect(
    page.locator('[data-testid="approval-form-builder"]'),
  ).not.toHaveAttribute('data-drag-active', 'true')
  const after = await settled(page)
  expect(after.activeDragKind).toBeNull()
  expect(after.order).toEqual(['text', 'number', 'date'])
  expect(after.historyDepth).toBe(0)
})

test('B5 — drop OUTSIDE any slot is a no-op that still clears drag state', async ({
  page,
}) => {
  await page.evaluate(() => {
    const chip = document.querySelector(
      '[data-testid="approval-form-palette-chip-select"]',
    )!
    const dataTransfer = new DataTransfer()
    chip.dispatchEvent(
      new DragEvent('dragstart', {
        bubbles: true,
        cancelable: true,
        dataTransfer,
      }),
    )
    // Canvas background, not a slot.
    document
      .querySelector('[data-testid="approval-form-builder"]')!
      .dispatchEvent(
        new DragEvent('drop', {
          bubbles: true,
          cancelable: true,
          dataTransfer,
        }),
      )
  })
  const after = await settled(page)
  expect(after.activeDragKind).toBeNull()
  expect(after.order).toEqual(['text', 'number', 'date'])
  expect(after.historyDepth).toBe(0)
})

test('B5 — foreign/malformed payloads are rejected; positive control mutates', async ({
  page,
}) => {
  await page.evaluate((mime) => {
    const slot = document.querySelectorAll('.approval-form-builder__slot')[0]!
    const drop = (dataTransfer: DataTransfer) =>
      slot.dispatchEvent(
        new DragEvent('drop', {
          bubbles: true,
          cancelable: true,
          dataTransfer,
        }),
      )
    // text/plain foreign payloads — bare type AND command-shaped JSON.
    let dt = new DataTransfer()
    dt.setData('text/plain', 'select')
    drop(dt)
    dt = new DataTransfer()
    dt.setData(
      'text/plain',
      JSON.stringify({ version: 1, kind: 'palette', fieldType: 'select' }),
    )
    drop(dt)
    // Malformed JSON under the application MIME.
    dt = new DataTransfer()
    dt.setData(mime, '{oops')
    drop(dt)
    // Unknown kind under the application MIME.
    dt = new DataTransfer()
    dt.setData(
      mime,
      JSON.stringify({ version: 1, kind: 'palette-field', fieldType: 'text' }),
    )
    drop(dt)
  }, MIME)
  let current = await settled(page)
  expect(current.order).toEqual(['text', 'number', 'date'])
  expect(current.historyDepth).toBe(0)

  // Positive control: a well-formed payload under the app MIME on the SAME slot.
  await page.evaluate((mime) => {
    const slot = document.querySelectorAll('.approval-form-builder__slot')[0]!
    const dataTransfer = new DataTransfer()
    dataTransfer.setData(
      mime,
      JSON.stringify({ version: 1, kind: 'palette', fieldType: 'select' }),
    )
    slot.dispatchEvent(
      new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer }),
    )
  }, MIME)
  current = await settled(page)
  expect(current.order).toEqual(['select', 'text', 'number', 'date'])
  expect(current.historyDepth).toBe(1)
})

test('B5 — stale anchor: drop on a slot whose anchor field was just removed is a values-free no-op', async ({
  page,
}) => {
  const removed = await page.evaluate((mime) => {
    // Capture the slot bound to {after, <2nd field>} BEFORE the removal, then
    // drop before the re-render lands — the genuine staleness window.
    const staleSlot = document.querySelectorAll(
      '.approval-form-builder__slot',
    )[2]!
    const ok = window.__AFB__!.removeSecondField()
    const dataTransfer = new DataTransfer()
    dataTransfer.setData(
      mime,
      JSON.stringify({ version: 1, kind: 'palette', fieldType: 'select' }),
    )
    staleSlot.dispatchEvent(
      new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer }),
    )
    return ok
  }, MIME)
  expect(removed).toBe(true)
  const after = await settled(page)
  // Only the removal landed; the stale drop inserted nothing.
  expect(after.order).toEqual(['text', 'date'])
  expect(after.historyDepth).toBe(1)
  const staleMessage = await page.evaluate(
    () => window.__AFB__!.staleRetryMessage,
  )
  expect(after.statusText).toBe(staleMessage)
  // Values-free: the copy names no field ids/labels/values.
  expect(staleMessage).not.toMatch(/local_|field_|字段 \d/)
  await page.screenshot({ path: `${OUT}/afb-stale-anchor.png`, fullPage: true })
})

test('B8 — read-only transition clears drag state and removes all drop targets', async ({
  page,
}) => {
  await page.evaluate(() => {
    const chip = document.querySelector(
      '[data-testid="approval-form-palette-chip-text"]',
    )!
    chip.dispatchEvent(
      new DragEvent('dragstart', {
        bubbles: true,
        cancelable: true,
        dataTransfer: new DataTransfer(),
      }),
    )
    window.__AFB__!.setReadOnly(true)
  })
  await page.waitForFunction(
    () => window.__AFB__!.state().slotCount === 0,
  )
  const after = await state(page)
  expect(after.activeDragKind).toBeNull()
  expect(after.order).toEqual(['text', 'number', 'date'])
  expect(
    await page
      .locator('[data-testid="approval-form-palette-chip-text"]')
      .count(),
  ).toBe(0)
})
