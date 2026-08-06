#!/usr/bin/env node
/**
 * Attendance Windows-native QA v2 — evidence summary tool.
 *
 * Draft/HOLD. Synthetic data only. Pinned SOURCE_SHA 0dc3596dd (unchanged by QA tooling).
 *
 * The runner enforces a CLOSED SET of exactly the ten matrix ids. Harnesses upsert one case at a
 * time, so the evidence summary must START as the full ten (all BLOCKED) — otherwise the runner
 * would throw on any partial file and could never be run until all ten exist. So:
 *
 *   --init            seed <evidence-dir>/summary.json from summary.template.json (10 BLOCKED).
 *                     Run this FIRST; harnesses then upsert into a file that already has the set.
 *   --record-residue  run residue-check.sql against the isolated DB and write the count into
 *                     summary.json.residue. Run AFTER the drop/recreate teardown (must be 0).
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  DEFAULT_EVIDENCE_DIR,
  openIsolatedClient,
  parseArg,
} from './qa-runtime.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const TEMPLATE = path.resolve(HERE, '..', 'summary.template.json')
const RESIDUE_SQL = path.resolve(HERE, '..', 'residue-check.sql')

async function main() {
  const evidenceDir = parseArg('--evidence-dir', DEFAULT_EVIDENCE_DIR)
  const summaryPath = path.join(evidenceDir, 'summary.json')

  if (process.argv.includes('--init')) {
    fs.mkdirSync(evidenceDir, { recursive: true })
    fs.copyFileSync(TEMPLATE, summaryPath)
    console.log(`[summary-tool] seeded ${summaryPath} from summary.template.json (10 BLOCKED, closed set)`)
    return
  }

  if (process.argv.includes('--record-residue')) {
    if (!fs.existsSync(summaryPath)) throw new Error(`No summary.json at ${summaryPath}; run --init first.`)
    const sql = fs.readFileSync(RESIDUE_SQL, 'utf8')
    const client = await openIsolatedClient()
    let residue
    try {
      residue = Number((await client.query(sql)).rows[0].residue)
    } finally {
      await client.end()
    }
    const summary = JSON.parse(fs.readFileSync(summaryPath, 'utf8'))
    summary.residue = residue
    fs.writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`)
    console.log(`[summary-tool] recorded residue=${residue} into ${summaryPath}`)
    if (residue !== 0) console.log('[summary-tool] NOTE: residue != 0 — this is the pre-teardown negative control, not a clean result.')
    return
  }

  throw new Error('Usage: summary-tool.mjs (--init | --record-residue) [--evidence-dir <dir>]')
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(`[summary-tool] ERROR: ${error?.message ?? error}`)
    process.exit(1)
  })
