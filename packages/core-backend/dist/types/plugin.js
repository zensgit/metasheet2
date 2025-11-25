/**
 * 插件系统核心类型定义
 * Last updated: 2025-11-03 (Batch 1 完成)
 */
/**
 * 插件状态
 */
export var PluginStatus;
(function (PluginStatus) {
    PluginStatus["DISCOVERED"] = "discovered";
    PluginStatus["LOADING"] = "loading";
    PluginStatus["INSTALLED"] = "installed";
    PluginStatus["ENABLED"] = "enabled";
    PluginStatus["DISABLED"] = "disabled";
    PluginStatus["UPDATING"] = "updating";
    PluginStatus["ERROR"] = "error";
})(PluginStatus || (PluginStatus = {}));
/**
 * 插件能力标识
 */
export var PluginCapability;
(function (PluginCapability) {
    PluginCapability["DATABASE"] = "database";
    PluginCapability["HTTP"] = "http";
    PluginCapability["WEBSOCKET"] = "websocket";
    PluginCapability["STORAGE"] = "storage";
    PluginCapability["SCHEDULER"] = "scheduler";
    PluginCapability["NOTIFICATION"] = "notification";
    PluginCapability["VIEW_PROVIDER"] = "view_provider";
    PluginCapability["FIELD_TYPE"] = "field_type";
    PluginCapability["FORMULA_FUNCTION"] = "formula_function";
    PluginCapability["TRIGGER_PROVIDER"] = "trigger_provider";
    PluginCapability["ACTION_PROVIDER"] = "action_provider";
    PluginCapability["API_ENDPOINT"] = "api_endpoint";
    PluginCapability["MENU_ITEM"] = "menu_item";
})(PluginCapability || (PluginCapability = {}));
/**
 * 能力权限映射
 */
export const CAPABILITY_PERMISSIONS = {
    [PluginCapability.DATABASE]: ['database.read', 'database.write'],
    [PluginCapability.HTTP]: ['http.request'],
    [PluginCapability.WEBSOCKET]: ['websocket.broadcast', 'websocket.send'],
    [PluginCapability.STORAGE]: ['storage.upload', 'storage.download'],
    [PluginCapability.SCHEDULER]: ['scheduler.schedule'],
    [PluginCapability.NOTIFICATION]: ['notification.send'],
    [PluginCapability.VIEW_PROVIDER]: ['view.register'],
    [PluginCapability.FIELD_TYPE]: ['field.register'],
    [PluginCapability.FORMULA_FUNCTION]: ['formula.register'],
    [PluginCapability.TRIGGER_PROVIDER]: ['trigger.register'],
    [PluginCapability.ACTION_PROVIDER]: ['action.register'],
    [PluginCapability.API_ENDPOINT]: ['api.register'],
    [PluginCapability.MENU_ITEM]: ['menu.register']
};
/**
 * 插件权限白名单
 *
 * 扩展至35+权限，覆盖10个功能类别
 * @version 2.0 - Expanded from 24 to 37 permissions
 */
export const PERMISSION_WHITELIST = [
    // 数据库权限 (4)
    'database.read',
    'database.write',
    'database.transaction',
    'database.*',
    // HTTP权限 (4)
    'http.addRoute',
    'http.removeRoute',
    'http.request',
    'http.middleware',
    // WebSocket权限 (3)
    'websocket.broadcast',
    'websocket.send',
    'websocket.listen',
    // 事件系统权限 (4)
    'events.emit',
    'events.listen',
    'events.on',
    'events.once',
    'events.off',
    // 存储权限 (4) - Renamed from file.* for clarity
    'storage.read',
    'storage.write',
    'storage.delete',
    'storage.list',
    // 缓存权限 (4)
    'cache.read',
    'cache.write',
    'cache.delete',
    'cache.clear',
    // 队列权限 (3)
    'queue.push',
    'queue.process',
    'queue.cancel',
    // 认证权限 (2) - NEW category, read-only for security
    'auth.verify',
    'auth.checkPermission',
    // 通知权限 (3)
    'notification.send',
    'notification.email',
    'notification.webhook',
    // 指标权限 (2) - NEW category for observability
    'metrics.read',
    'metrics.write',
    // Legacy file.* permissions - DEPRECATED, use storage.* instead
    'file.read',
    'file.write',
    'file.delete'
];
/**
 * 权限组定义 - 用于简化插件配置
 *
 * 注意：这些组主要用于TypeScript/构建脚本中复用
 * plugin.json中仍需展开为具体权限字符串
 *
 * @version 2.0 - Updated with expanded permission whitelist
 */
export const PERMISSION_GROUPS = {
    /**
     * 只读权限组 - 适用于数据分析、监控、报表类插件
     * 提供基础的读取权限和身份验证能力
     */
    readonly: [
        'database.read',
        'storage.read',
        'cache.read',
        'auth.verify',
        'metrics.read'
    ],
    /**
     * 基础权限组 - 适用于简单功能插件、工具类插件
     * 提供基本的读写和HTTP路由能力
     */
    basic: [
        'database.read',
        'http.addRoute',
        'events.emit',
        'cache.read',
        'cache.write',
        'storage.read'
    ],
    /**
     * 标准权限组 - 适用于业务功能插件、集成插件
     * 提供完整的业务开发所需权限
     */
    standard: [
        'database.read',
        'database.write',
        'http.addRoute',
        'websocket.send',
        'events.emit',
        'events.listen',
        'storage.read',
        'storage.write',
        'cache.read',
        'cache.write',
        'queue.push',
        'auth.verify'
    ],
    /**
     * 高级权限组 - 适用于系统管理插件、高级功能插件
     * 提供完整的系统级权限，使用通配符简化配置
     */
    advanced: [
        'database.*',
        'http.addRoute',
        'http.removeRoute',
        'http.request',
        'websocket.broadcast',
        'websocket.send',
        'websocket.listen',
        'events.emit',
        'events.listen',
        'events.on',
        'events.once',
        'storage.read',
        'storage.write',
        'storage.delete',
        'storage.list',
        'cache.read',
        'cache.write',
        'cache.delete',
        'cache.clear',
        'queue.push',
        'queue.process',
        'queue.cancel',
        'auth.verify',
        'auth.checkPermission',
        'notification.send',
        'notification.email',
        'metrics.read',
        'metrics.write'
    ]
};
//# sourceMappingURL=plugin.js.map