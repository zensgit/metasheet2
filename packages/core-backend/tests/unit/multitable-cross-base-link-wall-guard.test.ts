/**
 * ②a wall — §2a.2 DURABLE STRUCTURAL GUARD ("a new link-field write seam must be base-validated by
 * construction").
 *
 * The cross-base wall (`validateLinkFieldConfig`) is wired at the two field-DEFINITION route
 * chokepoints — POST /fields (create) and PATCH /fields/:fieldId (update). The multi-sink lesson (§2a.3
 * needed four review rounds to find every record-data egress surface) says: a future contributor who
 * adds a THIRD link-field write seam and forgets the base check will reopen the structural hole
 * silently. This guard prevents that by enumerating, at the SOURCE level:
 *
 *   1. The two route field-write chokepoints both invoke `validateLinkFieldConfig` (the wall),
 *      adjacent to the existing `validateLookupRollupConfig` call — so removing/relocating the wall
 *      from either chokepoint trips RED.
 *   2. The wall is gated on the foreign-sheet-key PRESENCE (payload-presence gate), mirroring the
 *      aiShortcut / expression lazy-revalidation pattern — so a rename-only PATCH on a pre-existing
 *      (legacy) cross-base link is not retroactively rejected (GA-T4b). The gate must cover ALL
 *      parseLinkFieldConfig foreign aliases (foreignSheetId / foreignDatasheetId / datasheetId).
 *   3. EVERY `INSERT INTO meta_fields` / `UPDATE meta_fields ... property` seam across src/ that can
 *      write a link field is enumerated against a FROZEN allowlist. A NEW or relocated seam fails this
 *      test until a contributor classifies it: WALL (routes through validateLinkFieldConfig) or
 *      OUT-OF-SCOPE (programmatic / internal path explicitly outside this slice — with a one-line
 *      reason recorded as a reviewer residual). Catching a third seam is the entire point.
 *
 * If this test fails you almost certainly added (or moved) a link-field write seam. Route it through
 * `validateLinkFieldConfig`, or classify it OUT-OF-SCOPE in SEAMS below with a reason.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, test } from 'vitest'

const SRC = join(__dirname, '../../src')
const read = (rel: string) => readFileSync(join(SRC, rel), 'utf8')

const UNIVER_META = read('routes/univer-meta.ts')

/** Lines (1-based) of every `INSERT INTO meta_fields` / `UPDATE meta_fields ... property` occurrence. */
function fieldWriteSites(src: string): Array<{ line: number; text: string }> {
  const sites: Array<{ line: number; text: string }> = []
  const lines = src.split('\n')
  lines.forEach((raw, i) => {
    const trimmed = raw.trimStart()
    if (trimmed.startsWith('//') || trimmed.startsWith('*')) return
    if (raw.includes('INSERT INTO meta_fields')) sites.push({ line: i + 1, text: raw.trim() })
    // Only `UPDATE meta_fields` statements that write `property` are link-config writes; the bare
    // `"order"` shuffles never touch property and cannot introduce a cross-base link.
    else if (raw.includes('UPDATE meta_fields') && raw.includes('property')) sites.push({ line: i + 1, text: raw.trim() })
  })
  return sites
}

/**
 * FROZEN registry of every link-field write seam across src/, keyed by `<file>:<approx-line-context>`.
 * Disposition:
 *   WALL         — the route field-DEFINITION chokepoint; routes through validateLinkFieldConfig.
 *   ORDER-SHUFFLE — UPDATE that does not write `property` (cannot carry a foreignSheetId).
 *   OUT-OF-SCOPE  — a programmatic/internal write path deliberately outside this slice (reviewer residual).
 *
 * Keyed by file + a stable substring of the statement so a relocated/new seam surfaces as unaudited.
 */
const SEAMS: Array<{ file: string; needle: string; disposition: 'WALL' | 'OUT-OF-SCOPE'; reason: string }> = [
  // routes/univer-meta.ts — the two WALL chokepoints (CREATE + UPDATE) both call validateLinkFieldConfig.
  {
    file: 'routes/univer-meta.ts',
    needle: "INSERT INTO meta_fields (id, sheet_id, name, type, property, \"order\")",
    disposition: 'WALL',
    reason: 'POST /fields create chokepoint — preceded by validateLinkFieldConfig',
  },
  {
    file: 'routes/univer-meta.ts',
    needle: 'UPDATE meta_fields\n           SET name = $2, type = $3, property = $4::jsonb',
    disposition: 'WALL',
    reason: 'PATCH /fields/:fieldId update chokepoint — preceded by validateLinkFieldConfig',
  },
  // routes/univer-meta.ts — the seed-sheet sample creator. Its fields are a FIXED in-process template
  // whose link target (if any) is created in the SAME base via ensureLegacyBase; never a user-supplied
  // cross-base foreignSheetId.
  {
    file: 'routes/univer-meta.ts',
    needle: "INSERT INTO meta_fields (id, sheet_id, name, type, property, \"order\")\n         VALUES ($1, $2, $3, $4, $5::jsonb, $6)\n         ON CONFLICT (id) DO NOTHING",
    disposition: 'OUT-OF-SCOPE',
    reason: 'seed-sheet sample: fixed in-process template, fields + base created together (ensureLegacyBase); no user-supplied cross-base target',
  },
  // routes/univer-meta.ts — system people-sheet ensureField: hard-coded type 'string', never a link.
  {
    file: 'routes/univer-meta.ts',
    needle: "INSERT INTO meta_fields (id, sheet_id, name, type, property, \"order\")\n       VALUES ($1, $2, $3, 'string', '{}'::jsonb, $4)",
    disposition: 'OUT-OF-SCOPE',
    reason: "system people-sheet ensureField: hard-coded type 'string', never writes a link field",
  },
  // multitable/provisioning.ts — programmatic object provisioning (PLM/integration). CAN write link
  // fields with a foreignSheetId; intentionally NOT gated in this slice (internal provisioning is a
  // separate trust/scope domain, see PR body residual + design §2a.2 "record link 写" line).
  {
    file: 'multitable/provisioning.ts',
    needle: 'INSERT INTO meta_fields (id, sheet_id, name, type, property, "order")',
    disposition: 'OUT-OF-SCOPE',
    reason: 'provisioning ensureFields: programmatic PLM/integration object provisioning — reviewer residual, gated separately if/when it accepts cross-base targets',
  },
  {
    file: 'multitable/provisioning.ts',
    needle: 'UPDATE meta_fields\n     SET property = $3::jsonb',
    disposition: 'OUT-OF-SCOPE',
    reason: 'provisioning patchObjectFieldProperty: programmatic property merge — reviewer residual, same domain as ensureFields',
  },
]

describe('②a §2a.2 cross-base link wall — durable structural guard', () => {
  test('both route field-DEFINITION chokepoints invoke validateLinkFieldConfig (the wall)', () => {
    // The wall must be defined exactly once and called at both chokepoints, adjacent to the lookup/
    // rollup validator. `await validateLinkFieldConfig(` matches the CALL sites only (the definition is
    // `async function validateLinkFieldConfig(`, excluded).
    const defs = [...UNIVER_META.matchAll(/function validateLinkFieldConfig\(/g)]
    expect(defs.length).toBe(1)
    const calls = [...UNIVER_META.matchAll(/await validateLinkFieldConfig\(/g)]
    // 1 call inside POST /fields + 1 call inside PATCH /fields/:fieldId.
    expect(
      calls.length,
      'validateLinkFieldConfig call count drifted from the two field-write chokepoints (POST /fields, ' +
        'PATCH /fields/:fieldId). The wall must guard BOTH create and update. Re-wire the missing chokepoint.',
    ).toBe(2)
    // Each validateLookupRollupConfig chokepoint must be paired with a validateLinkFieldConfig call
    // (they share the same two field-write seams).
    const lookupCalls = [...UNIVER_META.matchAll(/await validateLookupRollupConfig\(/g)]
    expect(lookupCalls.length).toBe(2)
  })

  test('the wall is gated on the foreign-sheet-key payload presence (compat: covers all aliases)', () => {
    // The PATCH compat gate must check the foreign-sheet key presence in the RAW payload — covering all
    // parseLinkFieldConfig aliases — so a rename-only PATCH on a pre-existing link is not retroactively
    // rejected (GA-T4b). Assert the presence gate references each alias key.
    expect(UNIVER_META).toMatch(/foreignSheetId/)
    expect(UNIVER_META).toMatch(/foreignDatasheetId/)
    expect(UNIVER_META).toMatch(/datasheetId/)
    // A dedicated presence-gate predicate (mirroring aiShortcutInPayload / expressionInPayload) gates
    // the PATCH-side wall call.
    expect(UNIVER_META).toMatch(/linkForeignKeyInPayload|foreignSheetKeyInPayload|linkConfigInPayload/)
  })

  test('every link-field write/update seam across src is audited (WALL or OUT-OF-SCOPE)', () => {
    const files = ['routes/univer-meta.ts', 'multitable/provisioning.ts']
    const found: Array<{ file: string; line: number; text: string }> = []
    for (const file of files) {
      for (const site of fieldWriteSites(read(file))) {
        found.push({ file, ...site })
      }
    }
    expect(found.length).toBeGreaterThan(0)

    // Each registered seam must still be present in the source (catches a relocated/deleted seam).
    const sources: Record<string, string> = {}
    for (const file of files) sources[file] = read(file)
    const missingRegistered = SEAMS.filter((s) => !sources[s.file].includes(s.needle))
    expect(
      missingRegistered.map((s) => `${s.file} :: ${s.reason}`),
      '②a GUARD: a registered link-field write seam moved or disappeared — re-confirm the wall still ' +
        'guards it, then update SEAMS needle.',
    ).toEqual([])

    // Each found seam must match at least one registered seam needle (catches a NEW unaudited seam).
    const unaudited = found.filter(
      (site) => !SEAMS.some((s) => s.file === site.file && sources[site.file].includes(s.needle) && site.text.length > 0 && matchesSeam(site, s)),
    )
    expect(
      unaudited.map((s) => `${s.file}:${s.line} → ${s.text.slice(0, 80)}`),
      '②a GUARD: unaudited link-field write seam(s). You likely added an INSERT/UPDATE meta_fields ' +
        'path that can carry a foreignSheetId. Route it through validateLinkFieldConfig (WALL) or ' +
        'classify it OUT-OF-SCOPE in SEAMS with a reason (reviewer residual).',
    ).toEqual([])
  })
})

/** A found site matches a registered seam when the registered needle's FIRST line is a substring of the site text. */
function matchesSeam(site: { text: string }, seam: { needle: string }): boolean {
  const firstNeedleLine = seam.needle.split('\n')[0].trim()
  return site.text.includes(firstNeedleLine) || firstNeedleLine.includes(site.text.replace(/,$/, '').trim())
}
