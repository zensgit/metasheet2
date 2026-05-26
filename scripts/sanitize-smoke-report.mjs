#!/usr/bin/env node
// Sanitize multitable live-smoke report.json into a PUBLIC baseline (e.g. for
// issue #1812). The raw report embeds credentials and real customer/business
// data captured by diagnostic checks (person names, record titles, request/
// response bodies, input values, localized free text). This produces a copy
// safe to commit while preserving the structural shape triage needs.
//
// SECURITY MODEL — default-deny:
//   Every string value is REDACTED unless it is provably safe (a known opaque
//   ID, a whitelisted enum, an ISO timestamp, or a scrubbed config field).
//   New diagnostic fields the runner may add (requestBody, responseBody,
//   inputValueBeforeClick, recordVersion*, …) and business values stored under
//   dynamic field-ID keys (e.g. "fld_title": "ACME order 123") are therefore
//   redacted by default, not silently leaked. Numbers/booleans/null are kept.
//
//   report.md CANNOT be key-sanitized reliably (prose), so it is treated as
//   NOT PUBLISHABLE: pattern-scrubbed for convenience but never certified clean.
//   Commit the sanitized JSON as the public baseline.
//
// Usage:
//   node scripts/sanitize-smoke-report.mjs <report.json> [more.json...] \
//        [--out <path>]   (single input only)  [--in-place]  [--scan-only]
//   node scripts/sanitize-smoke-report.mjs <report.md>      # warns, never "clean"
//
// Exits non-zero if any residual sensitive/free-text content remains.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REDACTION = '[REDACTED]'

// Keys whose nested OBJECT/ARRAY subtree is dropped wholesale (credentials and
// known business payloads). Scalars are NOT matched here — default-deny on the
// value already handles them, so safe scalars like labelValue=fld_… or
// zoomValue="month" or recordVersionBefore=7 survive for triage.
const SENSITIVE_CONTAINER_KEY_SUBSTRINGS = [
  'token', 'password', 'secret', 'cookie', 'authorization', 'apikey', 'api_key',
  'jwt', 'bearer', 'credential', 'payload', 'body', 'request', 'response',
  'data', 'context', 'record',
]

// Top-level run-config keys whose string value is KEPT after pattern-scrubbing.
// Deliberately NOT including common nested keys like `name`/`source` — those
// collide with business data (e.g. selectedPerson.name = a real person), so a
// global whitelist on them silently leaks. The smoke check id (name = "ui.x.y")
// is kept instead by a value-level shape check (CHECK_ID_RE), and auth-source
// labels by SAFE_ENUMS.
const SCRUB_AND_KEEP_KEYS = new Set([
  'apibase', 'webbase', 'outputdir', 'reportpath', 'reportmdpath', 'startedat', 'runmode',
])

// Opaque internal IDs are safe to retain (not PII): fld_/viw_/sht_/bas_/rec_/…
const SAFE_ID_RE = /^(?:fld|viw|sht|bas|rec|row|req|col|grp|tbl|wsp|org)_[A-Za-z0-9_-]+$/
// A KEY that is itself a field/column id means its value is a record cell value
// (customer data) — redact it regardless of type, incl. numbers (e.g. amounts).
const FIELD_DATA_KEY_RE = /^(?:fld|col)_[A-Za-z0-9_-]+$/i
const ISO_RE = /^\d{4}-\d{2}-\d{2}T[\d:.]+Z?$/
// A smoke check id: anchored to the KNOWN namespaces (ui./api.) so generic
// lowercase dotted business slugs / names (alice.customer, acme.order) are NOT
// kept — fail-safe (redact the unknown), not fail-open. If the extended runner
// adds new namespaces (e.g. runner./auth.), add them here explicitly.
const CHECK_ID_RE = /^(?:api|ui)\.[a-z0-9-]+(?:\.[a-z0-9-]+)*$/
// Small whitelist of known enums/flags that carry no customer data.
const SAFE_ENUMS = new Set([
  'day', 'week', 'month', 'year', 'date',
  'person', 'attachment', 'link', 'string', 'number', 'longtext', 'select',
  'grid', 'kanban', 'timeline', 'calendar', 'gallery', 'form', 'gantt',
  'live', 'local', 'login', 'editor', 'viewer', 'admin',
  'warning', 'refresh', 'direct', 'none', 'applied', 'deferred', 'superseded',
  'busy', 'pending', 'true', 'false', 'ok', 'fail', 'skipped', 'user',
  'auth_token', 'auth_token_file', 'dev-token', // auth-source labels (not the token)
])

const SCRUBBERS = [
  { name: 'ipv4', re: /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/g, sub: '[IP]' },
  { name: 'email', re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\b/g, sub: '[EMAIL]' },
  { name: 'jwt', re: /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{2,}/g, sub: '[JWT]' },
  { name: 'bearer', re: /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, sub: 'Bearer [TOKEN]' },
  { name: 'basic', re: /\bBasic\s+[A-Za-z0-9+/=]+/gi, sub: 'Basic [TOKEN]' },
  { name: 'home-path', re: /\/(?:Users|home)\/[^/\s"]+/g, sub: '/[USER]' },
]

// Residual detectors run on the FINAL output. Beyond the credential patterns,
// the structural detector flags any retained string that still looks like
// free-text / business data (spaces, CJK, or long), which a key/value
// whitelist could otherwise miss.
const RESIDUAL_PATTERNS = [
  { name: 'ipv4', re: SCRUBBERS[0].re },
  { name: 'email', re: SCRUBBERS[1].re },
  { name: 'jwt', re: SCRUBBERS[2].re },
  { name: 'bearer', re: /\bBearer\s+[A-Za-z0-9]/g },
  { name: 'basic', re: /\bBasic\s+[A-Za-z0-9]/g },
  { name: 'long-token', re: /\b[A-Za-z0-9+/=_-]{40,}\b/g },
]
const CJK_RE = /[㐀-鿿豈-﫿]/

const stats = { redactedKeys: {}, scrubHits: {}, redactedValues: 0, keptValues: 0 }
function bump(map, k) { map[k] = (map[k] ?? 0) + 1 }

// Only consulted for object/array values — decides whole-subtree drop.
function keyIsSensitiveContainer(key) {
  const k = String(key).toLowerCase()
  if (SCRUB_AND_KEEP_KEYS.has(k)) return false
  return SENSITIVE_CONTAINER_KEY_SUBSTRINGS.some((s) => k.includes(s))
}

function scrubString(value) {
  let out = value
  for (const { name, re, sub } of SCRUBBERS) {
    out = out.replace(re, () => { bump(stats.scrubHits, name); return sub })
  }
  return out
}

function valueIsProvablySafe(value) {
  if (SAFE_ID_RE.test(value)) return true
  if (CHECK_ID_RE.test(value)) return true
  if (ISO_RE.test(value)) return true
  if (SAFE_ENUMS.has(value.toLowerCase())) return true
  if (value === '' || value === REDACTION) return true
  return false
}

function redactedPlaceholder(value) {
  if (Array.isArray(value)) return [`${REDACTION} (${value.length} item(s))`]
  if (value && typeof value === 'object') return { [REDACTION]: true }
  return REDACTION
}

function sanitizeNode(node, keyHint) {
  if (typeof node === 'string') {
    const key = String(keyHint ?? '').toLowerCase()
    if (SCRUB_AND_KEEP_KEYS.has(key)) { stats.keptValues += 1; return scrubString(node) }
    if (valueIsProvablySafe(node)) { stats.keptValues += 1; return node }
    stats.redactedValues += 1
    return REDACTION // default-deny
  }
  if (typeof node === 'number' || typeof node === 'boolean' || node === null) return node
  if (Array.isArray(node)) return node.map((item) => sanitizeNode(item, keyHint))
  if (node && typeof node === 'object') {
    const out = {}
    for (const [key, val] of Object.entries(node)) {
      const isContainer = val !== null && typeof val === 'object'
      if (FIELD_DATA_KEY_RE.test(key)) { bump(stats.redactedKeys, key); out[key] = redactedPlaceholder(val) } // cell value (any type)
      else if (isContainer && keyIsSensitiveContainer(key)) { bump(stats.redactedKeys, key); out[key] = redactedPlaceholder(val) }
      else out[key] = sanitizeNode(val, key) // scalars/safe containers → default-deny
    }
    return out
  }
  return node
}

// Walk sanitized JSON and flag any retained string that still looks like
// free-text business data (whitespace / CJK / overly long) outside config keys.
function structuralResidual(node, keyHint, hits) {
  if (typeof node === 'string') {
    const key = String(keyHint ?? '').toLowerCase()
    if (SCRUB_AND_KEEP_KEYS.has(key)) return
    if (node === REDACTION || valueIsProvablySafe(node)) return
    if (/\s/.test(node) || CJK_RE.test(node) || node.length > 40) {
      hits.push({ key: keyHint ?? '(root)', sample: node.slice(0, 60) })
    }
    return
  }
  if (Array.isArray(node)) { node.forEach((v) => structuralResidual(v, keyHint, hits)); return }
  if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) structuralResidual(v, k, hits)
  }
}

function scanResidualText(text) {
  const hits = []
  for (const { name, re } of RESIDUAL_PATTERNS) {
    const m = text.match(new RegExp(re.source, re.flags))
    if (m && m.length) hits.push({ name, count: m.length, sample: m[0] })
  }
  return hits
}

function freshStats() { stats.redactedKeys = {}; stats.scrubHits = {}; stats.redactedValues = 0; stats.keptValues = 0 }

// Sanitize a report.json string. Returns the JSON output plus residual scan
// results and counters — the pure core, used by both the CLI and the tests.
export function sanitizeReportJson(raw) {
  freshStats()
  const output = JSON.stringify(sanitizeNode(JSON.parse(raw)), null, 2)
  const patternHits = scanResidualText(output)
  const structHits = []
  structuralResidual(JSON.parse(output), null, structHits)
  return {
    output,
    patternHits,
    structHits,
    clean: patternHits.length === 0 && structHits.length === 0,
    kept: stats.keptValues,
    redacted: stats.redactedValues,
    redactedKeys: { ...stats.redactedKeys },
    scrubHits: { ...stats.scrubHits },
  }
}

// report.md is pattern-scrubbed only and is NEVER certified publishable.
export function sanitizeMarkdown(raw) {
  freshStats()
  return raw.split('\n').map(scrubString).join('\n')
}

export { sanitizeNode, valueIsProvablySafe, scanResidualText, structuralResidual }

function parseArgs(argv) {
  const args = { files: [], out: null, inPlace: false, scanOnly: false }
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === '--out') args.out = argv[++i]
    else if (a === '--in-place') args.inPlace = true
    else if (a === '--scan-only') args.scanOnly = true
    else if (a.startsWith('--')) throw new Error(`Unknown flag: ${a}`)
    else args.files.push(a)
  }
  return args
}

function defaultOut(file) {
  const ext = path.extname(file)
  return `${file.slice(0, file.length - ext.length)}.sanitized${ext}`
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  if (!args.files.length) {
    console.error('usage: node scripts/sanitize-smoke-report.mjs <report.json> [...] [--out <path>] [--in-place] [--scan-only]')
    process.exit(2)
  }
  if (args.out && args.files.length > 1) { console.error('--out is only valid with a single input file'); process.exit(2) }

  let failures = 0
  for (const file of args.files) {
    if (!fs.existsSync(file)) { console.error(`skip (missing): ${file}`); process.exitCode = 2; continue }
    const raw = fs.readFileSync(file, 'utf8')
    const isJson = path.extname(file).toLowerCase() === '.json'

    if (!isJson) {
      // report.md: pattern-scrub only — NOT certifiable as publishable.
      const output = sanitizeMarkdown(raw)
      if (!args.scanOnly) {
        const out = args.inPlace ? file : (args.out ?? defaultOut(file))
        fs.writeFileSync(out, output)
        console.log(`wrote: ${out}`)
      }
      console.log(`\n[${file}] (markdown)`)
      console.log('  pattern scrubs:', Object.entries(stats.scrubHits).map(([k, n]) => `${k}×${n}`).join(', ') || '(none)')
      console.log('  ⚠ NOT PUBLISHABLE: markdown is prose; key-based redaction is not possible.')
      console.log('    Free-text business data (modalText/createRecordPayload/columnHeaders/…) may remain.')
      console.log('    Commit the sanitized JSON as the public baseline; do NOT publish this .md.')
      failures += 1 // force non-zero: md is never certified clean
      continue
    }

    let result
    try { result = sanitizeReportJson(raw) }
    catch (e) { console.error(`failed to sanitize ${file}: ${e.message}`); process.exitCode = 1; continue }
    const { output, patternHits, structHits } = result

    if (!args.scanOnly) {
      const out = args.inPlace ? file : (args.out ?? defaultOut(file))
      fs.writeFileSync(out, output + '\n')
      console.log(`wrote: ${out}`)
    }
    console.log(`\n[${file}]`)
    console.log(`  values: kept ${stats.keptValues}, redacted ${stats.redactedValues} (default-deny)`)
    console.log('  key-subtree redactions:', Object.entries(stats.redactedKeys).map(([k, n]) => `${k}×${n}`).join(', ') || '(none)')
    console.log('  pattern scrubs:', Object.entries(stats.scrubHits).map(([k, n]) => `${k}×${n}`).join(', ') || '(none)')
    if (patternHits.length || structHits.length) {
      if (patternHits.length) console.log('  ⚠ RESIDUAL (pattern):', patternHits.map((h) => `${h.name}×${h.count} (e.g. ${h.sample})`).join(', '))
      if (structHits.length) console.log('  ⚠ RESIDUAL (free-text):', structHits.slice(0, 5).map((h) => `${h.key}="${h.sample}"`).join(', '), structHits.length > 5 ? `(+${structHits.length - 5})` : '')
      failures += 1
    } else {
      console.log('  residual scan (pattern + free-text): clean ✓ — JSON safe to publish')
    }
  }

  if (failures > 0) {
    console.error(`\nFAIL: ${failures} file(s) not certified publishable (residual content and/or markdown).`)
    process.exit(1)
  }
}

// Run as CLI only — importing the module (e.g. from tests) must not execute.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
