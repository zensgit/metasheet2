/**
 * `yida.preview.synthetic.v1` — the YiDa consumer of the synthetic integration preview (evidence D §5).
 *
 * It receives rows that the run's RunValueStore already resolved for it, builds the compiler input
 * `{ config, rowsText, allocation }` from a FIXED mapping preset and calls the shared pure compiler
 * `compileYidaLocalDraft` (plugins/plugin-integration-core/lib/yida-draft-compiler.mjs:190) in memory.
 * That compiler's normalization and digests are reused, not copied.
 *
 * No other YiDa port is reachable from here: no draft store, no prepare/approve/submit/send, no grant,
 * admission, ACK or backfill, no lookup and no connection test. The compiler is INJECTED as a single
 * pure function; nothing else of the plugin is loaded. The preview result is not an authority: a digest
 * shown here does not let anything be sent (the send path re-derives and re-authorizes on its own).
 */
import { existsSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import type { SyntheticYidaMappingPreset } from './automation-operation-catalog'

export type YidaLocalDraftCompile = (input: { config: unknown; rowsText: string; allocation: unknown }) => unknown

export type SyntheticYidaPreviewRow = Readonly<{
  index: number
  status: string
  businessKeyDigest: string
  payloadDigest: string
  /** Preset-allowed target fields only (synthetic values). */
  fields: Readonly<Record<string, string | number | boolean | null>>
}>

export type SyntheticYidaPreviewView = Readonly<{
  intent: 'create' | 'update'
  rowCount: number
  planDigest: string
  keyDefinitionDigest: string
  locatorDigest: string
  rows: readonly SyntheticYidaPreviewRow[]
}>

export class YidaSyntheticPreviewError extends Error {
  readonly code = 'YIDA_SYNTHETIC_PREVIEW_REJECTED' as const
  constructor() {
    super('YIDA_SYNTHETIC_PREVIEW_REJECTED')
    this.name = 'YidaSyntheticPreviewError'
  }
}

const DIGEST = /^[0-9a-f]{64}$/u

function reject(): never {
  throw new YidaSyntheticPreviewError()
}

function own(value: unknown, key: string): unknown {
  if (!value || typeof value !== 'object') return undefined
  const descriptor = Object.getOwnPropertyDescriptor(value, key)
  return descriptor && Object.prototype.hasOwnProperty.call(descriptor, 'value') ? descriptor.value : undefined
}

function scalar(value: unknown): string | number | boolean | null {
  if (typeof value === 'boolean' || typeof value === 'string') return value
  if (typeof value === 'number' && Number.isFinite(value)) return value
  return null
}

function compilerInput(preset: SyntheticYidaMappingPreset, rows: readonly Readonly<Record<string, unknown>>[]) {
  const config = { ...JSON.parse(JSON.stringify(preset.rules)), target: { ...preset.target } }
  const allocation = preset.allocation.mode === 'original'
    ? { mode: 'original' }
    : {
      mode: preset.allocation.mode,
      projects: [...preset.allocation.projects],
      projectField: preset.allocation.projectField,
      quantityField: preset.allocation.quantityField,
    }
  return { config, rowsText: JSON.stringify(rows.map((row) => ({ ...row }))), allocation }
}

/**
 * Validate the pure compiler's output and project the preset-allowed view. Every flag the compiler
 * must report as false (canApply / tokenIssued / lookupExecuted / externalWriteAttempted) is checked;
 * anything else refuses. Nothing from a compiler error (message, cause, input) is kept.
 */
function toView(result: unknown, preset: SyntheticYidaMappingPreset): SyntheticYidaPreviewView {
  const plan = own(result, 'plan')
  if (!plan || own(plan, 'canApply') !== false || own(plan, 'tokenIssued') !== false
    || own(plan, 'lookupExecuted') !== false || own(plan, 'externalWriteAttempted') !== false) reject()
  const planRows = own(plan, 'rows')
  const rowSpecs = own(result, 'rowSpecs')
  if (!Array.isArray(planRows) || !Array.isArray(rowSpecs) || planRows.length !== rowSpecs.length || planRows.length === 0) reject()
  const planDigest = own(result, 'planDigest')
  const keyDefinitionDigest = own(result, 'keyDefinitionDigest')
  const locatorDigest = own(result, 'locatorDigest')
  for (const digest of [planDigest, keyDefinitionDigest, locatorDigest]) {
    if (typeof digest !== 'string' || !DIGEST.test(digest)) reject()
  }
  const intent = own(own(own(result, 'source'), 'config'), 'intent')
  if (intent !== 'create' && intent !== 'update') reject()
  const rows = planRows.map((row, index) => {
    const spec = rowSpecs[index]
    const payload = own(row, 'payload')
    const businessKeyDigest = own(spec, 'businessKeyDigest')
    const payloadDigest = own(spec, 'payloadDigest')
    const status = own(row, 'status')
    if (own(row, 'index') !== index || own(spec, 'index') !== index || typeof status !== 'string'
      || typeof businessKeyDigest !== 'string' || !DIGEST.test(businessKeyDigest)
      || typeof payloadDigest !== 'string' || !DIGEST.test(payloadDigest) || !payload || typeof payload !== 'object') reject()
    const fields: Record<string, string | number | boolean | null> = {}
    for (const field of preset.viewFields) {
      if (Object.prototype.hasOwnProperty.call(payload, field)) fields[field] = scalar(own(payload, field))
    }
    return Object.freeze({ index, status, businessKeyDigest, payloadDigest, fields: Object.freeze(fields) })
  })
  return Object.freeze({
    intent,
    rowCount: rows.length,
    planDigest: planDigest as string,
    keyDefinitionDigest: keyDefinitionDigest as string,
    locatorDigest: locatorDigest as string,
    rows: Object.freeze(rows),
  })
}

export type YidaSyntheticPreviewConsumer = Readonly<{
  id: 'yida.preview.synthetic.v1'
  consume(rows: readonly Readonly<Record<string, unknown>>[], preset: SyntheticYidaMappingPreset): SyntheticYidaPreviewView
}>

/** @param compile the shared pure compiler (`compileYidaLocalDraft`), injected. */
export function createYidaSyntheticPreviewConsumer(compile: YidaLocalDraftCompile): YidaSyntheticPreviewConsumer {
  if (typeof compile !== 'function') reject()
  return Object.freeze({
    id: 'yida.preview.synthetic.v1' as const,
    consume(rows: readonly Readonly<Record<string, unknown>>[], preset: SyntheticYidaMappingPreset) {
      let result: unknown
      try {
        result = compile(compilerInput(preset, rows))
      } catch {
        // The compiler's own error is never kept: not its message, its cause or its input.
        reject()
      }
      return toView(result, preset)
    },
  })
}

// ── Production loader ──────────────────────────────────────────────────────

const COMPILER_RELATIVE = path.join('plugins', 'plugin-integration-core', 'lib', 'yida-draft-compiler.mjs')

/** Same plugin-root candidates as the host plugin loader (core/plugin-loader.ts). */
export function resolveYidaDraftCompilerPath(cwd = process.cwd()): string | null {
  for (const root of [cwd, path.resolve(cwd, '..'), path.resolve(cwd, '..', '..')]) {
    const candidate = path.resolve(root, COMPILER_RELATIVE)
    if (existsSync(candidate)) return candidate
  }
  return null
}

// The backend compiles to CommonJS, where `import()` would be rewritten to require() and cannot load an
// ES module on every supported Node. This keeps a NATIVE dynamic import for the one fixed file path.
// eslint-disable-next-line @typescript-eslint/no-implied-eval
const nativeImportFn = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<Record<string, unknown>>

async function importCompilerModule(specifier: string): Promise<Record<string, unknown>> {
  try {
    return await nativeImportFn(specifier)
  } catch (error) {
    // Only inside a vm-hosted module runner (the vitest host suites) does a Function-body import have no
    // loader; there the transformed `import()` below is the runner's own. Any other failure propagates.
    if ((error as { code?: unknown })?.code !== 'ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING') throw error
    return await import(specifier) as Record<string, unknown>
  }
}

let cachedCompiler: Promise<YidaLocalDraftCompile> | null = null

/**
 * Load ONLY `compileYidaLocalDraft` from the shared compiler module. The persisted-path export
 * (`compileYidaDraft`, v2 only) and every other plugin module are not taken. A missing file or export
 * rejects (the preview then answers UNAVAILABLE).
 */
export function loadYidaLocalDraftCompiler(): Promise<YidaLocalDraftCompile> {
  cachedCompiler ??= (async () => {
    const file = resolveYidaDraftCompilerPath()
    if (!file) throw new YidaSyntheticPreviewError()
    const loaded = await importCompilerModule(pathToFileURL(file).href)
    const compile = loaded.compileYidaLocalDraft
    if (typeof compile !== 'function') throw new YidaSyntheticPreviewError()
    return compile as YidaLocalDraftCompile
  })()
  // A failed load is not cached, so a later run can retry it.
  cachedCompiler.catch(() => { cachedCompiler = null })
  return cachedCompiler
}
