/**
 * Pattern Trie for Efficient Wildcard Matching
 * Issue #28: Implement prefix tree for efficient wildcard pattern matching
 */
export interface Subscription {
    id: string;
    pattern: string;
    callback: (topic: string, message: any) => void;
    createdAt: number;
    metadata?: any;
}
export interface TrieStats {
    totalNodes: number;
    totalSubscriptions: number;
    maxDepth: number;
    averageDepth: number;
    memoryUsage: number;
}
export declare class PatternTrie {
    private root;
    private exactPatterns;
    private wildcardPatterns;
    private stats;
    constructor();
    /**
     * Add a pattern subscription to the trie
     */
    addPattern(pattern: string, subscription: Subscription): void;
    /**
     * Remove a pattern subscription from the trie
     */
    removePattern(pattern: string, subscriptionId: string): boolean;
    /**
     * Find all matching subscriptions for a topic
     */
    findMatches(topic: string): Subscription[];
    /**
     * Get all subscriptions (for debugging/monitoring)
     */
    getAllSubscriptions(): Subscription[];
    /**
     * Get trie statistics
     */
    getStats(): TrieStats;
    /**
     * Clear all patterns
     */
    clear(): void;
    /**
     * Private helper methods
     */
    private addExactPattern;
    private addPrefixPattern;
    private addSuffixPattern;
    private addComplexWildcardPattern;
    private findPrefixMatches;
    private findSuffixMatches;
    private findComplexWildcardMatches;
    private findIntermediateMatches;
    private removeFromTrie;
    private removeWildcardSubscription;
    private collectSubscriptions;
    private updateStats;
    private calculateDepths;
    /**
     * Debug method to visualize trie structure
     */
    debug(): string;
    private debugNode;
}
//# sourceMappingURL=pattern-trie.d.ts.map