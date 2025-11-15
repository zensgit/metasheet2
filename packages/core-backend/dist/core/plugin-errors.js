"use strict";
/**
 * 插件错误码与错误类型
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.PluginError = exports.PluginErrorCode = void 0;
var PluginErrorCode;
(function (PluginErrorCode) {
    PluginErrorCode["NOT_FOUND"] = "PLUGIN_001";
    PluginErrorCode["INVALID_MANIFEST"] = "PLUGIN_002";
    PluginErrorCode["VERSION_MISMATCH"] = "PLUGIN_003";
    PluginErrorCode["PERMISSION_DENIED"] = "PLUGIN_004";
    PluginErrorCode["ACTIVATION_FAILED"] = "PLUGIN_005";
    PluginErrorCode["CIRCULAR_DEPENDENCY"] = "PLUGIN_006";
    PluginErrorCode["BUILD_NOT_FOUND"] = "PLUGIN_007";
    PluginErrorCode["HOT_RELOAD_UNSUPPORTED"] = "PLUGIN_008";
})(PluginErrorCode || (exports.PluginErrorCode = PluginErrorCode = {}));
class PluginError extends Error {
    code;
    cause;
    constructor(code, message, cause) {
        super(message);
        this.name = 'PluginError';
        this.code = code;
        this.cause = cause;
    }
}
exports.PluginError = PluginError;
//# sourceMappingURL=plugin-errors.js.map