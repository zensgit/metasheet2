/**
 * ViewManager Service
 * Handles view configuration, state management, and data fetching for different view types
 */

import type {
  BaseViewConfig,
  View,
  ViewState,
  ViewDataResponse,
  GalleryConfig,
  FormConfig,
  CalendarConfig,
  FormResponse,
  FormSubmissionResponse
} from '../types/views'
import { useAuth } from '../composables/useAuth'
import { getApiBase } from '../utils/api'
import { MultitableApiClient } from '../multitable/api/client'
import type { MetaView, UpdateViewInput } from '../multitable/types'

type ViewConfigCarrier = BaseViewConfig & {
  filterInfo?: Record<string, unknown>
  sortInfo?: Record<string, unknown>
  groupInfo?: Record<string, unknown>
  hiddenFieldIds?: string[]
  sheetId?: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function cloneRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? { ...value } : {}
}

function normalizeViewType(type: string): View['type'] {
  switch (type) {
    case 'gallery':
    case 'form':
    case 'calendar':
    case 'kanban':
    case 'grid':
      return type
    default:
      return 'grid'
  }
}

function serializeLegacyConfig(view: ViewConfigCarrier): Record<string, unknown> {
  const config = cloneRecord(view.config)

  if (typeof view.description === 'string') config.description = view.description

  switch (view.type) {
    case 'gallery':
      if ('cardTemplate' in view && view.cardTemplate) config.cardTemplate = view.cardTemplate as unknown
      if ('layout' in view && view.layout) config.layout = view.layout as unknown
      if ('display' in view && view.display) config.display = view.display as unknown
      break
    case 'form':
      if ('fields' in view && Array.isArray(view.fields)) config.fields = view.fields as unknown
      if ('settings' in view && view.settings) config.settings = view.settings as unknown
      if ('validation' in view && view.validation) config.validation = view.validation as unknown
      if ('styling' in view && view.styling) config.styling = view.styling as unknown
      break
    case 'calendar':
      if ('defaultView' in view && view.defaultView) config.defaultView = view.defaultView as unknown
      if ('weekStartsOn' in view && typeof view.weekStartsOn === 'number') config.weekStartsOn = view.weekStartsOn
      if ('timeFormat' in view && typeof view.timeFormat === 'number') config.timeFormat = view.timeFormat
      if ('fields' in view && view.fields) config.fields = view.fields as unknown
      if ('colors' in view && view.colors) config.colors = view.colors as unknown
      if ('colorRules' in view && Array.isArray(view.colorRules)) config.colorRules = view.colorRules as unknown
      if ('workingHours' in view && view.workingHours) config.workingHours = view.workingHours as unknown
      break
  }

  return config
}

function deserializeLegacyConfig<T extends BaseViewConfig>(view: MetaView): T {
  const config = cloneRecord(view.config)
  const now = new Date()
  const base: ViewConfigCarrier = {
    id: view.id,
    name: view.name,
    type: normalizeViewType(view.type),
    description: typeof config.description === 'string' ? config.description : undefined,
    createdAt: now,
    updatedAt: now,
    createdBy: 'system',
    tableId: view.sheetId,
    config,
    filterInfo: cloneRecord(view.filterInfo),
    sortInfo: cloneRecord(view.sortInfo),
    groupInfo: cloneRecord(view.groupInfo),
    hiddenFieldIds: Array.isArray(view.hiddenFieldIds) ? [...view.hiddenFieldIds] : [],
    sheetId: view.sheetId,
  }

  switch (base.type) {
    case 'gallery':
      return {
        ...base,
        cardTemplate: isRecord(config.cardTemplate) ? (config.cardTemplate as GalleryConfig['cardTemplate']) : {
          titleField: 'title',
          contentFields: ['content'],
          imageField: 'image',
          tagFields: ['tags'],
        },
        layout: isRecord(config.layout) ? (config.layout as GalleryConfig['layout']) : {
          columns: 3,
          cardSize: 'medium',
          spacing: 'normal',
        },
        display: isRecord(config.display) ? (config.display as GalleryConfig['display']) : {
          showTitle: true,
          showContent: true,
          showImage: true,
          showTags: true,
          truncateContent: true,
          maxContentLength: 150,
        },
      } as unknown as T
    case 'form':
      return {
        ...base,
        fields: Array.isArray(config.fields) ? (config.fields as FormConfig['fields']) : [],
        settings: isRecord(config.settings) ? (config.settings as FormConfig['settings']) : {
          title: view.name,
          submitButtonText: '提交',
          allowMultiple: true,
          requireAuth: false,
          enablePublicAccess: true,
          notifyOnSubmission: false,
        },
        validation: isRecord(config.validation) ? (config.validation as FormConfig['validation']) : {
          enableValidation: true,
        },
        styling: isRecord(config.styling) ? (config.styling as FormConfig['styling']) : {
          theme: 'default',
          layout: 'single-column',
        },
      } as unknown as T
    case 'calendar':
      return {
        ...base,
        defaultView: config.defaultView === 'week' || config.defaultView === 'day' || config.defaultView === 'list' ? config.defaultView : 'month',
        weekStartsOn: typeof config.weekStartsOn === 'number' ? (config.weekStartsOn as CalendarConfig['weekStartsOn']) : 1,
        timeFormat: config.timeFormat === 12 ? 12 : 24,
        fields: isRecord(config.fields) ? (config.fields as CalendarConfig['fields']) : {
          title: 'title',
          start: 'startDate',
          startDate: 'startDate',
          end: 'endDate',
          endDate: 'endDate',
          category: 'category',
          location: 'location',
        },
        colors: isRecord(config.colors) ? (config.colors as CalendarConfig['colors']) : undefined,
        colorRules: Array.isArray(config.colorRules) ? (config.colorRules as CalendarConfig['colorRules']) : [],
        workingHours: isRecord(config.workingHours) ? (config.workingHours as CalendarConfig['workingHours']) : undefined,
      } as unknown as T
    default:
      return base as T
  }
}

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

  private createMultitableClient(): MultitableApiClient {
    return new MultitableApiClient({
      fetchFn: (path, init = {}) => {
        const headers = this.buildHeaders((init.headers ?? {}) as Record<string, string>)
        return fetch(`${getApiBase()}${path}`, {
          ...init,
          headers,
        })
      },
    })
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
      const result = await this.createMultitableClient().loadContext({ viewId })
      const matchedView = result.views.find((view) => view.id === viewId)
      if (!matchedView) return null

      const config = deserializeLegacyConfig<T>(matchedView)
      this.cache.set(cacheKey, config)
      return config
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
      const runtimeConfig = serializeLegacyConfig(config as ViewConfigCarrier)
      const updateInput: UpdateViewInput = {
        name: config.name,
        type: config.type,
        filterInfo: cloneRecord((config as ViewConfigCarrier).filterInfo),
        sortInfo: cloneRecord((config as ViewConfigCarrier).sortInfo),
        groupInfo: cloneRecord((config as ViewConfigCarrier).groupInfo),
        hiddenFieldIds: Array.isArray((config as ViewConfigCarrier).hiddenFieldIds)
          ? [...((config as ViewConfigCarrier).hiddenFieldIds as string[])]
          : undefined,
        config: runtimeConfig,
      }

      const result = await this.createMultitableClient().updateView(config.id, updateInput)
      const nextConfig = deserializeLegacyConfig<T>(result.view)

      this.cache.set(`config_${config.id}`, nextConfig)
      return true
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
      const sheetId = typeof config.tableId === 'string' ? config.tableId : undefined
      if (!sheetId) return null
      const result = await this.createMultitableClient().createView({
        ...config,
        sheetId,
        type: 'gallery',
        config: {
          cardTemplate: config.cardTemplate,
          layout: config.layout,
          display: config.display,
        },
      })
      return result.view?.id ?? null
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
      const sheetId = typeof config.tableId === 'string' ? config.tableId : undefined
      if (!sheetId) return null
      const result = await this.createMultitableClient().createView({
        ...config,
        sheetId,
        type: 'form',
        config: {
          fields: config.fields,
          settings: config.settings,
          validation: config.validation,
          styling: config.styling,
        },
      })
      return result.view?.id ?? null
    } catch (error) {
      console.error('Failed to create form view:', error)
      return null
    }
  }

  async submitForm(viewId: string, data: Record<string, any>): Promise<FormSubmissionResponse> {
    try {
      const result = await this.createMultitableClient().submitForm(viewId, { data })
      return {
        success: true,
        data: {
          id: result.record.id,
          message: result.mode === 'update' ? 'Form updated successfully' : 'Form submitted successfully',
        },
      }
    } catch (error) {
      console.error('Failed to submit form:', error)
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to submit form'
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
  async createView(view: Record<string, unknown>): Promise<View | null> {
    try {
      const result = await this.createMultitableClient().createView(view as any)
      return result.view as unknown as View
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
      await this.createMultitableClient().deleteView(viewId)
      this.clearCache(viewId)
      this.stateCache.delete(viewId)
      return true
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
      const result = await this.createMultitableClient().listViews(tableId)
      return result.views as unknown as View[]
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
      await this.createMultitableClient().updateView(view.id, view as any)
      this.clearCache(view.id)
      return true
    } catch (error) {
      console.error('Failed to update view:', error)
      return false
    }
  }
}
