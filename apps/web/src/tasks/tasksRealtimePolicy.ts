/**
 * Auto-connect policy for the tasks badge's realtime subscription (M4 design §8.2, `[fe-11]`).
 *
 * One export, in a module of its own, so a spec can replace it with `vi.mock`. The production
 * value is `import.meta.env.MODE !== 'test'`: every build except the test build connects. The
 * split exists for one reason: under vitest `MODE` is `'test'`, so a guard written inline in the
 * mount hook never connects, and a cell asserting "feature off => no socket" would be green on
 * BOTH sides of the gate (zero `io()` calls either way) and prove nothing. With this predicate
 * forced to `true` in the spec, the positive control ("feature on => exactly one `io()` call") is
 * a real call, and the negative controls mean what they say.
 *
 * Keep it a function (not a constant): a constant is inlined at module evaluation and a spec can
 * no longer flip it per case.
 */
export function shouldAutoConnectRealtime(): boolean {
  return import.meta.env.MODE !== 'test'
}
