import { createHash, createPrivateKey, createPublicKey } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import jwt from 'jsonwebtoken'

export class WeldingError extends Error {
  constructor(public readonly code: 'WELDING_UNAVAILABLE' | 'WELDING_SESSION_REQUIRED' | 'WELDING_INVALID_REQUEST' | 'WELDING_UPSTREAM_REJECTED' | 'WELDING_RESULT_UNKNOWN', public readonly status: number) {
    super(code)
  }
}

export interface WeldingProvider {
  metasheetTenantId: string
  origin: string
  provider: string
  tenantId: string
  orgId: string
  issuer: string
  clientId: string
  kid: string
  privateKeyFile: string
}

export function weldingEnabled(): boolean {
  return process.env.WELDING_READ_ENABLED === 'true'
}

export function weldingAvailable(): void {
  if (!weldingEnabled() || ['true', '1'].includes(process.env.RBAC_TOKEN_TRUST || '') || ['true', '1'].includes(process.env.RBAC_BYPASS || '') || process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0') {
    throw new WeldingError('WELDING_UNAVAILABLE', 503)
  }
}

export function weldingWriteAvailable(): void {
  weldingAvailable()
  if (process.env.WELDING_WRITE_ENABLED !== 'true') throw new WeldingError('WELDING_UNAVAILABLE', 503)
}

export function readWeldingProvider(): WeldingProvider {
  weldingAvailable()
  const value = (name: string, max = 255): string => {
    const result = process.env[name]
    if (!result || result.length > max || result.trim() !== result || /[\x00-\x1f\x7f]/.test(result)) throw new WeldingError('WELDING_UNAVAILABLE', 503)
    return result
  }
  try {
    const origin = new URL(value('WELDING_YUANTUS_ORIGIN', 2048))
    if (origin.protocol !== 'https:' || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) throw new Error()
    const config = {
      metasheetTenantId: value('WELDING_METASHEET_TENANT_ID'),
      origin: origin.origin,
      provider: value('WELDING_YUANTUS_PROVIDER', 100),
      tenantId: value('WELDING_YUANTUS_TENANT_ID'),
      orgId: value('WELDING_YUANTUS_ORG_ID'),
      issuer: value('WELDING_SSO_ISSUER', 2048),
      clientId: value('WELDING_SSO_CLIENT_ID'),
      kid: value('WELDING_SSO_KID'),
      privateKeyFile: value('WELDING_SSO_PRIVATE_KEY_FILE', 4096),
    }
    if (!isAbsolute(config.privateKeyFile)) throw new Error()
    return config
  } catch {
    throw new WeldingError('WELDING_UNAVAILABLE', 503)
  }
}

async function signingKey(config: WeldingProvider) {
  try {
    const info = await stat(config.privateKeyFile)
    if (!info.isFile() || info.size > 32768) throw new Error()
    const key = createPrivateKey(await readFile(config.privateKeyFile))
    if (key.asymmetricKeyType !== 'rsa' || (key.asymmetricKeyDetails?.modulusLength || 0) < 2048) throw new Error()
    return key
  } catch {
    throw new WeldingError('WELDING_UNAVAILABLE', 503)
  }
}

// v1: UTF-8 JSON.stringify of the ordered [verified tenant ID, native user ID] pair.
export function weldingSubject(tenantId: string, userId: string): string {
  return `ms2:v1:${createHash('sha256').update(JSON.stringify([tenantId, userId]), 'utf8').digest('hex')}`
}

export async function weldingJwks(config: WeldingProvider) {
  const key = createPublicKey(await signingKey(config)).export({ format: 'jwk' })
  return { keys: [{ kty: 'RSA', n: key.n!, e: key.e!, use: 'sig', alg: 'RS256', kid: config.kid }] }
}

export async function signWeldingAssertion(config: WeldingProvider, session: { userId: string; tenantId: string; exp: number }, nonce: string): Promise<string> {
  const key = await signingKey(config)
  const iat = Math.floor(Date.now() / 1000)
  const exp = Math.min(iat + 60, session.exp)
  if (exp <= iat) throw new WeldingError('WELDING_SESSION_REQUIRED', 401)
  return jwt.sign({ sub: weldingSubject(session.tenantId, session.userId), nonce, iat, exp }, key, {
    algorithm: 'RS256', keyid: config.kid, issuer: config.issuer, audience: config.clientId,
  })
}
