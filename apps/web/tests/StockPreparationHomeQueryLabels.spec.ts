import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  STOCK_PREP_HOME_FILTER_KEYS,
  STOCK_PREP_HOME_STATUS_LABELS,
  stockPrepHomeStatusLabel,
} from '../src/services/integration/stockPreparation/operatorHomeCards'
import {
  resolveStockPrepPullBanner,
  STOCK_PREP_HOME_DIRECTORY_MAY_BE_INCOMPLETE,
  STOCK_PREP_HOME_PULL_TARGET_SCAN_CAPPED,
  STOCK_PREP_HOME_PULL_TARGET_UNREADABLE,
} from '../src/services/integration/stockPreparation/plainLanguage'

// D4 (hardening wave, 2026-09-08) — 共享常量.
//
// 今天要处理 (StockPreparationOperatorHome.vue) and 项目查询 (StockPreparationProjectQueryView.vue)
// render the SAME five status words in their filter/status chip rows, and the SAME three-sentence
// pull-target priority chain above them. Before this wave each `.vue` file carried its OWN literal
// copy of both — two `Record<..., [string, string]>` maps and two `if`/`if`/`if` chains, byte-
// identical on the day they were written and with nothing tying them together afterwards. This file
// tests the ONE shared implementation both views now call (`stockPrepHomeStatusLabel` /
// `resolveStockPrepPullBanner`), plus a SOURCE-LEVEL check that neither `.vue` file re-introduces a
// local copy — a component-level mount would only prove today's wiring, not that a later edit cannot
// quietly grow a second copy the way the original duplication did.
//
// 「两视图渲染出的 chip 文案逐字相同」 follows from this file BY CONSTRUCTION rather than being
// re-proven by mounting both components: `bi(...stockPrepHomeStatusLabel(key))` and
// `bi(pullBanner.text.zh, pullBanner.text.en)` are literally the SAME expression evaluated in both
// templates once each view is confirmed (below) to call the shared function rather than a local
// table — there is only one place either word can come from.

const HERE = path.dirname(fileURLToPath(import.meta.url))
const HOME_SRC = fs.readFileSync(
  path.join(HERE, '../src/components/integration/stockPreparation/StockPreparationOperatorHome.vue'),
  'utf8',
)
const QUERY_SRC = fs.readFileSync(
  path.join(HERE, '../src/components/integration/stockPreparation/StockPreparationProjectQueryView.vue'),
  'utf8',
)

describe('StockPreparationHomeQueryLabels — 今天要处理 / 项目查询 共享文案常量', () => {
  it('all five status keys have a bilingual pair, and stockPrepHomeStatusLabel is a plain lookup over the same map', () => {
    for (const key of STOCK_PREP_HOME_FILTER_KEYS) {
      const [zh, en] = STOCK_PREP_HOME_STATUS_LABELS[key]
      expect(zh.length, `${key}: zh label must not be empty`).toBeGreaterThan(0)
      expect(en.length, `${key}: en label must not be empty`).toBeGreaterThan(0)
      expect(stockPrepHomeStatusLabel(key)).toBe(STOCK_PREP_HOME_STATUS_LABELS[key])
    }
    // Exactly the five §3/§4.1 words, in the frozen key order — a sixth key or a reorder here is a
    // structural change to the chip row, not a wording tweak.
    expect(STOCK_PREP_HOME_FILTER_KEYS).toEqual(['all', 'pending_decision', 'blocked', 'ready', 'not_pulled'])
  })

  it('resolveStockPrepPullBanner — null directory, and the priority order (unreadable > capped > incomplete)', () => {
    expect(resolveStockPrepPullBanner(null)).toBeNull()
    expect(resolveStockPrepPullBanner(undefined)).toBeNull()
    expect(resolveStockPrepPullBanner({})).toBeNull()

    expect(resolveStockPrepPullBanner({ pullTargetReady: false })).toEqual({
      key: 'pull_target_unreadable',
      text: STOCK_PREP_HOME_PULL_TARGET_UNREADABLE,
    })
    expect(resolveStockPrepPullBanner({ pullTargetScanCapped: true })).toEqual({
      key: 'pull_target_scan_capped',
      text: STOCK_PREP_HOME_PULL_TARGET_SCAN_CAPPED,
    })
    expect(resolveStockPrepPullBanner({ directoryMayBeIncomplete: true })).toEqual({
      key: 'directory_may_be_incomplete',
      text: STOCK_PREP_HOME_DIRECTORY_MAY_BE_INCOMPLETE,
    })

    // Priority: `pullTargetReady === false` beats BOTH of the other two, whichever else is also set.
    expect(resolveStockPrepPullBanner({
      pullTargetReady: false,
      pullTargetScanCapped: true,
      directoryMayBeIncomplete: true,
    })!.key).toBe('pull_target_unreadable')
    // ...and `pullTargetScanCapped` beats `directoryMayBeIncomplete` when both are set.
    expect(resolveStockPrepPullBanner({
      pullTargetScanCapped: true,
      directoryMayBeIncomplete: true,
    })!.key).toBe('pull_target_scan_capped')
  })

  it('resolveStockPrepPullBanner — every check is `=== true` / `=== false`, never a truthiness test', () => {
    // An older backend OMITS these fields; `undefined` must read as "unknown", never as `false` (which
    // would show the most alarming sentence on every deployment that predates the U2 contract).
    expect(resolveStockPrepPullBanner({ pullTargetReady: undefined })).toBeNull()
    expect(resolveStockPrepPullBanner({ pullTargetReady: true })).toBeNull()
    expect(resolveStockPrepPullBanner({ pullTargetScanCapped: false })).toBeNull()
    expect(resolveStockPrepPullBanner({ directoryMayBeIncomplete: false })).toBeNull()
  })

  it('SOURCE GUARD: 今天要处理 calls the shared label lookup, not a local FILTER_LABELS table', () => {
    expect(HOME_SRC).toContain('stockPrepHomeStatusLabel')
    expect(HOME_SRC).not.toMatch(/\bFILTER_LABELS\b/)
    expect(HOME_SRC).not.toMatch(/\bSTATUS_LABELS\b/)
  })

  it('SOURCE GUARD: 项目查询 calls the shared label lookup, not a local STATUS_LABELS table', () => {
    expect(QUERY_SRC).toContain('stockPrepHomeStatusLabel')
    expect(QUERY_SRC).not.toMatch(/\bSTATUS_LABELS\b/)
    expect(QUERY_SRC).not.toMatch(/\bFILTER_LABELS\b/)
  })

  it('SOURCE GUARD: both views call the shared pullBanner resolver, not their own if/if/if chain', () => {
    // Matched as the CALL SHAPE the old inline chain actually had (`dir.pullTargetReady === false`,
    // reading straight off the local `dir` binding each view's own computed used to declare) rather
    // than the bare comparison text — ProjectQueryView.vue's `sourceAvailable` section legitimately
    // documents the SAME field name for an unrelated reason a few hundred lines away, and a bare
    // substring match would have falsely flagged that prose as a regrown local chain.
    for (const src of [HOME_SRC, QUERY_SRC]) {
      expect(src).toContain('resolveStockPrepPullBanner(')
      expect(src).not.toMatch(/dir\.pullTargetReady\s*===\s*false/)
      expect(src).not.toMatch(/dir\.pullTargetScanCapped\s*===\s*true/)
      expect(src).not.toMatch(/dir\.directoryMayBeIncomplete\s*===\s*true/)
    }
  })
})
