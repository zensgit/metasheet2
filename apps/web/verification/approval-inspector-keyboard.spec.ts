import { test, expect } from '@playwright/test'
import { mkdirSync } from 'node:fs'

// Real-browser verification for PR #4944's gate fix round (Deviation (4) / "minimum set to clear
// this gate" item 3: docs/development/approval-lock0-d0-interaction-delta-20260817.md +
// review at /tmp/pr4944-review-claude-20260817.md). jsdom cannot execute native radio-group /
// tablist keyboard semantics at all (that IS the gate's P1-1 blind spot — "Link B" in the review),
// so this is the one leg that has to run in a real browser. See
// approval-inspector-keyboard-harness.ts for what is mounted (the REAL shipped
// ApprovalCanvasNodeInspector.vue + ApprovalGraphNodeConfigEditor.vue components) and what is
// mirrored rather than re-derived (the P1-1 `setApprovalSourceKind` fix — the production function's
// own correctness is pinned separately by a jsdom regression test).

const OUT = 'verification-output'
const HARNESS = '/verification/approval-inspector-keyboard-harness.html'

test('PR #4944 gate fix: roster arrow traversal preserves payload (P1-1); tab strip stays contained and reachable (A-11/A-12)', async ({ page }) => {
  mkdirSync(OUT, { recursive: true })
  const errs: string[] = []
  page.on('console', (m) => { if (m.type() === 'error') errs.push(`console: ${m.text()}`) })
  page.on('pageerror', (e) => errs.push(`pageerror: ${String(e)}`))

  await page.setViewportSize({ width: 1000, height: 800 })
  await page.goto(HARNESS, { waitUntil: 'domcontentloaded' })

  // ── Fixture sanity: static_role / roleIds:['legal'] is checked and the D2 echo reflects it ──
  const legalRadio = page.locator('[data-testid="approval-node-source-kind-static_role"]')
  await expect(legalRadio).toBeChecked()
  const echo = page.locator('[data-testid="approval-node-source-configured-summary"]')
  await expect(echo).toHaveText('已配置：指定角色（1 个）')
  await page.screenshot({ path: `${OUT}/approval-inspector-keyboard-initial.png` })

  // ── P1-1: real ArrowDown/ArrowUp on the NATIVE radiogroup (gate Link A/B, FIX-1 instructions) ──
  // "select static_role with roleIds:['legal'] → arrow to requester → arrow back → payload
  // PRESERVED (picker shows legal, echo 已配置：指定角色（1 个）)".
  await legalRadio.focus()
  await page.keyboard.press('ArrowDown')
  const requesterRadio = page.locator('[data-testid="approval-node-source-kind-requester"]')
  await expect(requesterRadio).toBeChecked()
  await expect(echo).toHaveText('已配置：发起人本人')
  const changeLog = page.locator('[data-test="change-event-log"]')
  await expect(changeLog).toContainText('change:requester')

  await page.keyboard.press('ArrowUp')
  await expect(legalRadio).toBeChecked()
  // The FIX-1 assertion: the payload survives the round trip — not stripped to
  // "已配置：指定角色（未选择）" the way the pre-fix `setApprovalSourceKind` left it.
  await expect(echo).toHaveText('已配置：指定角色（1 个）')
  const rolePicker = page.locator('[data-testid="approval-node-source-role-picker"]')
  await expect(rolePicker).toHaveValue('legal')
  await page.screenshot({ path: `${OUT}/approval-inspector-keyboard-after-roundtrip.png` })

  // ── A-11/A-12: tablist Left/Right stays within the two-tab strip; toolbar Left/Right stays
  //    within itself; neither widget's arrow key crosses into the other ──
  const tab1 = page.locator('[data-testid="approval-canvas-inspector-tab-assignee"]')
  const tab2 = page.locator('[data-testid="approval-canvas-inspector-tab-fieldPermissions"]')
  await expect(tab1).toHaveAttribute('aria-selected', 'true')
  await expect(tab2).toHaveAttribute('aria-selected', 'false')

  const toolbarButton = page.locator(`[data-testid="approval-canvas-insert-${'app_b'}"]`)
  await toolbarButton.focus()
  await page.keyboard.press('ArrowRight')
  await expect(tab1).toHaveAttribute('aria-selected', 'true') // unaffected by a toolbar arrow press
  let active = await page.evaluate(() => document.activeElement?.getAttribute('data-testid'))
  expect(active, 'toolbar arrow press must not move focus off the toolbar button').toBe(`approval-canvas-insert-app_b`)

  await tab1.focus()
  await page.keyboard.press('ArrowRight')
  await expect(tab2).toHaveAttribute('aria-selected', 'true')
  await expect(tab1).toHaveAttribute('aria-selected', 'false')
  active = await page.evaluate(() => document.activeElement?.getAttribute('data-testid'))
  expect(active, 'ArrowRight on the tablist must move real DOM focus to the newly active tab').toBe('approval-canvas-inspector-tab-fieldPermissions')
  // The toolbar button never had its tabIndex rewritten by the tablist's roving-tabindex logic.
  const toolbarTabIndex = await toolbarButton.evaluate((el) => (el as HTMLElement).tabIndex)
  expect(toolbarTabIndex, 'toolbar button stays in the Tab sequence — tablist arrows never touch it').toBe(0)

  await page.keyboard.press('ArrowLeft')
  await expect(tab1).toHaveAttribute('aria-selected', 'true')

  // ── Roving tabindex: only ONE tab is ever a Tab stop at a time (real browser, not a jsdom
  //    tabIndex-property read) ──
  const tab1Index = await tab1.evaluate((el) => (el as HTMLElement).tabIndex)
  const tab2Index = await tab2.evaluate((el) => (el as HTMLElement).tabIndex)
  expect([tab1Index, tab2Index].filter((i) => i === 0)).toHaveLength(1)
  await page.screenshot({ path: `${OUT}/approval-inspector-keyboard-tabstrip.png` })

  expect(errs, `console/page errors:\n${errs.join('\n')}`).toEqual([])
})
