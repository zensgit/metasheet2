/**
 * Gate 4 (R-71 ⑦.2): constants-only host mirror of plugins/plugin-integration-core/lib/yida-send-budget.cjs,
 * which is the single definition of the YiDa owner send budgets. core-backend src does not import plugin
 * lib modules; tests/unit/yida-send-budget-mirror.test.ts pins every value here equal to the plugin's.
 */
export const YIDA_SEND_SNAPSHOT_MAX_BYTES = 262144
export const YIDA_SEND_REQUEST_MAX_BYTES = 262144
export const YIDA_SEND_SNAPSHOT_MAX_NODES = 4096
export const YIDA_SEND_SNAPSHOT_MAX_DEPTH = 12
export const YIDA_SEND_SYSTEM_TOKEN_MAX_LENGTH = 4096
export const YIDA_SEND_USER_ID_MAX_LENGTH = 128
