import { describe, expect, it } from 'vitest'
import { MetaSheetServer } from '../../src/index'
import type { PluginContext, SecurityService } from '../../src/types/plugin'

function installLoadedPlugin(server: MetaSheetServer, name: string, plugin: Record<string, unknown>) {
  const loader = (server as unknown as { pluginLoader: { loadedPlugins: Map<string, unknown> } }).pluginLoader
  loader.loadedPlugins.set(name, {
    manifest: {
      name,
      version: '1.0.0',
      displayName: name,
      description: `${name} test plugin`,
    },
    plugin,
    path: `/tmp/${name}`,
    loadedAt: new Date(),
  })
}

describe('MetaSheetServer plugin runtime security service', () => {
  it('injects services.security through the real activation path', async () => {
    const server = new MetaSheetServer({ port: 0, host: '127.0.0.1', pluginDirs: [] })
    const pluginName = 'plugin-runtime-security-probe'
    let capturedSecurity: SecurityService | undefined
    let encryptedSecret = ''
    let decryptedSecret = ''
    let digest = ''
    let verified = false

    installLoadedPlugin(server, pluginName, {
      async activate(context: PluginContext) {
        capturedSecurity = context.services.security
        encryptedSecret = await context.services.security.encrypt('integration-secret')
        decryptedSecret = await context.services.security.decrypt(encryptedSecret)
        digest = await context.services.security.hash('payload')
        verified = await context.services.security.verify?.('payload', digest) ?? false
      },
    })

    await (server as unknown as { activatePluginByName(name: string): Promise<unknown> }).activatePluginByName(pluginName)

    expect(capturedSecurity).toBeDefined()
    expect(encryptedSecret).toMatch(/^enc:/)
    expect(decryptedSecret).toBe('integration-secret')
    expect(digest).toMatch(/^[a-f0-9]{64}$/)
    expect(verified).toBe(true)
  })

  it('uses platform enc format and rejects unsupported per-call keys', async () => {
    const server = new MetaSheetServer({ port: 0, host: '127.0.0.1', pluginDirs: [] })
    let security: SecurityService | undefined

    installLoadedPlugin(server, 'plugin-runtime-security-key-probe', {
      async activate(context: PluginContext) {
        security = context.services.security
      },
    })
    await (server as unknown as { activatePluginByName(name: string): Promise<unknown> }).activatePluginByName('plugin-runtime-security-key-probe')

    expect(security).toBeDefined()
    const encrypted = await security!.encrypt('stable-secret')
    const tampered = `${encrypted.slice(0, -1)}${encrypted.endsWith('a') ? 'b' : 'a'}`

    await expect(security!.decrypt(encrypted)).resolves.toBe('stable-secret')
    await expect(security!.decrypt('plain-value')).resolves.toBe('plain-value')
    await expect(security!.decrypt(tampered)).rejects.toThrow()
    await expect(security!.encrypt('stable-secret', 'custom-key')).rejects.toThrow(/per-call encryption keys/)
  })

  it('provides threat scanning, audit, rate-limit, and explicit sandbox rejection', async () => {
    const server = new MetaSheetServer({ port: 0, host: '127.0.0.1', pluginDirs: [] })
    const pluginName = 'plugin-runtime-security-scan-probe'
    let security: SecurityService | undefined

    installLoadedPlugin(server, pluginName, {
      async activate(context: PluginContext) {
        security = context.services.security
      },
    })
    await (server as unknown as { activatePluginByName(name: string): Promise<unknown> }).activatePluginByName(pluginName)

    const scan = await security!.scanForThreats(pluginName, 'const fs = require("fs"); process.exit(1)')
    expect(scan.safe).toBe(false)
    expect(scan.threats.map(threat => threat.type)).toEqual(
      expect.arrayContaining(['module_access', 'system_access']),
    )

    const auditEvents = await security!.getAuditLog?.({ pluginName, event: 'threat_scan' })
    expect(auditEvents?.length).toBeGreaterThanOrEqual(1)

    const firstAttempt = await security!.rateLimit?.(`${pluginName}:api`, 1, 60_000)
    const secondAttempt = await security!.rateLimit?.(`${pluginName}:api`, 1, 60_000)
    expect(firstAttempt?.allowed).toBe(true)
    expect(secondAttempt?.allowed).toBe(false)

    const sandbox = security!.createSandbox(pluginName, ['api.allowed'])
    expect(await security!.validateAPIAccess?.(pluginName, 'api.allowed.read', 'GET')).toBe(true)
    expect(await security!.validateAPIAccess?.(pluginName, 'api.blocked.read', 'GET')).toBe(false)
    await expect(sandbox.execute('1 + 1')).rejects.toThrow(/sandbox execution is not available/)
    sandbox.destroy?.()
    expect(security!.getSandbox?.(pluginName)).toBeNull()
  })
})
