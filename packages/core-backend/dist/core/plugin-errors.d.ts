/**
 * 插件错误码与错误类型
 */
export declare enum PluginErrorCode {
    NOT_FOUND = "PLUGIN_001",
    INVALID_MANIFEST = "PLUGIN_002",
    VERSION_MISMATCH = "PLUGIN_003",
    PERMISSION_DENIED = "PLUGIN_004",
    ACTIVATION_FAILED = "PLUGIN_005",
    CIRCULAR_DEPENDENCY = "PLUGIN_006",
    BUILD_NOT_FOUND = "PLUGIN_007",
    HOT_RELOAD_UNSUPPORTED = "PLUGIN_008"
}
export declare class PluginError extends Error {
    code: PluginErrorCode;
    cause?: unknown;
    constructor(code: PluginErrorCode, message: string, cause?: unknown);
}
//# sourceMappingURL=plugin-errors.d.ts.map