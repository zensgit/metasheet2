#!/usr/bin/env node

/**
 * ②a §2a.4-b — dangling / cross-base link ops sweep (READ-ONLY).
 *
 * Enumerates two governance hazards that the §2a.2 write-path wall cannot retroactively fix on already-
 * stored rows (and which base-delete would otherwise orphan silently — see the PR / design §2a.4):
 *
 *   (i)  cross-base link FIELDS — a `meta_fields` row of type 'link' whose foreign target sheet's
 *        `base_id` differs (null-aware, IS DISTINCT FROM) from the link field's own sheet `base_id`.
 *        The foreign target is read across the parseLinkFieldConfig aliases in the SAME precedence
 *        (foreignDatasheetId → foreignSheetId → datasheetId, trimmed/empty-as-null) so an aliased
 *        cross-base link is not missed.
 *   (ii) dangling meta_links — `meta_links.foreign_record_id` with no matching `meta_records` row.
 *        `foreign_record_id` has NO FK, so a deleted foreign record leaves a dangling edge.
 *
 * VALUES-FREE: ids / base ids / counts only, never cell data. READ-ONLY: no writes. Mirrors the psql
 * model of `scripts/ops/check-yjs-retention-health.mjs`.
 *
 * Exit codes:
 *   0  clean (no cross-base link fields, no dangling links)
 *   1  usage or execution failure
 *   2  data fetched but hazards found
 */

import { spawnSync } from 'node:child_process'

function printHelp() {
  console.log(`Usage: node scripts/ops/multitable-dangling-link-sweep.mjs [options]

Read-only sweep for cross-base link fields and dangling meta_links (②a §2a.4-b).

Options:
  --database-url <url>   Database URL, default from DATABASE_URL
  --limit <count>        Max rows to enumerate per category, default 200
  --json                 Print raw JSON payload after the summary
  --json-only            Print JSON payload only
  --help                 Show this help

Exit codes:
  0  clean      1  usage/execution failure      2  hazards found
`)
}

function parseArgs(argv) {
  const opts = {
    databaseUrl: process.env.DATABASE_URL || '',
    limit: 200,
    showJson: false,
    jsonOnly: false,
  }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    const next = argv[i + 1]
    switch (arg) {
      case '--database-url':
        opts.databaseUrl = next
        i += 1
        break
      case '--limit':
        opts.limit = Number(next)
        i += 1
        break
      case '--json':
        opts.showJson = true
        break
      case '--json-only':
        opts.jsonOnly = true
        break
      case '--help':
        printHelp()
        process.exit(0)
        break
      default:
        console.error(`Unknown argument: ${arg}`)
        printHelp()
        process.exit(1)
    }
  }
  return opts
}

function runPsql(databaseUrl, sql) {
  const result = spawnSync('psql', [databaseUrl, '-X', '-q', '-t', '-A', '-c', sql], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || `psql exited with status ${result.status}`)
  }
  return result.stdout.trim()
}

function buildPayload(databaseUrl, limit) {
  const cap = Math.max(1, Number.isFinite(limit) ? limit : 200)

  // (i) cross-base link fields. Alias precedence matches parseLinkFieldConfig; IS DISTINCT FROM is the
  // SQL of `baseIdsAreCrossBase` (null-aware !==). The foreign sheet must exist for a base comparison
  // (a link to a missing sheet is a separate residual, not a cross-base finding).
  const crossSql = `
SELECT COALESCE(json_agg(row_to_json(t)), '[]'::json)
FROM (
  SELECT
    mf.id              AS "fieldId",
    mf.sheet_id        AS "sourceSheetId",
    src.base_id        AS "sourceBaseId",
    fk.foreign_sheet_id AS "foreignSheetId",
    fgn.base_id        AS "foreignBaseId"
  FROM meta_fields mf
  JOIN meta_sheets src ON src.id = mf.sheet_id
  JOIN LATERAL (
    SELECT COALESCE(
      NULLIF(trim(mf.property ->> 'foreignDatasheetId'), ''),
      NULLIF(trim(mf.property ->> 'foreignSheetId'), ''),
      NULLIF(trim(mf.property ->> 'datasheetId'), '')
    ) AS foreign_sheet_id
  ) fk ON TRUE
  JOIN meta_sheets fgn ON fgn.id = fk.foreign_sheet_id
  WHERE mf.type = 'link'
    AND fk.foreign_sheet_id IS NOT NULL
    AND src.base_id IS DISTINCT FROM fgn.base_id
  ORDER BY mf.id ASC
  LIMIT ${cap}
) t;
`

  // (ii) dangling meta_links: foreign_record_id with no matching meta_records row.
  const danglingSql = `
SELECT COALESCE(json_agg(row_to_json(t)), '[]'::json)
FROM (
  SELECT
    l.id                AS "linkId",
    l.field_id          AS "fieldId",
    l.record_id         AS "recordId",
    l.foreign_record_id AS "foreignRecordId"
  FROM meta_links l
  LEFT JOIN meta_records r ON r.id = l.foreign_record_id
  WHERE r.id IS NULL
  ORDER BY l.id ASC
  LIMIT ${cap}
) t;
`

  const crossBaseLinkFields = JSON.parse(runPsql(databaseUrl, crossSql) || '[]')
  const danglingLinks = JSON.parse(runPsql(databaseUrl, danglingSql) || '[]')

  return {
    crossBaseLinkFields,
    danglingLinks,
    counts: {
      crossBaseLinkFields: crossBaseLinkFields.length,
      danglingLinks: danglingLinks.length,
    },
  }
}

function printSummary(payload) {
  const { counts } = payload
  const clean = counts.crossBaseLinkFields === 0 && counts.danglingLinks === 0
  console.log(`Multitable link sweep: ${clean ? 'CLEAN' : 'HAZARDS FOUND'}`)
  console.log(`Cross-base link fields: ${counts.crossBaseLinkFields}`)
  console.log(`Dangling meta_links: ${counts.danglingLinks}`)

  if (payload.crossBaseLinkFields.length > 0) {
    console.log('Cross-base link fields (fieldId: sourceSheet[base] → foreignSheet[base]):')
    for (const row of payload.crossBaseLinkFields) {
      console.log(
        `- ${row.fieldId}: ${row.sourceSheetId}[${row.sourceBaseId ?? 'null'}] → ${row.foreignSheetId}[${row.foreignBaseId ?? 'null'}]`,
      )
    }
  }
  if (payload.danglingLinks.length > 0) {
    console.log('Dangling meta_links (linkId: field/record → missing foreignRecord):')
    for (const row of payload.danglingLinks) {
      console.log(`- ${row.linkId}: ${row.fieldId}/${row.recordId} → ${row.foreignRecordId}`)
    }
  }
}

function main() {
  const opts = parseArgs(process.argv.slice(2))
  if (!opts.databaseUrl) {
    console.error('Missing database URL. Use --database-url or DATABASE_URL.')
    process.exit(1)
  }

  try {
    const payload = buildPayload(opts.databaseUrl, opts.limit)
    if (opts.jsonOnly) {
      console.log(JSON.stringify(payload, null, 2))
    } else {
      printSummary(payload)
      if (opts.showJson) console.log(JSON.stringify(payload, null, 2))
    }
    const clean = payload.counts.crossBaseLinkFields === 0 && payload.counts.danglingLinks === 0
    process.exit(clean ? 0 : 2)
  } catch (error) {
    console.error(`Failed to run dangling-link sweep: ${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  }
}

main()
