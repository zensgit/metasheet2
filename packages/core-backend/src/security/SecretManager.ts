/**
 * Secret management with pluggable providers.
 * Default provider reads from environment variables; file/vault are optional.
 */

import fs from 'fs'
import path from 'path'
import { Logger } from '../core/logger'

type ProviderName = 'env' | 'file' | 'vault'

interface SecretProvider {
  get(key: string): string | undefined
  refresh?(): Promise<void>
}

class EnvProvider implements SecretProvider {
  get(key: string): string | undefined {
    return process.env[key]
  }
}

class FileProvider implements SecretProvider {
  private cache: Record<string, string> = {}

  constructor(private filePath: string, private logger: Logger) {
    this.load()
  }

  private load(): void {
    try {
      const resolved = path.resolve(this.filePath)
      const raw = fs.readFileSync(resolved, 'utf-8')
      const parsed = JSON.parse(raw) as Record<string, string>
      this.cache = parsed
    } catch (err) {
      this.logger.warn('Failed to load secrets file', err instanceof Error ? err : undefined)
      this.cache = {}
    }
  }

  get(key: string): string | undefined {
    return this.cache[key]
  }

  async refresh(): Promise<void> {
    this.load()
  }
}

class VaultProvider implements SecretProvider {
  get(_key: string): string | undefined {
    // Placeholder for future vault integration
    return undefined
  }
}

export interface SecretOptions {
  required?: boolean
  fallback?: string
}

export class SecretManager {
  private provider: SecretProvider
  private logger = new Logger('SecretManager')
  private allowFallback: boolean

  constructor() {
    this.allowFallback = process.env.ALLOW_SECRET_FALLBACK === 'true' || process.env.NODE_ENV !== 'production'
    this.provider = this.createProvider()
  }

  private createProvider(): SecretProvider {
    const providerName = (process.env.SECRET_PROVIDER as ProviderName | undefined) || 'env'
    switch (providerName) {
      case 'file': {
        const filePath = process.env.SECRET_FILE_PATH
        if (!filePath) {
          this.logger.warn('SECRET_PROVIDER=file but SECRET_FILE_PATH is not set, falling back to env provider')
          return new EnvProvider()
        }
        return new FileProvider(filePath, this.logger)
      }
      case 'vault':
        this.logger.warn('Vault provider not implemented; falling back to env provider')
        return new VaultProvider()
      case 'env':
      default:
        return new EnvProvider()
    }
  }

  /**
   * Get secret value by key.
   * Throws if required and missing (unless fallback is allowed).
   */
  get(key: string, options?: SecretOptions): string | undefined {
    const value = this.provider.get(key) ?? options?.fallback
    if (value) return value

    const required = options?.required !== false
    if (required && !this.allowFallback) {
      throw new Error(`Secret not found for key: ${key}`)
    }

    if (required) {
      this.logger.warn(`Secret '${key}' missing; using empty value because ALLOW_SECRET_FALLBACK is enabled`)
    }

    return undefined
  }

  async refresh(): Promise<void> {
    await this.provider.refresh?.()
  }
}

export const secretManager = new SecretManager()
