// plugin-sandbox.ts
// Optional sandbox wrapper for plugin execution (flag gated)
export class NoopSandbox {
    wrap(plugin) { return plugin; }
}
export function createSandbox() {
    const enabled = process.env.PLUGIN_SANDBOX_ENABLED === 'true';
    if (!enabled)
        return new NoopSandbox();
    // Placeholder: real isolation strategy (vm, worker, etc.)
    return new NoopSandbox();
}
//# sourceMappingURL=plugin-sandbox.js.map