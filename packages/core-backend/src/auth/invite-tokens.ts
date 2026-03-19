import jwt, { type SignOptions } from 'jsonwebtoken'
import { secretManager } from '../security/SecretManager'

const INVITE_TOKEN_FALLBACK_SECRET = 'fallback-invite-secret-change-in-production'

export interface InviteTokenPayload {
  type: 'invite'
  userId: string
  email: string
  presetId?: string | null
  iat?: number
  exp?: number
}

type DecodedInvitePayload = InviteTokenPayload & {
  exp?: number
}

function getInviteSecret(): string {
  return secretManager.get('INVITE_TOKEN_SECRET', {
    required: process.env.NODE_ENV === 'production',
    fallback: process.env.JWT_SECRET || INVITE_TOKEN_FALLBACK_SECRET,
  }) || process.env.JWT_SECRET || INVITE_TOKEN_FALLBACK_SECRET
}

export function issueInviteToken(options: {
  userId: string
  email: string
  presetId?: string | null
  expiresIn?: SignOptions['expiresIn']
}): string {
  const expiresIn = (options.expiresIn || process.env.INVITE_TOKEN_EXPIRY || '7d') as SignOptions['expiresIn']
  const payload: Omit<InviteTokenPayload, 'iat' | 'exp'> = {
    type: 'invite',
    userId: options.userId,
    email: options.email,
    presetId: options.presetId || null,
  }

  return jwt.sign(payload, getInviteSecret(), {
    algorithm: 'HS256',
    expiresIn,
  } as SignOptions)
}

export function verifyInviteToken(token: string): InviteTokenPayload | null {
  try {
    const payload = jwt.verify(token, getInviteSecret()) as InviteTokenPayload
    if (payload.type !== 'invite') return null
    if (!payload.userId || !payload.email) return null
    return payload
  } catch {
    return null
  }
}

export function getInviteTokenExpiry(token: string): string | null {
  try {
    const payload = jwt.decode(token) as DecodedInvitePayload | null
    if (!payload || payload.type !== 'invite' || typeof payload.exp !== 'number') return null
    return new Date(payload.exp * 1000).toISOString()
  } catch {
    return null
  }
}

export function isInviteTokenExpired(token: string, now = Date.now()): boolean {
  const expiry = getInviteTokenExpiry(token)
  if (!expiry) return false
  return new Date(expiry).getTime() <= now
}
