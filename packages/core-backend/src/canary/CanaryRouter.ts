/**
 * CanaryRouter - Core routing engine for canary deployments
 *
 * Uses deterministic tenant-based hashing for consistent routing decisions.
 * Supports weight-based traffic splitting with per-tenant overrides.
 */

import { Logger } from '../core/logger'

const logger = new Logger('CanaryRouter')

/**
 * MurmurHash3 (32-bit) for deterministic tenant routing.
 * Same algorithm used by the sharding system for consistency.
 */
function murmurHash3(key: string, seed = 0): number {
  const encoder = new TextEncoder()
  const data = encoder.encode(key)

  let h1 = seed
  const c1 = 0xcc9e2d51
  const c2 = 0x1b873593

  for (let i = 0; i < data.length; i += 4) {
    let k1 = 0
    const remaining = Math.min(4, data.length - i)

    for (let j = 0; j < remaining; j++) {
      k1 |= data[i + j] << (j * 8)
    }

    k1 = Math.imul(k1, c1)
    k1 = (k1 << 15) | (k1 >>> 17)
    k1 = Math.imul(k1, c2)

    h1 ^= k1
    h1 = (h1 << 13) | (h1 >>> 19)
    h1 = Math.imul(h1, 5) + 0xe6546b64
  }

  h1 ^= data.length
  h1 ^= h1 >>> 16
  h1 = Math.imul(h1, 0x85ebca6b)
  h1 ^= h1 >>> 13
  h1 = Math.imul(h1, 0xc2b2ae35)
  h1 ^= h1 >>> 16

  return h1 >>> 0
}

export type CanaryVersion = 'stable' | 'canary'

export interface CanaryRule {
  topic: string
  canaryWeight: number // 0-100
  stableHandler: string
  canaryHandler: string
  overrides?: Record<string, CanaryVersion>
}

export class CanaryRouter {
  private rules: Map<string, CanaryRule> = new Map()
  private enabled: boolean

  constructor(enabled = false) {
    this.enabled = enabled
  }

  /**
   * Determine whether a tenant should receive stable or canary for a given topic.
   *
   * Routing logic:
   * 1. If canary routing is disabled globally, return 'stable'.
   * 2. If no rule exists for the topic, return 'stable'.
   * 3. If an override exists for the tenant, honour it.
   * 4. Otherwise, hash (topic + tenantId) and compare against canaryWeight.
   */
  route(topic: string, tenantId: string): CanaryVersion {
    if (!this.enabled) {
      return 'stable'
    }

    const rule = this.rules.get(topic)
    if (!rule) {
      return 'stable'
    }

    // Per-tenant overrides take precedence
    if (rule.overrides?.[tenantId]) {
      return rule.overrides[tenantId]
    }

    // Deterministic hash-based routing
    const hash = murmurHash3(`${topic}:${tenantId}`)
    const bucket = hash % 100

    return bucket < rule.canaryWeight ? 'canary' : 'stable'
  }

  /**
   * Create or update a routing rule for a topic.
   */
  updateRule(rule: CanaryRule): void {
    if (rule.canaryWeight < 0 || rule.canaryWeight > 100) {
      throw new Error(`canaryWeight must be 0-100, got ${rule.canaryWeight}`)
    }
    this.rules.set(rule.topic, { ...rule })
    logger.info(`Canary rule updated for topic=${rule.topic} weight=${rule.canaryWeight}%`)
  }

  /**
   * Remove a routing rule for a topic.
   */
  removeRule(topic: string): boolean {
    const removed = this.rules.delete(topic)
    if (removed) {
      logger.info(`Canary rule removed for topic=${topic}`)
    }
    return removed
  }

  /**
   * Get the rule for a topic.
   */
  getRule(topic: string): CanaryRule | undefined {
    const rule = this.rules.get(topic)
    return rule ? { ...rule } : undefined
  }

  /**
   * Get all rules.
   */
  getAllRules(): CanaryRule[] {
    return Array.from(this.rules.values()).map(r => ({ ...r }))
  }

  /**
   * Promote canary to 100% for a topic (full rollout).
   */
  promote(topic: string): boolean {
    const rule = this.rules.get(topic)
    if (!rule) return false
    rule.canaryWeight = 100
    logger.info(`Canary promoted for topic=${topic}`)
    return true
  }

  /**
   * Rollback canary to 0% for a topic.
   */
  rollback(topic: string): boolean {
    const rule = this.rules.get(topic)
    if (!rule) return false
    rule.canaryWeight = 0
    logger.info(`Canary rolled back for topic=${topic}`)
    return true
  }

  /**
   * Enable or disable canary routing globally.
   */
  setEnabled(enabled: boolean): void {
    this.enabled = enabled
    logger.info(`Canary routing ${enabled ? 'enabled' : 'disabled'}`)
  }

  /**
   * Check if canary routing is globally enabled.
   */
  isEnabled(): boolean {
    return this.enabled
  }
}

// Export hash for testing
export { murmurHash3 as canaryHash }
