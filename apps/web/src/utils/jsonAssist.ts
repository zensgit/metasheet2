// IU-5a (docs/development/integration-ux-workbench-redesign-design-lock-20260706.md §2 IU-5,
// "JSON-assist" disposition for sites 1-4 of the 5 raw JSON textareas the design-lock's §1 audit
// counted): a tiny, framework-agnostic helper shared by every JSON-assist textarea so the 4 call
// sites (IntegrationConnectionSection's connection-draft-config/connection-draft-capabilities,
// IntegrationPayloadPreviewSection's sample-record/payload-template) don't each hand-roll their
// own JSON.parse/stringify + error-position logic.
//
// SAFETY-CRITICAL invariant this module exists to enforce: Node's (and every modern V8's)
// `JSON.parse` SyntaxError messages embed a *snippet of the offending input* — e.g.
// `Unexpected token 'S', "{"a": SECRET_TOK"... is not valid JSON` — so if a caller ever renders
// `error.message` directly in the UI, any secret-shaped text pasted into the textarea (a token,
// password, etc.) leaks into the DOM verbatim. `analyzeJsonText` below NEVER returns or forwards
// `error.message`; it only extracts a plain integer byte-offset via a narrow `/position (\d+)/`
// regex (numbers can't leak content) and converts that offset to a line/column pair by counting
// newlines in the *caller's own already-visible* textarea text — never by slicing/quoting it back
// out. When the offset can't be recovered (some SyntaxErrors carry no position at all, e.g.
// "Unexpected end of JSON input"), callers fall back to a generic values-free message with no
// line/column instead of guessing from message content.
export type JsonAssistStatus = 'empty' | 'valid' | 'invalid'

export interface JsonAssistAnalysis {
  status: JsonAssistStatus
  /** 1-based line number of the parse failure, or null if unknown/not applicable. */
  line: number | null
  /** 1-based column number of the parse failure, or null if unknown/not applicable. */
  column: number | null
}

const POSITION_PATTERN = /position (\d+)/i

function extractErrorPosition(error: unknown): number | null {
  if (!(error instanceof Error)) return null
  const match = POSITION_PATTERN.exec(error.message)
  if (!match) return null
  const value = Number(match[1])
  return Number.isFinite(value) && value >= 0 ? value : null
}

function positionToLineColumn(text: string, position: number): { line: number; column: number } {
  const clamped = Math.max(0, Math.min(position, text.length))
  let line = 1
  let lastNewlineIndex = -1
  for (let i = 0; i < clamped; i += 1) {
    if (text.charCodeAt(i) === 10 /* \n */) {
      line += 1
      lastNewlineIndex = i
    }
  }
  return { line, column: clamped - lastNewlineIndex }
}

/**
 * Analyze raw JSON text for the JSON-assist status line. Returns a status plus an optional
 * (line, column) location of the first parse failure — never any text content from the input.
 */
export function analyzeJsonText(text: string): JsonAssistAnalysis {
  if (text.trim().length === 0) {
    return { status: 'empty', line: null, column: null }
  }
  try {
    JSON.parse(text)
    return { status: 'valid', line: null, column: null }
  } catch (error) {
    const position = extractErrorPosition(error)
    if (position === null) {
      return { status: 'invalid', line: null, column: null }
    }
    const { line, column } = positionToLineColumn(text, position)
    return { status: 'invalid', line, column }
  }
}

/**
 * Format JSON text with 2-space indentation (parse -> stringify round-trip). Returns null when
 * the input does not parse — callers should leave the model untouched in that case (the format
 * action is a no-op on invalid input, never a crash).
 */
export function formatJsonText(text: string): string | null {
  try {
    const parsed = JSON.parse(text)
    return JSON.stringify(parsed, null, 2)
  } catch {
    return null
  }
}
