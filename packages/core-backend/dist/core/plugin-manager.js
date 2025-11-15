"use strict";
/**
 * 插件管理器
 * 整合所有插件相关功能的顶层管理器
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.PluginManager = void 0;
exports.createPluginManager = createPluginManager;
const eventemitter3_1 = require("eventemitter3");
const plugin_1 = require("../types/plugin");
const plugin_registry_1 = require("./plugin-registry");
const plugin_loader_1 = require("./plugin-loader");
const plugin_config_manager_1 = require("./plugin-config-manager");
const plugin_service_factory_1 = require("./plugin-service-factory");
const enhanced_plugin_context_1 = require("./enhanced-plugin-context");
const logger_1 = require("./logger");
/**
 * 插件管理器
 */
class PluginManager extends eventemitter3_1.EventEmitter {
    registry;
    loader;
    configManager;
    serviceFactory;
    services = null;
    config;
    logger;
    initialized = false;
    constructor(coreAPI, config = {}) {
        super();
        this.config = {
            autoLoad: true,
            autoStart: true,
            configStorage: 'file',
            security: {
                enableSandbox: true,
                allowUnsafePlugins: false
            },
            ...config
        };
        this.logger = new logger_1.Logger('PluginManager');
        // 创建服务工厂
        this.serviceFactory = new plugin_service_factory_1.PluginServiceFactory(config.services);
        // 创建注册中心
        this.registry = new plugin_registry_1.PluginRegistry(coreAPI);
        // 创建加载器（支持自定义插件目录）
        this.loader = new plugin_loader_1.PluginLoader(coreAPI, {
            pluginDirs: config.pluginDirectories
        });
        // 创建配置管理器
        this.configManager = new plugin_config_manager_1.PluginConfigManager(config.configStorage === 'database'
            ? plugin_config_manager_1.PluginConfigManager.createDatabaseStorage(null) // 需要传入实际的db实例
            : plugin_config_manager_1.PluginConfigManager.createFileSystemStorage(config.configPath));
        this.setupEventListeners();
    }
    /**
     * 初始化插件管理器
     */
    async initialize() {
        if (this.initialized) {
            this.logger.warn('Plugin manager already initialized');
            return;
        }
        this.logger.info('Initializing plugin manager...');
        try {
            // 1. 创建服务实例
            this.services = await this.serviceFactory.createServices();
            this.logger.info('Plugin services initialized');
            // 2. 如果启用自动加载，扫描并加载插件
            if (this.config.autoLoad) {
                await this.discoverPlugins();
            }
            // 3. 如果启用自动启动，启动所有已安装的插件
            if (this.config.autoStart) {
                await this.startInstalledPlugins();
            }
            this.initialized = true;
            this.emit('manager:initialized');
            this.logger.info('Plugin manager initialized successfully');
        }
        catch (error) {
            this.logger.error('Failed to initialize plugin manager', error);
            throw error;
        }
    }
    /**
     * 发现插件
     */
    async discoverPlugins() {
        this.logger.info('Discovering plugins...');
        try {
            // 使用加载器扫描插件
            await this.loader.loadPlugins();
            // 将发现的插件注册到注册中心
            const loadedPlugins = this.loader.getPlugins();
            const registrations = [];
            for (const [name, instance] of loadedPlugins) {
                try {
                    const registration = await this.registry.registerPlugin(instance.manifest);
                    registrations.push(registration);
                    this.logger.info(`Discovered and registered plugin: ${name}`);
                }
                catch (error) {
                    this.logger.error(`Failed to register discovered plugin: ${name}`, error);
                }
            }
            this.emit('plugins:discovered', registrations);
            return registrations;
        }
        catch (error) {
            this.logger.error('Failed to discover plugins', error);
            throw error;
        }
    }
    /**
     * 启动已安装的插件
     */
    async startInstalledPlugins() {
        const installedPlugins = this.registry.getPluginsByStatus(plugin_1.PluginStatus.INSTALLED);
        for (const registration of installedPlugins) {
            try {
                await this.startPlugin(registration.manifest.name);
            }
            catch (error) {
                this.logger.error(`Failed to start plugin: ${registration.manifest.name}`, error);
            }
        }
    }
    /**
     * 安装插件
     */
    async installPlugin(manifest) {
        this.logger.info(`Installing plugin: ${manifest.name}`);
        try {
            // 1. 注册插件
            const registration = await this.registry.registerPlugin(manifest);
            // 2. 创建默认配置
            if (manifest.contributes?.configuration) {
                await this.configManager.setConfig(manifest.name, manifest.contributes.configuration.default || {}, 'system:install');
            }
            this.emit('plugin:installed', registration);
            return registration;
        }
        catch (error) {
            this.logger.error(`Failed to install plugin: ${manifest.name}`, error);
            throw error;
        }
    }
    /**
     * 启动插件
     */
    async startPlugin(pluginName) {
        this.logger.info(`Starting plugin: ${pluginName}`);
        try {
            const registration = this.registry.getPlugin(pluginName);
            if (!registration) {
                throw new Error(`Plugin not found: ${pluginName}`);
            }
            if (registration.status === plugin_1.PluginStatus.ENABLED) {
                this.logger.warn(`Plugin ${pluginName} is already running`);
                return;
            }
            // 1. 启用插件
            await this.registry.enablePlugin(pluginName);
            // 2. 创建增强的插件上下文
            if (this.services) {
                const context = (0, enhanced_plugin_context_1.createEnhancedPluginContext)(registration.manifest, this.createCoreAPIForPlugin(registration), this.services);
                // 更新加载器中的插件实例
                const instance = this.loader.getPlugin(pluginName);
                if (instance) {
                    instance.context = context;
                }
            }
            this.emit('plugin:started', pluginName);
        }
        catch (error) {
            this.logger.error(`Failed to start plugin: ${pluginName}`, error);
            throw error;
        }
    }
    /**
     * 停止插件
     */
    async stopPlugin(pluginName) {
        this.logger.info(`Stopping plugin: ${pluginName}`);
        try {
            await this.registry.disablePlugin(pluginName);
            this.emit('plugin:stopped', pluginName);
        }
        catch (error) {
            this.logger.error(`Failed to stop plugin: ${pluginName}`, error);
            throw error;
        }
    }
    /**
     * 卸载插件
     */
    async uninstallPlugin(pluginName) {
        this.logger.info(`Uninstalling plugin: ${pluginName}`);
        try {
            // 1. 停止插件
            const registration = this.registry.getPlugin(pluginName);
            if (registration && registration.status === plugin_1.PluginStatus.ENABLED) {
                await this.stopPlugin(pluginName);
            }
            // 2. 删除配置
            await this.configManager.deleteConfig(pluginName);
            // 3. 卸载插件
            await this.registry.uninstallPlugin(pluginName);
            this.emit('plugin:uninstalled', pluginName);
        }
        catch (error) {
            this.logger.error(`Failed to uninstall plugin: ${pluginName}`, error);
            throw error;
        }
    }
    /**
     * 更新插件配置
     */
    async updatePluginConfig(pluginName, config, modifiedBy) {
        try {
            await this.configManager.setConfig(pluginName, config, modifiedBy);
            // 通知插件配置变更
            const instance = this.loader.getPlugin(pluginName);
            if (instance && instance.plugin.onConfigChange) {
                instance.plugin.onConfigChange(config);
            }
            this.emit('plugin:config:updated', { pluginName, config });
        }
        catch (error) {
            this.logger.error(`Failed to update config for plugin: ${pluginName}`, error);
            throw error;
        }
    }
    /**
     * 获取插件配置
     */
    async getPluginConfig(pluginName) {
        try {
            const config = await this.configManager.getConfig(pluginName);
            return config?.config || null;
        }
        catch (error) {
            this.logger.error(`Failed to get config for plugin: ${pluginName}`, error);
            throw error;
        }
    }
    /**
     * 获取所有插件
     */
    getPlugins() {
        return this.registry.getAllPlugins();
    }
    /**
     * 获取特定插件
     */
    getPlugin(pluginName) {
        return this.registry.getPlugin(pluginName);
    }
    /**
     * 按状态获取插件
     */
    getPluginsByStatus(status) {
        return this.registry.getPluginsByStatus(status);
    }
    /**
     * 按能力获取插件
     */
    getPluginsByCapability(capability) {
        return this.registry.getPluginsByCapability(capability);
    }
    /**
     * 获取插件统计信息
     */
    getStats() {
        const registryStats = this.registry.getStats();
        const serviceStats = this.services ? {
            cache: this.services.cache.getMetrics?.() || 'N/A',
            queue: 'N/A', // 可以添加队列统计
            websocket: this.services.websocket.getStats?.() || 'N/A',
            security: this.services.security.getStats?.() || 'N/A',
            storage: 'N/A', // 可以添加存储统计
            scheduler: 'N/A', // 可以添加调度器统计
            notification: this.services.notification.getStats?.() || 'N/A',
            validation: 'N/A'
        } : {};
        return {
            ...registryStats,
            services: serviceStats
        };
    }
    /**
     * 获取健康状态
     */
    async getHealth() {
        const health = {
            manager: {
                status: this.initialized ? 'healthy' : 'initializing',
                initialized: this.initialized
            },
            registry: {
                status: 'healthy',
                pluginCount: this.registry.getAllPlugins().length
            },
            services: this.serviceFactory ? await this.serviceFactory.getHealth() : null
        };
        return health;
    }
    /**
     * 销毁插件管理器
     */
    async destroy() {
        this.logger.info('Destroying plugin manager...');
        try {
            // 停止所有运行的插件
            const enabledPlugins = this.registry.getPluginsByStatus(plugin_1.PluginStatus.ENABLED);
            for (const plugin of enabledPlugins) {
                try {
                    await this.stopPlugin(plugin.manifest.name);
                }
                catch (error) {
                    this.logger.error(`Error stopping plugin ${plugin.manifest.name}`, error);
                }
            }
            // 销毁服务
            if (this.serviceFactory) {
                await this.serviceFactory.destroy();
            }
            this.initialized = false;
            this.emit('manager:destroyed');
            this.logger.info('Plugin manager destroyed');
        }
        catch (error) {
            this.logger.error('Error during plugin manager destruction', error);
            throw error;
        }
    }
    /**
     * 设置事件监听器
     */
    setupEventListeners() {
        // 注册中心事件
        this.registry.on('plugin:installed', (pluginName) => {
            this.emit('plugin:installed', pluginName);
        });
        this.registry.on('plugin:enabled', (pluginName) => {
            this.emit('plugin:enabled', pluginName);
        });
        this.registry.on('plugin:disabled', (pluginName) => {
            this.emit('plugin:disabled', pluginName);
        });
        this.registry.on('plugin:error', (event) => {
            this.emit('plugin:error', event);
        });
        // 加载器事件
        this.loader.on('plugin:loaded', (pluginName) => {
            this.emit('plugin:loaded', pluginName);
        });
        this.loader.on('plugin:error', (event) => {
            this.emit('plugin:error', event);
        });
        // 配置管理器事件
        this.configManager.on('config:changed', (event) => {
            this.emit('plugin:config:changed', event);
        });
    }
    /**
     * 为插件创建CoreAPI实例
     */
    createCoreAPIForPlugin(registration) {
        // 这里可以基于插件的权限和能力创建定制的CoreAPI
        // 目前返回标准的CoreAPI，实际实现中应该注入真实的CoreAPI
        return {};
    }
}
exports.PluginManager = PluginManager;
/**
 * 创建插件管理器的便捷方法
 */
async function createPluginManager(coreAPI, config) {
    const manager = new PluginManager(coreAPI, config);
    await manager.initialize();
    return manager;
}
//# sourceMappingURL=plugin-manager.js.map