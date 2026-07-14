#!/usr/bin/env node
// attendance-window-runner-mint-token.mjs
//
// In-container helper for the attendance staging window-runner workflow
// (.github/workflows/attendance-staging-window-runner.yml). Runs INSIDE the
// staging backend container (docker exec), where JWT_SECRET and DATABASE_URL
// are the staging realm's own values, so no secret ever leaves the host.
//
// Modes:
//   --find-admin
//       Prints the id of an existing ACTIVE users row with role='admin'
//       (preferring id='admin'), or exits 3 if none exists. Read-only.
//       Staging runs NODE_ENV=production, so verifyToken() loads the user from
//       the DB and uses the DB role — a token is only useful when its subject
//       is a real active DB user (see packages/core-backend/src/auth/AuthService.ts).
//   --mint --user-id <id> [--roles a,b] [--perms p,q] [--expires-in 7200]
//       Prints an HS256 JWT signed with the container's JWT_SECRET (staging
//       realm). Zero-dependency signing (node:crypto), same shape as
//       scripts/gen-dev-token.js. No `sid` claim is included on purpose: the
//       session-registry check in verifyToken() only runs when `sid` is present.
//
// Prints ONLY the value (user id / token) on stdout so callers can capture it.

import crypto from 'node:crypto'

function base64url(input) {
  return Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')
}

function parseArgs(argv) {
  const opts = { mode: '', userId: '', roles: 'user', perms: '', expiresInSeconds: 7200 }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--find-admin') opts.mode = 'find-admin'
    else if (arg === '--mint') opts.mode = 'mint'
    else if (arg === '--user-id') opts.userId = argv[++i] || ''
    else if (arg === '--roles') opts.roles = argv[++i] || ''
    else if (arg === '--perms') opts.perms = argv[++i] || ''
    else if (arg === '--expires-in') opts.expiresInSeconds = Number.parseInt(argv[++i] || '7200', 10)
    else {
      console.error(`unknown argument: ${arg}`)
      process.exit(2)
    }
  }
  return opts
}

async function findAdmin() {
  let pg
  try {
    pg = await import('pg')
  } catch {
    console.error('FAIL: package "pg" must be resolvable (run from a directory with node_modules linked, e.g. /tmp/window-runner).')
    process.exit(2)
  }
  const databaseUrl = process.env.DATABASE_URL || ''
  if (!databaseUrl) {
    console.error('FAIL: DATABASE_URL is required (run inside the staging backend container).')
    process.exit(2)
  }
  const pool = new pg.default.Pool({ connectionString: databaseUrl })
  try {
    const result = await pool.query(
      `SELECT id FROM users
       WHERE role = 'admin' AND (is_active IS DISTINCT FROM false)
       ORDER BY (id = 'admin') DESC, created_at ASC NULLS LAST
       LIMIT 1`,
    )
    if (result.rows.length === 0) {
      console.error('FAIL: no active role=admin user exists in the staging database; the auth round-trip needs a real staging admin subject.')
      process.exit(3)
    }
    console.log(String(result.rows[0].id))
  } finally {
    await pool.end()
  }
}

function mint(opts) {
  const secret = process.env.JWT_SECRET || ''
  if (!secret) {
    console.error('FAIL: JWT_SECRET is not set in this environment; refusing to mint with a fallback secret.')
    process.exit(2)
  }
  if (!opts.userId) {
    console.error('FAIL: --user-id is required for --mint.')
    process.exit(2)
  }
  if (!Number.isFinite(opts.expiresInSeconds) || opts.expiresInSeconds <= 0 || opts.expiresInSeconds > 24 * 3600) {
    console.error('FAIL: --expires-in must be a positive number of seconds (max 86400).')
    process.exit(2)
  }
  const now = Math.floor(Date.now() / 1000)
  const header = { alg: 'HS256', typ: 'JWT' }
  const payload = {
    id: opts.userId,
    roles: opts.roles.split(',').map((v) => v.trim()).filter(Boolean),
    perms: opts.perms.split(',').map((v) => v.trim()).filter(Boolean),
    iat: now,
    exp: now + opts.expiresInSeconds,
  }
  const data = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`
  const signature = crypto
    .createHmac('sha256', secret)
    .update(data)
    .digest('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '')
  console.log(`${data}.${signature}`)
}

const opts = parseArgs(process.argv.slice(2))
if (opts.mode === 'find-admin') {
  await findAdmin()
} else if (opts.mode === 'mint') {
  mint(opts)
} else {
  console.error('usage: attendance-window-runner-mint-token.mjs --find-admin | --mint --user-id <id> [--roles a,b] [--perms p,q] [--expires-in <seconds>]')
  process.exit(2)
}
