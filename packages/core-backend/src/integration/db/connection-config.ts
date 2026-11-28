import type { PoolConfig } from 'pg'
import type { SecretOptions } from '../../security/SecretManager'

/** Reading configuration is explicit; importing this module creates no providers or connections. */
export function databaseConnectionConfig(
  secrets: { get(key: string, options?: SecretOptions): string | undefined },
  env: NodeJS.ProcessEnv = process.env,
): Pick<PoolConfig, 'connectionString' | 'ssl' | 'max'> {
  const connectionString = secrets.get('DATABASE_URL', { required: env.NODE_ENV === 'production' })
  const sslDisabled = ['false', '0', 'off', 'no'].includes((env.DB_SSL || '').trim().toLowerCase())
  const ssl = env.NODE_ENV === 'production' && !sslDisabled
    ? {
        rejectUnauthorized: env.DB_SSL_REJECT_UNAUTHORIZED !== 'false',
        ca: env.DB_SSL_CA,
        cert: env.DB_SSL_CERT,
        key: env.DB_SSL_KEY,
      }
    : false
  return { connectionString, ssl, max: parseInt(env.DB_POOL_MAX || '20', 10) }
}
