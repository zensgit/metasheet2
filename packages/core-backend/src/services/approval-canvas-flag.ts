/**
 * Approval Canvas V2 is the default authoring surface. Operators can still force the structured
 * rollback surface for one release by setting the flag to `false`. Invalid non-empty values also
 * fail closed to that surface; only unset or the exact literal `true` selects Canvas.
 */
export function isApprovalCanvasV2Enabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env.APPROVAL_CANVAS_V2_ENABLED ?? ''
  return value === '' || value === 'true'
}
