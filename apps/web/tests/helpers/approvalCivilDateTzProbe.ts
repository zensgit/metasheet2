/**
 * Out-of-process host-timezone probe for the approval civil-date rendering (test report 2026-10-08
 * T4a-E2; gate r1 P2-1). Spawned by approval-civil-date-tz-probe.spec.ts, never imported into a
 * vitest worker.
 *
 * Why out-of-process: Node reads `TZ` once, at startup. Setting it in a freshly spawned process's
 * environment reliably changes the zone the code under test sees; mutating `process.env.TZ` inside
 * an already-running worker does not (same finding as dateOnlyTzProbe.ts / GATE-5047 P2-1).
 *
 * Prints ONE JSON line:
 *   - the zone this process actually resolved, so the spec can refuse a silent fallback to UTC;
 *   - what the module under test (`buildDisplayFields`) renders for a `date` field and for a
 *     `date_range` field with `dateType: 'date'`, in both shell locales;
 *   - the expected labels, written out from the civil string's own digits (no Intl involved);
 *   - two negative controls computed HERE, never through the module under test, one per failure
 *     direction, so the spec can prove the probe sees the defect in the zone it runs:
 *       `oldInstantPathEn`       the civil string read as UTC midnight and shown in the host zone
 *                                (the pre-fix path; the PREVIOUS day west of UTC);
 *       `localMidnightReadInUtcEn` the civil day built at LOCAL midnight and shown in UTC (the
 *                                PREVIOUS day east of UTC).
 */
import { buildDisplayFields } from '../../src/approvals/detailField'
import type { FormField, FormSchema } from '../../src/types/approval'

const START = process.argv[2] || '2026-10-08'
const END = process.argv[3] || '2026-10-09'

const schema: FormSchema = {
  fields: [
    { id: 'fld_day', type: 'date', label: 'Day' } as FormField,
    { id: 'fld_trip', type: 'date_range', label: 'Trip', props: { dateType: 'date' } } as FormField,
  ],
}

function civilParts(value: string): [number, number, number] {
  const [year, month, day] = value.split('-').map(Number)
  return [year, month, day]
}

function expectedLabel(value: string, isZh: boolean): string {
  const [year, month, day] = civilParts(value)
  return isZh ? `${year}/${month}/${day}` : `${month}/${day}/${year}`
}

function render(isZh: boolean): { date: string; range: string } {
  const fields = buildDisplayFields(schema, { fld_day: START, fld_trip: { start: START, end: END } }, { isZh })
  const byKey = new Map(fields.map((field) => [field.key, field.value]))
  return { date: byKey.get('fld_day') ?? '', range: byKey.get('fld_trip') ?? '' }
}

const [year, month, day] = civilParts(START)

process.stdout.write(
  JSON.stringify({
    tzEnv: process.env.TZ ?? null,
    resolvedTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    offsetMinutes: new Date(year, month - 1, day).getTimezoneOffset(),
    expected: {
      zh: { date: expectedLabel(START, true), range: `${expectedLabel(START, true)} ~ ${expectedLabel(END, true)}` },
      en: { date: expectedLabel(START, false), range: `${expectedLabel(START, false)} ~ ${expectedLabel(END, false)}` },
    },
    actual: { zh: render(true), en: render(false) },
    negativeControls: {
      oldInstantPathEn: new Date(START).toLocaleDateString('en-US'),
      localMidnightReadInUtcEn: new Date(year, month - 1, day).toLocaleDateString('en-US', { timeZone: 'UTC' }),
    },
  }),
)
