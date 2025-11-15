/**
 * Permission Metrics Implementation
 * Issue #35: Permission denied metric test enhancement
 */
export declare class PermissionMetrics {
    private metrics;
    /**
     * Track authentication failures
     */
    incrementAuthFailure(reason: string, endpoint?: string, method?: string): void;
    /**
     * Track API requests with status codes
     */
    incrementApiRequest(endpoint: string, method: string, status: number): void;
    /**
     * Track RBAC permission denials
     */
    incrementRbacDenial(resourceType: string, action: string, role?: string, reason?: string): void;
    /**
     * Track permission check latency
     */
    recordPermissionCheckDuration(resourceType: string, action: string, durationMs: number): void;
    /**
     * Track token validation results
     */
    incrementTokenValidation(valid: boolean, reason?: string): void;
    /**
     * Track department-based access denials
     */
    incrementDepartmentDenial(department: string, resourceType: string, action: string): void;
    /**
     * Get current active sessions gauge
     */
    setActiveSessions(count: number): void;
    /**
     * Track permission cache hit/miss
     */
    incrementPermissionCache(hit: boolean): void;
    /**
     * Export metrics in Prometheus format
     */
    toPrometheusFormat(): string;
    /**
     * Get all metrics as object
     */
    getMetrics(): Record<string, any>;
    /**
     * Reset all metrics
     */
    reset(): void;
    /**
     * Private helper methods
     */
    private incrementCounter;
    private setGauge;
    private addHistogramValue;
    private findMetric;
    private labelsMatch;
    private formatLabels;
}
export declare const permissionMetrics: PermissionMetrics;
//# sourceMappingURL=permission-metrics.d.ts.map