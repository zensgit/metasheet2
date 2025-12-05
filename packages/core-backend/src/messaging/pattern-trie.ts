/**
 * Pattern Trie for Efficient Wildcard Matching
 * Issue #28: Implement prefix tree for efficient wildcard pattern matching
 */

export interface Subscription {
  id: string
  pattern: string
  callback: (topic: string, message: unknown) => void
  createdAt: number
  metadata?: Record<string, unknown>
}

export interface TrieStats {
  totalNodes: number
  totalSubscriptions: number
  maxDepth: number
  averageDepth: number
  memoryUsage: number
}

class TrieNode {
  children: Map<string, TrieNode> = new Map()
  subscriptions: Set<Subscription> = new Set()
  isWildcard: boolean = false
  isEndOfPattern: boolean = false

  constructor() {}

  /**
   * Get memory usage of this node and its children
   */
  getMemoryUsage(): number {
    let size = 0

    // Node overhead
    size += 64 // Base object size

    // Children map
    size += this.children.size * 32 // Map entry overhead
    for (const [key, child] of this.children) {
      size += key.length * 2 // String size (UTF-16)
      size += child.getMemoryUsage()
    }

    // Subscriptions set
    size += this.subscriptions.size * 16 // Set entry overhead
    for (const sub of this.subscriptions) {
      size += sub.pattern.length * 2
      size += 128 // Subscription object overhead
    }

    return size
  }
}

export class PatternTrie {
  private root: TrieNode = new TrieNode()
  private exactPatterns: Map<string, Set<Subscription>> = new Map()
  private wildcardPatterns: Map<string, Set<Subscription>> = new Map()
  private stats: TrieStats = {
    totalNodes: 1,
    totalSubscriptions: 0,
    maxDepth: 0,
    averageDepth: 0,
    memoryUsage: 0
  }

  constructor() {}

  /**
   * Add a pattern subscription to the trie
   */
  addPattern(pattern: string, subscription: Subscription): void {
    this.stats.totalSubscriptions++

    // Handle exact matches (no wildcards)
    if (!pattern.includes('*')) {
      this.addExactPattern(pattern, subscription)
      return
    }

    // Count wildcards to determine pattern type
    const wildcardCount = (pattern.match(/\*/g) || []).length

    // Handle different wildcard types
    if (wildcardCount === 1 && pattern.endsWith('.*')) {
      // Simple prefix pattern: user.*
      this.addPrefixPattern(pattern, subscription)
    } else if (wildcardCount === 1 && pattern.startsWith('*.')) {
      // Simple suffix pattern: *.login
      this.addSuffixPattern(pattern, subscription)
    } else {
      // Complex pattern with multiple wildcards or embedded wildcards: *.*.event, user.*.action
      this.addComplexWildcardPattern(pattern, subscription)
    }

    this.updateStats()
  }

  /**
   * Remove a pattern subscription from the trie
   */
  removePattern(pattern: string, subscriptionId: string): boolean {
    let found = false

    // Remove from exact patterns
    if (!pattern.includes('*')) {
      const subs = this.exactPatterns.get(pattern)
      if (subs) {
        const toRemove = Array.from(subs).find(s => s.id === subscriptionId)
        if (toRemove) {
          subs.delete(toRemove)
          if (subs.size === 0) {
            this.exactPatterns.delete(pattern)
          }
          found = true
        }
      }
    } else if (pattern.endsWith('.*')) {
      // Remove prefix pattern from trie
      found = this.removePrefixPattern(pattern, subscriptionId)
    } else if (pattern.startsWith('*.')) {
      // Remove suffix pattern from wildcardPatterns
      found = this.removeSuffixPattern(subscriptionId)
    } else {
      // Remove complex wildcard pattern
      found = this.removeComplexPattern(subscriptionId)
    }

    if (found) {
      this.stats.totalSubscriptions--
      this.updateStats()
    }

    return found
  }

  /**
   * Find all matching subscriptions for a topic
   */
  findMatches(topic: string): Subscription[] {
    const matches = new Set<Subscription>()

    // Check exact matches first (fastest)
    const exactSubs = this.exactPatterns.get(topic)
    if (exactSubs) {
      exactSubs.forEach(sub => matches.add(sub))
    }

    // Check prefix patterns (user.* matches user.login)
    this.findPrefixMatches(topic, matches)

    // Check suffix patterns (*.login matches user.login)
    this.findSuffixMatches(topic, matches)

    // Check complex wildcard patterns
    this.findComplexWildcardMatches(topic, matches)

    return Array.from(matches)
  }

  /**
   * Get all subscriptions (for debugging/monitoring)
   */
  getAllSubscriptions(): Subscription[] {
    const all = new Set<Subscription>()

    // Add exact patterns
    for (const subs of this.exactPatterns.values()) {
      subs.forEach(sub => all.add(sub))
    }

    // Add trie patterns (prefix patterns)
    this.collectSubscriptions(this.root, all)

    // Add suffix and complex wildcard patterns
    for (const subs of this.wildcardPatterns.values()) {
      subs.forEach(sub => all.add(sub))
    }

    return Array.from(all)
  }

  /**
   * Get trie statistics
   */
  getStats(): TrieStats {
    return { ...this.stats }
  }

  /**
   * Clear all patterns
   */
  clear(): void {
    this.root = new TrieNode()
    this.exactPatterns.clear()
    this.wildcardPatterns.clear()
    this.stats = {
      totalNodes: 1,
      totalSubscriptions: 0,
      maxDepth: 0,
      averageDepth: 0,
      memoryUsage: 0
    }
  }

  /**
   * Private helper methods
   */

  private addExactPattern(pattern: string, subscription: Subscription): void {
    if (!this.exactPatterns.has(pattern)) {
      this.exactPatterns.set(pattern, new Set())
    }
    this.exactPatterns.get(pattern)!.add(subscription)
  }

  private addPrefixPattern(pattern: string, subscription: Subscription): void {
    // pattern: "user.*" -> prefix: "user"
    const prefix = pattern.slice(0, -2) // Remove ".*"
    let node = this.root
    let depth = 0

    for (const char of prefix) {
      if (!node.children.has(char)) {
        node.children.set(char, new TrieNode())
        this.stats.totalNodes++
      }
      node = node.children.get(char)!
      depth++
    }

    node.subscriptions.add(subscription)
    node.isWildcard = true
    this.stats.maxDepth = Math.max(this.stats.maxDepth, depth)
  }

  private addSuffixPattern(pattern: string, subscription: Subscription): void {
    // pattern: "*.login" -> suffix: "login"
    const suffix = pattern.slice(2) // Remove "*."

    if (!this.wildcardPatterns.has('suffix')) {
      this.wildcardPatterns.set('suffix', new Set())
    }

    // Store with reversed suffix for efficient matching
    const reversedSuffix = suffix.split('').reverse().join('')
    subscription.metadata = { ...subscription.metadata, reversedSuffix }
    this.wildcardPatterns.get('suffix')!.add(subscription)
  }

  private addComplexWildcardPattern(pattern: string, subscription: Subscription): void {
    // Handle patterns like "user.*.action" or "*.*.event"
    if (!this.wildcardPatterns.has('complex')) {
      this.wildcardPatterns.set('complex', new Set())
    }

    // Convert pattern to regex for complex matching
    const regexPattern = pattern
      .replace(/\./g, '\\.')  // Escape dots
      .replace(/\*/g, '[^.]*') // * matches anything except dots
      .replace(/\\\.\[/g, '\\.[') // Fix escaped dots before wildcards

    subscription.metadata = {
      ...subscription.metadata,
      regex: new RegExp(`^${regexPattern}$`)
    }
    this.wildcardPatterns.get('complex')!.add(subscription)
  }

  private findPrefixMatches(topic: string, matches: Set<Subscription>): void {
    let node = this.root
    const path: string[] = []

    for (const char of topic) {
      path.push(char)

      if (!node.children.has(char)) {
        break
      }

      node = node.children.get(char)!

      // If this node has wildcard subscriptions, they match
      if (node.isWildcard && node.subscriptions.size > 0) {
        // Check if we're at a valid boundary (next char is '.' or end)
        const nextCharIndex = path.length
        if (nextCharIndex >= topic.length || topic[nextCharIndex] === '.') {
          node.subscriptions.forEach(sub => matches.add(sub))
        }
      }
    }

    // Also check intermediate wildcard nodes
    this.findIntermediateMatches(this.root, topic, 0, matches)
  }

  private findSuffixMatches(topic: string, matches: Set<Subscription>): void {
    const suffixSubs = this.wildcardPatterns.get('suffix')
    if (!suffixSubs) return

    for (const sub of suffixSubs) {
      const reversedSuffix = sub.metadata?.reversedSuffix as string | undefined
      if (reversedSuffix) {
        const reversedTopic = topic.split('').reverse().join('')
        if (reversedTopic.startsWith(reversedSuffix)) {
          // Check boundary
          const suffixLength = reversedSuffix.length
          if (suffixLength >= reversedTopic.length || reversedTopic[suffixLength] === '.') {
            matches.add(sub)
          }
        }
      }
    }
  }

  private findComplexWildcardMatches(topic: string, matches: Set<Subscription>): void {
    const complexSubs = this.wildcardPatterns.get('complex')
    if (!complexSubs) return

    for (const sub of complexSubs) {
      const regex = sub.metadata?.regex as RegExp | undefined
      if (regex && regex.test(topic)) {
        matches.add(sub)
      }
    }
  }

  private findIntermediateMatches(
    node: TrieNode,
    topic: string,
    index: number,
    matches: Set<Subscription>
  ): void {
    if (index >= topic.length) return

    const char = topic[index]

    // Follow exact path
    const exactChild = node.children.get(char)
    if (exactChild) {
      // Check if this node has wildcard subscriptions
      if (exactChild.isWildcard) {
        // Check if we're at a word boundary
        const remainingTopic = topic.slice(index)
        const nextDotIndex = remainingTopic.indexOf('.')
        if (nextDotIndex === -1 || nextDotIndex === remainingTopic.length - 1) {
          exactChild.subscriptions.forEach(sub => matches.add(sub))
        }
      }

      this.findIntermediateMatches(exactChild, topic, index + 1, matches)
    }
  }

  private removeFromTrie(
    node: TrieNode,
    pattern: string,
    index: number,
    subscriptionId: string
  ): boolean {
    if (index >= pattern.length) {
      // Find and remove the subscription
      const toRemove = Array.from(node.subscriptions).find(s => s.id === subscriptionId)
      if (toRemove) {
        node.subscriptions.delete(toRemove)
        return true
      }
      return false
    }

    const char = pattern[index]
    if (char === '*') {
      // Handle wildcard removal
      return this.removeWildcardSubscription(node, subscriptionId)
    }

    const child = node.children.get(char)
    if (!child) return false

    const found = this.removeFromTrie(child, pattern, index + 1, subscriptionId)

    // Clean up empty nodes
    if (found && child.subscriptions.size === 0 && child.children.size === 0) {
      node.children.delete(char)
      this.stats.totalNodes--
    }

    return found
  }

  private removeWildcardSubscription(node: TrieNode, subscriptionId: string): boolean {
    const toRemove = Array.from(node.subscriptions).find(s => s.id === subscriptionId)
    if (toRemove) {
      node.subscriptions.delete(toRemove)
      if (node.subscriptions.size === 0) {
        node.isWildcard = false
      }
      return true
    }
    return false
  }

  private removePrefixPattern(pattern: string, subscriptionId: string): boolean {
    // pattern: "user.*" -> prefix: "user"
    const prefix = pattern.slice(0, -2) // Remove ".*"
    let node = this.root

    // Navigate to the prefix node
    for (const char of prefix) {
      if (!node.children.has(char)) {
        return false
      }
      node = node.children.get(char)!
    }

    // Remove subscription from this node
    return this.removeWildcardSubscription(node, subscriptionId)
  }

  private removeSuffixPattern(subscriptionId: string): boolean {
    const suffixSubs = this.wildcardPatterns.get('suffix')
    if (!suffixSubs) return false

    const toRemove = Array.from(suffixSubs).find(s => s.id === subscriptionId)
    if (toRemove) {
      suffixSubs.delete(toRemove)
      if (suffixSubs.size === 0) {
        this.wildcardPatterns.delete('suffix')
      }
      return true
    }
    return false
  }

  private removeComplexPattern(subscriptionId: string): boolean {
    const complexSubs = this.wildcardPatterns.get('complex')
    if (!complexSubs) return false

    const toRemove = Array.from(complexSubs).find(s => s.id === subscriptionId)
    if (toRemove) {
      complexSubs.delete(toRemove)
      if (complexSubs.size === 0) {
        this.wildcardPatterns.delete('complex')
      }
      return true
    }
    return false
  }

  private collectSubscriptions(node: TrieNode, all: Set<Subscription>): void {
    node.subscriptions.forEach(sub => all.add(sub))
    for (const child of node.children.values()) {
      this.collectSubscriptions(child, all)
    }
  }

  private updateStats(): void {
    this.stats.memoryUsage = this.root.getMemoryUsage()

    // Calculate average depth
    const depths: number[] = []
    this.calculateDepths(this.root, 0, depths)
    this.stats.averageDepth = depths.length > 0
      ? depths.reduce((a, b) => a + b, 0) / depths.length
      : 0
  }

  private calculateDepths(node: TrieNode, currentDepth: number, depths: number[]): void {
    if (node.subscriptions.size > 0) {
      depths.push(currentDepth)
    }

    for (const child of node.children.values()) {
      this.calculateDepths(child, currentDepth + 1, depths)
    }
  }

  /**
   * Debug method to visualize trie structure
   */
  debug(): string {
    const lines: string[] = []
    this.debugNode(this.root, '', true, lines)
    return lines.join('\n')
  }

  private debugNode(node: TrieNode, prefix: string, isLast: boolean, lines: string[]): void {
    const marker = isLast ? '└── ' : '├── '
    const nodeInfo = node.subscriptions.size > 0
      ? ` (${node.subscriptions.size} subs${node.isWildcard ? ', wildcard' : ''})`
      : ''

    if (prefix || nodeInfo) {
      lines.push(prefix + nodeInfo)
    }

    const children = Array.from(node.children.entries())
    children.forEach(([char, child], index) => {
      const isLastChild = index === children.length - 1
      const childPrefix = prefix + (isLast ? '    ' : '│   ') + marker + char
      this.debugNode(child, childPrefix, isLastChild, lines)
    })
  }
}
