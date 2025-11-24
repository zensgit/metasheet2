#!/usr/bin/env node
/**
 * Staging JWT token generator
 * - Reads JWT_SECRET from env
 * - Supports roles/perms via env: STAGING_ROLES (comma), STAGING_PERMS (comma)
 * - Supports user id via env: USER_ID (default: staging-tester)
 * - Output: token only (stdout)
 */
import crypto from 'crypto'

function base64url(input) {
  return Buffer.from(input)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '')
}

function signJWT(payload, secret, expiresInSec = 7200) {
  const header = { alg: 'HS256', typ: 'JWT' }
  const now = Math.floor(Date.now() / 1000)
  const full = { ...payload, iat: now, exp: now + expiresInSec }
  const h = base64url(JSON.stringify(header))
  const p = base64url(JSON.stringify(full))
  const data = `${h}.${p}`
  const sig = crypto.createHmac('sha256', secret).update(data).digest('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')
  return `${data}.${sig}`
}

try {
  const secret = process.env.JWT_SECRET
  if (!secret) {
    console.error('JWT_SECRET env is required')
    process.exit(2)
  }
  const user = process.env.USER_ID || 'staging-tester'
  const roles = (process.env.STAGING_ROLES || '').split(',').map(s => s.trim()).filter(Boolean)
  const perms = (process.env.STAGING_PERMS || '').split(',').map(s => s.trim()).filter(Boolean)
  const exp = parseInt(process.env.TOKEN_TTL_SEC || '7200', 10)

  const payload = { id: user, roles, perms }
  const token = signJWT(payload, secret, exp)
  console.log(token)
} catch (e) {
  console.error('Failed to generate staging token:', e.message)
  process.exit(1)
}

