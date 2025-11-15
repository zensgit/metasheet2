"use strict";
/**
 * 插件加载器
 */
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.PluginLoader = void 0;
const path = __importStar(require("path"));
const fs = __importStar(require("fs/promises"));
const glob_1 = require("glob");
const eventemitter3_1 = require("eventemitter3");
const plugin_context_1 = require("./plugin-context");
const logger_1 = require("./logger");
const PluginManifestValidator_1 = require("./PluginManifestValidator");
class PluginLoader extends eventemitter3_1.EventEmitter {
    plugins = new Map();
    loadOrder = [];
    coreAPI;
    logger;
    manifestValidator;
    constructor(coreAPI) {
        super();
        this.coreAPI = coreAPI;
        this.logger = new logger_1.Logger('PluginLoader');
        this.manifestValidator = new PluginManifestValidator_1.ManifestValidator();
    }
    /**
     * 加载所有插件
     */
    async loadPlugins() {
        this.logger.info('Starting plugin loading...');
        try {
            // 1. 扫描插件目录
            const pluginDirs = await this.scanPluginDirectories();
            this.logger.info(`Found ${pluginDirs.length} plugin directories`);
            // 2. 读取所有插件配置
            const manifests = await this.loadManifests(pluginDirs);
            this.logger.info(`Loaded ${manifests.length} plugin manifests`);
            // 3. 验证插件
            const validManifests = manifests.filter(m => this.validateManifest(m));
            this.logger.info(`${validManifests.length} plugins passed validation`);
            // 4. 解析依赖关系并排序
            const sortedManifests = this.topologicalSort(validManifests);
            // 5. 按序加载插件
            for (const manifest of sortedManifests) {
                await this.loadPlugin(manifest);
            }
            // 6. 激活所有插件
            await this.activatePlugins();
            this.logger.info(`Successfully loaded ${this.plugins.size} plugins`);
        }
        catch (error) {
            this.logger.error('Failed to load plugins', error);
            throw error;
        }
    }
    /**
     * 扫描插件目录
     */
    async scanPluginDirectories() {
        // Look for plugins in metasheet-v2 root (all plugins/*) and installed namespace packages
        const rootDir = path.resolve(process.cwd(), '../../');
        const patterns = [
            path.join(rootDir, 'plugins', '*'),
            path.join(process.cwd(), 'node_modules', '@metasheet', 'plugin-*')
        ];
        const dirs = [];
        for (const pattern of patterns) {
            try {
                const matches = await (0, glob_1.glob)(pattern);
                // Filter to only directories
                const dirMatches = [];
                for (const match of matches) {
                    const stat = await Promise.resolve().then(() => __importStar(require('fs'))).then(fs => fs.promises.stat(match));
                    if (stat.isDirectory()) {
                        dirMatches.push(match);
                    }
                }
                dirs.push(...dirMatches);
            }
            catch (e) {
                // Ignore glob errors for now
            }
        }
        return dirs;
    }
    /**
     * 加载插件配置文件
     */
    async loadManifests(dirs) {
        const manifests = [];
        for (const dir of dirs) {
            try {
                const manifestPath = path.join(dir, 'plugin.json');
                const content = await fs.readFile(manifestPath, 'utf-8');
                const manifest = JSON.parse(content);
                manifest.path = dir;
                manifests.push(manifest);
            }
            catch (error) {
                this.logger.warn(`Failed to load manifest from ${dir}`, error);
            }
        }
        return manifests;
    }
    /**
     * 验证插件配置
     */
    validateManifest(manifest) {
        // 使用增强的manifest validator进行全面验证
        const result = this.manifestValidator.validate(manifest);
        // 记录错误和警告
        if (result.errors.length > 0) {
            this.logger.error(`Manifest validation failed for ${manifest.name}:`);
            result.errors.forEach(error => {
                this.logger.error(`  - ${error}`);
            });
            return false;
        }
        if (result.warnings.length > 0) {
            this.logger.warn(`Manifest validation warnings for ${manifest.name}:`);
            result.warnings.forEach(warning => {
                this.logger.warn(`  - ${warning}`);
            });
        }
        return true;
    }
    /**
     * 拓扑排序（处理依赖关系）
     */
    topologicalSort(manifests) {
        const sorted = [];
        const visited = new Set();
        const visiting = new Set();
        const manifestMap = new Map();
        for (const manifest of manifests) {
            manifestMap.set(manifest.name, manifest);
        }
        const visit = (name) => {
            if (visited.has(name))
                return;
            if (visiting.has(name)) {
                throw new Error(`Circular dependency detected: ${name}`);
            }
            visiting.add(name);
            const manifest = manifestMap.get(name);
            if (manifest) {
                // 处理依赖
                const deps = [
                    ...Object.keys(manifest.dependencies || {}),
                    ...Object.keys(manifest.peerDependencies || {})
                ];
                for (const dep of deps) {
                    if (manifestMap.has(dep)) {
                        visit(dep);
                    }
                }
                sorted.push(manifest);
            }
            visiting.delete(name);
            visited.add(name);
        };
        for (const manifest of manifests) {
            visit(manifest.name);
        }
        return sorted;
    }
    /**
     * 加载单个插件
     */
    async loadPlugin(manifest) {
        this.logger.info(`Loading plugin: ${manifest.name}`);
        try {
            // 检查权限
            this.checkPermissions(manifest);
            // 创建插件上下文
            const context = (0, plugin_context_1.createPluginContext)(manifest, this.coreAPI);
            // 解析插件入口：支持纯 JS 源码 main，或 main.backend，或 dist/index.js
            let pluginPath;
            if (typeof manifest.main === 'string') {
                pluginPath = path.join(manifest.path || manifest.name, manifest.main);
            }
            else if (manifest.main?.backend) {
                pluginPath = path.join(manifest.path || manifest.name, manifest.main.backend);
            }
            else {
                pluginPath = path.join(manifest.path || manifest.name, 'dist', 'index.js');
            }
            const pluginModule = await Promise.resolve(`${pluginPath}`).then(s => __importStar(require(s)));
            const PluginClass = pluginModule.default || pluginModule;
            // 创建插件实例
            let plugin;
            if (typeof PluginClass === 'function') {
                plugin = new PluginClass();
            }
            else if (typeof pluginModule.onLoad === 'function' || typeof pluginModule.activate === 'function') {
                // 直接使用导出的生命周期对象
                plugin = pluginModule;
            }
            else {
                plugin = PluginClass;
            }
            // 创建插件实例记录
            const instance = {
                manifest,
                plugin,
                context,
                status: 'loaded'
            };
            // 执行安装钩子
            if (plugin.install) {
                await plugin.install(context);
            }
            else if (plugin.onLoad) {
                await plugin.onLoad(context);
            }
            // 注册插件
            this.plugins.set(manifest.name, instance);
            this.loadOrder.push(manifest.name);
            this.logger.info(`Plugin ${manifest.name} loaded successfully`);
            this.emit('plugin:loaded', manifest.name);
        }
        catch (error) {
            this.logger.error(`Failed to load plugin ${manifest.name}`, error);
            this.emit('plugin:error', { plugin: manifest.name, error });
            // Continue loading other plugins instead of failing completely
            this.logger.warn(`Skipping plugin ${manifest.name} and continuing...`);
        }
    }
    /**
     * 检查权限
     */
    checkPermissions(manifest) {
        // TODO: 实现权限检查逻辑
        const requiredPermissions = manifest.permissions || [];
        for (const permission of requiredPermissions) {
            this.logger.debug(`Checking permission: ${permission}`);
            // 验证权限是否合法
        }
    }
    /**
     * 激活所有插件
     */
    async activatePlugins() {
        for (const name of this.loadOrder) {
            const instance = this.plugins.get(name);
            if (instance && instance.status === 'loaded') {
                try {
                    await instance.plugin.activate(instance.context);
                    instance.status = 'active';
                    this.logger.info(`Plugin ${name} activated`);
                    this.emit('plugin:activated', name);
                }
                catch (error) {
                    instance.status = 'error';
                    this.logger.error(`Failed to activate plugin ${name}`, error);
                    this.emit('plugin:error', { plugin: name, error });
                }
            }
        }
    }
    /**
     * 停用插件
     */
    async deactivatePlugin(name) {
        const instance = this.plugins.get(name);
        if (!instance) {
            throw new Error(`Plugin ${name} not found`);
        }
        if (instance.status === 'active' && instance.plugin.deactivate) {
            await instance.plugin.deactivate();
            instance.status = 'inactive';
            this.logger.info(`Plugin ${name} deactivated`);
            this.emit('plugin:deactivated', name);
        }
    }
    /**
     * 卸载插件
     */
    async unloadPlugin(name) {
        const instance = this.plugins.get(name);
        if (!instance) {
            throw new Error(`Plugin ${name} not found`);
        }
        // 先停用
        await this.deactivatePlugin(name);
        // 执行卸载钩子
        if (instance.plugin.uninstall) {
            await instance.plugin.uninstall();
        }
        // 移除插件
        this.plugins.delete(name);
        const index = this.loadOrder.indexOf(name);
        if (index > -1) {
            this.loadOrder.splice(index, 1);
        }
        // 事件 / 消息 订阅清理（按插件名）
        try {
            // Lazy import to avoid circular issues
            const { eventBus } = await Promise.resolve().then(() => __importStar(require('../integration/events/event-bus')));
            const { messageBus } = await Promise.resolve().then(() => __importStar(require('../integration/messaging/message-bus')));
            const evRemoved = eventBus.unsubscribeByPlugin(name);
            const msgRemoved = messageBus.unsubscribeByPlugin(name);
            this.logger.info(`Cleaned subscriptions for ${name}`, { events: evRemoved, messages: msgRemoved });
        }
        catch (e) {
            this.logger.warn(`Subscription cleanup failed for ${name}`, e);
        }
        this.logger.info(`Plugin ${name} unloaded`);
        this.emit('plugin:unloaded', name);
    }
    /**
     * 获取所有插件
     */
    getPlugins() {
        return new Map(this.plugins);
    }
    /**
     * 获取单个插件
     */
    getPlugin(name) {
        return this.plugins.get(name);
    }
    /**
     * 重新加载插件
     */
    async reloadPlugin(name) {
        await this.unloadPlugin(name);
        // TODO: 重新扫描并加载插件
    }
}
exports.PluginLoader = PluginLoader;
//# sourceMappingURL=plugin-loader.js.map