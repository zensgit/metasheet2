/**
 * Repo guard — h24-midnight recurrence guard for `Intl.DateTimeFormat` sites (issue #4922).
 *
 * THE DEFECT CLASS. Any `Intl.DateTimeFormat` whose output is PARSED numerically and
 * configured with `hour12: false` is subject to the h24-midnight hazard: older ICU (the
 * node 18/20 class — including the production image, `Dockerfile.backend` =
 * `node:20-slim`) resolves `hour12: false` to the h24 hour cycle, which formats midnight as
 * hour `'24'` on the SAME displayed calendar date. Two concrete corruptions were proven
 * live on 2026-08-15 (PR #4911 investigation) in `plugins/plugin-attendance/index.cjs`:
 * `getZonedParts` overflowed `Date.UTC(..., 24, ...)` a day forward (every midnight wall
 * time landed one day early for offset-0 zones), and `getZonedMinutes` returned 1440+
 * minutes for a midnight instant in EVERY timezone. Newer ICU resolves `hour12: false` to
 * h23, so the corruption is invisible on a developer's own machine — only CI's node 18/20
 * matrix and production exhibit it. A formatter with NEITHER `hour12` NOR `hourCycle` is
 * WORSE than either: it inherits `en-US`'s h12 default, which is wrong in a different way
 * for a parser expecting 24-hour digits.
 *
 * THE FIX PATTERN (landed in #4911, commit `6d3adf8c33`, and already the house idiom in
 * `packages/core-backend/src/multitable/automation-timezone.ts`): replace `hour12: false`
 * with explicit `hourCycle: 'h23'` — per spec `hour12` takes precedence over `hourCycle`
 * when both are present, so adding `hourCycle` ALONGSIDE `hour12` is a silent no-op, it
 * must REPLACE it — and add a defensive `hour === 24 ? 0 : hour` fold after parsing (the
 * displayed calendar DATE does not roll back under h24, only the hour string does).
 *
 * WHY A FROZEN ALLOWLIST TABLE, NOT A DERIVED "is this statement's output parsed" CHECK.
 * The task this guard was built against explicitly offers this as the fallback when
 * mechanical derivation is too fragile, and this codebase's own shape is why: the two
 * ALREADY-FIXED parsing sites in `plugin-attendance/index.cjs` (`getZonedParts`,
 * `getZonedMinutes`) and one display-only site (`toWorkDate`) do not call
 * `new Intl.DateTimeFormat` directly — they all route through one shared cache factory,
 * `getCachedIntlDateTimeFormat(cache, timeZone, locale, options)`, whose own construction
 * expression (`new Intl.DateTimeFormat(locale, { ...options, timeZone: tz })`) never
 * contains a literal `hour12` or `hourCycle` token at all — those live in each CALLER's own
 * options object, three statements away from the actual `new Intl.DateTimeFormat(`. A
 * same-statement or same-function textual derivation would either miss all three real sites
 * or require a bespoke special case for this one file. The table below instead enumerates
 * every real site by hand (verified against this commit, not trusted from the issue text —
 * the issue's own "display sites" sentence mis-groups `automation-timezone.ts` and is
 * corrected here) and the guard asserts MECHANICALLY that the table's site set exactly
 * matches what a live scan finds (see "COVERAGE" below), so a genuinely new site — whether
 * a brand new `new Intl.DateTimeFormat(` anywhere in domain, or a new caller of the shared
 * factory — reds the guard until a human classifies it.
 *
 * SITE IDENTITY IS THE SOURCE LINE'S TEXT, NEVER ITS LINE NUMBER.
 * `plugins/plugin-attendance/index.cjs` is a 24000+-line file edited constantly; keying
 * identity on line numbers would red this guard on every unrelated edit above a site, and
 * the reflexive repair — bump the frozen number back to green — is exactly how a genuinely
 * new hazardous site would slip past review. The trimmed text of the site's own source line
 * only changes when the site itself is touched, so that text (not its line number) is the
 * table's key. Line numbers appear only inside comments, computed for a reader, never
 * compared.
 *
 * SCOPE. Domain = every tracked `.ts` / `.cjs` / `.mjs` file under
 * `packages/core-backend/src/`, `plugins/`, or `scripts/` — 1664 files at the time of
 * writing (measure yourself: `git ls-files | grep -E '\.(ts|cjs|mjs)$' | grep -E
 * '^(packages/core-backend/src/|plugins/|scripts/)' | wc -l`). `.js` was swept across the
 * same three directories too (18 tracked files) and contains zero `Intl.DateTimeFormat`
 * constructions — the 3-extension domain is not hiding a `.js` site today, but that is a
 * measured fact about this commit, not a standing guarantee; whoever adds a `.js` producer
 * under these directories should re-check.
 *
 * DELIBERATELY OUT OF SCOPE: `apps/web/**` (frontend, not the production backend surface
 * #4922 is about). It was swept anyway while building this table and holds 7 more
 * `Intl.DateTimeFormat` sites, NONE reclassified here — a deliberate deferral, not a claim
 * they are clean:
 *   - `apps/web/src/composables/useCalendarDays.ts` — 4 sites (`formatCalendarMonthLabel`
 *     ×2 fallback pair, `formatLunarDayLabel` ×2 fallback pair) — all date/month-only, no
 *     `hour` component, on manual read.
 *   - `apps/web/src/multitable/utils/field-display.ts:27` — timezone-validity probe
 *     (`.format(new Date(0))`, result discarded), same idiom as the backend probes below.
 *   - `apps/web/src/utils/timezones.ts:26` — ALREADY uses explicit `hourCycle: 'h23'` on
 *     manual read; would classify PARSING-compliant if this guard's domain widened to cover
 *     it.
 *   - `apps/web/src/views/attendance/attendanceTimezones.ts:121` — requests `hour` but only
 *     ever reads the `timeZoneName` part (`shortOffset`), not the `hour` part; the `hour`
 *     option is present only to force a correct offset computation, not parsed itself.
 *
 * WHY EVERY NON-EXCEPTION DISPLAY SITE MUST CARRY NO `hour:` OPTION AT ALL, NOT JUST
 * "NO hour12". A display site with an `hour` option and NO parsing today could gain
 * `.formatToParts()` / split-and-`Number()` consumption tomorrow without adding a single new
 * `new Intl.DateTimeFormat(` anywhere — same site, same line, just a new caller reading its
 * output — which the coverage leg below (keyed on construction sites) would never see. Every
 * display entry is therefore additionally required to have NO `hour:` key, with exactly one
 * named, audited exception: `interactive-card-update.ts`'s `CARD_TIME_FORMATTER`, whose
 * `hour12: false` result is traced (by hand, below) into a `已同意${suffix}` / `已驳回${suffix}`
 * template-string interpolation and never parsed — issue #4922 calls this one "cosmetic at
 * worst, optional tidy-up", so this guard leaves it alone but keeps a live check on the one
 * consumption pathway (`.formatToParts(`) that would turn it into a real hazard.
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const REPO_ROOT = path.resolve(__dirname, '../../../../')
const ISSUE = '#4922'

const SOURCE_EXTENSIONS = new Set(['.ts', '.cjs', '.mjs'])
const DOMAIN_PREFIXES = ['packages/core-backend/src/', 'plugins/', 'scripts/']

/** Domain DERIVED from git, never a hand-maintained list — same idiom as
 *  `source-files-no-raw-control-bytes.test.ts`. */
function trackedDomainFiles(root: string = REPO_ROOT): string[] {
  const raw = execFileSync('git', ['ls-files', '-z', '--cached'], {
    cwd: root,
    maxBuffer: 128 * 1024 * 1024,
  })
  return raw
    .toString('utf8')
    .split('\0')
    .filter((rel) => rel.length > 0)
    .filter((rel) => SOURCE_EXTENSIONS.has(path.extname(rel)))
    .filter((rel) => DOMAIN_PREFIXES.some((prefix) => rel.startsWith(prefix)))
    .sort()
}

type SiteKind = 'parsing' | 'display'

interface KnownSite {
  file: string
  /** Trimmed source-line text at the construction/call — the identity key. See docstring
   *  "SITE IDENTITY". */
  lineText: string
  kind: SiteKind
  /** True for exactly one documented exception: a DISPLAY site allowed to carry `hour:`
   *  (and `hour12`) because its output was hand-traced to a display-only interpolation. */
  allowsHourOption?: boolean
}

// prettier-ignore
const KNOWN_SITES: KnownSite[] = [
  // ---------------------------------------------------------------------------------
  // PARSING sites — output reaches formatToParts() with numeric consumption, or a
  // format() string is split/Number-parsed. Every entry MUST carry explicit
  // `hourCycle: 'h23'` and MUST NOT carry `hour12`.
  // ---------------------------------------------------------------------------------
  {
    // w4c1-strict-time.ts `zoneFormatter()` -> `wallPartsAt()` Number(part.value) per part.
    file: 'packages/core-backend/src/attendance/w4c1-strict-time.ts',
    lineText: "formatter = new Intl.DateTimeFormat('en-US', {",
    kind: 'parsing',
  },
  {
    // workday-calendar-port.ts `tzParts()` — formatToParts, `Number(get('hour')) % 24`.
    file: 'packages/core-backend/src/core/workday-calendar-port.ts',
    lineText: "const fmt = new Intl.DateTimeFormat('en-US', {",
    kind: 'parsing',
  },
  {
    // automation-timezone.ts `getFormatter()` -> `getZonedParts()` formatToParts,
    // Number(part.value) per part. The issue text's own "display sites" sentence
    // mis-groups this file; it is PARSING and already compliant.
    file: 'packages/core-backend/src/multitable/automation-timezone.ts',
    lineText: "fmt = new Intl.DateTimeFormat('en-US', {",
    kind: 'parsing',
  },
  {
    // AttendanceNotificationDeliveryWorker.ts `isAttendanceNotificationQuietHours()` —
    // formatToParts, hour/minute parts read directly as HH:MM comparison inputs.
    file: 'packages/core-backend/src/services/AttendanceNotificationDeliveryWorker.ts',
    lineText: "const parts = new Intl.DateTimeFormat('en-US', {",
    kind: 'parsing',
  },
  {
    // plugin-attendance/index.cjs `getZonedMinutes()` — indirect via the shared factory;
    // formatter.format(value).split(':') + Number(...). Fixed by #4911.
    file: 'plugins/plugin-attendance/index.cjs',
    lineText:
      "const formatter = getCachedIntlDateTimeFormat(zonedMinutesFormatterCache, timeZone, 'en-GB', {",
    kind: 'parsing',
  },
  {
    // plugin-attendance/index.cjs `getZonedParts()` — indirect via the shared factory;
    // formatter.formatToParts(date), Number(part.value) per part. Fixed by #4911.
    file: 'plugins/plugin-attendance/index.cjs',
    lineText:
      "const formatter = getCachedIntlDateTimeFormat(zonedPartsFormatterCache, timeZone, 'en-US', {",
    kind: 'parsing',
  },

  // ---------------------------------------------------------------------------------
  // DISPLAY sites — either a timezone-validity probe whose formatted output is
  // discarded, or a date-only (no `hour`) formatter, or (one exception) an audited
  // display-only interpolation. Every non-exception entry MUST NOT carry `hour:`.
  // ---------------------------------------------------------------------------------
  {
    // automation-timezone.ts `isValidIanaTimeZone()` — `.format(0)` return value discarded,
    // used only to force the RangeError on an unknown zone. No hour option at all.
    file: 'packages/core-backend/src/multitable/automation-timezone.ts',
    lineText: "new Intl.DateTimeFormat('en-US', { timeZone: timeZone.trim() }).format(0)",
    kind: 'display',
  },
  {
    // field-codecs.ts `dateTime` column-def normalizer — same validity-probe idiom.
    file: 'packages/core-backend/src/multitable/field-codecs.ts',
    lineText: "new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(new Date(0))",
    kind: 'display',
  },
  {
    // AttendanceNotificationDeliveryWorker.ts quiet-hours TZ env validator — same idiom.
    file: 'packages/core-backend/src/services/AttendanceNotificationDeliveryWorker.ts',
    lineText: "new Intl.DateTimeFormat('en-US', { timeZone }).format(new Date())",
    kind: 'display',
  },
  {
    // interactive-card-update.ts `CARD_TIME_FORMATTER` -> `formatCardTime()` -> interpolated
    // into `已同意${suffix}` / `已驳回${suffix}` card text. Never parsed. Issue #4922 calls
    // this "cosmetic at worst, optional tidy-up" — left as-is, guarded by the file-wide
    // consumption check below (`cardFormatterConsumptionViolations`).
    file: 'packages/core-backend/src/integrations/dingtalk/interactive-card-update.ts',
    lineText: "const CARD_TIME_FORMATTER = new Intl.DateTimeFormat('zh-CN', {",
    kind: 'display',
    allowsHourOption: true,
  },
  {
    // plugin-attendance/index.cjs `isValidTimeZoneIdentifier()` — validity probe.
    file: 'plugins/plugin-attendance/index.cjs',
    lineText: "new Intl.DateTimeFormat('en-US', { timeZone: zone }).format(new Date())",
    kind: 'display',
  },
  {
    // plugin-attendance/index.cjs `getCachedIntlDateTimeFormat()` — the shared factory's OWN
    // construction. Its literal options are always `{ ...options, timeZone: tz }`: no
    // hour12/hourCycle token ever appears here directly — the real options come from each
    // CALLER, which are the three factory-call entries in this table (two 'parsing' above,
    // one 'display' below).
    file: 'plugins/plugin-attendance/index.cjs',
    lineText: 'const fmt = new Intl.DateTimeFormat(locale, { ...options, timeZone: tz })',
    kind: 'display',
  },
  {
    // plugin-attendance/index.cjs `toWorkDate()` — indirect via the shared factory;
    // en-CA year/month/day only, no hour, `.format(value)` returned as the work-date string.
    file: 'plugins/plugin-attendance/index.cjs',
    lineText:
      "const formatter = getCachedIntlDateTimeFormat(workDateFormatterCache, timeZone, 'en-CA', {",
    kind: 'display',
  },
  {
    // attendance-work-date-resolver.cjs `isValidTimeZone()` — validity probe.
    file: 'plugins/plugin-attendance/lib/attendance-work-date-resolver.cjs',
    lineText: "new Intl.DateTimeFormat('en-US', { timeZone: value.trim() }).format(new Date(0))",
    kind: 'display',
  },
  {
    // staging-attendance-dispatch-d5-smoke.mjs `formatDateInTimeZone()` — formatToParts
    // consumed, but only year/month/day parts; no `hour` requested.
    file: 'scripts/ops/staging-attendance-dispatch-d5-smoke.mjs',
    lineText: "const parts = new Intl.DateTimeFormat('en-US', {",
    kind: 'display',
  },
  {
    // staging-attendance-makeup-punch-mp6-smoke.mjs `todayLocalKey()` — en-CA date-only.
    file: 'scripts/ops/staging-attendance-makeup-punch-mp6-smoke.mjs',
    lineText: "return new Intl.DateTimeFormat('en-CA', {",
    kind: 'display',
  },
  {
    // staging-attendance-shift-swap-sw5-smoke.mjs `formatDateInTimeZone()` — same as the
    // dispatch-d5 smoke sibling above: formatToParts, year/month/day only, no hour.
    file: 'scripts/ops/staging-attendance-shift-swap-sw5-smoke.mjs',
    lineText: "const parts = new Intl.DateTimeFormat('en-US', {",
    kind: 'display',
  },
]

function siteKey(s: { file: string; lineText: string }): string {
  return `${s.file}\0${s.lineText}`
}

interface CandidateSite {
  file: string
  lineText: string
  callText: string
}

const RAW_CONSTRUCTION_RE = /new Intl\.DateTimeFormat\(/g
/** The shared per-timezone formatter factory unique to `plugin-attendance/index.cjs` (see
 *  docstring). Its definition line is itself a raw construction site (tracked above as
 *  'display' — its own literal options never carry hour12/hourCycle); its CALLERS carry the
 *  real options and are found by this second pattern, definition line excluded. */
const FACTORY_CALL_RE = /getCachedIntlDateTimeFormat\(/g

function lineTextAt(content: string, matchIndex: number): string {
  const lineStart = content.lastIndexOf('\n', matchIndex) + 1
  let lineEnd = content.indexOf('\n', matchIndex)
  if (lineEnd === -1) lineEnd = content.length
  return content.slice(lineStart, lineEnd).trim()
}

/** Naive paren-balance scan from an opening `(` to its matching `)`. Correct for every
 *  known site in this domain (verified by hand while building KNOWN_SITES) because none of
 *  them holds an unbalanced paren inside a string/template literal within the call; the
 *  `overlapCount` check in `computeViolations` catches the specific failure mode where this
 *  assumption breaks (the scan running past its own call into a neighboring site). */
function extractCallText(content: string, openParenIndex: number): string {
  let depth = 0
  let i = openParenIndex
  for (; i < content.length; i++) {
    if (content[i] === '(') depth++
    else if (content[i] === ')') {
      depth--
      if (depth === 0) {
        i++
        break
      }
    }
  }
  return content.slice(openParenIndex, i)
}

function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
}

/** Mechanical candidate-site finder: every raw `new Intl.DateTimeFormat(` construction, plus
 *  (in a file that defines it) every CALLER of the shared `getCachedIntlDateTimeFormat`
 *  factory. Parameterised by root + file list so the positive controls exercise this exact
 *  function against a decoy tree, never a re-typed copy of it. */
function findCandidateSites(files: readonly string[], root: string = REPO_ROOT): CandidateSite[] {
  const out: CandidateSite[] = []
  for (const rel of files) {
    const content = fs.readFileSync(path.join(root, rel), 'utf8')
    for (const match of content.matchAll(RAW_CONSTRUCTION_RE)) {
      const openParenIndex = match.index! + match[0].length - 1
      out.push({
        file: rel,
        lineText: lineTextAt(content, match.index!),
        callText: extractCallText(content, openParenIndex),
      })
    }
    if (content.includes('function getCachedIntlDateTimeFormat(')) {
      for (const match of content.matchAll(FACTORY_CALL_RE)) {
        const lineText = lineTextAt(content, match.index!)
        if (lineText.startsWith('function getCachedIntlDateTimeFormat(')) continue
        const openParenIndex = match.index! + match[0].length - 1
        out.push({
          file: rel,
          lineText,
          callText: extractCallText(content, openParenIndex),
        })
      }
    }
  }
  return out
}

/** Builds the guard's failure text IN the asserted value (not a side comment), so a `toEqual
 *  ([])` diff on the caller side already names the file, the required fix, and issue #4922 —
 *  the guard's failure message requirement is structural, not something a reviewer has to
 *  trust separately from the test output. */
function computeViolations(sites: readonly KnownSite[], candidates: readonly CandidateSite[]): string[] {
  const violations: string[] = []
  for (const site of sites) {
    const matches = candidates.filter((c) => c.file === site.file && c.lineText === site.lineText)
    if (matches.length !== 1) {
      violations.push(
        `${site.file}: expected exactly 1 live match for known site "${site.lineText}", found ` +
          `${matches.length} — the site moved, was edited, or was removed; re-classify it against ${ISSUE}.`,
      )
      continue
    }
    const callText = stripComments(matches[0].callText)
    const overlapCount =
      (callText.match(/new Intl\.DateTimeFormat\(/g)?.length ?? 0) +
      (callText.match(/getCachedIntlDateTimeFormat\(/g)?.length ?? 0)
    if (overlapCount > 1) {
      violations.push(
        `${site.file}: "${site.lineText}" — call-text extraction overran into a neighboring ` +
          `Intl.DateTimeFormat/getCachedIntlDateTimeFormat call (a paren-balance bug in the guard ` +
          `itself, not necessarily a source defect) — fix extractCallText before trusting this site.`,
      )
      continue
    }
    if (site.kind === 'parsing') {
      const hasCorrectHourCycle = /\bhourCycle\s*:\s*'h23'/.test(callText)
      const hasHour12 = /\bhour12\s*:/.test(callText)
      if (hasHour12) {
        violations.push(
          `${site.file}: "${site.lineText}" is a PARSING site (its output is consumed numerically) ` +
            `and uses hour12 — older ICU (node 18/20, the production node:20-slim image) resolves ` +
            `hour12:false to the h24 hour cycle and renders midnight as hour '24' on the same day. ` +
            `Fix: REPLACE hour12 with hourCycle: 'h23' (hour12 takes precedence over hourCycle when ` +
            `both are present, so it must be replaced, not accompanied) and add a defensive ` +
            `\`hour === 24 ? 0 : hour\` fold after parsing. See ${ISSUE}.`,
        )
      } else if (!hasCorrectHourCycle) {
        violations.push(
          `${site.file}: "${site.lineText}" is a PARSING site without hourCycle: 'h23' — a formatter ` +
            `with neither hour12 nor hourCycle inherits the en-US h12 default, which is WORSE than h24 ` +
            `for a parser expecting 24-hour digits (and a non-h23 hourCycle value reproduces the same ` +
            `midnight defect this guard exists for). Fix: add hourCycle: 'h23' explicitly and a ` +
            `defensive \`hour === 24 ? 0 : hour\` fold after parsing. See ${ISSUE}.`,
        )
      }
    } else {
      if (site.allowsHourOption) {
        if (!/\bhour12\s*:\s*false/.test(callText)) {
          violations.push(
            `${site.file}: "${site.lineText}" is the one documented display-only hour12 exception and ` +
              `its options no longer match the audited shape (hour12: false) — re-audit whether its ` +
              `output is still unparsed before updating this table. See ${ISSUE}.`,
          )
        }
      } else if (/\bhour\s*:/.test(callText)) {
        violations.push(
          `${site.file}: "${site.lineText}" was classified DISPLAY (no hour component) but its ` +
            `options now carry an hour: key — re-classify: if its output is ever formatToParts'd or ` +
            `split/Number-parsed for the hour, this becomes a PARSING site and needs explicit ` +
            `hourCycle: 'h23' (never hour12). See ${ISSUE}.`,
        )
      }
    }
  }
  return violations
}

/** File-wide check for the one audited DISPLAY exception: `CARD_TIME_FORMATTER`'s primary
 *  numeric-consumption pathway (`formatToParts`) is absent. This does not attempt to prove
 *  every conceivable future consumption pattern is absent (that is not mechanically
 *  decidable from text) — it pins the one pathway that would turn today's audited
 *  display-only interpolation into a real parsing hazard. */
function cardFormatterConsumptionViolations(root: string = REPO_ROOT): string[] {
  const file = 'packages/core-backend/src/integrations/dingtalk/interactive-card-update.ts'
  const content = fs.readFileSync(path.join(root, file), 'utf8')
  const violations: string[] = []
  if (content.includes('CARD_TIME_FORMATTER.formatToParts(')) {
    violations.push(
      `${file}: CARD_TIME_FORMATTER is now consumed via formatToParts — it was audited as ` +
        `display-only (interpolated into a card status string). If it is now parsed, replace its ` +
        `hour12: false with hourCycle: 'h23' and add a defensive hour===24 fold. See ${ISSUE}.`,
    )
  }
  return violations
}

/** Writes files into an isolated temp tree that mirrors repo-relative paths. Never plants
 *  into the real tree — same reasoning as `source-files-no-raw-control-bytes.test.ts`. */
function withDecoyTree(files: Record<string, string>, run: (decoyRoot: string) => void): void {
  const decoyRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hourcycle-guard-decoy-'))
  try {
    for (const [rel, content] of Object.entries(files)) {
      const abs = path.join(decoyRoot, rel)
      fs.mkdirSync(path.dirname(abs), { recursive: true })
      fs.writeFileSync(abs, content)
    }
    run(decoyRoot)
  } finally {
    fs.rmSync(decoyRoot, { recursive: true, force: true })
  }
}

describe('repo guard: h24-midnight hourCycle/hour12 parsing hazard (issue #4922)', () => {
  it('the scanned domain is non-vacuous and the KNOWN_SITES table matches the site count found live', () => {
    // A zero-length or wrongly-filtered domain would make every leg below pass vacuously —
    // the "empty read is not an absence" failure this repo's other source-scan guards exist
    // to avoid, one level up.
    const files = trackedDomainFiles()
    expect(files.length).toBeGreaterThan(1500)
    expect(files).toContain('plugins/plugin-attendance/index.cjs')
    expect(files).toContain('packages/core-backend/src/multitable/automation-timezone.ts')
    const candidates = findCandidateSites(files)
    expect(candidates.length).toBe(KNOWN_SITES.length)
  })

  it('KNOWN_SITES covers exactly the real Intl.DateTimeFormat sites in the domain (set equality — a new site reds this until classified)', () => {
    const candidates = findCandidateSites(trackedDomainFiles())
    expect(candidates.map(siteKey).sort()).toEqual(KNOWN_SITES.map(siteKey).sort())
  })

  it('every PARSING site carries explicit hourCycle:\'h23\' (never hour12), and every non-exception DISPLAY site carries no hour: option', () => {
    const candidates = findCandidateSites(trackedDomainFiles())
    expect(computeViolations(KNOWN_SITES, candidates)).toEqual([])
  })

  it('the one audited DISPLAY exception (CARD_TIME_FORMATTER) shows no sign of being parsed via formatToParts', () => {
    expect(cardFormatterConsumptionViolations()).toEqual([])
  })

  it('POSITIVE CONTROL: a planted hour12:false PARSING site reds the leg, naming the file, the fix, and the issue', () => {
    const probe = 'packages/core-backend/src/attendance/probe-hour12-parsing.ts'
    withDecoyTree(
      {
        [probe]:
          "const fmt = new Intl.DateTimeFormat('en-US', { hour12: false, hour: '2-digit' })\n" +
          'const parts = fmt.formatToParts(new Date())\n' +
          "const hour = Number(parts.find((p) => p.type === 'hour')?.value)\n",
      },
      (decoyRoot) => {
        const site: KnownSite = {
          file: probe,
          lineText: "const fmt = new Intl.DateTimeFormat('en-US', { hour12: false, hour: '2-digit' })",
          kind: 'parsing',
        }
        const violations = computeViolations([site], findCandidateSites([probe], decoyRoot))
        expect(violations.length).toBe(1)
        expect(violations[0]).toContain(probe)
        expect(violations[0]).toContain("hourCycle: 'h23'")
        expect(violations[0]).toContain(ISSUE)
      },
    )
  })

  it('POSITIVE CONTROL: a planted no-option PARSING site (inherits h12) reds the leg', () => {
    const probe = 'packages/core-backend/src/attendance/probe-no-option-parsing.ts'
    withDecoyTree(
      {
        [probe]:
          "const fmt = new Intl.DateTimeFormat('en-US', { hour: '2-digit' })\n" +
          'const parts = fmt.formatToParts(new Date())\n',
      },
      (decoyRoot) => {
        const site: KnownSite = {
          file: probe,
          lineText: "const fmt = new Intl.DateTimeFormat('en-US', { hour: '2-digit' })",
          kind: 'parsing',
        }
        const violations = computeViolations([site], findCandidateSites([probe], decoyRoot))
        expect(violations.length).toBe(1)
        expect(violations[0]).toContain(probe)
        expect(violations[0]).toContain("hourCycle: 'h23'")
        expect(violations[0]).toContain(ISSUE)
      },
    )
  })

  it('control: a compliant hourCycle:\'h23\' PARSING site does NOT red (proves the guard discriminates, not just always-red)', () => {
    const probe = 'packages/core-backend/src/attendance/probe-compliant-parsing.ts'
    withDecoyTree(
      {
        [probe]:
          "const fmt = new Intl.DateTimeFormat('en-US', { hourCycle: 'h23', hour: '2-digit' })\n" +
          'const parts = fmt.formatToParts(new Date())\n',
      },
      (decoyRoot) => {
        const site: KnownSite = {
          file: probe,
          lineText: "const fmt = new Intl.DateTimeFormat('en-US', { hourCycle: 'h23', hour: '2-digit' })",
          kind: 'parsing',
        }
        expect(computeViolations([site], findCandidateSites([probe], decoyRoot))).toEqual([])
      },
    )
  })

  it('POSITIVE CONTROL: a DISPLAY site that gains an hour: option reds (must be re-classified before it can be parsed)', () => {
    const probe = 'packages/core-backend/src/attendance/probe-display-gains-hour.ts'
    withDecoyTree(
      {
        [probe]:
          "new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', hour: '2-digit' }).format(new Date())\n",
      },
      (decoyRoot) => {
        const site: KnownSite = {
          file: probe,
          lineText: "new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', hour: '2-digit' }).format(new Date())",
          kind: 'display',
        }
        const violations = computeViolations([site], findCandidateSites([probe], decoyRoot))
        expect(violations.length).toBe(1)
        expect(violations[0]).toContain(probe)
        expect(violations[0]).toContain(ISSUE)
      },
    )
  })

  it('POSITIVE CONTROL: a brand-new Intl.DateTimeFormat site not in KNOWN_SITES reds the coverage leg', () => {
    const probe = 'packages/core-backend/src/attendance/probe-unclassified.ts'
    const lineText = "const fmt = new Intl.DateTimeFormat('en-US', { hourCycle: 'h23' })"
    withDecoyTree({ [probe]: `${lineText}\n` }, (decoyRoot) => {
      const candidateKeys = new Set(findCandidateSites([probe], decoyRoot).map(siteKey))
      const knownKeys = new Set(KNOWN_SITES.map(siteKey))
      const unclassified = [...candidateKeys].filter((k) => !knownKeys.has(k))
      expect(unclassified).toEqual([siteKey({ file: probe, lineText })])
    })
  })
})
