/**
 * Approval Canvas V2 rollout gate.
 *
 * ROLLOUT POSTURE CHANGED 2026-08-24 (owner decision, recorded in the parity execution ledger's
 * flag row): the canvas is now the DEFAULT authoring surface, per the owner's 「默认就画布」 ruling
 * after reviewing it live on the local testbed. The structured list survives as the retained
 * accessible alternative (辅助编辑模式) reachable from the in-page view toggle, so this flip changes
 * which surface opens first — it removes no authoring path.
 *
 * The escape hatch is explicit and follows the repo's established default-on convention
 * (`!== 'false'`, as in ENABLE_PATTERN_TRIE / SAFETY_GUARD_ENABLED / DB_SSL_REJECT_UNAUTHORIZED):
 * set `APPROVAL_CANVAS_V2_ENABLED=false` to force the legacy structured editor. Admin role, product
 * mode, and plugin state still never infer access — the value is read from env and nowhere else.
 */
export function isApprovalCanvasV2Enabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return String(env.APPROVAL_CANVAS_V2_ENABLED ?? '').trim().toLowerCase() !== 'false'
}
