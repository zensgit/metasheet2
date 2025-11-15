"use strict";
/**
 * 插件能力系统
 * 定义和管理插件的各种能力，提供能力验证和权限检查
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.CapabilityUtils = exports.PluginCapabilityManager = exports.CAPABILITY_DESCRIPTIONS = exports.CAPABILITY_PRIORITY = exports.CAPABILITY_CONFLICTS = exports.CAPABILITY_DEPENDENCIES = void 0;
const eventemitter3_1 = require("eventemitter3");
// Use value imports for runtime enums/constants; Phase A tolerates any typing looseness
const plugin_1 = require("../types/plugin");
const logger_1 = require("../core/logger");
/**
 * 能力依赖关系定义
 */
exports.CAPABILITY_DEPENDENCIES = {
    [plugin_1.PluginCapability.VIEW_PROVIDER]: [plugin_1.PluginCapability.CUSTOM_COMPONENT],
    [plugin_1.PluginCapability.CUSTOM_COMPONENT]: [],
    [plugin_1.PluginCapability.WORKFLOW_NODE]: [plugin_1.PluginCapability.DATA_SOURCE],
    [plugin_1.PluginCapability.TRIGGER_PROVIDER]: [],
    [plugin_1.PluginCapability.ACTION_PROVIDER]: [plugin_1.PluginCapability.NOTIFICATION_CHANNEL],
    [plugin_1.PluginCapability.DATA_SOURCE]: [],
    [plugin_1.PluginCapability.FORMULA_FUNCTION]: [],
    [plugin_1.PluginCapability.FIELD_TYPE]: [],
    [plugin_1.PluginCapability.API_ENDPOINT]: [],
    [plugin_1.PluginCapability.WEBHOOK_HANDLER]: [plugin_1.PluginCapability.API_ENDPOINT],
    [plugin_1.PluginCapability.EXTERNAL_AUTH]: [plugin_1.PluginCapability.AUTH_PROVIDER],
    [plugin_1.PluginCapability.NOTIFICATION_CHANNEL]: [],
    [plugin_1.PluginCapability.EMAIL_TEMPLATE]: [plugin_1.PluginCapability.NOTIFICATION_CHANNEL],
    [plugin_1.PluginCapability.AUTH_PROVIDER]: [],
    [plugin_1.PluginCapability.PERMISSION_PROVIDER]: [plugin_1.PluginCapability.AUTH_PROVIDER],
    [plugin_1.PluginCapability.BACKGROUND_TASK]: [plugin_1.PluginCapability.SCHEDULED_JOB],
    [plugin_1.PluginCapability.SCHEDULED_JOB]: [],
    [plugin_1.PluginCapability.CACHE_PROVIDER]: [],
    [plugin_1.PluginCapability.MENU_ITEM]: [plugin_1.PluginCapability.CUSTOM_COMPONENT],
    [plugin_1.PluginCapability.TOOLBAR_BUTTON]: [plugin_1.PluginCapability.CUSTOM_COMPONENT],
    [plugin_1.PluginCapability.CONTEXT_MENU]: [plugin_1.PluginCapability.CUSTOM_COMPONENT],
    [plugin_1.PluginCapability.SETTINGS_PAGE]: [plugin_1.PluginCapability.CUSTOM_COMPONENT]
};
/**
 * 能力冲突定义（互斥的能力）
 */
exports.CAPABILITY_CONFLICTS = {
    [plugin_1.PluginCapability.VIEW_PROVIDER]: [],
    [plugin_1.PluginCapability.CUSTOM_COMPONENT]: [],
    [plugin_1.PluginCapability.WORKFLOW_NODE]: [],
    [plugin_1.PluginCapability.TRIGGER_PROVIDER]: [],
    [plugin_1.PluginCapability.ACTION_PROVIDER]: [],
    [plugin_1.PluginCapability.DATA_SOURCE]: [],
    [plugin_1.PluginCapability.FORMULA_FUNCTION]: [],
    [plugin_1.PluginCapability.FIELD_TYPE]: [],
    [plugin_1.PluginCapability.API_ENDPOINT]: [],
    [plugin_1.PluginCapability.WEBHOOK_HANDLER]: [],
    [plugin_1.PluginCapability.EXTERNAL_AUTH]: [plugin_1.PluginCapability.AUTH_PROVIDER], // 外部认证与内置认证冲突
    [plugin_1.PluginCapability.NOTIFICATION_CHANNEL]: [],
    [plugin_1.PluginCapability.EMAIL_TEMPLATE]: [],
    [plugin_1.PluginCapability.AUTH_PROVIDER]: [plugin_1.PluginCapability.EXTERNAL_AUTH], // 内置认证与外部认证冲突
    [plugin_1.PluginCapability.PERMISSION_PROVIDER]: [],
    [plugin_1.PluginCapability.BACKGROUND_TASK]: [],
    [plugin_1.PluginCapability.SCHEDULED_JOB]: [],
    [plugin_1.PluginCapability.CACHE_PROVIDER]: [],
    [plugin_1.PluginCapability.MENU_ITEM]: [],
    [plugin_1.PluginCapability.TOOLBAR_BUTTON]: [],
    [plugin_1.PluginCapability.CONTEXT_MENU]: [],
    [plugin_1.PluginCapability.SETTINGS_PAGE]: []
};
/**
 * 能力优先级定义（用于解决冲突时的选择）
 */
exports.CAPABILITY_PRIORITY = {
    [plugin_1.PluginCapability.AUTH_PROVIDER]: 10,
    [plugin_1.PluginCapability.PERMISSION_PROVIDER]: 9,
    [plugin_1.PluginCapability.DATA_SOURCE]: 8,
    [plugin_1.PluginCapability.CACHE_PROVIDER]: 7,
    [plugin_1.PluginCapability.NOTIFICATION_CHANNEL]: 6,
    [plugin_1.PluginCapability.API_ENDPOINT]: 5,
    [plugin_1.PluginCapability.VIEW_PROVIDER]: 4,
    [plugin_1.PluginCapability.WORKFLOW_NODE]: 3,
    [plugin_1.PluginCapability.TRIGGER_PROVIDER]: 3,
    [plugin_1.PluginCapability.ACTION_PROVIDER]: 3,
    [plugin_1.PluginCapability.EXTERNAL_AUTH]: 2,
    [plugin_1.PluginCapability.WEBHOOK_HANDLER]: 2,
    [plugin_1.PluginCapability.SCHEDULED_JOB]: 2,
    [plugin_1.PluginCapability.BACKGROUND_TASK]: 2,
    [plugin_1.PluginCapability.FORMULA_FUNCTION]: 1,
    [plugin_1.PluginCapability.FIELD_TYPE]: 1,
    [plugin_1.PluginCapability.EMAIL_TEMPLATE]: 1,
    [plugin_1.PluginCapability.CUSTOM_COMPONENT]: 1,
    [plugin_1.PluginCapability.MENU_ITEM]: 0,
    [plugin_1.PluginCapability.TOOLBAR_BUTTON]: 0,
    [plugin_1.PluginCapability.CONTEXT_MENU]: 0,
    [plugin_1.PluginCapability.SETTINGS_PAGE]: 0
};
/**
 * 能力描述
 */
exports.CAPABILITY_DESCRIPTIONS = {
    [plugin_1.PluginCapability.VIEW_PROVIDER]: '提供自定义视图（如看板、甘特图等）',
    [plugin_1.PluginCapability.CUSTOM_COMPONENT]: '提供自定义UI组件',
    [plugin_1.PluginCapability.WORKFLOW_NODE]: '提供工作流节点',
    [plugin_1.PluginCapability.TRIGGER_PROVIDER]: '提供触发器',
    [plugin_1.PluginCapability.ACTION_PROVIDER]: '提供动作执行器',
    [plugin_1.PluginCapability.DATA_SOURCE]: '提供数据源连接',
    [plugin_1.PluginCapability.FORMULA_FUNCTION]: '提供自定义公式函数',
    [plugin_1.PluginCapability.FIELD_TYPE]: '提供自定义字段类型',
    [plugin_1.PluginCapability.API_ENDPOINT]: '提供API端点',
    [plugin_1.PluginCapability.WEBHOOK_HANDLER]: '处理Webhook请求',
    [plugin_1.PluginCapability.EXTERNAL_AUTH]: '提供外部认证集成',
    [plugin_1.PluginCapability.NOTIFICATION_CHANNEL]: '提供通知渠道',
    [plugin_1.PluginCapability.EMAIL_TEMPLATE]: '提供邮件模板',
    [plugin_1.PluginCapability.AUTH_PROVIDER]: '提供认证服务',
    [plugin_1.PluginCapability.PERMISSION_PROVIDER]: '提供权限控制',
    [plugin_1.PluginCapability.BACKGROUND_TASK]: '提供后台任务',
    [plugin_1.PluginCapability.SCHEDULED_JOB]: '提供定时任务',
    [plugin_1.PluginCapability.CACHE_PROVIDER]: '提供缓存服务',
    [plugin_1.PluginCapability.MENU_ITEM]: '提供菜单项',
    [plugin_1.PluginCapability.TOOLBAR_BUTTON]: '提供工具栏按钮',
    [plugin_1.PluginCapability.CONTEXT_MENU]: '提供上下文菜单',
    [plugin_1.PluginCapability.SETTINGS_PAGE]: '提供设置页面'
};
/**
 * 插件能力管理器
 */
class PluginCapabilityManager extends eventemitter3_1.EventEmitter {
    registrations = new Map();
    pluginCapabilities = new Map();
    logger;
    constructor() {
        super();
        this.logger = new logger_1.Logger('PluginCapabilityManager');
    }
    /**
     * 验证插件能力
     */
    validateCapabilities(manifest, requestedCapabilities) {
        const result = {
            valid: true,
            errors: [],
            warnings: [],
            missingDependencies: [],
            conflicts: [],
            requiredPermissions: []
        };
        // 检查能力依赖
        const allRequiredCapabilities = this.resolveDependencies(requestedCapabilities);
        const missingCapabilities = allRequiredCapabilities.filter(cap => !requestedCapabilities.includes(cap));
        if (missingCapabilities.length > 0) {
            result.missingDependencies = missingCapabilities;
            result.errors.push(`Missing required capabilities: ${missingCapabilities.join(', ')}`);
            result.valid = false;
        }
        // 检查能力冲突
        const conflicts = this.findConflicts(requestedCapabilities);
        if (conflicts.length > 0) {
            result.conflicts = conflicts;
            result.errors.push(`Conflicting capabilities detected: ${conflicts.join(', ')}`);
            result.valid = false;
        }
        // 收集所需权限
        const requiredPermissions = this.getRequiredPermissions(requestedCapabilities);
        result.requiredPermissions = Array.from(new Set(requiredPermissions));
        // 检查权限是否在插件清单中声明
        const declaredPermissions = new Set(manifest.permissions || []);
        const missingPermissions = requiredPermissions.filter(perm => !declaredPermissions.has(perm) && !declaredPermissions.has('*'));
        if (missingPermissions.length > 0) {
            result.errors.push(`Missing required permissions: ${missingPermissions.join(', ')}`);
            result.valid = false;
        }
        // 检查能力的实现要求
        for (const capability of requestedCapabilities) {
            const implementationCheck = this.validateCapabilityImplementation(manifest, capability);
            if (!implementationCheck.valid) {
                result.errors.push(...implementationCheck.errors);
                result.warnings.push(...implementationCheck.warnings);
                result.valid = false;
            }
        }
        return result;
    }
    /**
     * 注册能力实现
     */
    registerCapability(pluginName, capability, implementation, metadata = {}) {
        const registration = {
            pluginName,
            capability,
            implementation,
            priority: exports.CAPABILITY_PRIORITY[capability],
            metadata,
            registeredAt: new Date()
        };
        if (!this.registrations.has(capability)) {
            this.registrations.set(capability, []);
        }
        const existing = this.registrations.get(capability);
        existing.push(registration);
        existing.sort((a, b) => b.priority - a.priority); // 按优先级排序
        // 更新插件能力映射
        if (!this.pluginCapabilities.has(pluginName)) {
            this.pluginCapabilities.set(pluginName, new Set());
        }
        this.pluginCapabilities.get(pluginName).add(capability);
        this.emit('capability:registered', { pluginName, capability, registration });
        this.logger.info(`Registered capability ${capability} for plugin ${pluginName}`);
    }
    /**
     * 取消注册能力
     */
    unregisterCapability(pluginName, capability) {
        const registrations = this.registrations.get(capability);
        if (registrations) {
            const index = registrations.findIndex(reg => reg.pluginName === pluginName);
            if (index !== -1) {
                registrations.splice(index, 1);
                if (registrations.length === 0) {
                    this.registrations.delete(capability);
                }
            }
        }
        // 更新插件能力映射
        const pluginCaps = this.pluginCapabilities.get(pluginName);
        if (pluginCaps) {
            pluginCaps.delete(capability);
            if (pluginCaps.size === 0) {
                this.pluginCapabilities.delete(pluginName);
            }
        }
        this.emit('capability:unregistered', { pluginName, capability });
        this.logger.info(`Unregistered capability ${capability} for plugin ${pluginName}`);
    }
    /**
     * 取消注册插件的所有能力
     */
    unregisterPluginCapabilities(pluginName) {
        const capabilities = this.pluginCapabilities.get(pluginName);
        if (capabilities) {
            for (const capability of capabilities) {
                this.unregisterCapability(pluginName, capability);
            }
        }
    }
    /**
     * 获取能力的实现
     */
    getCapabilityImplementations(capability) {
        return this.registrations.get(capability) || [];
    }
    /**
     * 获取最高优先级的能力实现
     */
    getPrimaryImplementation(capability) {
        const implementations = this.getCapabilityImplementations(capability);
        return implementations.length > 0 ? implementations[0] : null;
    }
    /**
     * 获取插件的能力
     */
    getPluginCapabilities(pluginName) {
        const capabilities = this.pluginCapabilities.get(pluginName);
        return capabilities ? Array.from(capabilities) : [];
    }
    /**
     * 检查插件是否具有某个能力
     */
    hasCapability(pluginName, capability) {
        const capabilities = this.pluginCapabilities.get(pluginName);
        return capabilities ? capabilities.has(capability) : false;
    }
    /**
     * 获取所有已注册的能力
     */
    getAllRegisteredCapabilities() {
        return Array.from(this.registrations.keys());
    }
    /**
     * 获取能力统计信息
     */
    getCapabilityStats() {
        const stats = {};
        for (const [capability, registrations] of this.registrations.entries()) {
            stats[capability] = registrations.length;
        }
        return stats;
    }
    /**
     * 解析能力依赖
     */
    resolveDependencies(capabilities) {
        const resolved = new Set(capabilities);
        const toProcess = [...capabilities];
        while (toProcess.length > 0) {
            const current = toProcess.shift();
            const dependencies = exports.CAPABILITY_DEPENDENCIES[current] || [];
            for (const dep of dependencies) {
                if (!resolved.has(dep)) {
                    resolved.add(dep);
                    toProcess.push(dep);
                }
            }
        }
        return Array.from(resolved);
    }
    /**
     * 查找能力冲突
     */
    findConflicts(capabilities) {
        const conflicts = [];
        for (let i = 0; i < capabilities.length; i++) {
            const capability = capabilities[i];
            const conflictsWith = exports.CAPABILITY_CONFLICTS[capability] || [];
            for (const conflict of conflictsWith) {
                if (capabilities.includes(conflict) && !conflicts.includes(conflict)) {
                    conflicts.push(conflict);
                }
            }
        }
        return conflicts;
    }
    /**
     * 获取能力所需的权限
     */
    getRequiredPermissions(capabilities) {
        const permissions = [];
        for (const capability of capabilities) {
            const capabilityPermissions = plugin_1.CAPABILITY_PERMISSIONS[capability] || [];
            permissions.push(...capabilityPermissions);
        }
        return permissions;
    }
    /**
     * 验证能力的实现要求
     */
    validateCapabilityImplementation(manifest, capability) {
        const result = { valid: true, errors: [], warnings: [] };
        switch (capability) {
            case plugin_1.PluginCapability.VIEW_PROVIDER:
                if (!manifest.contributes?.views || manifest.contributes.views.length === 0) {
                    result.errors.push('VIEW_PROVIDER capability requires views contribution in manifest');
                    result.valid = false;
                }
                break;
            case plugin_1.PluginCapability.FORMULA_FUNCTION:
                if (!manifest.contributes?.formulas || manifest.contributes.formulas.length === 0) {
                    result.errors.push('FORMULA_FUNCTION capability requires formulas contribution in manifest');
                    result.valid = false;
                }
                break;
            case plugin_1.PluginCapability.FIELD_TYPE:
                if (!manifest.contributes?.fieldTypes || manifest.contributes.fieldTypes.length === 0) {
                    result.errors.push('FIELD_TYPE capability requires fieldTypes contribution in manifest');
                    result.valid = false;
                }
                break;
            case plugin_1.PluginCapability.WORKFLOW_NODE:
                if (!manifest.contributes?.triggers && !manifest.contributes?.actions) {
                    result.errors.push('WORKFLOW_NODE capability requires triggers or actions contribution in manifest');
                    result.valid = false;
                }
                break;
            case plugin_1.PluginCapability.API_ENDPOINT:
                if (!manifest.main?.backend) {
                    result.errors.push('API_ENDPOINT capability requires backend entry point in manifest');
                    result.valid = false;
                }
                break;
            case plugin_1.PluginCapability.SETTINGS_PAGE:
                if (!manifest.contributes?.configuration) {
                    result.warnings.push('SETTINGS_PAGE capability should include configuration contribution in manifest');
                }
                break;
        }
        return result;
    }
    /**
     * 生成能力兼容性报告
     */
    generateCompatibilityReport(capabilities) {
        const issues = [];
        const suggestions = [];
        // 检查依赖
        const allRequired = this.resolveDependencies(capabilities);
        const missing = allRequired.filter(cap => !capabilities.includes(cap));
        if (missing.length > 0) {
            issues.push({
                type: 'error',
                message: `Missing required capabilities: ${missing.join(', ')}`
            });
            suggestions.push(`Add the following capabilities to your plugin: ${missing.join(', ')}`);
        }
        // 检查冲突
        const conflicts = this.findConflicts(capabilities);
        if (conflicts.length > 0) {
            issues.push({
                type: 'error',
                message: `Conflicting capabilities: ${conflicts.join(', ')}`
            });
            suggestions.push(`Remove conflicting capabilities or choose an alternative approach`);
        }
        // 性能建议
        if (capabilities.length > 10) {
            issues.push({
                type: 'warning',
                message: 'Plugin declares many capabilities, which may impact performance'
            });
            suggestions.push('Consider splitting functionality into multiple focused plugins');
        }
        return {
            compatible: issues.filter(i => i.type === 'error').length === 0,
            issues,
            suggestions
        };
    }
    /**
     * 清理所有注册
     */
    clear() {
        this.registrations.clear();
        this.pluginCapabilities.clear();
        this.emit('capabilities:cleared');
    }
}
exports.PluginCapabilityManager = PluginCapabilityManager;
/**
 * 能力工具函数
 */
exports.CapabilityUtils = {
    /**
     * 获取能力的描述
     */
    getDescription(capability) {
        return exports.CAPABILITY_DESCRIPTIONS[capability] || '未知能力';
    },
    /**
     * 获取能力的优先级
     */
    getPriority(capability) {
        return exports.CAPABILITY_PRIORITY[capability] || 0;
    },
    /**
     * 检查两个能力是否冲突
     */
    areConflicting(cap1, cap2) {
        const conflicts1 = exports.CAPABILITY_CONFLICTS[cap1] || [];
        const conflicts2 = exports.CAPABILITY_CONFLICTS[cap2] || [];
        return conflicts1.includes(cap2) || conflicts2.includes(cap1);
    },
    /**
     * 获取能力的依赖
     */
    getDependencies(capability) {
        return exports.CAPABILITY_DEPENDENCIES[capability] || [];
    },
    /**
     * 获取能力所需的权限
     */
    getRequiredPermissions(capability) {
        return plugin_1.CAPABILITY_PERMISSIONS[capability] || [];
    },
    /**
     * 按优先级排序能力
     */
    sortByPriority(capabilities) {
        return capabilities.sort((a, b) => exports.CAPABILITY_PRIORITY[b] - exports.CAPABILITY_PRIORITY[a]);
    }
};
//# sourceMappingURL=PluginCapabilities.js.map