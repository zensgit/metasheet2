// G10 — the CLIENT-SIDE MIRROR of the runtime's permanent external-write fence, and the copy that
// describes it.
//
// AUTHORITY, and what this file is not. The ban itself lives in
// plugins/plugin-integration-core/lib/k3-external-write-permanent-fence.cjs (E4, Human-Governance
// solution v1.2 §10.1), which refuses K3 Save/Submit/Audit at four independent layers per connector
// kind. THAT module decides every actual request. This one holds a copy of its closed subject set for
// exactly one purpose: so the data-factory UI can stop OFFERING an action the runtime will always
// refuse. Until G10, the workbench rendered a "Save-only 推送" button for a K3 target and the operator
// only found out at the 403.
//
// Why a mirror and not a fetch. The decision it drives is "do not render a button", which has to be
// right before any network round-trip resolves — and there is no read endpoint that answers "is this
// kind fenced" ahead of a run. The drift risk that buys is closed by a test, not by hope:
// tests/integrationErrorCodeLabels.spec.ts requires the server fence module and fails RED if
// K3_EXTERNAL_WRITE_TARGET_KINDS here and there ever differ.
//
// DIRECTION OF EFFECT. Everything here can only ever HIDE a write affordance or add a read-only
// sentence. A kind absent from the list changes nothing (the pre-existing UI is what renders), and
// nothing in this module can enable, unlock or widen a write — the fence, and only the fence, decides
// what the server does.

/** The K3 WebAPI transport. Same literal as the server fence's K3_EXTERNAL_WRITE_TARGET_KIND. */
export const K3_EXTERNAL_WRITE_TARGET_KIND = 'erp:k3-wise-webapi'

/**
 * The SIBLING K3 transport (direct SQL Server). A disjoint transport into the SAME customer K3, and a
 * subject of the same ban since the 20260901 parity pass — the UI must not treat it as a normal
 * writable target just because it is not the WebAPI kind.
 */
export const K3_EXTERNAL_WRITE_SQLSERVER_TARGET_KIND = 'erp:k3-wise-sqlserver'

/** The closed subject set, in the server module's own order. */
export const K3_EXTERNAL_WRITE_TARGET_KINDS: readonly string[] = Object.freeze([
  K3_EXTERNAL_WRITE_TARGET_KIND,
  K3_EXTERNAL_WRITE_SQLSERVER_TARGET_KIND,
])

/**
 * EXACT-MATCH ONLY, deliberately: no prefix test, no `startsWith('erp:k3')`, no regex. A prefix match
 * would silently take in a future K3-adjacent kind the server has NOT banned and hide a write button
 * that should render — the mirror would then be making a policy decision of its own, which is the one
 * thing it must never do. A non-string (or an unselected target) is not fenced.
 */
export function isK3ExternalWriteTargetKind(kind: string | null | undefined): boolean {
  if (typeof kind !== 'string') return false
  return K3_EXTERNAL_WRITE_TARGET_KINDS.includes(kind)
}

/**
 * The one-line posture badge. Byte-identical to K3_FENCE_NOTICE in
 * plugins/plugin-integration-core/lib/integration-hub-overview.cjs, which is what the 对接总览 panel on
 * the same screen already renders for these kinds — the run panel must not invent a second phrasing for
 * the same fact. tests/integrationErrorCodeLabels.spec.ts requires that server constant and asserts the
 * two are equal, so "byte-identical" is a checked property rather than a comment.
 */
export const K3_WRITE_FENCE_NOTICE = Object.freeze({
  zh: '只读·永不写入',
  en: 'Read-only · never writes',
})

/**
 * The sentence that REPLACES the Save-only control when the selected target is fenced. It states the
 * posture and then the remedy that actually exists, because "you cannot do this" without "do this
 * instead" is what sends operators looking for a switch that was never built.
 */
export const K3_WRITE_FENCE_EXPLANATION = Object.freeze({
  zh: 'K3 目标永久只读（只读·永不写入），不提供 Save-only 推送。dry-run 预览后请导出清洗结果，或把它写入多维表。',
  en: 'K3 targets are permanently read-only (read-only · never writes) and offer no Save-only push. Preview with dry-run, then export the cleansed result or write it into a Metasheet table.',
})
