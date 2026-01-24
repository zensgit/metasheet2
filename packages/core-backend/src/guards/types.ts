/**
 * SafetyGuard Types
 *
 * Risk levels and operation classification for dangerous operations
 */

export enum RiskLevel {
  LOW = 'low',
  MEDIUM = 'medium',
  HIGH = 'high',
  CRITICAL = 'critical'
}

export enum OperationType {
  // Data operations
  DELETE_DATA = 'delete_data',
  TRUNCATE_TABLE = 'truncate_table',
  DROP_TABLE = 'drop_table',
  BULK_UPDATE = 'bulk_update',

  // Plugin operations
  UNLOAD_PLUGIN = 'unload_plugin',
  RELOAD_ALL_PLUGINS = 'reload_all_plugins',
  FORCE_RELOAD = 'force_reload',
  UPDATE_PLUGIN_CONFIG = 'update_plugin_config',

  // Snapshot operations
  DELETE_SNAPSHOT = 'delete_snapshot',
  RESTORE_SNAPSHOT = 'restore_snapshot',
  CLEANUP_SNAPSHOTS = 'cleanup_snapshots',

  // System operations
  CLEAR_CACHE = 'clear_cache',
  RESET_METRICS = 'reset_metrics',
  SHUTDOWN_SERVICE = 'shutdown_service',

  // Schema operations
  ALTER_SCHEMA = 'alter_schema',
  DROP_COLUMN = 'drop_column',
  RENAME_COLUMN = 'rename_column'
}

export interface OperationContext {
  /** The type of operation being performed */
  operation: OperationType;

  /** User or service initiating the operation */
  initiator: string;

  /** Additional context about the operation */
  details?: Record<string, unknown>;

  /** Timestamp of the request */
  timestamp?: Date;

  /** Optional confirmation token for double-confirm */
  confirmationToken?: string;
}

export interface RiskAssessment {
  /** Overall risk level */
  riskLevel: RiskLevel;

  /** Whether confirmation is required */
  requiresConfirmation: boolean;

  /** Whether double confirmation is required (type operation name) */
  requiresDoubleConfirm: boolean;

  /** Human-readable risk description */
  riskDescription: string;

  /** Suggested safety measures */
  safeguards: string[];

  /** Impact estimation */
  impact: {
    scope: 'single' | 'batch' | 'system-wide';
    reversible: boolean;
    estimatedDuration?: string;
  };
}

export interface SafetyCheckResult {
  /** Whether the operation is allowed to proceed */
  allowed: boolean;

  /** The risk assessment */
  assessment: RiskAssessment;

  /** Reason if blocked */
  blockedReason?: string;

  /** Token to use for confirmation */
  confirmationToken?: string;

  /** Expiration time for confirmation token */
  tokenExpiry?: Date;
}

export interface ConfirmationRequest {
  /** The token from SafetyCheckResult */
  token: string;

  /** User typed confirmation (for double-confirm) */
  typedConfirmation?: string;

  /** Additional acknowledgment */
  acknowledged?: boolean;
}

export interface SafetyGuardConfig {
  /** Enable or disable the safety guard */
  enabled: boolean;

  /** Allow bypassing safety checks (for testing) */
  allowBypass: boolean;

  /** Token expiration time in seconds */
  tokenExpirationSeconds: number;

  /** Operations that require double-confirm */
  doubleConfirmOperations: OperationType[];

  /** Operations that are completely blocked */
  blockedOperations: OperationType[];
}
