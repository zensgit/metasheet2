import { validateEvent, type EventCandidate, type ScopeAuthority } from './validation'

/** Only transient W3 facts. W2 recovery uses its durable source in E1-B, never this buffer. */
export class EventRetryBuffer {
  private readonly entries: { input: EventCandidate; authority: ScopeAuthority; expires: number }[] = []
  constructor(private readonly now: () => number = () => performance.now()) {}
  get size() { this.expire(); return this.entries.length }
  private expire() {
    const now = this.now()
    // Initial writes can finish in a different order from their observation times.
    for (let index = this.entries.length - 1; index >= 0; index--) {
      if (this.entries[index].expires <= now) this.entries.splice(index, 1)
    }
  }
  offer(input: EventCandidate, authority: ScopeAuthority, startedAt = this.now()): { retained: boolean; count_unknown: boolean } {
    try {
      const now = this.now(), expires = startedAt + 60000
      if (!Number.isFinite(startedAt) || startedAt > now || expires <= now) return { retained: false, count_unknown: true }
      // Retain the validated snapshot, frozen, never the caller objects.
      const scope: ScopeAuthority = Object.freeze({ ...authority })
      const { scope_kind: _scope, org_id: _org, schema_version: _version, outcome: _outcome, severity: _severity, ...checked } = validateEvent(input, scope)
      this.expire()
      if (this.entries.length >= 1000) return { retained: false, count_unknown: true }
      this.entries.push({ input: Object.freeze({ ...checked, facts: Object.freeze({ ...checked.facts }) }), authority: scope, expires })
      return { retained: true, count_unknown: true }
    } catch { return { retained: false, count_unknown: true } }
  }
  /** Caller schedules explicitly. Remove before await: no second retry, even when persistence fails. */
  async retryOne(write: (input: EventCandidate, authority: ScopeAuthority) => Promise<{ recorded: boolean }>): Promise<{ attempted: boolean; count_unknown: boolean }> {
    this.expire()
    const entry = this.entries.shift()
    if (!entry) return { attempted: false, count_unknown: true }
    try { return { attempted: true, count_unknown: !(await write(entry.input, entry.authority)).recorded } }
    catch { return { attempted: true, count_unknown: true } }
  }
}
