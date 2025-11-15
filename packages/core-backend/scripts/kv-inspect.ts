#!/usr/bin/env tsx
/**
 * Admin KV inspect CLI
 *
 * Usage:
 *  API_ORIGIN=http://localhost:8900 JWT_TOKEN=... tsx scripts/kv-inspect.ts list --plugin @metasheet/plugin-test-a
 *  API_ORIGIN=http://localhost:8900 JWT_TOKEN=... tsx scripts/kv-inspect.ts get --plugin @metasheet/plugin-test-a --key lastPing
 *
 * Env vars:
 *  - API_ORIGIN: server origin (default http://localhost:8900)
 *  - JWT_TOKEN: Bearer token for admin endpoints
 */

type Args = { command: 'list' | 'get'; plugin: string; key?: string; origin: string; token?: string }

function parseArgs(argv: string[]): Args {
  const origin = process.env.API_ORIGIN || 'http://localhost:8900'
  const token = process.env.JWT_TOKEN
  const [command, ...rest] = argv.slice(2)
  if (!command || (command !== 'list' && command !== 'get')) {
    console.error('Usage: tsx scripts/kv-inspect.ts <list|get> --plugin <name> [--key <key>]')
    process.exit(2)
  }
  let plugin = ''
  let key: string | undefined
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]
    if (a === '--plugin') plugin = rest[++i]
    else if (a === '--key') key = rest[++i]
  }
  if (!plugin) {
    console.error('--plugin is required')
    process.exit(2)
  }
  if (command === 'get' && !key) {
    console.error('--key is required for get')
    process.exit(2)
  }
  return { command, plugin, key, origin, token }
}

async function httpGetJson(url: string, token?: string): Promise<any> {
  const headers: Record<string, string> = {}
  if (token) headers['authorization'] = `Bearer ${token}`
  const res = await fetch(url, { method: 'GET', headers })
  const text = await res.text()
  try { return JSON.parse(text) } catch { return { raw: text, status: res.status } }
}

async function main() {
  const args = parseArgs(process.argv)
  if (args.command === 'list') {
    const url = `${args.origin}/api/admin/plugin-kv?plugin=${encodeURIComponent(args.plugin)}`
    const out = await httpGetJson(url, args.token)
    console.log(JSON.stringify(out, null, 2))
    process.exit(out?.ok ? 0 : 1)
  }
  if (args.command === 'get') {
    const url = `${args.origin}/api/admin/plugin-kv/value?plugin=${encodeURIComponent(args.plugin)}&key=${encodeURIComponent(args.key!)}`
    const out = await httpGetJson(url, args.token)
    console.log(JSON.stringify(out, null, 2))
    process.exit(out?.ok ? 0 : 1)
  }
}

main().catch((e) => { console.error(e); process.exit(1) })

