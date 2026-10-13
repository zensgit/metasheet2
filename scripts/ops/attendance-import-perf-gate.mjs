import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { acceptanceConfiguration, collectAcceptanceProvenance, verifyAcceptanceTokenTenant } from './attendance-acceptance-preflight.mjs'

export function isPerfGateError(error) {
  return /^ACCEPTANCE_[A-Z_]+$/.test(error?.message ?? '')
}

export function createPerfGate(env = process.env) {
  const bound = ['AUTH_EXPECTED_TENANT_ID', 'ATTENDANCE_SYNTHETIC_ORG_ID', 'ATTENDANCE_EXPECTED_DEPLOY_SHA']
    .some(key => env[key] !== undefined)
  let checkoutSha
  if (bound) {
    acceptanceConfiguration(env)
    try {
      checkoutSha = execFileSync('git', ['-C', fileURLToPath(new URL('../../', import.meta.url)), 'rev-parse', 'HEAD'], {
        encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], env: { PATH: process.env.PATH },
      }).trim()
    } catch {
      throw new Error('ACCEPTANCE_CHECKOUT_SHA_INVALID')
    }
  }
  return {
    bound,
    async verify(token) {
      if (!bound) return undefined
      await verifyAcceptanceTokenTenant(env.API_BASE, token, { env })
      return collectAcceptanceProvenance(env, checkoutSha)
    },
  }
}
