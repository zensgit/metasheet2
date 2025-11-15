// plugin-sandbox.ts
// Optional sandbox wrapper for plugin execution (flag gated)

export interface SandboxAdapter {
  wrap<T extends object>(plugin: T, manifestId: string): T
}

export class NoopSandbox implements SandboxAdapter {
  wrap<T extends object>(plugin: T): T { return plugin }
}

export function createSandbox(): SandboxAdapter {
  const enabled = process.env.PLUGIN_SANDBOX_ENABLED === 'true'
  if (!enabled) return new NoopSandbox()
  // Placeholder: real isolation strategy (vm, worker, etc.)
  return new NoopSandbox()
}

