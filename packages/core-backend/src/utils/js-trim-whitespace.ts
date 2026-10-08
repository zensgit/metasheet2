/**
 * #5809 — every character JavaScript's `String.prototype.trim()` strips (ECMA-262 WhiteSpace plus
 * LineTerminator), joined into one string, so SQL can trim a STORED value the way the client trims the
 * term it sends: `btrim(col, $n)` with this string bound as `$n`.
 *
 * Why it exists: Postgres `btrim(text)` without a second argument strips only U+0020. A name stored
 * with a trailing ideographic space (U+3000), an NBSP (U+00A0) or a tab would then never EQUAL a term
 * the client has already trimmed, although the pre-#5809 client-side match (JS `trim()` on both sides)
 * accepted it.
 *
 * Always bind it as a query PARAMETER; never splice it into SQL text.
 * tests/unit/multitable-person-directory-resolver.test.ts checks that this string equals exactly what
 * `trim()` removes, over every Unicode code point. The class has no members outside the BMP.
 */
export const JS_TRIM_WHITESPACE = [
  '\u0009', // CHARACTER TABULATION
  '\u000A', // LINE FEED
  '\u000B', // LINE TABULATION
  '\u000C', // FORM FEED
  '\u000D', // CARRIAGE RETURN
  '\u0020', // SPACE
  '\u00A0', // NO-BREAK SPACE
  '\u1680', // OGHAM SPACE MARK
  '\u2000', '\u2001', '\u2002', '\u2003', '\u2004', '\u2005', '\u2006', '\u2007', '\u2008', '\u2009', '\u200A', // EN QUAD .. HAIR SPACE
  '\u2028', // LINE SEPARATOR
  '\u2029', // PARAGRAPH SEPARATOR
  '\u202F', // NARROW NO-BREAK SPACE
  '\u205F', // MEDIUM MATHEMATICAL SPACE
  '\u3000', // IDEOGRAPHIC SPACE
  '\uFEFF', // ZERO WIDTH NO-BREAK SPACE (BOM)
].join('')
