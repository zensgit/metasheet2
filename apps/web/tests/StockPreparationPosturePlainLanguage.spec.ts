import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  STOCK_PREP_POSTURE_PLAIN,
  stockPrepPosturePlain,
} from '../src/services/integration/stockPreparation/plainLanguage'

// THE FOURTH SITE OF THE POSTURE FENCE, made mechanical.
//
// A posture fence ("围栏") is declared in FOUR places, and three of them already fail loudly when
// they fall out of step:
//   1. plugins/plugin-integration-core/lib/stock-preparation-preflight.cjs  buildPosture()
//   2. plugins/plugin-integration-core/app.manifest.json                    posture.entries[]
//   3. packages/core-backend/tests/platform-app-registry.test.ts            the id list
//   4. THIS table — the operator-facing plain-language line on the install page
//
// (4) had no guardrail, and CI proved the consequence rather than the theory: at commit 11dbe5bf2
// the manifest already declared `carryTargetBinding` while this table had no entry for it, and the
// whole web gate passed. `stockPrepPosturePlain` returns null for an unknown id — it does not throw
// — so the failure mode is silent: the install page renders a bare English state token to an
// on-site operator, in the middle of a deploy window, and nothing anywhere says so.
//
// The manifest is read FROM THE REPO, the way the plugin's own app-manifest.test.cjs reads it, so
// this cannot drift by copying the id list into the test.
const HERE = path.dirname(fileURLToPath(import.meta.url))
const MANIFEST_PATH = path.resolve(
  HERE,
  '..',
  '..',
  '..',
  'plugins',
  'plugin-integration-core',
  'app.manifest.json',
)

interface PostureEntry {
  id: string
  expectedState?: string
  what?: string
}

function manifestPostureEntries(): PostureEntry[] {
  const raw = fs.readFileSync(MANIFEST_PATH, 'utf8')
  const manifest = JSON.parse(raw) as { posture?: { entries?: PostureEntry[] } }
  return manifest.posture?.entries ?? []
}

describe('stock-prep posture plain language', () => {
  it('reads the shipped manifest (anti-vacuity: the fences really are declared there)', () => {
    const entries = manifestPostureEntries()
    expect(entries.length).toBeGreaterThan(0)
    for (const entry of entries) expect(typeof entry.id).toBe('string')
  })

  it('carries a plain-language line for EVERY posture fence the manifest declares', () => {
    const declared = manifestPostureEntries().map((entry) => entry.id).sort()
    const translated = Object.keys(STOCK_PREP_POSTURE_PLAIN).sort()
    const missing = declared.filter((id) => !translated.includes(id))
    expect(
      missing,
      `these posture fences ship to the install page with no plain-language line: ${missing.join(', ')}. `
        + 'Add an entry to STOCK_PREP_POSTURE_PLAIN — an operator reading a deploy window should never '
        + 'meet a bare state token.',
    ).toEqual([])
  })

  it('every declared fence resolves through the lookup, in both languages', () => {
    for (const entry of manifestPostureEntries()) {
      const plain = stockPrepPosturePlain(entry.id)
      expect(plain, `stockPrepPosturePlain('${entry.id}') must resolve`).toBeTruthy()
      // Both languages, and a NEXT line: the install page renders all three, so a half-filled entry
      // is the same silent gap as a missing one.
      expect(String(plain?.zh ?? '').trim().length, `${entry.id}.zh`).toBeGreaterThan(0)
      expect(String(plain?.en ?? '').trim().length, `${entry.id}.en`).toBeGreaterThan(0)
      expect(String(plain?.zhNext ?? '').trim().length, `${entry.id}.zhNext`).toBeGreaterThan(0)
      expect(String(plain?.enNext ?? '').trim().length, `${entry.id}.enNext`).toBeGreaterThan(0)
    }
  })
})
