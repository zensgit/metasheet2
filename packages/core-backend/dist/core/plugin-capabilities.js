"use strict";
// plugin-capabilities.ts
// Central registry for declared capabilities (in-memory)
Object.defineProperty(exports, "__esModule", { value: true });
exports.capabilityMatrix = exports.CapabilityMatrix = void 0;
class CapabilityMatrix {
    caps = new Set();
    add(key) { this.caps.add(key); }
    has(key) { return this.caps.has(key); }
    list() { return Array.from(this.caps).sort(); }
}
exports.CapabilityMatrix = CapabilityMatrix;
exports.capabilityMatrix = new CapabilityMatrix();
//# sourceMappingURL=plugin-capabilities.js.map