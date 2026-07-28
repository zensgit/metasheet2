/**
 * Approval Canvas V2 rollout gate. The authoring UI is additive and must remain dormant unless an
 * operator explicitly enables it; admin role, product mode, and plugin state never infer access.
 */
export function isApprovalCanvasV2Enabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return String(env.APPROVAL_CANVAS_V2_ENABLED ?? '').trim().toLowerCase() === 'true'
}
