/**
 * W4C-3b R0 — must load before ApprovalProductService / ApprovalBridgeService.
 * Product services construct the global pool from DATABASE_URL at import time.
 * When only ATTENDANCE_TEST_DATABASE_URL is set (full-schema gate), mirror it.
 */
const scratch = process.env.ATTENDANCE_TEST_DATABASE_URL
if (typeof scratch === 'string' && scratch.trim().length > 0) {
  process.env.DATABASE_URL = scratch.trim()
}
