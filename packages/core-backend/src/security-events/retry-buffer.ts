import { validateEvent, type EventCandidate, type ScopeAuthority } from './validation'

/** Only transient W3 facts. W2 recovery uses its durable source in E1-B, never this buffer. */
export class EventRetryBuffer {
  private readonly entries: { input: EventCandidate; authority: ScopeAuthority; expires: number }[] = []
  constructor(private readonly now: () => number = () => performance.now()) {}
  get size() { this.expire(); return this.entries.length }
  private expire() {
    const now = this.now()
    while (this.entries.length && this.entries[0].expires <= now) this.entries.shift()
  }
  offer(input: EventCandidate, authority: ScopeAuthority): { retained: boolean; count_unknown: boolean } {
    try {
      validateEvent(input, authority)
      this.expire()
      if (this.entries.length >= 1000) return { retained: false, count_unknown: true }
      this.entries.push({ input: structuredClone(input), authority: { ...authority }, expires: this.now() + 60000 })
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
