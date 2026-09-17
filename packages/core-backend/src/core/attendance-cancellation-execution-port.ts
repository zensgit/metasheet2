/**
 * Lock §3 C-1 (`approval-change-request-design-lock-draft-20260915.md:81-95`) — the PORT through
 * which the approval side reaches 完整业务取消, and nothing else.
 *
 * Direction and precedent. This is the same hexagonal shape as `workday-calendar-port.ts` (T3-2):
 * a single-provider, process-wide registry that lets the approval path call into the attendance
 * domain WITHOUT a compile-time dependency on the plugin and without ever reading `attendance_*`
 * itself. The plugin constructs its request-operation boundary once at activate
 * (`plugins/plugin-attendance/index.cjs`, `w4RequestOperationBoundary = …`) and binds THAT object
 * here.
 *
 * What is bound is deliberately the WHOLE `AttendanceRequestOperationBoundaryV1`, not a bespoke
 * `cancelForApproval(...)`. Lock §3 C-1 「接口形态」 and the v5 review's P1-A both forbid lifting
 * `requestCancelAdapter.execute` out on its own: 「**外部事务入口复用同一套 W4 操作协议** …
 * **仅移交连接与事务生命周期的所有权**——不是把 `requestCancelAdapter.execute` 搬出来单独调」.
 * A narrower port would re-introduce exactly what that clause rejects, so the port type is the
 * boundary interface itself and the approval side calls its `executeInExternalTransaction`.
 *
 * ⚠️ FAIL CLOSED when unbound — the one place this deliberately DIFFERS from the workday-calendar
 * precedent, which fails OPEN to natural elapsed arithmetic. An SLA deadline computed without a
 * calendar is merely less precise; a cancel round redeemed without a provider would write
 * `approval_rounds.outcome = 'applied'` and let its engine instance reach `approved` with **zero
 * business cancellation performed** — a round that claims the leave was cancelled when it was not.
 * `getAttendanceCancellationExecutionPort()` therefore returns `undefined` and the redemption
 * branch throws, which rolls the caller's transaction back and leaves the round `pending` with its
 * seats: lock §3 C-3 row 5 (基础设施异常 ⇒ 事务回滚 ⇒ 保持 `pending` ⇒ 继续占位), the same shape
 * `CANCEL_ROUND_WINDOW_ANCHOR_MISSING` already takes.
 */

import type { AttendanceRequestOperationBoundaryV1 } from '../attendance/w4c3b-request-operation-boundary'

/**
 * The port. Structurally the request-operation boundary; the approval side uses only
 * `executeInExternalTransaction`, but the type is not narrowed (see the module note — narrowing is
 * what lock §3 C-1 forbids, and a `Pick<>` here would invite a second, smaller contract later).
 */
export type AttendanceCancellationExecutionPort = AttendanceRequestOperationBoundaryV1

/**
 * Single-provider registry, mirroring `WorkdayCalendarRegistryImpl`. Exactly one attendance
 * request-operation boundary exists process-wide (the plugin builds one at activate), so binding a
 * second replaces the first and is logged.
 */
class AttendanceCancellationExecutionRegistryImpl {
  private provider: AttendanceCancellationExecutionPort | undefined
  private static instance: AttendanceCancellationExecutionRegistryImpl

  private constructor() {}

  static getInstance(): AttendanceCancellationExecutionRegistryImpl {
    if (!AttendanceCancellationExecutionRegistryImpl.instance) {
      AttendanceCancellationExecutionRegistryImpl.instance = new AttendanceCancellationExecutionRegistryImpl()
    }
    return AttendanceCancellationExecutionRegistryImpl.instance
  }

  register(provider: AttendanceCancellationExecutionPort): void {
    if (this.provider) {
      console.warn('AttendanceCancellationExecutionPort provider is being replaced')
    }
    this.provider = provider
  }

  unregister(): void {
    this.provider = undefined
  }

  get(): AttendanceCancellationExecutionPort | undefined {
    return this.provider
  }

  has(): boolean {
    return this.provider !== undefined
  }

  /** Clear the bound provider (test isolation). */
  clear(): void {
    this.provider = undefined
  }
}

export function getAttendanceCancellationExecutionRegistry(): AttendanceCancellationExecutionRegistryImpl {
  return AttendanceCancellationExecutionRegistryImpl.getInstance()
}

/** Bind the process-wide provider (the attendance plugin, once, at activate). */
export function registerAttendanceCancellationExecutionProvider(
  provider: AttendanceCancellationExecutionPort,
): void {
  getAttendanceCancellationExecutionRegistry().register(provider)
}

/** Unbind (plugin deactivate / test teardown). */
export function unregisterAttendanceCancellationExecutionProvider(): void {
  getAttendanceCancellationExecutionRegistry().unregister()
}

/**
 * Read the bound provider. `undefined` when no attendance plugin has registered one — the
 * redemption branch MUST treat that as 基础设施异常 and throw, never as 「nothing to cancel」.
 */
export function getAttendanceCancellationExecutionPort(): AttendanceCancellationExecutionPort | undefined {
  return getAttendanceCancellationExecutionRegistry().get()
}

export { AttendanceCancellationExecutionRegistryImpl }
