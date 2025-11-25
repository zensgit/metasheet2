// plugin-capabilities.ts
// Central registry for declared capabilities (in-memory)
export class CapabilityMatrix {
    caps = new Set();
    add(key) { this.caps.add(key); }
    has(key) { return this.caps.has(key); }
    list() { return Array.from(this.caps).sort(); }
}
export const capabilityMatrix = new CapabilityMatrix();
//# sourceMappingURL=plugin-capabilities.js.map