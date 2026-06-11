/**
 * Multitable AI field shortcut — config governance + prompt assembly (A2).
 *
 * Design lock: docs/development/multitable-ai-shortcut-backend-a2-design-20260611.md §2.1.
 *
 * The shortcut config persists at `field.property.aiShortcut`. Because
 * `sanitizeFieldProperty` passes unknown property keys through untouched, the
 * field create/update path validates the key EXPLICITLY through
 * `validateAiShortcutFieldProperty` (kind enum; source fields exist on the
 * sheet and are non-computed; locked params caps: options ≤50×each ≤100 chars,
 * targetLang ≤32 chars, instruction ≤500 chars). Invalid → 4xx at the route.
 *
 * Prompts are SERVER-SIDE templates per kind — user data (source values and
 * every param string) enters slots only and is part of the assembled text that
 * the route's unsafe_input pre-send scan covers (§2.4).
 */

export const AI_SHORTCUT_KINDS = ['summarize', 'classify', 'extract', 'translate'] as const
export type AiShortcutKind = (typeof AI_SHORTCUT_KINDS)[number]

export interface AiShortcutParams {
  options?: string[]
  targetLang?: string
  instruction?: string
}

export interface AiShortcutConfig {
  kind: AiShortcutKind
  sourceFieldIds: string[]
  params: AiShortcutParams
}

/** §2.1: classify writes the label TEXT — select targets are a later ring. */
export const AI_SHORTCUT_TARGET_FIELD_TYPES: ReadonlySet<string> = new Set(['string', 'longText'])

/** Computed field types are server-derived — forbidden as shortcut sources. */
export const AI_SHORTCUT_COMPUTED_SOURCE_TYPES: ReadonlySet<string> = new Set(['formula', 'lookup', 'rollup'])

export const AI_SHORTCUT_MAX_SOURCE_FIELDS = 20
export const AI_SHORTCUT_MAX_OPTIONS = 50
export const AI_SHORTCUT_MAX_OPTION_LENGTH = 100
export const AI_SHORTCUT_MAX_TARGET_LANG_LENGTH = 32
export const AI_SHORTCUT_MAX_INSTRUCTION_LENGTH = 500

const ALLOWED_PARAM_KEYS = new Set(['options', 'targetLang', 'instruction'])

export type AiShortcutConfigParseResult =
  | { ok: true; config: AiShortcutConfig }
  | { ok: false; error: string }

type AiShortcutQueryFn = (
  sql: string,
  params?: unknown[],
) => Promise<{ rows: unknown[]; rowCount?: number | null }>

/** Structural validation of an aiShortcut config value (no DB access). */
export function parseAiShortcutConfig(value: unknown): AiShortcutConfigParseResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, error: 'aiShortcut must be an object' }
  }
  const raw = value as Record<string, unknown>

  const kind = typeof raw.kind === 'string' ? raw.kind : ''
  if (!(AI_SHORTCUT_KINDS as readonly string[]).includes(kind)) {
    return { ok: false, error: `aiShortcut.kind must be one of: ${AI_SHORTCUT_KINDS.join(', ')}` }
  }

  if (!Array.isArray(raw.sourceFieldIds) || raw.sourceFieldIds.length === 0) {
    return { ok: false, error: 'aiShortcut.sourceFieldIds must be a non-empty array of field ids' }
  }
  if (raw.sourceFieldIds.length > AI_SHORTCUT_MAX_SOURCE_FIELDS) {
    return { ok: false, error: `aiShortcut.sourceFieldIds allows at most ${AI_SHORTCUT_MAX_SOURCE_FIELDS} fields` }
  }
  const sourceFieldIds: string[] = []
  for (const entry of raw.sourceFieldIds) {
    if (typeof entry !== 'string' || entry.trim().length === 0 || entry.length > 50) {
      return { ok: false, error: 'aiShortcut.sourceFieldIds entries must be non-empty field id strings' }
    }
    if (!sourceFieldIds.includes(entry)) sourceFieldIds.push(entry)
  }

  const params: AiShortcutParams = {}
  if (raw.params !== undefined) {
    if (!raw.params || typeof raw.params !== 'object' || Array.isArray(raw.params)) {
      return { ok: false, error: 'aiShortcut.params must be an object' }
    }
    const rawParams = raw.params as Record<string, unknown>
    for (const key of Object.keys(rawParams)) {
      if (!ALLOWED_PARAM_KEYS.has(key)) {
        return { ok: false, error: `aiShortcut.params has an unknown key: ${key}` }
      }
    }
    if (rawParams.options !== undefined) {
      if (!Array.isArray(rawParams.options) || rawParams.options.length > AI_SHORTCUT_MAX_OPTIONS) {
        return { ok: false, error: `aiShortcut.params.options must be an array of at most ${AI_SHORTCUT_MAX_OPTIONS} entries` }
      }
      const options: string[] = []
      for (const option of rawParams.options) {
        if (typeof option !== 'string' || option.length === 0 || option.length > AI_SHORTCUT_MAX_OPTION_LENGTH) {
          return { ok: false, error: `aiShortcut.params.options entries must be strings of at most ${AI_SHORTCUT_MAX_OPTION_LENGTH} characters` }
        }
        options.push(option)
      }
      params.options = options
    }
    if (rawParams.targetLang !== undefined) {
      if (typeof rawParams.targetLang !== 'string' || rawParams.targetLang.length > AI_SHORTCUT_MAX_TARGET_LANG_LENGTH) {
        return { ok: false, error: `aiShortcut.params.targetLang must be a string of at most ${AI_SHORTCUT_MAX_TARGET_LANG_LENGTH} characters` }
      }
      params.targetLang = rawParams.targetLang
    }
    if (rawParams.instruction !== undefined) {
      if (typeof rawParams.instruction !== 'string' || rawParams.instruction.length > AI_SHORTCUT_MAX_INSTRUCTION_LENGTH) {
        return { ok: false, error: `aiShortcut.params.instruction must be a string of at most ${AI_SHORTCUT_MAX_INSTRUCTION_LENGTH} characters` }
      }
      params.instruction = rawParams.instruction
    }
  }

  return { ok: true, config: { kind: kind as AiShortcutKind, sourceFieldIds, params } }
}

/** Source fields must exist (in the given sheet field set) and be non-computed. */
export function validateAiShortcutSourceFields(
  config: AiShortcutConfig,
  fieldTypeById: Map<string, string>,
): string | null {
  for (const fieldId of config.sourceFieldIds) {
    const type = fieldTypeById.get(fieldId)
    if (type === undefined) {
      return `aiShortcut source field not found on this sheet: ${fieldId}`
    }
    if (AI_SHORTCUT_COMPUTED_SOURCE_TYPES.has(type)) {
      return `aiShortcut source field must not be computed (formula/lookup/rollup): ${fieldId}`
    }
  }
  return null
}

/**
 * Field create/update chokepoint: validates `property.aiShortcut` when present.
 * Returns an error string for the route to surface as 4xx, or null when the
 * property carries no aiShortcut key / the config is valid.
 */
export async function validateAiShortcutFieldProperty(
  query: AiShortcutQueryFn,
  sheetId: string,
  property: Record<string, unknown> | undefined,
): Promise<string | null> {
  const raw = property?.aiShortcut
  if (raw === undefined) return null

  const parsed = parseAiShortcutConfig(raw)
  // `in`-guard (not `!parsed.ok`): the backend tsconfig is non-strict, where
  // boolean-discriminant narrowing does not apply.
  if ('error' in parsed) return parsed.error

  const result = await query(
    'SELECT id, type FROM meta_fields WHERE sheet_id = $1 AND id = ANY($2::text[])',
    [sheetId, parsed.config.sourceFieldIds],
  )
  const fieldTypeById = new Map(
    (result.rows as Array<{ id: unknown; type: unknown }>).map((row) => [String(row.id), String(row.type)]),
  )
  return validateAiShortcutSourceFields(parsed.config, fieldTypeById)
}

/** Stringify a record value for a prompt slot (structured values JSON-encoded). */
export function formatAiShortcutSourceValue(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

/**
 * Server-side prompt template per kind — user data enters slots only. The
 * FULL assembled text (including every param string) goes through the route's
 * unsafe_input pre-send scan before any provider call.
 */
export function buildAiShortcutPrompt(
  config: AiShortcutConfig,
  sources: Array<{ name: string; value: unknown }>,
): string {
  const lines: string[] = []
  switch (config.kind) {
    case 'summarize':
      lines.push('Task: Write a concise summary of the record content below. Respond with the summary only.')
      break
    case 'classify': {
      lines.push('Task: Choose the single best matching category for the record content below. Respond with the category text only.')
      const options = config.params.options ?? []
      if (options.length > 0) {
        lines.push(`Allowed categories: ${options.join(' | ')}`)
      }
      break
    }
    case 'extract':
      lines.push('Task: Extract the requested information from the record content below. Respond with the extracted value only.')
      break
    case 'translate': {
      const target = config.params.targetLang
      lines.push(`Task: Translate the record content below${target ? ` into ${target}` : ''}. Respond with the translation only.`)
      break
    }
  }
  if (config.params.instruction) {
    lines.push(`Additional instruction: ${config.params.instruction}`)
  }
  lines.push('Record content:')
  for (const source of sources) {
    lines.push(`${source.name}: ${formatAiShortcutSourceValue(source.value)}`)
  }
  return lines.join('\n')
}
