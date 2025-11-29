#!/usr/bin/env node

/**
 * Secure Secret Generator for MetaSheet v2
 *
 * Generates cryptographically secure secrets for production deployment
 * Usage: node scripts/generate-secret.js [type] [length]
 *
 * Types:
 *   jwt    - JWT secret (default: 64 bytes)
 *   api    - API key (default: 32 bytes)
 *   db     - Database password (default: 24 chars, alphanumeric)
 */

const crypto = require('crypto')

function generateSecret(type = 'jwt', length = null) {
  switch (type) {
    case 'jwt':
      const jwtLength = length || 64
      return crypto.randomBytes(jwtLength).toString('base64').replace(/[/+=]/g, '')

    case 'api':
      const apiLength = length || 32
      return crypto.randomBytes(apiLength).toString('hex')

    case 'db':
      const dbLength = length || 24
      const chars = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789'
      let result = ''
      for (let i = 0; i < dbLength; i++) {
        result += chars.charAt(Math.floor(Math.random() * chars.length))
      }
      return result

    default:
      const defaultLength = length || 32
      return crypto.randomBytes(defaultLength).toString('hex')
  }
}

// Parse command line arguments
const args = process.argv.slice(2)
const type = args[0] || 'jwt'
const length = args[1] ? parseInt(args[1]) : null

// Generate and display secret
const secret = generateSecret(type, length)

console.log(`\n🔐 Generated ${type.toUpperCase()} Secret:`)
console.log(`${secret}\n`)

if (type === 'jwt') {
  console.log('📋 Add to your .env file:')
  console.log(`JWT_SECRET=${secret}`)
  console.log('\n💡 Also consider setting:')
  console.log('JWT_EXPIRY=1h                    # Shorter expiry for production')
  console.log('BCRYPT_SALT_ROUNDS=12            # Higher rounds for production')
} else if (type === 'api') {
  console.log('📋 Add to your .env file:')
  console.log(`VALID_API_KEYS=${secret}`)
  console.log('\n💡 For multiple API keys, separate with commas:')
  console.log(`VALID_API_KEYS=${secret},${generateSecret('api')}`)
} else if (type === 'db') {
  console.log('📋 Use for database password:')
  console.log(`DATABASE_URL=postgresql://user:${secret}@localhost:5432/metasheet`)
}

console.log('\n⚠️  Keep this secret secure and never commit to version control!\n')