"use strict";
// plugin-sandbox.ts
// Optional sandbox wrapper for plugin execution (flag gated)
Object.defineProperty(exports, "__esModule", { value: true });
exports.NoopSandbox = void 0;
exports.createSandbox = createSandbox;
class NoopSandbox {
    wrap(plugin) { return plugin; }
}
exports.NoopSandbox = NoopSandbox;
function createSandbox() {
    const enabled = process.env.PLUGIN_SANDBOX_ENABLED === 'true';
    if (!enabled)
        return new NoopSandbox();
    // Placeholder: real isolation strategy (vm, worker, etc.)
    return new NoopSandbox();
}
//# sourceMappingURL=plugin-sandbox.js.map