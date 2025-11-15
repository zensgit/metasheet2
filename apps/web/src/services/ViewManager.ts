/**
 * ViewManager Service
 * Handles view configuration, state management, and data fetching for different view types
 */

import type {
  BaseViewConfig,
  View,
  ViewType,
  ViewState,
  ViewConfigResponse,
  ViewDataResponse,
  GalleryConfig,
  FormConfig,
  FormResponse,
  FormSubmissionResponse
} from '../types/views'
import { useAuth } from '../composables/useAuth'
import { getApiBase } from '../utils/api'

export class ViewManager {
  private static instance: ViewManager
  private cache = new Map<string, any>()
  private stateCache = new Map<string, ViewState>()
  private auth = useAuth()

  static getInstance(): ViewManager {
    if (!ViewManager.instance) {
      ViewManager.instance = new ViewManager()
    }
    return ViewManager.instance
  }

  // Use shared API base util

  private buildHeaders(additionalHeaders: Record<string, string> = {}): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      ...this.auth.buildAuthHeaders(),
      ...additionalHeaders
    }
  }

  /**
   * Load view configuration
   */
  async loadViewConfig<T extends BaseViewConfig>(viewId: string, useCache = true): Promise<T | null> {
    const cacheKey = `config_${viewId}`

    if (useCache && this.cache.has(cacheKey)) {
      return this.cache.get(cacheKey)
    }

    try {
      const response = await fetch(`${getApiBase()}/api/views/${viewId}/config`, {
        headers: this.buildHeaders()
      })

      const result: ViewConfigResponse = await response.json()

      if (result.success && result.data) {
        this.cache.set(cacheKey, result.data)
        return result.data as T
      }

      return null
    } catch (error) {
      console.error('Failed to load view config:', error)
      return null
    }
  }

  /**
   * Save view configuration
   */
  async saveViewConfig<T extends BaseViewConfig>(config: T): Promise<boolean> {
    try {
      const response = await fetch(`${getApiBase()}/api/views/${config.id}/config`, {
        method: 'PUT',
        headers: this.buildHeaders(),
        body: JSON.stringify(config)
      })

      const result: ViewConfigResponse = await response.json()

      if (result.success) {
        // Update cache
        this.cache.set(`config_${config.id}`, config)
        return true
      }

      return false
    } catch (error) {
      console.error('Failed to save view config:', error)
      return false
    }
  }

  /**
   * Load view data with pagination and filtering
   */
  async loadViewData<T = any>(
    viewId: string,
    options: {
      page?: number
      pageSize?: number
      filters?: Record<string, any>
      sorting?: { field: string; direction: 'asc' | 'desc' }[]
      useCache?: boolean
    } = {}
  ): Promise<ViewDataResponse<T>> {
    const { page = 1, pageSize = 50, filters = {}, sorting = [], useCache = true } = options

    const cacheKey = `data_${viewId}_${JSON.stringify({ page, pageSize, filters, sorting })}`

    if (useCache && this.cache.has(cacheKey)) {
      return this.cache.get(cacheKey)
    }

    try {
      const params = new URLSearchParams({
        page: page.toString(),
        pageSize: pageSize.toString(),
        filters: JSON.stringify(filters),
        sorting: JSON.stringify(sorting)
      })

      const response = await fetch(`${getApiBase()}/api/views/${viewId}/data?${params}`, {
        headers: this.buildHeaders()
      })

      const result: ViewDataResponse<T> = await response.json()

      if (result.success) {
        // Cache successful responses
        this.cache.set(cacheKey, result)
      }

      return result
    } catch (error) {
      console.error('Failed to load view data:', error)
      return {
        success: false,
        data: [],
        meta: { total: 0, page, pageSize, hasMore: false },
        error: 'Failed to load data'
      }
    }
  }

  /**
   * Load and save view state
   */
  async loadViewState(viewId: string): Promise<ViewState | null> {
    if (this.stateCache.has(viewId)) {
      return this.stateCache.get(viewId) || null
    }

    try {
      const response = await fetch(`${getApiBase()}/api/views/${viewId}/state`, {
        headers: this.buildHeaders()
      })

      if (response.ok) {
        const state: ViewState = await response.json()
        this.stateCache.set(viewId, state)
        return state
      }

      return null
    } catch (error) {
      console.error('Failed to load view state:', error)
      return null
    }
  }

  async saveViewState(viewId: string, state: Partial<ViewState>): Promise<void> {
    try {
      const currentState = this.stateCache.get(viewId) || {
        viewId,
        filters: {},
        sorting: [],
        pagination: { page: 1, pageSize: 50, total: 0 },
        selectedItems: [],
        lastModified: new Date()
      }

      const updatedState: ViewState = {
        ...currentState,
        ...state,
        lastModified: new Date()
      }

      this.stateCache.set(viewId, updatedState)

      // Debounced save to backend
      this.debouncedSaveState(viewId, updatedState)
    } catch (error) {
      console.error('Failed to save view state:', error)
    }
  }

  private saveStateTimeouts = new Map<string, ReturnType<typeof setTimeout>>()

  private debouncedSaveState(viewId: string, state: ViewState): void {
    // Clear existing timeout
    const existingTimeout = this.saveStateTimeouts.get(viewId)
    if (existingTimeout) {
      clearTimeout(existingTimeout)
    }

    // Set new timeout
    const timeout = setTimeout(async () => {
      try {
        await fetch(`${getApiBase()}/api/views/${viewId}/state`, {
          method: 'POST',
          headers: this.buildHeaders(),
          body: JSON.stringify(state)
        })
        this.saveStateTimeouts.delete(viewId)
      } catch (error) {
        console.error('Failed to persist view state:', error)
      }
    }, 1000)

    this.saveStateTimeouts.set(viewId, timeout)
  }

  /**
   * Gallery View specific methods
   */
  async createGalleryView(config: Omit<GalleryConfig, 'id' | 'createdAt' | 'updatedAt'>): Promise<string | null> {
    try {
      const response = await fetch(`${getApiBase()}/api/views/gallery`, {
        method: 'POST',
        headers: this.buildHeaders(),
        body: JSON.stringify(config)
      })

      const result = await response.json()
      return result.success ? result.data.id : null
    } catch (error) {
      console.error('Failed to create gallery view:', error)
      return null
    }
  }

  /**
   * Form View specific methods
   */
  async createFormView(config: Omit<FormConfig, 'id' | 'createdAt' | 'updatedAt'>): Promise<string | null> {
    try {
      const response = await fetch(`${getApiBase()}/api/views/form`, {
        method: 'POST',
        headers: this.buildHeaders(),
        body: JSON.stringify(config)
      })

      const result = await response.json()
      return result.success ? result.data.id : null
    } catch (error) {
      console.error('Failed to create form view:', error)
      return null
    }
  }

  async submitForm(viewId: string, data: Record<string, any>): Promise<FormSubmissionResponse> {
    try {
      const response = await fetch(`${getApiBase()}/api/views/${viewId}/submit`, {
        method: 'POST',
        headers: this.buildHeaders(),
        body: JSON.stringify({ data })
      })

      return await response.json()
    } catch (error) {
      console.error('Failed to submit form:', error)
      return {
        success: false,
        error: 'Failed to submit form'
      }
    }
  }

  async getFormResponses(viewId: string, page = 1, pageSize = 20): Promise<ViewDataResponse<FormResponse>> {
    try {
      const params = new URLSearchParams({
        page: page.toString(),
        pageSize: pageSize.toString()
      })

      const response = await fetch(`${getApiBase()}/api/views/${viewId}/responses?${params}`, {
        headers: this.buildHeaders()
      })

      return await response.json()
    } catch (error) {
      console.error('Failed to load form responses:', error)
      return {
        success: false,
        data: [],
        meta: { total: 0, page, pageSize, hasMore: false },
        error: 'Failed to load responses'
      }
    }
  }

  /**
   * Cache management
   */
  clearCache(pattern?: string): void {
    if (pattern) {
      const keys = Array.from(this.cache.keys()).filter(key => key.includes(pattern))
      keys.forEach(key => this.cache.delete(key))
    } else {
      this.cache.clear()
    }
  }

  invalidateViewCache(viewId: string): void {
    this.clearCache(viewId)
  }

  /**
   * Create a new view configuration
   */
  async createView(view: View): Promise<View | null> {
    try {
      const response = await fetch(`${getApiBase()}/api/views`, {
        method: 'POST',
        headers: this.buildHeaders(),
        body: JSON.stringify(view)
      })

      const result = await response.json()
      return result.success ? result.data : null
    } catch (error) {
      console.error('Failed to create view:', error)
      return null
    }
  }

  /**
   * Delete a view
   */
  async deleteView(viewId: string): Promise<boolean> {
    try {
      const response = await fetch(`${getApiBase()}/api/views/${viewId}`, {
        method: 'DELETE',
        headers: this.buildHeaders()
      })

      const result = await response.json()

      if (result.success) {
        this.clearCache(viewId)
        this.stateCache.delete(viewId)
        return true
      }

      return false
    } catch (error) {
      console.error('Failed to delete view:', error)
      return false
    }
  }

  /**
   * Get all views for a specific table
   */
  async getTableViews(tableId: string): Promise<View[]> {
    try {
      const response = await fetch(`${getApiBase()}/api/tables/${tableId}/views`, {
        headers: this.buildHeaders()
      })

      const result = await response.json()

      if (result.success && Array.isArray(result.data)) {
        return result.data
      }

      return []
    } catch (error) {
      console.error('Failed to load table views:', error)
      return []
    }
  }

  /**
   * Update an existing view
   */
  async updateView(view: View): Promise<boolean> {
    try {
      const response = await fetch(`${getApiBase()}/api/views/${view.id}`, {
        method: 'PUT',
        headers: this.buildHeaders(),
        body: JSON.stringify(view)
      })

      const result = await response.json()

      if (result.success) {
        this.clearCache(view.id)
        return true
      }

      return false
    } catch (error) {
      console.error('Failed to update view:', error)
      return false
    }
  }
}
