/**
 * 插件注册表
 * 提供中心化的插件注册、发现和管理功能
 */
import { EventEmitter } from 'eventemitter3';
import semver from 'semver';
import { PluginStatus } from '../types/plugin';
import { PluginCapabilityManager } from './PluginCapabilities';
import { Logger } from '../core/logger';
/**
 * 插件注册表实现
 */
export class PluginRegistry extends EventEmitter {
    plugins = new Map();
    pluginsByCapability = new Map();
    pluginsByAuthor = new Map();
    pluginTags = new Map();
    dependencyGraph = null;
    capabilityManager;
    database;
    logger;
    constructor(database) {
        super();
        this.database = database;
        this.capabilityManager = new PluginCapabilityManager();
        this.logger = new Logger('PluginRegistry');
        // 监听能力管理器事件
        this.capabilityManager.on('capability:registered', (event) => {
            this.emit('plugin:capability:registered', event);
        });
        this.capabilityManager.on('capability:unregistered', (event) => {
            this.emit('plugin:capability:unregistered', event);
        });
    }
    /**
     * 注册插件
     */
    async register(manifest, capabilities = []) {
        const pluginName = manifest.name;
        try {
            // 验证插件清单
            this.validateManifest(manifest);
            // 验证能力
            const capabilityValidation = this.capabilityManager.validateCapabilities(manifest, capabilities);
            if (!capabilityValidation.valid) {
                throw new Error(`Capability validation failed: ${capabilityValidation.errors.join(', ')}`);
            }
            // 检查版本兼容性
            await this.checkVersionCompatibility(manifest);
            // 检查依赖
            const dependencyCheck = await this.checkDependencies(manifest);
            if (!dependencyCheck.satisfied) {
                throw new Error(`Dependencies not satisfied: ${dependencyCheck.missing.join(', ')}`);
            }
            const existingPlugin = this.plugins.get(pluginName);
            const isUpdate = existingPlugin !== undefined;
            const registration = {
                manifest,
                capabilities,
                dependencies: this.parseDependencies(manifest),
                status: PluginStatus.INSTALLED,
                installedAt: existingPlugin?.installedAt || new Date(),
                lastActivated: existingPlugin?.lastActivated,
                error: undefined
            };
            // 如果是更新，保持之前的状态
            if (isUpdate && existingPlugin) {
                registration.status = existingPlugin.status;
                registration.lastActivated = existingPlugin.lastActivated;
            }
            // 注册插件
            this.plugins.set(pluginName, registration);
            // 更新索引
            this.updateIndexes(pluginName, registration);
            // 持久化到数据库
            if (this.database) {
                await this.persistToDatabase(registration);
            }
            // 重新构建依赖图
            this.rebuildDependencyGraph();
            const eventType = isUpdate ? PluginEvent.INSTALLED : PluginEvent.INSTALLED;
            this.emit(eventType, registration);
            this.logger.info(`${isUpdate ? 'Updated' : 'Registered'} plugin: ${pluginName}`);
            return registration;
        }
        catch (error) {
            this.logger.error(`Failed to register plugin ${pluginName}`, error);
            // 记录错误状态
            if (this.plugins.has(pluginName)) {
                const errorRegistration = this.plugins.get(pluginName);
                errorRegistration.status = PluginStatus.ERROR;
                errorRegistration.error = error.message;
                this.emit(PluginEvent.ERROR, errorRegistration);
            }
            throw error;
        }
    }
    /**
     * 卸载插件
     */
    async unregister(pluginName) {
        const registration = this.plugins.get(pluginName);
        if (!registration) {
            throw new Error(`Plugin not found: ${pluginName}`);
        }
        try {
            // 检查是否有其他插件依赖这个插件
            const dependents = this.findDependents(pluginName);
            if (dependents.length > 0) {
                throw new Error(`Cannot unregister plugin ${pluginName}: it is required by ${dependents.join(', ')}`);
            }
            // 取消注册能力
            this.capabilityManager.unregisterPluginCapabilities(pluginName);
            // 从索引中移除
            this.removeFromIndexes(pluginName, registration);
            // 从主映射中移除
            this.plugins.delete(pluginName);
            // 从数据库中删除
            if (this.database) {
                await this.removeFromDatabase(pluginName);
            }
            // 重新构建依赖图
            this.rebuildDependencyGraph();
            this.emit(PluginEvent.UNINSTALLED, registration);
            this.logger.info(`Unregistered plugin: ${pluginName}`);
        }
        catch (error) {
            this.logger.error(`Failed to unregister plugin ${pluginName}`, error);
            throw error;
        }
    }
    /**
     * 启用插件
     */
    async enable(pluginName) {
        const registration = this.plugins.get(pluginName);
        if (!registration) {
            throw new Error(`Plugin not found: ${pluginName}`);
        }
        if (registration.status === PluginStatus.ENABLED) {
            return; // 已经启用
        }
        try {
            // 检查依赖是否都已启用
            const enabledDependencies = await this.checkEnabledDependencies(pluginName);
            if (!enabledDependencies.satisfied) {
                throw new Error(`Cannot enable plugin ${pluginName}: dependencies not enabled: ${enabledDependencies.missing.join(', ')}`);
            }
            registration.status = PluginStatus.ENABLED;
            registration.lastActivated = new Date();
            registration.error = undefined;
            // 更新数据库
            if (this.database) {
                await this.updatePluginStatus(pluginName, PluginStatus.ENABLED);
            }
            this.emit(PluginEvent.ENABLED, registration);
            this.logger.info(`Enabled plugin: ${pluginName}`);
        }
        catch (error) {
            registration.status = PluginStatus.ERROR;
            registration.error = error.message;
            this.emit(PluginEvent.ERROR, registration);
            this.logger.error(`Failed to enable plugin ${pluginName}`, error);
            throw error;
        }
    }
    /**
     * 禁用插件
     */
    async disable(pluginName) {
        const registration = this.plugins.get(pluginName);
        if (!registration) {
            throw new Error(`Plugin not found: ${pluginName}`);
        }
        if (registration.status === PluginStatus.DISABLED) {
            return; // 已经禁用
        }
        try {
            // 检查是否有启用的插件依赖这个插件
            const enabledDependents = this.findEnabledDependents(pluginName);
            if (enabledDependents.length > 0) {
                throw new Error(`Cannot disable plugin ${pluginName}: it is required by enabled plugins: ${enabledDependents.join(', ')}`);
            }
            registration.status = PluginStatus.DISABLED;
            registration.error = undefined;
            // 取消注册能力
            this.capabilityManager.unregisterPluginCapabilities(pluginName);
            // 更新数据库
            if (this.database) {
                await this.updatePluginStatus(pluginName, PluginStatus.DISABLED);
            }
            this.emit(PluginEvent.DISABLED, registration);
            this.logger.info(`Disabled plugin: ${pluginName}`);
        }
        catch (error) {
            registration.status = PluginStatus.ERROR;
            registration.error = error.message;
            this.emit(PluginEvent.ERROR, registration);
            this.logger.error(`Failed to disable plugin ${pluginName}`, error);
            throw error;
        }
    }
    /**
     * 获取插件
     */
    get(pluginName) {
        return this.plugins.get(pluginName);
    }
    /**
     * 检查插件是否存在
     */
    has(pluginName) {
        return this.plugins.has(pluginName);
    }
    /**
     * 获取所有插件
     */
    getAll() {
        return Array.from(this.plugins.values());
    }
    /**
     * 查询插件
     */
    query(options = {}) {
        let results = Array.from(this.plugins.values());
        if (options.name) {
            results = results.filter(p => p.manifest.name.includes(options.name));
        }
        if (options.status) {
            results = results.filter(p => p.status === options.status);
        }
        if (options.capability) {
            results = results.filter(p => p.capabilities.includes(options.capability));
        }
        if (options.author) {
            results = results.filter(p => p.manifest.author?.includes(options.author));
        }
        if (options.tag) {
            // 搜索标签需要从清单的关键词或描述中匹配
            results = results.filter(p => p.manifest.description?.includes(options.tag) ||
                JSON.stringify(p.manifest).toLowerCase().includes(options.tag.toLowerCase()));
        }
        if (options.version) {
            results = results.filter(p => semver.satisfies(p.manifest.version, options.version));
        }
        if (options.enabled !== undefined) {
            const enabled = options.enabled;
            results = results.filter(p => enabled ? p.status === PluginStatus.ENABLED : p.status !== PluginStatus.ENABLED);
        }
        return results;
    }
    /**
     * 搜索插件
     */
    search(keyword, limit = 10) {
        const results = [];
        const lowerKeyword = keyword.toLowerCase();
        for (const plugin of this.plugins.values()) {
            const manifest = plugin.manifest;
            let score = 0;
            const matchedFields = [];
            // 插件名称匹配（权重最高）
            if (manifest.name.toLowerCase().includes(lowerKeyword)) {
                score += 100;
                matchedFields.push('name');
            }
            // 显示名称匹配
            if (manifest.displayName?.toLowerCase().includes(lowerKeyword)) {
                score += 80;
                matchedFields.push('displayName');
            }
            // 描述匹配
            if (manifest.description?.toLowerCase().includes(lowerKeyword)) {
                score += 60;
                matchedFields.push('description');
            }
            // 作者匹配
            if (manifest.author?.toLowerCase().includes(lowerKeyword)) {
                score += 40;
                matchedFields.push('author');
            }
            // 能力匹配
            const capabilityMatch = plugin.capabilities.some(cap => cap.toLowerCase().includes(lowerKeyword));
            if (capabilityMatch) {
                score += 30;
                matchedFields.push('capabilities');
            }
            if (score > 0) {
                results.push({ plugin, score, matchedFields });
            }
        }
        // 按分数排序并限制结果数量
        return results
            .sort((a, b) => b.score - a.score)
            .slice(0, limit);
    }
    /**
     * 获取具有特定能力的插件
     */
    getByCapability(capability) {
        const pluginNames = this.pluginsByCapability.get(capability);
        if (!pluginNames)
            return [];
        return Array.from(pluginNames)
            .map(name => this.plugins.get(name))
            .filter(Boolean);
    }
    /**
     * 获取作者的所有插件
     */
    getByAuthor(author) {
        const pluginNames = this.pluginsByAuthor.get(author);
        if (!pluginNames)
            return [];
        return Array.from(pluginNames)
            .map(name => this.plugins.get(name))
            .filter(Boolean);
    }
    /**
     * 获取依赖图
     */
    getDependencyGraph() {
        if (!this.dependencyGraph) {
            this.rebuildDependencyGraph();
        }
        return this.dependencyGraph;
    }
    /**
     * 获取插件的依赖
     */
    getDependencies(pluginName) {
        const plugin = this.plugins.get(pluginName);
        if (!plugin)
            return [];
        return plugin.dependencies
            .map(dep => this.plugins.get(dep.name))
            .filter(Boolean);
    }
    /**
     * 获取依赖于指定插件的插件
     */
    getDependents(pluginName) {
        return this.findDependents(pluginName)
            .map(name => this.plugins.get(name))
            .filter(Boolean);
    }
    /**
     * 检查循环依赖
     */
    findCircularDependencies() {
        const graph = this.getDependencyGraph();
        return graph.cycles;
    }
    /**
     * 获取插件统计信息
     */
    getStats() {
        const plugins = Array.from(this.plugins.values());
        return {
            total: plugins.length,
            enabled: plugins.filter(p => p.status === PluginStatus.ENABLED).length,
            disabled: plugins.filter(p => p.status === PluginStatus.DISABLED).length,
            error: plugins.filter(p => p.status === PluginStatus.ERROR).length,
            byCapability: Object.fromEntries(Array.from(this.pluginsByCapability.entries()).map(([cap, plugins]) => [cap, plugins.size])),
            authors: this.pluginsByAuthor.size,
            dependencies: plugins.reduce((sum, p) => sum + p.dependencies.length, 0)
        };
    }
    /**
     * 验证插件清单
     */
    validateManifest(manifest) {
        if (!manifest.name) {
            throw new Error('Plugin name is required');
        }
        if (!manifest.version) {
            throw new Error('Plugin version is required');
        }
        if (!semver.valid(manifest.version)) {
            throw new Error(`Invalid version format: ${manifest.version}`);
        }
        if (!manifest.engines?.metasheet) {
            throw new Error('Plugin engines.metasheet is required');
        }
    }
    /**
     * 检查版本兼容性
     */
    async checkVersionCompatibility(manifest) {
        // 这里可以检查与当前系统版本的兼容性
        const requiredVersion = manifest.engines?.metasheet;
        if (!requiredVersion)
            return;
        // 简化的版本检查，实际应该从系统获取当前版本
        const currentVersion = '1.0.0'; // 应该从配置或环境中获取
        if (!semver.satisfies(currentVersion, requiredVersion)) {
            throw new Error(`Version incompatible: requires ${requiredVersion}, current ${currentVersion}`);
        }
    }
    /**
     * 检查依赖
     */
    async checkDependencies(manifest) {
        const missing = [];
        const conflicts = [];
        const dependencies = this.parseDependencies(manifest);
        for (const dep of dependencies) {
            const depPlugin = this.plugins.get(dep.name);
            if (!depPlugin) {
                if (!dep.optional) {
                    missing.push(dep.name);
                }
                continue;
            }
            // 检查版本兼容性
            if (!semver.satisfies(depPlugin.manifest.version, dep.version)) {
                conflicts.push(`${dep.name}: requires ${dep.version}, found ${depPlugin.manifest.version}`);
            }
            // 检查能力依赖
            if (dep.capabilities) {
                const missingCapabilities = dep.capabilities.filter(cap => !depPlugin.capabilities.includes(cap));
                if (missingCapabilities.length > 0) {
                    conflicts.push(`${dep.name}: missing capabilities ${missingCapabilities.join(', ')}`);
                }
            }
        }
        return {
            satisfied: missing.length === 0 && conflicts.length === 0,
            missing,
            conflicts
        };
    }
    /**
     * 检查已启用的依赖
     */
    async checkEnabledDependencies(pluginName) {
        const plugin = this.plugins.get(pluginName);
        if (!plugin)
            throw new Error(`Plugin not found: ${pluginName}`);
        const missing = [];
        for (const dep of plugin.dependencies) {
            if (dep.optional)
                continue;
            const depPlugin = this.plugins.get(dep.name);
            if (!depPlugin || depPlugin.status !== PluginStatus.ENABLED) {
                missing.push(dep.name);
            }
        }
        return {
            satisfied: missing.length === 0,
            missing
        };
    }
    /**
     * 解析依赖信息
     */
    parseDependencies(manifest) {
        const dependencies = [];
        // 解析 dependencies
        if (manifest.dependencies) {
            for (const [name, version] of Object.entries(manifest.dependencies)) {
                dependencies.push({ name, version });
            }
        }
        // 解析 peerDependencies
        if (manifest.peerDependencies) {
            for (const [name, version] of Object.entries(manifest.peerDependencies)) {
                dependencies.push({ name, version, optional: true });
            }
        }
        return dependencies;
    }
    /**
     * 查找依赖于指定插件的插件
     */
    findDependents(pluginName) {
        const dependents = [];
        for (const [name, registration] of this.plugins.entries()) {
            const hasDependency = registration.dependencies.some(dep => dep.name === pluginName);
            if (hasDependency) {
                dependents.push(name);
            }
        }
        return dependents;
    }
    /**
     * 查找启用的依赖插件
     */
    findEnabledDependents(pluginName) {
        return this.findDependents(pluginName).filter(name => {
            const plugin = this.plugins.get(name);
            return plugin && plugin.status === PluginStatus.ENABLED;
        });
    }
    /**
     * 更新索引
     */
    updateIndexes(pluginName, registration) {
        // 按能力索引
        for (const capability of registration.capabilities) {
            if (!this.pluginsByCapability.has(capability)) {
                this.pluginsByCapability.set(capability, new Set());
            }
            this.pluginsByCapability.get(capability).add(pluginName);
        }
        // 按作者索引
        if (registration.manifest.author) {
            const author = registration.manifest.author;
            if (!this.pluginsByAuthor.has(author)) {
                this.pluginsByAuthor.set(author, new Set());
            }
            this.pluginsByAuthor.get(author).add(pluginName);
        }
    }
    /**
     * 从索引中移除
     */
    removeFromIndexes(pluginName, registration) {
        // 从能力索引中移除
        for (const capability of registration.capabilities) {
            const pluginSet = this.pluginsByCapability.get(capability);
            if (pluginSet) {
                pluginSet.delete(pluginName);
                if (pluginSet.size === 0) {
                    this.pluginsByCapability.delete(capability);
                }
            }
        }
        // 从作者索引中移除
        if (registration.manifest.author) {
            const author = registration.manifest.author;
            const pluginSet = this.pluginsByAuthor.get(author);
            if (pluginSet) {
                pluginSet.delete(pluginName);
                if (pluginSet.size === 0) {
                    this.pluginsByAuthor.delete(author);
                }
            }
        }
    }
    /**
     * 重新构建依赖图
     */
    rebuildDependencyGraph() {
        const nodes = [];
        const edges = [];
        // 构建节点和边
        for (const [name, plugin] of this.plugins.entries()) {
            nodes.push({ id: name, plugin });
            for (const dep of plugin.dependencies) {
                if (this.plugins.has(dep.name)) {
                    edges.push({
                        from: name,
                        to: dep.name,
                        type: dep.optional ? 'peer' : 'dependency'
                    });
                }
            }
        }
        // 检测循环依赖
        const cycles = this.detectCycles(nodes.map(n => n.id), edges);
        this.dependencyGraph = { nodes, edges, cycles };
    }
    /**
     * 检测循环依赖
     */
    detectCycles(nodes, edges) {
        const cycles = [];
        const visited = new Set();
        const visiting = new Set();
        const path = [];
        const visit = (node) => {
            if (visiting.has(node)) {
                // 找到循环
                const cycleStart = path.indexOf(node);
                if (cycleStart >= 0) {
                    cycles.push(path.slice(cycleStart));
                }
                return;
            }
            if (visited.has(node))
                return;
            visiting.add(node);
            path.push(node);
            // 访问所有依赖
            const dependencies = edges.filter(e => e.from === node && e.type === 'dependency');
            for (const edge of dependencies) {
                visit(edge.to);
            }
            visiting.delete(node);
            visited.add(node);
            path.pop();
        };
        for (const node of nodes) {
            if (!visited.has(node)) {
                visit(node);
            }
        }
        return cycles;
    }
    /**
     * 持久化到数据库
     */
    async persistToDatabase(registration) {
        if (!this.database)
            return;
        try {
            const sql = `
        INSERT INTO plugin_registry
        (name, version, manifest, capabilities, status, installed_at, last_activated, error)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        ON CONFLICT (name)
        DO UPDATE SET
          version = EXCLUDED.version,
          manifest = EXCLUDED.manifest,
          capabilities = EXCLUDED.capabilities,
          status = EXCLUDED.status,
          last_activated = EXCLUDED.last_activated,
          error = EXCLUDED.error,
          updated_at = NOW()
      `;
            await this.database.query(sql, [
                registration.manifest.name,
                registration.manifest.version,
                JSON.stringify(registration.manifest),
                JSON.stringify(registration.capabilities),
                registration.status,
                registration.installedAt,
                registration.lastActivated,
                registration.error
            ]);
        }
        catch (error) {
            this.logger.error('Failed to persist plugin to database', error);
        }
    }
    /**
     * 从数据库中删除
     */
    async removeFromDatabase(pluginName) {
        if (!this.database)
            return;
        try {
            await this.database.query('DELETE FROM plugin_registry WHERE name = $1', [pluginName]);
        }
        catch (error) {
            this.logger.error('Failed to remove plugin from database', error);
        }
    }
    /**
     * 更新插件状态
     */
    async updatePluginStatus(pluginName, status) {
        if (!this.database)
            return;
        try {
            const sql = `
        UPDATE plugin_registry
        SET status = $1, last_activated = $2, updated_at = NOW()
        WHERE name = $3
      `;
            const lastActivated = status === PluginStatus.ENABLED ? new Date() : null;
            await this.database.query(sql, [status, lastActivated, pluginName]);
        }
        catch (error) {
            this.logger.error('Failed to update plugin status in database', error);
        }
    }
    /**
     * 从数据库加载插件
     */
    async loadFromDatabase() {
        if (!this.database)
            return;
        try {
            const result = await this.database.query('SELECT * FROM plugin_registry');
            for (const row of result) {
                const registration = {
                    manifest: JSON.parse(row.manifest),
                    capabilities: JSON.parse(row.capabilities || '[]'),
                    dependencies: this.parseDependencies(JSON.parse(row.manifest)),
                    status: row.status,
                    installedAt: new Date(row.installed_at),
                    lastActivated: row.last_activated ? new Date(row.last_activated) : undefined,
                    error: row.error
                };
                this.plugins.set(row.name, registration);
                this.updateIndexes(row.name, registration);
            }
            this.rebuildDependencyGraph();
            this.logger.info(`Loaded ${result.length} plugins from database`);
        }
        catch (error) {
            this.logger.error('Failed to load plugins from database', error);
        }
    }
}
//# sourceMappingURL=PluginRegistry.js.map