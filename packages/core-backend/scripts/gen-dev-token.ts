#!/usr/bin/env tsx
/**
 * Dev JWT token generator
 * Usage:
 *   npx tsx packages/core-backend/scripts/gen-dev-token.ts --user dev-user \
 *     --roles admin,editor --perms views:read,permissions:read --expiresIn 1d
 */
import jwt from 'jsonwebtoken'
import { getConfig } from '../src/config'

function parseArgs(argv: string[]) {
  const out: any = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--')) continue
    const key = a.slice(2)
    const val = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : 'true'
    out[key] = val
  }
  return out
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const user = String(args.user || args.u || 'dev-user')
  const roles = String(args.roles || args.r || '').split(',').filter(Boolean)
  const perms = String(args.perms || args.p || '').split(',').filter(Boolean)
  const expiresIn = args.expiresIn || args.exp || '1d'
  let secret = 'dev-secret-key'
  try {
    const cfg = getConfig() as any
    if (cfg && cfg.jwt && typeof cfg.jwt.secret === 'string') secret = cfg.jwt.secret
  } catch {}
  if (process.env.JWT_SECRET) secret = process.env.JWT_SECRET
  const payload: any = { id: user }
  if (roles.length) payload.roles = roles
  if (perms.length) payload.perms = perms
  const token = jwt.sign(payload, secret, { algorithm: 'HS256', expiresIn })
  const out = { ok: true, token, payload }
  console.log(JSON.stringify(out, null, 2))
}

main().catch((e) => { console.error(e); process.exit(1) })
