/**
 * View Data Provider Registry
 *
 * Central registry for view-specific data providers.
 * Allows plugins to register their data handlers for different view types.
 */

import type {
  ViewDataProvider,
  ViewDataProviderRegistry
} from '../types/view-data'

/**
 * Singleton registry for view data providers
 */
class ViewDataProviderRegistryImpl implements ViewDataProviderRegistry {
  private providers = new Map<string, ViewDataProvider>()
  private static instance: ViewDataProviderRegistryImpl

  private constructor() {}

  /**
   * Get the singleton instance
   */
  static getInstance(): ViewDataProviderRegistryImpl {
    if (!ViewDataProviderRegistryImpl.instance) {
      ViewDataProviderRegistryImpl.instance = new ViewDataProviderRegistryImpl()
    }
    return ViewDataProviderRegistryImpl.instance
  }

  /**
   * Register a view data provider
   */
  register(provider: ViewDataProvider): void {
    if (this.providers.has(provider.viewType)) {
      console.warn(`View data provider for type '${provider.viewType}' is being replaced`)
    }
    this.providers.set(provider.viewType, provider)
    console.log(`Registered view data provider for type: ${provider.viewType}`)
  }

  /**
   * Unregister a view data provider
   */
  unregister(viewType: string): void {
    if (this.providers.delete(viewType)) {
      console.log(`Unregistered view data provider for type: ${viewType}`)
    }
  }

  /**
   * Get a provider for a specific view type
   */
  get(viewType: string): ViewDataProvider | undefined {
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
 * Get the view data provider registry singleton
 */
export function getViewDataRegistry(): ViewDataProviderRegistry {
  return ViewDataProviderRegistryImpl.getInstance()
}

/**
 * Register a view data provider (convenience function)
 */
export function registerViewDataProvider(provider: ViewDataProvider): void {
  getViewDataRegistry().register(provider)
}

/**
 * Unregister a view data provider (convenience function)
 */
export function unregisterViewDataProvider(viewType: string): void {
  getViewDataRegistry().unregister(viewType)
}

export { ViewDataProviderRegistryImpl }
