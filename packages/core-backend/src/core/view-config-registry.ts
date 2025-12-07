/**
 * View Configuration Provider Registry
 *
 * Central registry for view-specific configuration providers.
 * Allows plugins to register their configuration handlers for different view types.
 */

import type {
  ViewConfigProvider,
  ViewConfigProviderRegistry,
  BaseViewConfig
} from '../types/view-config'

/**
 * Singleton registry for view config providers
 */
class ViewConfigProviderRegistryImpl implements ViewConfigProviderRegistry {
  private providers = new Map<string, ViewConfigProvider>()
  private static instance: ViewConfigProviderRegistryImpl

  private constructor() {}

  /**
   * Get the singleton instance
   */
  static getInstance(): ViewConfigProviderRegistryImpl {
    if (!ViewConfigProviderRegistryImpl.instance) {
      ViewConfigProviderRegistryImpl.instance = new ViewConfigProviderRegistryImpl()
    }
    return ViewConfigProviderRegistryImpl.instance
  }

  /**
   * Register a view config provider
   */
  register(provider: ViewConfigProvider): void {
    if (this.providers.has(provider.viewType)) {
      console.warn(`View config provider for type '${provider.viewType}' is being replaced`)
    }
    this.providers.set(provider.viewType, provider)
    console.log(`Registered view config provider for type: ${provider.viewType}`)
  }

  /**
   * Unregister a view config provider
   */
  unregister(viewType: string): void {
    if (this.providers.delete(viewType)) {
      console.log(`Unregistered view config provider for type: ${viewType}`)
    }
  }

  /**
   * Get a provider for a specific view type
   */
  get(viewType: string): ViewConfigProvider | undefined {
    return this.providers.get(viewType)
  }

  /**
   * Check if a provider is registered for a view type
   */
  has(viewType: string): boolean {
    return this.providers.has(viewType)
  }

  /**
   * Get all registered view types
   */
  getRegisteredTypes(): string[] {
    return Array.from(this.providers.keys())
  }

  /**
   * Clear all providers (useful for testing)
   */
  clear(): void {
    this.providers.clear()
  }
}

/**
 * Get the view config provider registry singleton
 */
export function getViewConfigRegistry(): ViewConfigProviderRegistry {
  return ViewConfigProviderRegistryImpl.getInstance()
}

/**
 * Register a view config provider (convenience function)
 */
export function registerViewConfigProvider<T extends BaseViewConfig>(
  provider: ViewConfigProvider<T>
): void {
  getViewConfigRegistry().register(provider)
}

/**
 * Unregister a view config provider (convenience function)
 */
export function unregisterViewConfigProvider(viewType: string): void {
  getViewConfigRegistry().unregister(viewType)
}

export { ViewConfigProviderRegistryImpl }
