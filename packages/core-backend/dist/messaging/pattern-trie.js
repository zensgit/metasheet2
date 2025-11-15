"use strict";
/**
 * Pattern Trie for Efficient Wildcard Matching
 * Issue #28: Implement prefix tree for efficient wildcard pattern matching
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.PatternTrie = void 0;
class TrieNode {
    children = new Map();
    subscriptions = new Set();
    isWildcard = false;
    isEndOfPattern = false;
    constructor() { }
    /**
     * Get memory usage of this node and its children
     */
    getMemoryUsage() {
        let size = 0;
        // Node overhead
        size += 64; // Base object size
        // Children map
        size += this.children.size * 32; // Map entry overhead
        for (const [key, child] of this.children) {
            size += key.length * 2; // String size (UTF-16)
            size += child.getMemoryUsage();
        }
        // Subscriptions set
        size += this.subscriptions.size * 16; // Set entry overhead
        for (const sub of this.subscriptions) {
            size += sub.pattern.length * 2;
            size += 128; // Subscription object overhead
        }
        return size;
    }
}
class PatternTrie {
    root = new TrieNode();
    exactPatterns = new Map();
    wildcardPatterns = new Map();
    stats = {
        totalNodes: 1,
        totalSubscriptions: 0,
        maxDepth: 0,
        averageDepth: 0,
        memoryUsage: 0
    };
    constructor() { }
    /**
     * Add a pattern subscription to the trie
     */
    addPattern(pattern, subscription) {
        this.stats.totalSubscriptions++;
        // Handle exact matches (no wildcards)
        if (!pattern.includes('*')) {
            this.addExactPattern(pattern, subscription);
            return;
        }
        // Handle different wildcard types
        if (pattern.endsWith('.*')) {
            this.addPrefixPattern(pattern, subscription);
        }
        else if (pattern.startsWith('*.')) {
            this.addSuffixPattern(pattern, subscription);
        }
        else if (pattern.includes('*')) {
            this.addComplexWildcardPattern(pattern, subscription);
        }
        this.updateStats();
    }
    /**
     * Remove a pattern subscription from the trie
     */
    removePattern(pattern, subscriptionId) {
        let found = false;
        // Remove from exact patterns
        if (!pattern.includes('*')) {
            const subs = this.exactPatterns.get(pattern);
            if (subs) {
                const toRemove = Array.from(subs).find(s => s.id === subscriptionId);
                if (toRemove) {
                    subs.delete(toRemove);
                    if (subs.size === 0) {
                        this.exactPatterns.delete(pattern);
                    }
                    found = true;
                }
            }
        }
        else {
            // Remove from trie structure
            found = this.removeFromTrie(this.root, pattern, 0, subscriptionId);
        }
        if (found) {
            this.stats.totalSubscriptions--;
            this.updateStats();
        }
        return found;
    }
    /**
     * Find all matching subscriptions for a topic
     */
    findMatches(topic) {
        const matches = new Set();
        // Check exact matches first (fastest)
        const exactSubs = this.exactPatterns.get(topic);
        if (exactSubs) {
            exactSubs.forEach(sub => matches.add(sub));
        }
        // Check prefix patterns (user.* matches user.login)
        this.findPrefixMatches(topic, matches);
        // Check suffix patterns (*.login matches user.login)
        this.findSuffixMatches(topic, matches);
        // Check complex wildcard patterns
        this.findComplexWildcardMatches(topic, matches);
        return Array.from(matches);
    }
    /**
     * Get all subscriptions (for debugging/monitoring)
     */
    getAllSubscriptions() {
        const all = new Set();
        // Add exact patterns
        for (const subs of this.exactPatterns.values()) {
            subs.forEach(sub => all.add(sub));
        }
        // Add trie patterns
        this.collectSubscriptions(this.root, all);
        return Array.from(all);
    }
    /**
     * Get trie statistics
     */
    getStats() {
        return { ...this.stats };
    }
    /**
     * Clear all patterns
     */
    clear() {
        this.root = new TrieNode();
        this.exactPatterns.clear();
        this.wildcardPatterns.clear();
        this.stats = {
            totalNodes: 1,
            totalSubscriptions: 0,
            maxDepth: 0,
            averageDepth: 0,
            memoryUsage: 0
        };
    }
    /**
     * Private helper methods
     */
    addExactPattern(pattern, subscription) {
        if (!this.exactPatterns.has(pattern)) {
            this.exactPatterns.set(pattern, new Set());
        }
        this.exactPatterns.get(pattern).add(subscription);
    }
    addPrefixPattern(pattern, subscription) {
        // pattern: "user.*" -> prefix: "user"
        const prefix = pattern.slice(0, -2); // Remove ".*"
        let node = this.root;
        let depth = 0;
        for (const char of prefix) {
            if (!node.children.has(char)) {
                node.children.set(char, new TrieNode());
                this.stats.totalNodes++;
            }
            node = node.children.get(char);
            depth++;
        }
        node.subscriptions.add(subscription);
        node.isWildcard = true;
        this.stats.maxDepth = Math.max(this.stats.maxDepth, depth);
    }
    addSuffixPattern(pattern, subscription) {
        // pattern: "*.login" -> suffix: "login"
        const suffix = pattern.slice(2); // Remove "*."
        if (!this.wildcardPatterns.has('suffix')) {
            this.wildcardPatterns.set('suffix', new Set());
        }
        // Store with reversed suffix for efficient matching
        const reversedSuffix = suffix.split('').reverse().join('');
        subscription.metadata = { ...subscription.metadata, reversedSuffix };
        this.wildcardPatterns.get('suffix').add(subscription);
    }
    addComplexWildcardPattern(pattern, subscription) {
        // Handle patterns like "user.*.action" or "*.*.event"
        if (!this.wildcardPatterns.has('complex')) {
            this.wildcardPatterns.set('complex', new Set());
        }
        // Convert pattern to regex for complex matching
        const regexPattern = pattern
            .replace(/\./g, '\\.') // Escape dots
            .replace(/\*/g, '[^.]*') // * matches anything except dots
            .replace(/\\\.\[/g, '\\.['); // Fix escaped dots before wildcards
        subscription.metadata = {
            ...subscription.metadata,
            regex: new RegExp(`^${regexPattern}$`)
        };
        this.wildcardPatterns.get('complex').add(subscription);
    }
    findPrefixMatches(topic, matches) {
        let node = this.root;
        const path = [];
        for (const char of topic) {
            path.push(char);
            if (!node.children.has(char)) {
                break;
            }
            node = node.children.get(char);
            // If this node has wildcard subscriptions, they match
            if (node.isWildcard && node.subscriptions.size > 0) {
                const currentPrefix = path.join('');
                // Check if we're at a valid boundary (next char is '.' or end)
                const nextCharIndex = path.length;
                if (nextCharIndex >= topic.length || topic[nextCharIndex] === '.') {
                    node.subscriptions.forEach(sub => matches.add(sub));
                }
            }
        }
        // Also check intermediate wildcard nodes
        this.findIntermediateMatches(this.root, topic, 0, matches);
    }
    findSuffixMatches(topic, matches) {
        const suffixSubs = this.wildcardPatterns.get('suffix');
        if (!suffixSubs)
            return;
        for (const sub of suffixSubs) {
            const reversedSuffix = sub.metadata?.reversedSuffix;
            if (reversedSuffix) {
                const reversedTopic = topic.split('').reverse().join('');
                if (reversedTopic.startsWith(reversedSuffix)) {
                    // Check boundary
                    const suffixLength = reversedSuffix.length;
                    if (suffixLength >= reversedTopic.length || reversedTopic[suffixLength] === '.') {
                        matches.add(sub);
                    }
                }
            }
        }
    }
    findComplexWildcardMatches(topic, matches) {
        const complexSubs = this.wildcardPatterns.get('complex');
        if (!complexSubs)
            return;
        for (const sub of complexSubs) {
            const regex = sub.metadata?.regex;
            if (regex && regex.test(topic)) {
                matches.add(sub);
            }
        }
    }
    findIntermediateMatches(node, topic, index, matches) {
        if (index >= topic.length)
            return;
        const char = topic[index];
        // Follow exact path
        const exactChild = node.children.get(char);
        if (exactChild) {
            // Check if this node has wildcard subscriptions
            if (exactChild.isWildcard) {
                // Check if we're at a word boundary
                const remainingTopic = topic.slice(index);
                const nextDotIndex = remainingTopic.indexOf('.');
                if (nextDotIndex === -1 || nextDotIndex === remainingTopic.length - 1) {
                    exactChild.subscriptions.forEach(sub => matches.add(sub));
                }
            }
            this.findIntermediateMatches(exactChild, topic, index + 1, matches);
        }
    }
    removeFromTrie(node, pattern, index, subscriptionId) {
        if (index >= pattern.length) {
            // Find and remove the subscription
            const toRemove = Array.from(node.subscriptions).find(s => s.id === subscriptionId);
            if (toRemove) {
                node.subscriptions.delete(toRemove);
                return true;
            }
            return false;
        }
        const char = pattern[index];
        if (char === '*') {
            // Handle wildcard removal
            return this.removeWildcardSubscription(node, subscriptionId);
        }
        const child = node.children.get(char);
        if (!child)
            return false;
        const found = this.removeFromTrie(child, pattern, index + 1, subscriptionId);
        // Clean up empty nodes
        if (found && child.subscriptions.size === 0 && child.children.size === 0) {
            node.children.delete(char);
            this.stats.totalNodes--;
        }
        return found;
    }
    removeWildcardSubscription(node, subscriptionId) {
        const toRemove = Array.from(node.subscriptions).find(s => s.id === subscriptionId);
        if (toRemove) {
            node.subscriptions.delete(toRemove);
            if (node.subscriptions.size === 0) {
                node.isWildcard = false;
            }
            return true;
        }
        return false;
    }
    collectSubscriptions(node, all) {
        node.subscriptions.forEach(sub => all.add(sub));
        for (const child of node.children.values()) {
            this.collectSubscriptions(child, all);
        }
    }
    updateStats() {
        this.stats.memoryUsage = this.root.getMemoryUsage();
        // Calculate average depth
        const depths = [];
        this.calculateDepths(this.root, 0, depths);
        this.stats.averageDepth = depths.length > 0
            ? depths.reduce((a, b) => a + b, 0) / depths.length
            : 0;
    }
    calculateDepths(node, currentDepth, depths) {
        if (node.subscriptions.size > 0) {
            depths.push(currentDepth);
        }
        for (const child of node.children.values()) {
            this.calculateDepths(child, currentDepth + 1, depths);
        }
    }
    /**
     * Debug method to visualize trie structure
     */
    debug() {
        const lines = [];
        this.debugNode(this.root, '', true, lines);
        return lines.join('\n');
    }
    debugNode(node, prefix, isLast, lines) {
        const marker = isLast ? '└── ' : '├── ';
        const nodeInfo = node.subscriptions.size > 0
            ? ` (${node.subscriptions.size} subs${node.isWildcard ? ', wildcard' : ''})`
            : '';
        if (prefix || nodeInfo) {
            lines.push(prefix + nodeInfo);
        }
        const children = Array.from(node.children.entries());
        children.forEach(([char, child], index) => {
            const isLastChild = index === children.length - 1;
            const childPrefix = prefix + (isLast ? '    ' : '│   ') + marker + char;
            this.debugNode(child, childPrefix, isLastChild, lines);
        });
    }
}
exports.PatternTrie = PatternTrie;
//# sourceMappingURL=pattern-trie.js.map