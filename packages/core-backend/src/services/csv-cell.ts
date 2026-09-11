/**
 * P3-1 — CSV cell serialization with formula-injection hardening.
 *
 * Own module: this repo has no shared CSV sanitiser to reuse (a repo-wide search for
 * `csvEscape|sanitizeCsv|formulaInjection` returns nothing), so contract §3 is implemented fresh
 * here. This module is scoped to the approval export only; no other export path is modified by
 * this slice.
 *
 * THREAT (contract §3): Excel / LibreOffice / Google Sheets evaluate a cell that STARTS WITH
 * certain characters as a formula (or, historically, a DDE directive), which can exfiltrate data
 * or run a command the moment the exported file is opened in a spreadsheet application. A CSV
 * export is a persistent artifact that LEAVES the system, so every user-controlled value that
 * reaches a cell — title, form field values, requester/subject snapshots, anything sourced from
 * `meta`/JSON — must be neutralized, not just the fields that look obviously dangerous.
 *
 * DESIGN (contract §3.2): the covered vectors are an ENUMERATED CONSTANT TABLE, not a scatter of
 * `if`s — see [[feedback_trap_enumeration_does_not_converge]] ("补 trap 不收敛"): a table plus a
 * test that ITERATES it means a vector added to the table without being handled fails the test,
 * instead of silently shipping unneutralized. That discipline applies to `CSV_FORMULA_INJECTION_
 * LEAD_CHARS` below, which stays a small enumerated table (contract §3 ratified exactly these 7
 * characters). It does NOT extend to the "ignorable lead-in" axis below (see that block's own
 * comment for why a second fix round replaced its table with a predicate, and a THIRD fix round
 * then replaced that predicate's own category set after gate 3 measured that it, too, did not
 * converge).
 */

/**
 * Every leading byte this module treats as "this cell would be evaluated as a formula (or a DDE
 * directive) by a spreadsheet application". `=` `+` `-` `@` are the classic formula-leading
 * characters; TAB/CR/LF are included because a cell that starts with one of them can still land as
 * the first character of the NEXT rendered cell/row once a spreadsheet application normalizes
 * whitespace on paste/import — treated as leading-dangerous here rather than assumed harmless.
 *
 * EXPORTED so the unit suite can iterate this table directly (mutation-probed): appending a vector
 * here without touching `neutralizeFormulaInjectionLead` must fail the iterating test, not pass it
 * silently.
 */
export const CSV_FORMULA_INJECTION_LEAD_CHARS = ['=', '+', '-', '@', '\t', '\r', '\n'] as const

export type CsvFormulaInjectionLeadChar = (typeof CSV_FORMULA_INJECTION_LEAD_CHARS)[number]

const DANGEROUS_LEAD_CHAR_SET: ReadonlySet<string> = new Set(CSV_FORMULA_INJECTION_LEAD_CHARS)

/**
 * Fix round (P3-6, gate-1 finding) — characters that some spreadsheet importers TRIM or silently
 * drop before evaluating a cell, so a dangerous character hiding behind a run of them can still be
 * evaluated as a formula even though it is not literally `text[0]`. Example: `" =cmd|'/c
 * calc'!A1"` (leading space) previously received no apostrophe because `text[0]` was `' '`, not
 * `'='`.
 *
 * Second fix round (P3-B, gate-2 finding) — the FIRST attempt at this axis was a 7-entry
 * hand-typed table (space, TAB, NBSP, ZWSP, ZWNJ, ZWJ, BOM). Gate 2 measured 18 residual lead-in
 * characters that table still let straight through un-neutralized. That is exactly
 * [[feedback_trap_enumeration_does_not_converge]] ("补 trap 不收敛") happening a SECOND time on a
 * SECOND axis: answering a non-converging enumeration with another enumeration does not converge
 * either. That round replaced the table with `/[\s\p{Cf}\p{Zs}]/u`, on the theory that `\s`
 * (whitespace), `Cf` (FORMAT) and `Zs` (SPACE_SEPARATOR) together were "exactly the categories a
 * spreadsheet importer's own trim/normalize pass is built to skip".
 *
 * THIRD fix round (P2-2/NIT-1, gate-3 findings) — that theory was checked by MEASUREMENT, not
 * assumed, and gate 3 found it did not converge either, on two independent counts:
 *
 *   1. `\p{Zs}` was DEAD WEIGHT the whole time. ECMAScript `\s` (`WhiteSpace` + `LineTerminator`)
 *      already includes `<USP>` — "any other Unicode 'Space_Separator' code point" — so `\p{Zs}`
 *      matches nothing `\s` does not already match. Measured directly: a full sweep of every code
 *      point U+0000-U+10FFFF found ZERO characters matching `\p{Zs}` but not `\s`, and mutation M5
 *      (removing `\p{Zs}` from the old pattern) produced zero test reds. The comment above this
 *      one used to both (correctly) say "`\s`… covers… every Unicode `Zs`…" AND (incorrectly)
 *      present `\p{Zs}` as a third, independently-necessary category — that self-contradiction is
 *      corrected by deleting `\p{Zs}` outright, not by rewording it.
 *   2. The docblock's own rationale for `\p{Cf}` — "characters whose entire Unicode purpose is
 *      'exists to be skipped by text processing'" — is, verbatim, the definition of Unicode's
 *      `Default_Ignorable_Code_Point` (DI) binary property (supported in ES2018+ `\p{}` property
 *      escapes), not of `Cf` alone. `Cf` is a strict SUBSET of DI: Hangul filler characters
 *      (U+115F, U+1160, U+3164, U+FFA0 — general category `Lo`) and default-ignorable combining
 *      marks (U+034F COMBINING GRAPHEME JOINER, U+FE0F VARIATION SELECTOR-16 — general category
 *      `Mn`) satisfy the STATED rationale exactly while sitting entirely outside `Cf`. MEASURED
 *      (see the Node/methodology note below): of Unicode's 4174 `Default_Ignorable_Code_Point`
 *      characters, the second round's pattern (`\s`/`Cf`/`Zs`) missed 4036 of them.
 *
 * `CSV_IGNORABLE_LEAD_PATTERN` below is corrected on both counts: `\p{Zs}` is dropped (measured
 * redundant, not merely "probably covered"), and `\p{Cc}` (control) plus `\p{Default_Ignorable_
 * Code_Point}` are added. `\p{Cc}` because THIS round separately measured that the old pattern left
 * 27 of the 32 C0 control characters (U+0000-U+001F, excluding the 3 already in
 * `CSV_FORMULA_INJECTION_LEAD_CHARS`) as un-neutralized lead-ins (NUL, NEL, and the U+001C-U+001F
 * information separators among them) — gate 3's own report cited "26 of 33" under a different
 * counting convention (gate 3 apparently counted U+007F DEL as a 33rd C0 control and/or subtracted
 * the dangerous-overlap differently; this comment states what THIS round independently measured,
 * not gate 3's number relabeled, precisely so a future reader is not misled about which claim was
 * re-verified vs merely copied) — a control character in a cell's lead position has no legitimate
 * meaning, so treating it as ignorable is strictly safer than leaving it unhandled; `\p{Default_
 * Ignorable_Code_Point}` because it is the closed form the docblock's own rationale was always
 * describing.
 *
 * MEASURED result of the new pattern (`/[\s\p{Cc}\p{Cf}\p{Default_Ignorable_Code_Point}]/u`), from
 * the same full-sweep methodology as above:
 *   - 0 of the 4174 `Default_Ignorable_Code_Point` characters are missed (down from 4036 missed
 *     by the second round's pattern).
 *   - 0 of the 32 C0 controls are left un-neutralized (down from 27).
 *   - 17 of gate 2's original 18 named residuals are now covered by the pattern alone (up from
 *     15) — the ONLY one still outside it is U+0301 COMBINING ACUTE ACCENT (general category
 *     `Mn`; not `Cc`, not `Cf`, and NOT `Default_Ignorable_Code_Point` — combining diacritics in
 *     general are not DI, only the specific few Unicode has designated as such are, which does not
 *     include this one). `CSV_IGNORABLE_LEAD_SUPPLEMENT_CHARS` below now names exactly that one
 *     remaining exception, down from 3 (NUL and NEL both moved from the supplement into pattern
 *     coverage via `\p{Cc}`).
 *
 * METHODOLOGY AND ITS LIMITS, stated rather than implied: the sweep (script run, numbers recorded
 * here, script deleted per this repo's scratch-probe discipline) ran on Node v25.9.0's V8/ICU
 * Unicode data; the required CI check runs Node 18.x/20.x, and the SET of `Default_Ignorable_
 * Code_Point` characters is, in general, Unicode-version-dependent — 4174 is what that ICU build
 * reports, not a fixed constant. Re-checked directly (not assumed): the SAME full-sweep DI-total
 * count was re-run on Node v20.20.2 and also returned exactly 4174 — so this specific number is
 * confirmed stable across the 20.x leg of the required matrix, though 18.x was not independently
 * re-checked and a future Node/ICU/Unicode upgrade could still move it. The PER-CHARACTER outcomes
 * this file gates (every named residual in `tests/unit/csv-cell.test.ts`'s corpus — Hangul fillers,
 * CGJ, VS-16, the C0 controls, U+0301) have been stable Unicode properties for many Unicode
 * versions and are independently re-verified on every CI run via `isCsvIgnorableLeadChar`/
 * `CSV_IGNORABLE_LEAD_PATTERN` assertions, regardless of Node version. The AGGREGATE counts
 * (4174/4036/0/27/32/17/15) are NOT independently re-verified by that corpus on every run — it
 * names ~40 specific characters, not the full Unicode range — so beyond the one cross-check noted
 * above they remain a point-in-time measurement, recorded here for the reasoning trail, not a
 * machine-checked invariant. Do not read "0 missed" as a CI-enforced guarantee; read the per-
 * character corpus assertions that way instead.
 *
 * NOTE the deliberate overlap with `CSV_FORMULA_INJECTION_LEAD_CHARS`: TAB/CR/LF are members of
 * BOTH the dangerous table and this ignorable predicate. `neutralizeFormulaInjectionLead` below
 * checks DANGEROUS membership before IGNORABLE membership at every position, so a character that
 * is both is always treated as dangerous — this is what keeps a BARE tab (`'\t'` alone) prefixed
 * exactly as before, while still letting a genuinely-safe run of ignorable characters be skipped
 * past to find a dangerous character behind it.
 */
// EXPORTED (additive; mirrors `CSV_FORMULA_INJECTION_LEAD_CHARS`'s and
// `CSV_IGNORABLE_LEAD_SUPPLEMENT_CHARS`'s own "test can drive this directly" discipline) so the
// unit suite can assert which of the two ignorable-lead mechanisms (this pattern, or the named
// supplement) covers a given corpus entry, independently of `isCsvIgnorableLeadChar`'s own OR'd
// outcome (NIT-2 fix — see `tests/unit/csv-cell.test.ts`'s "SPLIT, not just union" block).
export const CSV_IGNORABLE_LEAD_PATTERN = /[\s\p{Cc}\p{Cf}\p{Default_Ignorable_Code_Point}]/u

/**
 * The ONE named residual `CSV_IGNORABLE_LEAD_PATTERN` does NOT match, after the third fix round
 * moved NUL and NEL into pattern coverage (via `\p{Cc}`). Per
 * [[feedback_exemption_reasons_rot_make_them_data]] (an exemption reason must be a checkable
 * claim, not prose) and per the instruction that an entry must never be kept on the strength of a
 * mechanism nobody has verified, the reason stated below is NOT a claim about what any specific
 * spreadsheet importer does — no such mechanism has ever been confirmed for this character, across
 * two fix rounds — it is a checkable COST comparison instead:
 *   - U+0301 COMBINING ACUTE ACCENT — general category `Mn`. NOT `Cc`, NOT `Cf`, NOT
 *     `Default_Ignorable_Code_Point` (measured directly — combining diacritics are not, as a
 *     class, default-ignorable; only the specific few Unicode designates as such are, and this is
 *     not one of them), so no closed-form clause above covers it. NO CONFIRMED MECHANISM: an
 *     earlier draft of this comment claimed Unicode-normalizing import paths "drop" an orphaned
 *     combining mark; Unicode normalization (NFC/NFD/NFKC/NFKD) is decomposition and/or
 *     recomposition and never DELETES a character, so that claim was FALSE, not merely unverified,
 *     and no replacement mechanism has been confirmed since. Kept anyway, on an asymmetric-cost
 *     argument that is itself checkable rather than assumed: treating it as ignorable when no such
 *     importer behavior exists costs exactly one defensive apostrophe on a value that happens to
 *     start with a bare combining accent mark (verified by this file's own corpus tests — the
 *     ORIGINAL text always survives byte-for-byte behind that apostrophe); NOT treating it as
 *     ignorable, if such an importer behavior is ever found to exist, costs a live formula-
 *     injection bypass. That asymmetry, not a claimed mechanism, is the entirety of the
 *     justification for keeping this one entry.
 *
 * EXPORTED, small, and hand-typed on purpose (mirrors `CSV_FORMULA_INJECTION_LEAD_CHARS`'s own
 * discipline): a silent drop from this list is exactly the kind of regression only an independent
 * literal census — not iteration over the list itself — can catch.
 */
export const CSV_IGNORABLE_LEAD_SUPPLEMENT_CHARS = ['\u0301'] as const

export type CsvIgnorableLeadSupplementChar = (typeof CSV_IGNORABLE_LEAD_SUPPLEMENT_CHARS)[number]

const IGNORABLE_LEAD_SUPPLEMENT_SET: ReadonlySet<string> = new Set(CSV_IGNORABLE_LEAD_SUPPLEMENT_CHARS)

/**
 * True iff `ch` is a character `neutralizeFormulaInjectionLead` should skip PAST while scanning
 * for a dangerous leading character: Unicode whitespace/control/format/default-ignorable
 * (`CSV_IGNORABLE_LEAD_PATTERN`) OR the one named, justified exception in
 * `CSV_IGNORABLE_LEAD_SUPPLEMENT_CHARS`. EXPORTED so the unit suite can drive this predicate
 * directly against a corpus of individual characters and assert the OUTCOME, instead of
 * re-deriving "ignorable" from the same regex/set the production code uses.
 *
 * SINGLE-CODE-POINT CONTRACT: `ch` is expected to be exactly one code point (what `for…of`
 * yields per iteration in `neutralizeFormulaInjectionLead`, the only production caller). Passing a
 * longer string is not this function's contract — `CSV_IGNORABLE_LEAD_PATTERN` is unanchored, so
 * e.g. `isCsvIgnorableLeadChar("abc ")` returns `true` (the trailing space matches). Do not call
 * this with anything but a single character.
 */
export function isCsvIgnorableLeadChar(ch: string): boolean {
  return CSV_IGNORABLE_LEAD_PATTERN.test(ch) || IGNORABLE_LEAD_SUPPLEMENT_SET.has(ch)
}

/**
 * Stringify an arbitrary DTO value into what a CSV cell should contain. `null`/`undefined` render
 * as an empty cell (not the literal text "null"/"undefined"); strings pass through unchanged;
 * everything else (number, boolean, object, array — including a `formSnapshot`, a `requester`
 * snapshot, or the record-link `RECORD_LINK_INACCESSIBLE_VALUE` sentinel) is JSON-serialized, so a
 * structured DTO field round-trips into one legible cell instead of `[object Object]`.
 */
export function stringifyCsvValue(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  try {
    // `JSON.stringify` returns `undefined` (not a thrown error) for a bare function/symbol/
    // `undefined` value — falling through to `''` keeps this function's return type honest and
    // keeps `neutralizeFormulaInjectionLead` from being handed `undefined` instead of a string.
    return JSON.stringify(value) ?? ''
  } catch {
    return String(value)
  }
}

/**
 * Contract §3.1: neutralize the LEADING character before RFC-4180 quoting is applied, so the
 * neutralization is semantically load-bearing even after quoting wraps the cell. Excel/LibreOffice
 * /Sheets treat a cell prefixed with a single apostrophe as forced text, and the apostrophe survives
 * RFC-4180 quoting unchanged (quoting only wraps/escapes on `"`, `,`, `\r`, `\n` — it never inspects
 * or strips a leading character).
 *
 * Fix round (P3-6, gate-1 finding): this used to inspect only `text[0]`, so a dangerous character
 * preceded by a run of ignorable characters (leading space, NBSP, ZWSP, …) slipped through
 * unneutralized, because some spreadsheet importers trim or silently drop exactly that run before
 * evaluating the cell. This now scans forward from the start, skipping ignorable characters
 * (`isCsvIgnorableLeadChar`), until it finds either a DANGEROUS character (neutralize) or a
 * genuinely ordinary one (stop — nothing to neutralize) or the end of the string (nothing to
 * neutralize). Dangerous-membership is checked BEFORE ignorable-membership at each position, so
 * TAB — a member of both — is always treated as dangerous, keeping a bare `'\t'` prefixed exactly
 * as before this fix.
 *
 * Second fix round (P3-B, gate-2 finding) — corrects an overclaim: this docblock previously said
 * the P3-6 fix "fixes the SHAPE, not just the symptom". It did not — its answer to a non-converging
 * enumeration was a second, narrower enumeration on the same axis (see `CSV_IGNORABLE_LEAD_
 * PATTERN`'s comment). What is actually true now: the scan-forward SHAPE introduced by P3-6 is
 * unchanged and correct; what changed in this round is what counts as "ignorable" at each scanned
 * position — a closed-form Unicode-category predicate plus a small, named, justified supplement,
 * not "the shape" — but the honest claim is "this enumerated axis, measured", never "the shape" or
 * "every conceivable importer quirk".
 *
 * Third fix round (P2-2/NIT-1, gate-3 findings) — the shape claim above still stands; what changed
 * again is which Unicode categories the predicate itself covers (`CSV_IGNORABLE_LEAD_PATTERN`'s
 * comment has the measured before/after numbers). 17 of gate 2's 18 named residuals are now
 * covered by the predicate itself, 1 by the supplement, all 18 by the combination.
 *
 * The ORIGINAL text is always what gets prefixed — never trimmed, never altered otherwise — so a
 * leading ignorable run the value legitimately carries survives byte-for-byte behind the
 * apostrophe.
 */
export function neutralizeFormulaInjectionLead(text: string): string {
  for (const ch of text) {
    if (DANGEROUS_LEAD_CHAR_SET.has(ch)) return `'${text}`
    if (!isCsvIgnorableLeadChar(ch)) return text
  }
  return text
}

/**
 * RFC-4180 quoting: wrap the cell in double quotes (doubling any internal double quote) iff it
 * contains a comma, a double quote, a carriage return, or a line feed. Operates on the ALREADY
 * lead-neutralized text (contract §3.1 ordering).
 */
export function quoteRfc4180(text: string): string {
  return /["\r\n,]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

/**
 * The one function production code and tests should call per cell. Order is fixed and matches
 * contract §3.1 exactly: stringify → neutralize the leading character → RFC-4180 quote/escape.
 * Applies uniformly to every cell, including header cells (§3.3) — callers must not special-case
 * the header row or skip this for a field that "looks safe".
 */
export function sanitizeCsvCell(value: unknown): string {
  return quoteRfc4180(neutralizeFormulaInjectionLead(stringifyCsvValue(value)))
}

/**
 * One CSV row (the caller appends the line terminator). CRLF is the de-facto/Excel-friendly CSV
 * line ending — matching the CRLF convention this repo's existing CSV output already uses
 * for this repo ("CRLF line endings = the CSV de-facto standard (Excel-friendly)").
 */
export function sanitizeCsvRow(values: readonly unknown[]): string {
  return values.map(sanitizeCsvCell).join(',')
}

/** The line terminator every row in a `sanitizeCsvRow`-built export should be joined with. */
export const CSV_LINE_TERMINATOR = '\r\n'
