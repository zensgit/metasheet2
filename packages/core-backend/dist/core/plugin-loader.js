/**
 * 插件加载器
 */
import * as path from 'path';
import * as fs from 'fs/promises';
import { glob } from 'glob';
import { EventEmitter } from 'eventemitter3';
import { createPluginContext } from './plugin-context';
import { Logger } from './logger';
import { ManifestValidator } from './PluginManifestValidator';
export class PluginLoader extends EventEmitter {
    plugins = new Map();
    loadOrder = [];
    coreAPI;
    logger;
    manifestValidator;
    lastSummary = { scannedDirs: 0, manifests: 0, validManifests: 0, loaded: 0, activated: 0, errors: [], timestamp: new Date().toISOString() };
    constructor(coreAPI) {
        super();
        this.coreAPI = coreAPI;
        this.logger = new Logger('PluginLoader');
        this.manifestValidator = new ManifestValidator();
    }
    /**
     * 加载所有插件
     */
    async loadPlugins() {
        this.logger.info('Starting plugin loading...');
        const summaryErrors = [];
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
            // 5. 按序加载插件（单个失败不影响整体）
            for (const manifest of sortedManifests) {
                try {
                    await this.loadPlugin(manifest);
                }
                catch (e) {
                    const msg = (e && e.message) ? e.message : String(e);
                    summaryErrors.push({ plugin: manifest.name, message: msg });
                    // continue
                }
            }
            // 6. 激活所有插件（激活失败也仅记录）
            try {
                await this.activatePlugins();
            }
            catch (e) {
                const msg = (e && e.message) ? e.message : String(e);
                summaryErrors.push({ message: `activate: ${msg}` });
            }
            this.logger.info(`Successfully loaded ${this.plugins.size} plugins`);
            this.lastSummary = {
                scannedDirs: pluginDirs.length,
                manifests: manifests.length,
                validManifests: validManifests.length,
                loaded: this.plugins.size,
                activated: Array.from(this.plugins.values()).filter(p => p.status === 'active').length,
                errors: summaryErrors.slice(0, 10),
                timestamp: new Date().toISOString()
            };
        }
        catch (error) {
            this.logger.error('Failed to load plugins (top-level)', error);
            const msg = error?.message || String(error);
            summaryErrors.push({ message: msg });
            this.lastSummary = {
                scannedDirs: this.lastSummary.scannedDirs,
                manifests: this.lastSummary.manifests,
                validManifests: this.lastSummary.validManifests,
                loaded: this.plugins.size,
                activated: Array.from(this.plugins.values()).filter(p => p.status === 'active').length,
                errors: summaryErrors.slice(0, 10),
                timestamp: new Date().toISOString()
            };
            // 不再抛出，保证启动继续
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
            path.resolve(process.cwd(), 'plugins', '*'), // Local plugins in core-backend/plugins
            path.join(process.cwd(), 'node_modules', '@metasheet', 'plugin-*')
        ];
        const dirs = [];
        for (const pattern of patterns) {
            try {
                const matches = await glob(pattern);
                // Filter to only directories
                const dirMatches = [];
                for (const match of matches) {
                    const stat = await import('fs').then(fs => fs.promises.stat(match));
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
            const context = createPluginContext(manifest, this.coreAPI);
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
            const pluginModule = await import(pluginPath);
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
        const perms = manifest.permissions;
        if (!perms) {
            this.logger.debug(`No permissions declared for ${manifest.name}`);
            return;
        }
        // Support both old array format and new V2 object format
        if (Array.isArray(perms)) {
            // Old format: string[]
            for (const permission of perms) {
                this.logger.debug(`Checking permission: ${permission}`);
            }
        }
        else {
            // New V2 format: object with database/http/filesystem
            if (perms.database) {
                const dbPerms = perms.database;
                if (dbPerms.read) {
                    this.logger.debug(`Database read permissions: ${dbPerms.read.join(', ')}`);
                }
                if (dbPerms.write) {
                    this.logger.debug(`Database write permissions: ${dbPerms.write.join(', ')}`);
                }
            }
            if (perms.http) {
                const httpPerms = perms.http;
                if (httpPerms.internal) {
                    this.logger.debug(`HTTP internal access: enabled`);
                }
                if (httpPerms.external) {
                    this.logger.debug(`HTTP external domains: ${httpPerms.external.join(', ')}`);
                }
            }
            if (perms.filesystem) {
                const fsPerms = perms.filesystem;
                if (fsPerms.read) {
                    this.logger.debug(`Filesystem read paths: ${fsPerms.read.join(', ')}`);
                }
                if (fsPerms.write) {
                    this.logger.debug(`Filesystem write paths: ${fsPerms.write.join(', ')}`);
                }
            }
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
            const { eventBus } = await import('../integration/events/event-bus');
            const { messageBus } = await import('../integration/messaging/message-bus');
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
     * 获取插件加载摘要
     */
    getSummary() {
        return { ...this.lastSummary };
    }
    /**
     * 获取扁平列表（用于HTTP返回）
     */
    getList() {
        return Array.from(this.plugins.entries()).map(([name, instance]) => ({
            name,
            version: instance.manifest.version,
            displayName: instance.manifest.displayName,
            status: instance.status
        }));
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
        const instance = this.plugins.get(name);
        if (!instance) {
            throw new Error(`Plugin ${name} not found for reload`);
        }
        // 保存插件路径信息用于重新加载
        const pluginPath = instance.manifest.path;
        if (!pluginPath) {
            throw new Error(`Plugin ${name} has no path information for reload`);
        }
        this.logger.info(`Reloading plugin: ${name}`);
        this.emit('plugin:reloading', name);
        // 卸载插件
        await this.unloadPlugin(name);
        // 重新加载 manifest
        const manifestPath = path.join(pluginPath, 'plugin.json');
        let manifest;
        try {
            const content = await fs.readFile(manifestPath, 'utf-8');
            manifest = JSON.parse(content);
            manifest.path = pluginPath;
        }
        catch (error) {
            this.logger.error(`Failed to reload manifest for ${name}`, error);
            this.emit('plugin:reload:failed', { name, error });
            throw new Error(`Failed to reload manifest for ${name}: ${error.message}`);
        }
        // 验证 manifest
        if (!this.validateManifest(manifest)) {
            this.emit('plugin:reload:failed', { name, error: 'Manifest validation failed' });
            throw new Error(`Manifest validation failed for ${name}`);
        }
        // 重新加载插件并记录指标
        const start = process.hrtime.bigint();
        try {
            await this.loadPlugin(manifest);
            const durSec = Number(process.hrtime.bigint() - start) / 1e9;
            try {
                // 动态导入避免潜在循环依赖
                const { metrics } = await import('../metrics/metrics');
                metrics.pluginReloadTotal.inc({ plugin_name: name, result: 'success' });
                metrics.pluginReloadDuration.observe({ plugin_name: name }, durSec);
            }
            catch { }
            this.logger.info(`Plugin ${name} reloaded successfully in ${durSec.toFixed(3)}s`);
            this.emit('plugin:reloaded', name);
        }
        catch (error) {
            const durSec = Number(process.hrtime.bigint() - start) / 1e9;
            try {
                const { metrics } = await import('../metrics/metrics');
                metrics.pluginReloadTotal.inc({ plugin_name: name, result: 'failure' });
                metrics.pluginReloadDuration.observe({ plugin_name: name }, durSec);
            }
            catch { }
            this.logger.error(`Failed to reload plugin ${name}`, error);
            this.emit('plugin:reload:failed', { name, error });
            throw error;
        }
    }
}
//# sourceMappingURL=plugin-loader.js.map