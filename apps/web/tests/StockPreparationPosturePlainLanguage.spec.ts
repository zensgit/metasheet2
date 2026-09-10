import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  STOCK_PREP_BOARD_ERROR_GENERIC,
  STOCK_PREP_BOARD_ERROR_PLAIN,
  STOCK_PREP_ERROR_COPY_SENTENCE,
  STOCK_PREP_ERROR_GENERIC,
  STOCK_PREP_ERROR_PLAIN,
  STOCK_PREP_POSTURE_PLAIN,
  STOCK_PREP_READ_FAILED,
  STOCK_PREP_SOURCE_BLOCKER_PLAIN,
  STOCK_PREP_SOURCE_WARNING_PLAIN,
  stockPrepBoardErrorPlain,
  stockPrepErrorCopyText,
  stockPrepErrorPlain,
  stockPrepPosturePlain,
  stockPrepSourceBlockerPlain,
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

// The SOURCE preflight's own closed vocabularies, read from the module that emits them. Same
// discipline as the manifest read above and for the same reason: the register below is the fourth
// site of a fact declared elsewhere, and a hand-kept copy cannot notice its own omissions. This
// guard exists because it did not: `pull_principal_delegation_unavailable` shipped server-side while
// this table had no entry, so the install page would have rendered a bare English code to an
// implementer mid-deploy — exactly the failure the posture guard above was written to stop.
const SOURCE_PREFLIGHT_PATH = path.resolve(
  HERE,
  '..',
  '..',
  '..',
  'plugins',
  'plugin-integration-core',
  'lib',
  'stock-preparation-source-preflight.cjs',
)

/**
 * The string literals of one `Object.freeze({ … })` register in that module.
 *
 * Deliberately a TEXT read rather than a `require`: the module pulls the vendor-preset catalog and
 * the BOM read plan behind it, and a spec that had to load all of that to learn six words would be
 * a spec nobody could keep hermetic. The line shape (`NAME: 'value',`) is narrow enough that a
 * comment — which is where every quote and CJK character in that file lives — cannot match it.
 */
function sourcePreflightCodes(constName: string): string[] {
  const text = fs.readFileSync(SOURCE_PREFLIGHT_PATH, 'utf8')
  const start = text.indexOf(`const ${constName} = Object.freeze({`)
  if (start === -1) throw new Error(`${constName} not found in stock-preparation-source-preflight.cjs`)
  // The register body holds only `NAME: 'value',` lines, so the first `})` after the declaration
  // is its own close.
  const end = text.indexOf('})', start)
  if (end === -1) throw new Error(`${constName} is not closed`)
  const body = text.slice(start, end)
  // Two literal spaces, and a tolerated CR: the file ships LF but checks out CRLF on Windows, and
  // a bare \s class would happily eat the newline itself.
  return [...body.matchAll(/^ {2}[A-Z0-9_]+: '([a-z0-9_]+)',\r?$/gm)].map((match) => match[1]).sort()
}

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

  // THE SAME GUARANTEE, ON THE SOURCE PREFLIGHT'S REGISTERS.
  //
  // These are the fourth site of a fact declared in the plugin, and they had no guardrail at all —
  // which is how `pull_principal_delegation_unavailable` shipped server-side with no line here, and
  // how `declared_subtree_contradicts_measurement` had been missing since the folder-tree axis
  // landed. `stockPrepSourceBlockerPlain` returns null rather than throwing, so the failure mode is
  // silent: a bare English code on the install page, mid-deploy, to an on-site implementer.
  it('reads the shipped source-preflight vocabularies (anti-vacuity)', () => {
    expect(sourcePreflightCodes('SOURCE_PREFLIGHT_BLOCKER_CODES').length).toBeGreaterThan(5)
    expect(sourcePreflightCodes('SOURCE_PREFLIGHT_WARNING_CODES').length).toBeGreaterThan(5)
    // The code this PR added must really be in the register the guard reads, or the guard below is
    // asserting about a vocabulary that does not contain the thing it was written for.
    expect(sourcePreflightCodes('SOURCE_PREFLIGHT_BLOCKER_CODES'))
      .toContain('pull_principal_delegation_unavailable')
  })

  it('carries a plain-language line for EVERY source blocker and warning the server can emit', () => {
    const blockers = sourcePreflightCodes('SOURCE_PREFLIGHT_BLOCKER_CODES')
    const missingBlockers = blockers.filter((code) => !(code in STOCK_PREP_SOURCE_BLOCKER_PLAIN))
    expect(
      missingBlockers,
      `these source blockers reach the install page with no plain-language line: ${missingBlockers.join(', ')}. `
        + 'Add an entry to STOCK_PREP_SOURCE_BLOCKER_PLAIN — an implementer meeting a refusal should '
        + 'never be handed a bare code with no next step.',
    ).toEqual([])

    const warnings = sourcePreflightCodes('SOURCE_PREFLIGHT_WARNING_CODES')
    const missingWarnings = warnings.filter((code) => !(code in STOCK_PREP_SOURCE_WARNING_PLAIN))
    expect(missingWarnings, `source warnings with no plain-language line: ${missingWarnings.join(', ')}`).toEqual([])
  })

  it('every source blocker resolves through the lookup, in both languages, with a next step', () => {
    for (const code of sourcePreflightCodes('SOURCE_PREFLIGHT_BLOCKER_CODES')) {
      const plain = stockPrepSourceBlockerPlain(code)
      expect(plain, `stockPrepSourceBlockerPlain('${code}') must resolve`).toBeTruthy()
      expect(String(plain?.zh ?? '').trim().length, `${code}.zh`).toBeGreaterThan(0)
      expect(String(plain?.en ?? '').trim().length, `${code}.en`).toBeGreaterThan(0)
      // A source blocker without a NEXT line is the failure this whole register exists to prevent:
      // it names a problem on somebody else's machine and stops.
      expect(String(plain?.zhNext ?? '').trim().length, `${code}.zhNext`).toBeGreaterThan(0)
      expect(String(plain?.enNext ?? '').trim().length, `${code}.enNext`).toBeGreaterThan(0)
    }
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

  // -------------------------------------------------------------------------
  // P0-5: THE SECOND LINE, on the error vocabulary.
  //
  // `STOCK_PREP_ERROR_PLAIN` widened from `StockPrepPlainText` to `StockPrepPlainEntry` (F7) so every
  // code could carry a `zhNext`/`enNext` alongside its unchanged first line. This is the anti-vacuity
  // half for THAT table: every entry — including the shared generic and the install page's HTTP-status
  // read-failure line — must carry a non-empty second line, or the widening bought nothing.
  //
  // Deliberately no "reads the codes from an external register" step here, unlike the two guards
  // above: `STOCK_PREP_ERROR_PLAIN`'s own header comment says the server vocabulary is OPEN (a clamp
  // to a shape, not to a fixed list), so this table is not — and does not try to be — exhaustive.
  // -------------------------------------------------------------------------
  it('every STOCK_PREP_ERROR_PLAIN entry carries a second line — 发生了什么 is never alone', () => {
    for (const code of Object.keys(STOCK_PREP_ERROR_PLAIN)) {
      const plain = STOCK_PREP_ERROR_PLAIN[code]
      expect(String(plain.zh ?? '').trim().length, `${code}.zh`).toBeGreaterThan(0)
      expect(String(plain.en ?? '').trim().length, `${code}.en`).toBeGreaterThan(0)
      expect(String(plain.zhNext ?? '').trim().length, `${code}.zhNext`).toBeGreaterThan(0)
      expect(String(plain.enNext ?? '').trim().length, `${code}.enNext`).toBeGreaterThan(0)
    }
    // The fallback every unrecognised code renders through — a blank second line there would be the
    // one gap no per-code loop above could ever catch.
    expect(String(STOCK_PREP_ERROR_GENERIC.zhNext ?? '').trim().length).toBeGreaterThan(0)
    expect(String(STOCK_PREP_ERROR_GENERIC.enNext ?? '').trim().length).toBeGreaterThan(0)
    // ...and the lookup function itself hands the second line back, for a code nobody wrote a row for.
    const unknown = stockPrepErrorPlain('SOME_CODE_NOBODY_REGISTERED')
    expect(String(unknown.zhNext ?? '').trim().length).toBeGreaterThan(0)

    // The install page's other error surface — an HTTP status, no code — widened alongside it.
    expect(String(STOCK_PREP_READ_FAILED.zhNext ?? '').trim().length).toBeGreaterThan(0)
    expect(String(STOCK_PREP_READ_FAILED.enNext ?? '').trim().length).toBeGreaterThan(0)
  })

  it('the existing first-line assertions are untouched by the widening (F7: additive only)', () => {
    // The two sentences the pre-P0-5 suites already pinned, verbatim — proof the widening did not
    // reword what a caller that has not been taught to read `zhNext` still shows.
    expect(stockPrepErrorPlain('FORBIDDEN').zh).toBe('当前账号没有做这件事的权限。')
    expect(stockPrepErrorPlain('STOCK_PREPARATION_HANDOFF_NOT_CURRENT_HANDLER').zh).toBe('现在不是您这一步,所以不能通知下一步。')
  })

  // -------------------------------------------------------------------------
  // SOURCE_UNAVAILABLE — the 503 DataSourceManager.connectDataSource raises when the source library
  // itself (PLM / K3's SQL Server, etc.) cannot be reached (#5586). Source precheck, an operator's
  // dry-run and a pull all read through that one chokepoint, so this code reaches the stock-prep
  // surfaces too, not just the raw data-sources routes.
  // -------------------------------------------------------------------------
  it('SOURCE_UNAVAILABLE has a dedicated row naming the 503 and the source library, not the driver text', () => {
    const plain = STOCK_PREP_ERROR_PLAIN.SOURCE_UNAVAILABLE
    expect(plain, 'SOURCE_UNAVAILABLE must have a row in the shipped plain-language table').toBeTruthy()
    // 「发生了什么」: the status and what kind of thing is down — never the driver's raw connect text.
    expect(plain.zh).toContain('503')
    expect(plain.zh).toContain('源库')
    expect(plain.en).toContain('503')
    // 「该怎么办」: #5588 review — a bare 503 cannot prove "not a permission problem" or "retrying
    // never helps" (a source-account permission refusal and a transient fault both land on this same
    // code), so the copy must not make either claim. What it CAN say, and what these assertions pin,
    // is the narrower and provable half: adding a permission to the MetaSheet account will not fix
    // this, because the account this route touches is on the source side.
    expect(plain.zh).toContain('不是直接给 MetaSheet 账号加权限')
    expect(plain.en).toContain('This is not fixed by adding a permission')
    expect(plain.zhNext, 'zhNext').toBeTruthy()
    expect(plain.zhNext).toContain('不是给账号加权限')
    expect(plain.enNext, 'enNext').toBeTruthy()
    expect(plain.enNext).toContain('This is not fixed by adding a permission')
    // The lookup function a caller actually uses agrees with the table read directly.
    expect(stockPrepErrorPlain('SOURCE_UNAVAILABLE').zh).toBe(plain.zh)
    expect(stockPrepErrorPlain('SOURCE_UNAVAILABLE')).not.toEqual(STOCK_PREP_ERROR_GENERIC)
  })

  // -------------------------------------------------------------------------
  // P0-5 (second half): THE BOARD'S OWN TABLE — the one the FLOOR reads.
  //
  // The confirmation queue is where an administrator looks; the project board is where an operator
  // lives. A wave that widened only the write table would have delivered the second line to the
  // surface that needed it least.
  // -------------------------------------------------------------------------
  it('every STOCK_PREP_BOARD_ERROR_PLAIN entry carries a second line, and so does its READ-shaped generic', () => {
    for (const code of Object.keys(STOCK_PREP_BOARD_ERROR_PLAIN)) {
      const plain = STOCK_PREP_BOARD_ERROR_PLAIN[code]
      expect(String(plain.zh ?? '').trim().length, `${code}.zh`).toBeGreaterThan(0)
      expect(String(plain.zhNext ?? '').trim().length, `${code}.zhNext`).toBeGreaterThan(0)
      expect(String(plain.enNext ?? '').trim().length, `${code}.enNext`).toBeGreaterThan(0)
    }
    expect(String(STOCK_PREP_BOARD_ERROR_GENERIC.zhNext ?? '').trim().length).toBeGreaterThan(0)
    expect(String(STOCK_PREP_BOARD_ERROR_GENERIC.enNext ?? '').trim().length).toBeGreaterThan(0)
    // The board's own 404 keeps its first line and gains the sentence §4.5 asked for.
    const notFound = stockPrepBoardErrorPlain('STOCK_PREPARATION_PROJECT_BOARD_NOT_FOUND')
    expect(notFound.zh).toBe('这个项目号在您这里还没有数据。')
    expect(notFound.zhNext).toContain('从 PLM 拉取数据')
    // A cross-plane code still resolves through the shared table, second line included — one
    // definition, two surfaces. This is the sentence whose only render point is the board.
    expect(stockPrepBoardErrorPlain('STOCK_PREPARATION_HANDOFF_NOT_CURRENT_HANDLER').zhNext).toContain('轮到')
  })

  // -------------------------------------------------------------------------
  // 「复制这条报错」的载荷 (§6.1 acceptance #8: 复制内容 values-free)
  //
  // The payload is built by a pure function precisely so it can be asserted here rather than only
  // through a clipboard nobody reads back. It is the code plus one committed sentence — never the
  // prose beside it, and never anything a server said.
  // -------------------------------------------------------------------------
  it('the copy-this-error payload is the code plus one fixed sentence, in both locales', () => {
    const zh = stockPrepErrorCopyText('STOCK_PREPARATION_HANDOFF_NOT_CURRENT_HANDLER', true)
    expect(zh).toContain('STOCK_PREPARATION_HANDOFF_NOT_CURRENT_HANDLER')
    expect(zh).toContain(STOCK_PREP_ERROR_COPY_SENTENCE.zh)
    const en = stockPrepErrorCopyText('FORBIDDEN', false)
    expect(en).toContain('FORBIDDEN')
    expect(en).toContain(STOCK_PREP_ERROR_COPY_SENTENCE.en)
  })

  it('the copy payload never carries a value, whatever it is handed', () => {
    // A caller that passed a server message, a project number or a part code instead of a clamped
    // enum would be the one way this button could leak — so the payload is built from a code-shaped
    // argument and one constant, and nothing else. These are the shapes that must never appear from
    // the CONSTANT half; the code half is the caller's own clamped token.
    const payload = stockPrepErrorCopyText('FORBIDDEN', true)
    expect(payload).not.toMatch(/[\w.+-]+@[\w-]+\.[\w.-]+/)
    expect(payload).not.toMatch(/\d{6,}/)
    // An absent/blank code degrades to a placeholder rather than emitting a dangling separator.
    expect(stockPrepErrorCopyText('', true)).toContain('UNKNOWN')
    expect(stockPrepErrorCopyText(null, true)).toContain('UNKNOWN')
  })
})
