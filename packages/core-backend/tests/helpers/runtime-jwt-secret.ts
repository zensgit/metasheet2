import { secretManager } from '../../src/security/SecretManager'
import { resolveRuntimeJwtSecret } from '../../src/security/auth-runtime-config'

export function runtimeJwtSecret(): string {
  return resolveRuntimeJwtSecret(secretManager.get('JWT_SECRET', { required: false }))
}
