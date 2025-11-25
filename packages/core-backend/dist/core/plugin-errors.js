/**
 * 插件错误码与错误类型
 */
export var PluginErrorCode;
(function (PluginErrorCode) {
    PluginErrorCode["NOT_FOUND"] = "PLUGIN_001";
    PluginErrorCode["INVALID_MANIFEST"] = "PLUGIN_002";
    PluginErrorCode["VERSION_MISMATCH"] = "PLUGIN_003";
    PluginErrorCode["PERMISSION_DENIED"] = "PLUGIN_004";
    PluginErrorCode["ACTIVATION_FAILED"] = "PLUGIN_005";
    PluginErrorCode["CIRCULAR_DEPENDENCY"] = "PLUGIN_006";
    PluginErrorCode["BUILD_NOT_FOUND"] = "PLUGIN_007";
    PluginErrorCode["HOT_RELOAD_UNSUPPORTED"] = "PLUGIN_008";
})(PluginErrorCode || (PluginErrorCode = {}));
export class PluginError extends Error {
    code;
    cause;
    constructor(code, message, cause) {
        super(message);
        this.name = 'PluginError';
        this.code = code;
        this.cause = cause;
    }
}
//# sourceMappingURL=plugin-errors.js.map