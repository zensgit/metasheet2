/**
 * useAiShortcut — A3 trigger-surface state machine for the AI field shortcut
 * (docs/development/multitable-ai-shortcut-frontend-a3-design-20260611.md §2.2/§2.3).
 *
 * One instance per workbench drives ALL THREE entry points (record drawer
 * preview/run, cell-editor run, field-manager config-time preview) so the
 * in-flight pending guard is unified (LOCKED §2.2 reentrancy).
 *
 * Wire discipline:
 *  - The run response is NOT a PatchResult. `adaptAiShortcutRunResult`
 *    synthesizes `{updated, records}` for the grid's `applyPatchResult()`;
 *    `version === null` skips the version write and merges the value only.
 *    The consumed key set is pinned route-level by the backend integration
 *    suite (A2-T5 Object.keys assertion) — fixture-drift rule.
 *  - Errors branch STRICTLY on `error.code` (the body's top-level `status`
 *    discriminator never reaches the client). RATE_LIMITED (429 + Retry-After)
 *    starts a countdown that gates every entry point; AI_QUOTA_EXHAUSTED
 *    (429, no Retry-After) gets no countdown. AI_BLOCKED (503) keeps its own
 *    code — never a generic-5xx bucket. UI copy for known codes lives in
 *    meta-api-error-labels (aiShortcutErrorMessage); the raw backend message
 *    is kept for unknown codes only.
 *  - Drift guard (LOCKED §2.2, review-F4 refinement): the local row version is
 *    captured when the run starts. If it changed by the time the response
 *    lands AND differs from the RESPONSE version (genuine collaborative
 *    edit), the merge is SKIPPED and `refreshHint` surfaces the same refresh
 *    recovery copy as 409. If the local version EQUALS the response version,
 *    the bump was the run's OWN write echoed back through a live Yjs session
 *    before the HTTP response landed — the output is already applied, so the
 *    (redundant) merge is skipped silently with a success state and NO
 *    refresh warning (tokens still shown).
 *  - `busy` (review F3): single disable signal for ALL trigger surfaces —
 *    true exactly when `begin()` would refuse (in-flight request OR an active
 *    RATE_LIMITED countdown). Surfaces must disable on it so a guarded click
 *    can never silently no-op (the cell path would otherwise destroy the
 *    user's edit session for nothing).
 */
import { computed, getCurrentScope, onScopeDispose, reactive } from 'vue'
import type {
  AiShortcutConfigInput,
  AiShortcutPreviewData,
  AiShortcutRunData,
  AiShortcutUsage,
  AiUsageSummary,
} from '../api/client'
import type { PatchResult } from '../types'

// Client-side mirrors of the A2 config governance caps (ai-shortcut-config.ts).
export const AI_SHORTCUT_KINDS = ['summarize', 'classify', 'extract', 'translate'] as const
export const AI_SHORTCUT_MAX_SOURCE_FIELDS = 20
export const AI_SHORTCUT_MAX_OPTIONS = 50
export const AI_SHORTCUT_MAX_OPTION_LENGTH = 100
export const AI_SHORTCUT_MAX_TARGET_LANG_LENGTH = 32
export const AI_SHORTCUT_MAX_INSTRUCTION_LENGTH = 500
/** Computed field types are server-derived — forbidden as shortcut sources (A2 mirror). */
export const AI_SHORTCUT_COMPUTED_SOURCE_TYPES: ReadonlySet<string> = new Set(['formula', 'lookup', 'rollup'])

/** Known §2.3 codes plus raw passthrough for anything else (`(string & {})` keeps autocomplete). */
export type AiShortcutErrorCode =
  | 'AI_BLOCKED'
  | 'RATE_LIMITED'
  | 'AI_QUOTA_EXHAUSTED'
  | 'AI_UNSAFE_INPUT'
  | 'AI_PROVIDER_ERROR'
  | 'VERSION_CONFLICT'
  | 'UNKNOWN'
  | (string & {})

export interface AiShortcutUiError {
  code: AiShortcutErrorCode
  /** Raw backend message (server-side redacted) — display copy comes from meta-api-error-labels by code. */
  message: string
  status?: number
  retryAfterMs?: number
  recordId?: string
  fieldId?: string
}

export interface AiShortcutUiResult {
  kind: 'preview' | 'run'
  recordId: string
  fieldId: string | null
  output: string
  promptTokens: number
  completionTokens: number
  totalTokens: number
  /**
   * run only: true when the output is reflected locally — either we applied
   * the merge, or the run's own Yjs echo already did (review F4). false only
   * when the drift guard skipped the merge on genuine third-party drift.
   */
  merged: boolean
  /** true → show the SAME refresh recovery copy as 409 (error.aiVersionConflict). */
  refreshHint: boolean
}

export interface AiShortcutState {
  pending: { kind: 'preview' | 'run'; recordId: string; fieldId: string | null } | null
  result: AiShortcutUiResult | null
  error: AiShortcutUiError | null
  /** RATE_LIMITED countdown (ms); null when no countdown is active. */
  retryRemainingMs: number | null
}

export type AiShortcutPreviewOutcome =
  | { data: AiShortcutPreviewData }
  | { error: AiShortcutUiError }

interface AiShortcutClientLike {
  aiShortcutPreview(
    sheetId: string,
    input: { recordId: string; fieldId?: string; config?: AiShortcutConfigInput },
  ): Promise<AiShortcutPreviewData>
  aiShortcutRun(sheetId: string, input: { recordId: string; fieldId: string }): Promise<AiShortcutRunData>
}

export interface UseAiShortcutOptions {
  client: AiShortcutClientLike
  sheetId: () => string
  /** Local grid row version for the drift guard; undefined when the row is not loaded locally. */
  getLocalRecordVersion: (recordId: string) => number | undefined
  /** The grid's applyPatchResult — the single echo application seam. */
  applyPatchResult: (result: PatchResult) => void
}

/**
 * A3-T4 adapter (LOCKED §2.2): synthesize a PatchResult from the run wire.
 * `output` mirrors what the backend wrote (`result.text ?? ''`); a null
 * version yields NO `updated` entry (value merge only).
 */
export function adaptAiShortcutRunResult(data: AiShortcutRunData): PatchResult {
  return {
    updated: typeof data.version === 'number' ? [{ recordId: data.recordId, version: data.version }] : [],
    records: [{ recordId: data.recordId, data: { [data.fieldId]: data.output ?? '' } }],
  }
}

/** Normalize a thrown MultitableApiError into the §2.3 UI error (branch by code, never by status alone). */
export function mapAiShortcutError(err: unknown): AiShortcutUiError {
  const e = (err ?? {}) as { code?: unknown; message?: unknown; status?: unknown; retryAfterMs?: unknown }
  const code = typeof e.code === 'string' && e.code.length > 0 ? e.code : 'UNKNOWN'
  return {
    code,
    message: typeof e.message === 'string' ? e.message : '',
    ...(typeof e.status === 'number' ? { status: e.status } : {}),
    ...(typeof e.retryAfterMs === 'number' ? { retryAfterMs: e.retryAfterMs } : {}),
  }
}

function usageNumbers(usage: AiShortcutUsage | null | undefined): {
  promptTokens: number
  completionTokens: number
  totalTokens: number
} {
  const promptTokens = usage?.promptTokens ?? 0
  const completionTokens = usage?.completionTokens ?? 0
  return { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens }
}

// --- A3-T7: admin usage-summary 403 probe cache (per browser session) ---
// A non-admin's first probe 403s once; afterwards the card stays silently
// hidden for the whole session (module-level on purpose — survives remounts).
let aiUsageSummaryForbiddenThisSession = false

export function resetAiUsageSummarySessionCache(): void {
  aiUsageSummaryForbiddenThisSession = false
}

/**
 * Fetch the admin usage summary through the session 403 cache: null means
 * "hide the card" (non-admin), other failures propagate (NOT cached).
 */
export async function fetchAiUsageSummaryWithProbeCache(
  fetchFn: () => Promise<AiUsageSummary>,
): Promise<AiUsageSummary | null> {
  if (aiUsageSummaryForbiddenThisSession) return null
  try {
    return await fetchFn()
  } catch (err) {
    if ((err as { status?: number }).status === 403) {
      aiUsageSummaryForbiddenThisSession = true
      return null
    }
    throw err
  }
}

export function useAiShortcut(opts: UseAiShortcutOptions) {
  const state = reactive<AiShortcutState>({
    pending: null,
    result: null,
    error: null,
    retryRemainingMs: null,
  })

  let countdownTimer: ReturnType<typeof setInterval> | null = null

  function clearCountdown(): void {
    if (countdownTimer) {
      clearInterval(countdownTimer)
      countdownTimer = null
    }
    state.retryRemainingMs = null
  }

  function startCountdown(ms: number): void {
    clearCountdown()
    state.retryRemainingMs = ms
    const startedAt = Date.now()
    countdownTimer = setInterval(() => {
      const left = ms - (Date.now() - startedAt)
      if (left <= 0) clearCountdown()
      else state.retryRemainingMs = left
    }, 1000)
  }

  /**
   * Unified entry gate (LOCKED §2.2): one in-flight request across all three
   * trigger surfaces, and the RATE_LIMITED countdown blocks new sends (the
   * limiter budget is shared between preview and run server-side).
   */
  function begin(kind: 'preview' | 'run', recordId: string, fieldId: string | null): boolean {
    if (state.pending) return false
    if (state.retryRemainingMs !== null) return false
    state.pending = { kind, recordId, fieldId }
    state.result = null
    state.error = null
    return true
  }

  function fail(err: unknown, recordId: string, fieldId: string | null): AiShortcutUiError {
    const mapped = mapAiShortcutError(err)
    state.error = { ...mapped, recordId, ...(fieldId ? { fieldId } : {}) }
    if (mapped.code === 'RATE_LIMITED' && typeof mapped.retryAfterMs === 'number' && mapped.retryAfterMs > 0) {
      startCountdown(mapped.retryAfterMs)
    }
    return mapped
  }

  /** Drawer path: preview the PERSISTED config of a readable field. */
  async function preview(recordId: string, fieldId: string): Promise<AiShortcutPreviewData | null> {
    if (!begin('preview', recordId, fieldId)) return null
    try {
      const data = await opts.client.aiShortcutPreview(opts.sheetId(), { recordId, fieldId })
      state.result = {
        kind: 'preview',
        recordId,
        fieldId,
        output: data.output ?? '',
        ...usageNumbers(data.usage),
        merged: false,
        refreshHint: false,
      }
      return data
    } catch (err) {
      fail(err, recordId, fieldId)
      return null
    } finally {
      state.pending = null
    }
  }

  /**
   * Field-manager path: preview the inline DRAFT config (real call, consumes
   * quota — §2.1 locked copy lives in the manager). Outcome is returned
   * inline so the manager renders result/errors next to the draft; the
   * shared pending guard + countdown still apply. null = guarded no-op.
   */
  async function previewWithConfig(
    recordId: string,
    config: AiShortcutConfigInput,
  ): Promise<AiShortcutPreviewOutcome | null> {
    if (!begin('preview', recordId, null)) return null
    try {
      const data = await opts.client.aiShortcutPreview(opts.sheetId(), { recordId, config })
      return { data }
    } catch (err) {
      const mapped = mapAiShortcutError(err)
      if (mapped.code === 'RATE_LIMITED' && typeof mapped.retryAfterMs === 'number' && mapped.retryAfterMs > 0) {
        startCountdown(mapped.retryAfterMs)
      }
      return { error: mapped }
    } finally {
      state.pending = null
    }
  }

  /** Run the persisted config and merge the echo through applyPatchResult. */
  async function run(recordId: string, fieldId: string): Promise<void> {
    if (!begin('run', recordId, fieldId)) return
    const capturedVersion = opts.getLocalRecordVersion(recordId)
    try {
      const data = await opts.client.aiShortcutRun(opts.sheetId(), { recordId, fieldId })
      const localVersion = opts.getLocalRecordVersion(recordId)
      const responseVersion = typeof data.version === 'number' ? data.version : null
      const changedLocally = capturedVersion !== undefined && localVersion !== capturedVersion
      // Own-echo guard (review F4): in a Yjs-live session the run's OWN write
      // can bump the local version via the realtime echo before the HTTP
      // response lands. Local version === response version → the output is
      // already applied; skip the redundant merge silently (success, no
      // refresh warning). Only a local version differing from BOTH the
      // captured and the response version is genuine third-party drift.
      const alreadyApplied = changedLocally && responseVersion !== null && localVersion === responseVersion
      const drifted = changedLocally && !alreadyApplied
      if (!drifted && !alreadyApplied) {
        opts.applyPatchResult(adaptAiShortcutRunResult(data))
      }
      state.result = {
        kind: 'run',
        recordId,
        fieldId,
        output: data.output ?? '',
        ...usageNumbers(data.usage),
        merged: !drifted,
        refreshHint: drifted,
      }
    } catch (err) {
      fail(err, recordId, fieldId)
    } finally {
      state.pending = null
    }
  }

  function clear(): void {
    state.result = null
    state.error = null
  }

  /**
   * Review F3: unified disable signal for EVERY trigger surface (drawer
   * buttons, cell-editor run button, field-manager config preview).
   * Definitionally identical to the `begin()` refusal condition so a surface
   * that disables on `busy` can never fire a click that silently no-ops.
   */
  const busy = computed(() => state.pending !== null || state.retryRemainingMs !== null)

  if (getCurrentScope()) {
    onScopeDispose(() => {
      if (countdownTimer) clearInterval(countdownTimer)
    })
  }

  return { state, busy, preview, previewWithConfig, run, clear }
}
