// plugin-capabilities.ts
// Central registry for declared capabilities (in-memory)

export class CapabilityMatrix {
  private caps = new Set<string>()
  add(key: string) { this.caps.add(key) }
  has(key: string) { return this.caps.has(key) }
  list() { return Array.from(this.caps).sort() }
}

export const capabilityMatrix = new CapabilityMatrix()

