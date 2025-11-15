"use strict";
/**
 * 插件注册中心
 * 提供插件的集中管理、生命周期控制、依赖管理等功能
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.PluginRegistry = void 0;
const eventemitter3_1 = require("eventemitter3");
const semver_1 = __importDefault(require("semver"));
const plugin_1 = require("../types/plugin");
const plugin_2 = require("../types/plugin");
const plugin_loader_1 = require("./plugin-loader");
const logger_1 = require("./logger");
/**
 * 插件依赖解析器
 */
class DependencyResolver {
    logger;
    constructor() {
        this.logger = new logger_1.Logger('DependencyResolver');
    }
    /**
     * 解析插件依赖关系
     */
    resolveDependencies(plugins, targetPlugin) {
        const pluginMap = new Map();
        const order = [];
        const visited = new Set();
        const visiting = new Set();
        const conflicts = [];
        const missing = [];
        // 构建插件映射
        for (const plugin of plugins) {
            pluginMap.set(plugin.name, plugin);
        }
        // 深度优先搜索
        const visit = (pluginName) => {
            if (visited.has(pluginName)) {
                return true;
            }
            if (visiting.has(pluginName)) {
                conflicts.push(`Circular dependency detected: ${pluginName}`);
                return false;
            }
            const plugin = pluginMap.get(pluginName);
            if (!plugin) {
                missing.push(pluginName);
                return false;
            }
            visiting.add(pluginName);
            // 处理依赖
            const dependencies = [
                ...Object.keys(plugin.dependencies || {}),
                ...Object.keys(plugin.peerDependencies || {})
            ];
            for (const depName of dependencies) {
                if (!visit(depName)) {
                    return false;
                }
                // 版本兼容性检查
                const depPlugin = pluginMap.get(depName);
                if (depPlugin) {
                    const requiredVersion = plugin.dependencies?.[depName] || plugin.peerDependencies?.[depName];
                    if (requiredVersion && !semver_1.default.satisfies(depPlugin.version, requiredVersion)) {
                        conflicts.push(`Version conflict: ${pluginName} requires ${depName}@${requiredVersion}, ` +
                            `but found ${depPlugin.version}`);
                    }
                }
            }
            visiting.delete(pluginName);
            visited.add(pluginName);
            order.push(pluginName);
            return true;
        };
        // 如果指定了目标插件，只解析该插件的依赖
        if (targetPlugin) {
            visit(targetPlugin);
        }
        else {
            // 解析所有插件
            for (const plugin of plugins) {
                visit(plugin.name);
            }
        }
        return { order, conflicts, missing };
    }
    /**
     * 检查插件能力依赖
     */
    checkCapabilityDependencies(plugin, availableCapabilities) {
        const missing = [];
        if (plugin.contributes) {
            // 检查视图依赖
            if (plugin.contributes.views) {
                for (const view of plugin.contributes.views) {
                    if (view.depends && view.depends.length > 0) {
                        for (const capability of view.depends) {
                            if (!this.hasCapability(capability, availableCapabilities)) {
                                missing.push(`View capability dependency missing: ${capability}`);
                            }
                        }
                    }
                }
            }
            // 检查工作流依赖
            if (plugin.contributes.actions) {
                for (const action of plugin.contributes.actions) {
                    if (action.depends && action.depends.length > 0) {
                        for (const capability of action.depends) {
                            if (!this.hasCapability(capability, availableCapabilities)) {
                                missing.push(`Action capability dependency missing: ${capability}`);
                            }
                        }
                    }
                }
            }
        }
        return missing;
    }
    hasCapability(capability, availableCapabilities) {
        for (const [, capabilities] of availableCapabilities) {
            if (capabilities.includes(capability)) {
                return true;
            }
        }
        return false;
    }
}
/**
 * 插件注册中心实现
 */
class PluginRegistry extends eventemitter3_1.EventEmitter {
    registrations = new Map();
    loader;
    dependencyResolver;
    logger;
    capabilities = new Map();
    constructor(coreAPI) {
        super();
        this.loader = new plugin_loader_1.PluginLoader(coreAPI);
        this.dependencyResolver = new DependencyResolver();
        this.logger = new logger_1.Logger('PluginRegistry');
        // 监听插件加载器事件
        this.setupLoaderListeners();
    }
    setupLoaderListeners() {
        this.loader.on('plugin:loaded', (pluginName) => {
            this.updatePluginStatus(pluginName, plugin_1.PluginStatus.ENABLED);
            this.emit(plugin_1.PluginEvent.ENABLED, pluginName);
        });
        this.loader.on('plugin:activated', (pluginName) => {
            this.updatePluginStatus(pluginName, plugin_1.PluginStatus.ENABLED);
            const registration = this.registrations.get(pluginName);
            if (registration) {
                registration.lastActivated = new Date();
            }
        });
        this.loader.on('plugin:error', ({ plugin, error }) => {
            this.updatePluginStatus(plugin, plugin_1.PluginStatus.ERROR, error.message);
            this.emit(plugin_1.PluginEvent.ERROR, { plugin, error });
        });
    }
    /**
     * 注册插件
     */
    async registerPlugin(manifest) {
        try {
            this.logger.info(`Registering plugin: ${manifest.name}`);
            // 验证插件清单
            this.validateManifest(manifest);
            // 检查插件是否已注册
            if (this.registrations.has(manifest.name)) {
                throw new Error(`Plugin ${manifest.name} is already registered`);
            }
            // 解析插件能力
            const capabilities = this.extractCapabilities(manifest);
            // 检查权限兼容性
            this.validatePermissions(manifest, capabilities);
            // 创建注册信息
            const registration = {
                manifest,
                capabilities,
                dependencies: this.extractDependencies(manifest),
                status: plugin_1.PluginStatus.INSTALLED,
                installedAt: new Date()
            };
            // 保存注册信息
            this.registrations.set(manifest.name, registration);
            this.capabilities.set(manifest.name, capabilities);
            this.logger.info(`Plugin registered successfully: ${manifest.name}`);
            this.emit(plugin_1.PluginEvent.INSTALLED, manifest.name);
            return registration;
        }
        catch (error) {
            this.logger.error(`Failed to register plugin ${manifest.name}`, error);
            throw error;
        }
    }
    /**
     * 启用插件
     */
    async enablePlugin(pluginName) {
        const registration = this.registrations.get(pluginName);
        if (!registration) {
            throw new Error(`Plugin ${pluginName} is not registered`);
        }
        if (registration.status === plugin_1.PluginStatus.ENABLED) {
            this.logger.warn(`Plugin ${pluginName} is already enabled`);
            return;
        }
        try {
            // 检查依赖关系
            await this.checkDependencies(pluginName);
            // 更新状态
            this.updatePluginStatus(pluginName, plugin_1.PluginStatus.LOADING);
            // 通过加载器启用插件（使用公开API，而非调用私有方法）
            // 此处简单复用 Loader 的单个加载流程
            await this.loader.loadPlugin(registration.manifest);
            this.logger.info(`Plugin enabled: ${pluginName}`);
        }
        catch (error) {
            this.updatePluginStatus(pluginName, plugin_1.PluginStatus.ERROR, error.message);
            this.logger.error(`Failed to enable plugin ${pluginName}`, error);
            throw error;
        }
    }
    /**
     * 禁用插件
     */
    async disablePlugin(pluginName) {
        const registration = this.registrations.get(pluginName);
        if (!registration) {
            throw new Error(`Plugin ${pluginName} is not registered`);
        }
        if (registration.status === plugin_1.PluginStatus.DISABLED) {
            this.logger.warn(`Plugin ${pluginName} is already disabled`);
            return;
        }
        try {
            // 检查是否有其他插件依赖此插件
            this.checkReverseDependencies(pluginName);
            // 通过加载器停用插件
            await this.loader.deactivatePlugin(pluginName);
            // 更新状态
            this.updatePluginStatus(pluginName, plugin_1.PluginStatus.DISABLED);
            this.logger.info(`Plugin disabled: ${pluginName}`);
            this.emit(plugin_1.PluginEvent.DISABLED, pluginName);
        }
        catch (error) {
            this.logger.error(`Failed to disable plugin ${pluginName}`, error);
            throw error;
        }
    }
    /**
     * 卸载插件
     */
    async uninstallPlugin(pluginName) {
        const registration = this.registrations.get(pluginName);
        if (!registration) {
            throw new Error(`Plugin ${pluginName} is not registered`);
        }
        try {
            // 先禁用插件
            if (registration.status === plugin_1.PluginStatus.ENABLED) {
                await this.disablePlugin(pluginName);
            }
            // 通过加载器卸载插件
            await this.loader.unloadPlugin(pluginName);
            // 移除注册信息
            this.registrations.delete(pluginName);
            this.capabilities.delete(pluginName);
            this.logger.info(`Plugin uninstalled: ${pluginName}`);
            this.emit(plugin_1.PluginEvent.UNINSTALLED, pluginName);
        }
        catch (error) {
            this.logger.error(`Failed to uninstall plugin ${pluginName}`, error);
            throw error;
        }
    }
    /**
     * 更新插件
     */
    async updatePlugin(pluginName, newManifest) {
        const registration = this.registrations.get(pluginName);
        if (!registration) {
            throw new Error(`Plugin ${pluginName} is not registered`);
        }
        try {
            const wasEnabled = registration.status === plugin_1.PluginStatus.ENABLED;
            // 更新状态
            this.updatePluginStatus(pluginName, plugin_1.PluginStatus.UPDATING);
            // 如果插件已启用，先禁用
            if (wasEnabled) {
                await this.disablePlugin(pluginName);
            }
            // 验证新清单
            this.validateManifest(newManifest);
            // 检查版本
            if (!semver_1.default.gt(newManifest.version, registration.manifest.version)) {
                throw new Error(`New version ${newManifest.version} is not greater than current version ${registration.manifest.version}`);
            }
            // 更新注册信息
            registration.manifest = newManifest;
            registration.capabilities = this.extractCapabilities(newManifest);
            registration.dependencies = this.extractDependencies(newManifest);
            // 如果原本启用，重新启用
            if (wasEnabled) {
                await this.enablePlugin(pluginName);
            }
            else {
                this.updatePluginStatus(pluginName, plugin_1.PluginStatus.INSTALLED);
            }
            this.logger.info(`Plugin updated: ${pluginName} to version ${newManifest.version}`);
        }
        catch (error) {
            this.updatePluginStatus(pluginName, plugin_1.PluginStatus.ERROR, error.message);
            this.logger.error(`Failed to update plugin ${pluginName}`, error);
            throw error;
        }
    }
    /**
     * 获取插件注册信息
     */
    getPlugin(pluginName) {
        return this.registrations.get(pluginName) || null;
    }
    /**
     * 获取所有插件
     */
    getAllPlugins() {
        return Array.from(this.registrations.values());
    }
    /**
     * 按状态获取插件
     */
    getPluginsByStatus(status) {
        return Array.from(this.registrations.values()).filter(p => p.status === status);
    }
    /**
     * 按能力获取插件
     */
    getPluginsByCapability(capability) {
        return Array.from(this.registrations.values()).filter(p => p.capabilities.includes(capability));
    }
    /**
     * 检查插件依赖
     */
    async checkDependencies(pluginName) {
        const allManifests = Array.from(this.registrations.values()).map(r => r.manifest);
        const { conflicts, missing } = this.dependencyResolver.resolveDependencies(allManifests, pluginName);
        if (conflicts.length > 0) {
            throw new Error(`Dependency conflicts: ${conflicts.join('; ')}`);
        }
        if (missing.length > 0) {
            throw new Error(`Missing dependencies: ${missing.join(', ')}`);
        }
        // 检查能力依赖
        const registration = this.registrations.get(pluginName);
        const missingCapabilities = this.dependencyResolver.checkCapabilityDependencies(registration.manifest, this.capabilities);
        if (missingCapabilities.length > 0) {
            throw new Error(`Missing capabilities: ${missingCapabilities.join(', ')}`);
        }
    }
    /**
     * 检查反向依赖
     */
    checkReverseDependencies(pluginName) {
        const dependents = [];
        for (const [name, registration] of this.registrations) {
            if (name === pluginName || registration.status !== plugin_1.PluginStatus.ENABLED) {
                continue;
            }
            const dependencies = [
                ...Object.keys(registration.manifest.dependencies || {}),
                ...Object.keys(registration.manifest.peerDependencies || {})
            ];
            if (dependencies.includes(pluginName)) {
                dependents.push(name);
            }
        }
        if (dependents.length > 0) {
            throw new Error(`Cannot disable plugin ${pluginName}: it is required by ${dependents.join(', ')}`);
        }
    }
    /**
     * 验证插件清单
     */
    validateManifest(manifest) {
        if (!manifest.name || !manifest.version) {
            throw new Error('Plugin manifest must include name and version');
        }
        if (!semver_1.default.valid(manifest.version)) {
            throw new Error(`Invalid version format: ${manifest.version}`);
        }
        if (!manifest.engines?.metasheet) {
            throw new Error('Plugin manifest must specify metasheet engine version');
        }
    }
    /**
     * 提取插件能力
     */
    extractCapabilities(manifest) {
        const capabilities = [];
        if (manifest.contributes) {
            const { contributes } = manifest;
            if (contributes.views && contributes.views.length > 0) {
                capabilities.push(plugin_1.PluginCapability.VIEW_PROVIDER);
            }
            if (contributes.fieldTypes && contributes.fieldTypes.length > 0) {
                capabilities.push(plugin_1.PluginCapability.FIELD_TYPE);
            }
            if (contributes.formulas && contributes.formulas.length > 0) {
                capabilities.push(plugin_1.PluginCapability.FORMULA_FUNCTION);
            }
            if (contributes.triggers && contributes.triggers.length > 0) {
                capabilities.push(plugin_1.PluginCapability.TRIGGER_PROVIDER);
            }
            if (contributes.actions && contributes.actions.length > 0) {
                capabilities.push(plugin_1.PluginCapability.ACTION_PROVIDER);
            }
            if (contributes.commands && contributes.commands.length > 0) {
                capabilities.push(plugin_1.PluginCapability.API_ENDPOINT);
            }
            if (contributes.menus) {
                capabilities.push(plugin_1.PluginCapability.MENU_ITEM);
            }
        }
        return capabilities;
    }
    /**
     * 提取插件依赖
     */
    extractDependencies(manifest) {
        const dependencies = [];
        // 处理普通依赖
        if (manifest.dependencies) {
            for (const [name, version] of Object.entries(manifest.dependencies)) {
                dependencies.push({ name, version, optional: false });
            }
        }
        // 处理对等依赖
        if (manifest.peerDependencies) {
            for (const [name, version] of Object.entries(manifest.peerDependencies)) {
                dependencies.push({ name, version, optional: true });
            }
        }
        return dependencies;
    }
    /**
     * 验证权限
     */
    validatePermissions(manifest, capabilities) {
        const requiredPermissions = new Set();
        // 根据能力计算所需权限
        for (const capability of capabilities) {
            const permissions = plugin_2.CAPABILITY_PERMISSIONS[capability] || [];
            permissions.forEach(p => requiredPermissions.add(p));
        }
        // 检查清单中的权限是否包含所需权限
        const manifestPermissions = new Set(manifest.permissions || []);
        for (const required of requiredPermissions) {
            if (!manifestPermissions.has(required) && !manifestPermissions.has('*')) {
                this.logger.warn(`Plugin ${manifest.name} capability ${capabilities} requires permission ${required} ` +
                    `but it's not declared in manifest`);
            }
        }
    }
    /**
     * 更新插件状态
     */
    updatePluginStatus(pluginName, status, error) {
        const registration = this.registrations.get(pluginName);
        if (registration) {
            registration.status = status;
            if (error) {
                registration.error = error;
            }
            else {
                delete registration.error;
            }
        }
    }
    /**
     * 获取统计信息
     */
    getStats() {
        const stats = {
            total: this.registrations.size,
            enabled: 0,
            disabled: 0,
            error: 0,
            capabilities: {}
        };
        // 初始化能力计数
        for (const capability of Object.values(plugin_1.PluginCapability)) {
            stats.capabilities[capability] = 0;
        }
        // 统计状态和能力
        for (const registration of this.registrations.values()) {
            switch (registration.status) {
                case plugin_1.PluginStatus.ENABLED:
                    stats.enabled++;
                    break;
                case plugin_1.PluginStatus.DISABLED:
                    stats.disabled++;
                    break;
                case plugin_1.PluginStatus.ERROR:
                    stats.error++;
                    break;
            }
            // 统计能力
            for (const capability of registration.capabilities) {
                stats.capabilities[capability]++;
            }
        }
        return stats;
    }
    /**
     * 获取依赖图
     */
    getDependencyGraph() {
        const graph = {};
        for (const [name, registration] of this.registrations) {
            graph[name] = registration.dependencies.map(dep => dep.name);
        }
        return graph;
    }
}
exports.PluginRegistry = PluginRegistry;
//# sourceMappingURL=plugin-registry.js.map