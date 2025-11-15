/**
 * Feature Flags Configuration
 *
 * All feature flags follow the naming convention: FEATURE_{DOMAIN}_{CAPABILITY}
 * Default: false (disabled) for safety
 *
 * Usage:
 *   import { FEATURE_FLAGS, isFeatureEnabled } from './config/flags'
 *   if (isFeatureEnabled('FEATURE_VIEWSERVICE_UNIFICATION')) { ... }
 */
export declare const FEATURE_FLAGS: {
    readonly FEATURE_VIEWSERVICE_UNIFICATION: boolean;
    readonly FEATURE_TABLE_RBAC_ENABLED: boolean;
    readonly FEATURE_VIEWSERVICE_ROUTES: boolean;
    readonly FEATURE_VIEWSERVICE_METRICS: boolean;
    readonly FEATURE_JWT_IMPROVEMENTS: boolean;
    readonly FEATURE_ADMIN_ROUTES_V2: boolean;
    readonly FEATURE_METRICS_V2: boolean;
    readonly FEATURE_VIEW_MANAGER_V2: boolean;
    readonly FEATURE_FORM_GALLERY_VIEWS: boolean;
};
/**
 * Type-safe feature flag accessor
 * @param flag - The feature flag key
 * @returns boolean - true if enabled, false otherwise
 */
export declare function isFeatureEnabled(flag: keyof typeof FEATURE_FLAGS): boolean;
/**
 * Get all enabled features (for debugging/monitoring)
 */
export declare function getEnabledFeatures(): string[];
//# sourceMappingURL=flags.d.ts.map