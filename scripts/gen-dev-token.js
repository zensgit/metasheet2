#!/usr/bin/env node
/**
 * JWT token generator for CI environments
 * Standalone version - no dependencies on TypeScript or external packages
 */
import crypto from 'crypto'

// Simple JWT implementation
function base64url(input) {
  return Buffer.from(input)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '')
}

function generateJWT(payload, secret, expiresIn = '2h') {
  const header = {
    alg: 'HS256',
    typ: 'JWT'
  }

  // Calculate expiration time
  const now = Math.floor(Date.now() / 1000)
  let exp = now + 7200 // default 2 hours

  if (typeof expiresIn === 'string') {
    const match = expiresIn.match(/^(\d+)([smhd])$/)
    if (match) {
      const value = parseInt(match[1])
      const unit = match[2]
      const multipliers = { s: 1, m: 60, h: 3600, d: 86400 }
      exp = now + value * multipliers[unit]
    }
  }

  const fullPayload = {
    ...payload,
    iat: now,
    exp
  }

  const encodedHeader = base64url(JSON.stringify(header))
  const encodedPayload = base64url(JSON.stringify(fullPayload))
  const dataToSign = `${encodedHeader}.${encodedPayload}`

  const signature = crypto
    .createHmac('sha256', secret)
    .update(dataToSign)
    .digest('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '')

  return `${dataToSign}.${signature}`
}

// Main
try {
  // Get secret from environment or use default
  const secret = process.env.JWT_SECRET || 'dev-secret-key'

  // Create default payload with admin role for CI/E2E tests
  const payload = {
    id: process.env.USER_ID || 'dev-user',
    roles: ['admin'],
    perms: ['permissions:read', 'permissions:write', 'approvals:read', 'approvals:write']
  }

  // Generate token
  const token = generateJWT(payload, secret, '2h')

  // Output just the token (CI compatibility)
  console.log(token)
} catch (error) {
  console.error('Error generating token:', error.message)
  process.exit(1)
}
