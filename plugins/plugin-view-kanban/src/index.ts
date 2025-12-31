/**
 * Kanban View Plugin
 *
 * Provides a kanban board view for records with drag-and-drop
 * card management, customizable columns, and swimlanes.
 *
 * This plugin implements ViewConfigProvider to handle kanban-specific
 * configuration storage, maintaining architectural separation of concerns.
 */

import type { PluginLifecycle, PluginContext } from '@metasheet/core-backend/src/types/plugin'
import type { Pool } from 'pg'

// ============================================================
// View Config Provider Types (matches core-backend interface)
// ============================================================

interface ViewConfigProvider<T = unknown> {
  readonly viewType: string
  getConfig(viewId: string, pool: Pool): Promise<T | null>
  saveConfig(viewId: string, config: Partial<T>, pool: Pool): Promise<void>
  deleteConfig(viewId: string, pool: Pool): Promise<void>
  transformConfig?(rawConfig: Record<string, unknown>): Partial<T>
  toApiFormat?(storedConfig: T): Record<string, unknown>
}

// ============================================================
// Kanban Plugin Types
// ============================================================

interface KanbanConfig {
  id: string
  viewId: string
  spreadsheetId: string
  groupByField: string
  swimlanesField?: string
  cardFields: string[]
  cardCoverField?: string
  showEmptyGroups: boolean
  columns: KanbanColumnConfig[]
  createdAt: Date
  updatedAt: Date
}

interface KanbanColumnConfig {
  id: string
  name: string
  color?: string
  wipLimit?: number
  order: number
}

interface KanbanColumn {
  id: string
  title: string
  cards: KanbanCard[]
  order: number
}

interface KanbanCard {
  id: string
  title: string
  content?: string
  assignee?: {
    id: string
    name: string
    avatar?: string
  }
  status: string
  priority?: 'low' | 'medium' | 'high' | 'urgent'
  dueDate?: Date
  tags?: string[]
}

// Database row type
interface KanbanConfigRow {
  view_id: string
  group_by_field: string
  swimlanes_field: string | null
  card_fields: string[] | string | null
  card_cover_field: string | null
  show_empty_groups: boolean
  created_at: Date
  updated_at: Date
}

// ============================================================
// Default Configurations
// ============================================================

const DEFAULT_COLUMNS: KanbanColumnConfig[] = [
  { id: 'todo', name: 'To Do', order: 0 },
  { id: 'in_progress', name: 'In Progress', order: 1 },
  { id: 'review', name: 'Review', order: 2 },
  { id: 'done', name: 'Done', order: 3 }
]

// ============================================================
// Kanban View Config Provider (Database Integration)
// ============================================================

/**
 * Kanban view configuration provider
 * Handles reading/writing kanban_configs table
 */
class KanbanViewConfigProvider implements ViewConfigProvider<KanbanConfig> {
  readonly viewType = 'kanban'

  async getConfig(viewId: string, pool: Pool): Promise<KanbanConfig | null> {
    const result = await pool.query<KanbanConfigRow>(
      'SELECT * FROM kanban_configs WHERE view_id = $1',
      [viewId]
    )

    if (result.rows.length === 0) {
      return null
    }

    const row = result.rows[0]
    return this.rowToConfig(row)
  }

  async saveConfig(viewId: string, config: Partial<KanbanConfig>, pool: Pool): Promise<void> {
    const cardFields = config.cardFields || []

    await pool.query(
      `INSERT INTO kanban_configs (view_id, group_by_field, swimlanes_field, card_fields, card_cover_field, show_empty_groups, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW())
       ON CONFLICT (view_id) DO UPDATE SET
         group_by_field = EXCLUDED.group_by_field,
         swimlanes_field = EXCLUDED.swimlanes_field,
         card_fields = EXCLUDED.card_fields,
         card_cover_field = EXCLUDED.card_cover_field,
         show_empty_groups = EXCLUDED.show_empty_groups,
         updated_at = NOW()`,
      [
        viewId,
        config.groupByField || 'status',
        config.swimlanesField || null,
        JSON.stringify(cardFields),
        config.cardCoverField || null,
        config.showEmptyGroups ?? true
      ]
    )
  }

  async deleteConfig(viewId: string, pool: Pool): Promise<void> {
    await pool.query('DELETE FROM kanban_configs WHERE view_id = $1', [viewId])
  }

  /**
   * Transform raw API config to internal format
   */
  transformConfig(rawConfig: Record<string, unknown>): Partial<KanbanConfig> {
    return {
      groupByField: rawConfig.groupByField as string || rawConfig.group_by_field as string || 'status',
      swimlanesField: rawConfig.swimlanesField as string || rawConfig.swimlanes_field as string,
      cardFields: rawConfig.cardFields as string[] || rawConfig.card_fields as string[] || [],
      cardCoverField: rawConfig.cardCoverField as string || rawConfig.card_cover_field as string,
      showEmptyGroups: rawConfig.showEmptyGroups as boolean ?? rawConfig.show_empty_groups as boolean ?? true,
      columns: rawConfig.columns as KanbanColumnConfig[] || DEFAULT_COLUMNS
    }
  }

  /**
   * Transform stored config to API response format
   */
  toApiFormat(storedConfig: KanbanConfig): Record<string, unknown> {
    return {
      groupByField: storedConfig.groupByField,
      swimlanesField: storedConfig.swimlanesField,
      cardFields: storedConfig.cardFields,
      cardCoverField: storedConfig.cardCoverField,
      showEmptyGroups: storedConfig.showEmptyGroups,
      columns: storedConfig.columns
    }
  }

  private rowToConfig(row: KanbanConfigRow): KanbanConfig {
    let cardFields: string[] = []
    if (row.card_fields) {
      cardFields = typeof row.card_fields === 'string'
        ? JSON.parse(row.card_fields)
        : row.card_fields
    }

    return {
      id: `kanban:${row.view_id}`,
      viewId: row.view_id,
      spreadsheetId: '',
      groupByField: row.group_by_field,
      swimlanesField: row.swimlanes_field || undefined,
      cardFields,
      cardCoverField: row.card_cover_field || undefined,
      showEmptyGroups: row.show_empty_groups,
      columns: DEFAULT_COLUMNS, // Columns are stored in view.config, not kanban_configs
      createdAt: row.created_at,
      updatedAt: row.updated_at
    }
  }
}

// ============================================================
// Kanban Plugin Implementation
// ============================================================

export default class KanbanPlugin implements PluginLifecycle {
  private context!: PluginContext
  private kanbanData = new Map<string, KanbanColumn[]>()
  private kanbanConfigs = new Map<string, KanbanConfig>()
  private configProvider = new KanbanViewConfigProvider()

  /**
   * Plugin activation
   */
  async activate(context: PluginContext): Promise<void> {
    this.context = context
    this.context.logger.info('Kanban View Plugin activating...')

    // Register view config provider with core registry
    this.registerViewConfigProvider()

    // Register API routes
    this.registerRoutes()

    // Register event listeners
    this.registerEventListeners()

    // Register plugin API
    this.registerPluginAPI()

    // Register WebSocket events
    this.registerWebSocketEvents()

    this.context.logger.info('Kanban View Plugin activated')
  }

  /**
   * Register the view config provider with the core registry
   */
  private registerViewConfigProvider(): void {
    // Emit event for core to register our provider
    this.context.api.events.emit('view:configProvider:register', {
      viewType: 'kanban',
      provider: this.configProvider
    })
    this.context.logger.debug('Kanban view config provider registered')
  }

  /**
   * 插件停用
   */
  async deactivate(): Promise<void> {
    // 清理资源
    this.kanbanData.clear()
    this.context.logger.info('Kanban plugin deactivated')
  }

  /**
   * 注册API路由
   */
  private registerRoutes(): void {
    const { api } = this.context

    // 获取看板数据
    api.http.addRoute('GET', '/api/kanban/:spreadsheetId', async (req, res) => {
      try {
        const { spreadsheetId } = req.params
        const kanbanData = await this.getKanbanData(spreadsheetId)
        res.json({ success: true, data: kanbanData })
      } catch (error) {
        res.status(500).json({ success: false, error: error.message })
      }
    })

    // 移动卡片
    api.http.addRoute('POST', '/api/kanban/:spreadsheetId/move', async (req, res) => {
      try {
        const { spreadsheetId } = req.params
        const { cardId, fromColumn, toColumn, position } = req.body

        await this.moveCard(spreadsheetId, cardId, fromColumn, toColumn, position)

        res.json({ success: true })
      } catch (error) {
        res.status(500).json({ success: false, error: error.message })
      }
    })

    // 更新卡片
    api.http.addRoute('PUT', '/api/kanban/:spreadsheetId/card/:cardId', async (req, res) => {
      try {
        const { spreadsheetId, cardId } = req.params
        const updates = req.body

        await this.updateCard(spreadsheetId, cardId, updates)

        res.json({ success: true })
      } catch (error) {
        res.status(500).json({ success: false, error: error.message })
      }
    })

    // 添加列
    api.http.addRoute('POST', '/api/kanban/:spreadsheetId/column', async (req, res) => {
      try {
        const { spreadsheetId } = req.params
        const { title, position } = req.body

        const column = await this.addColumn(spreadsheetId, title, position)

        res.json({ success: true, data: column })
      } catch (error) {
        res.status(500).json({ success: false, error: error.message })
      }
    })

    this.context.logger.info('Kanban routes registered')
  }

  /**
   * 注册事件监听
   */
  private registerEventListeners(): void {
    const { api } = this.context

    // 监听表格数据更新
    api.events.on('spreadsheet:update', async (data: any) => {
      if (data.viewType === 'kanban') {
        await this.syncKanbanData(data.spreadsheetId)

        // 广播更新
        api.websocket.broadcast('kanban:update', {
          spreadsheetId: data.spreadsheetId,
          changes: data.changes
        })
      }
    })

    // 监听记录创建
    api.events.on('record:created', async (data: any) => {
      await this.handleRecordCreated(data)
    })

    // 监听记录更新
    api.events.on('record:updated', async (data: any) => {
      await this.handleRecordUpdated(data)
    })

    // 监听记录删除
    api.events.on('record:deleted', async (data: any) => {
      await this.handleRecordDeleted(data)
    })

    this.context.logger.info('Event listeners registered')
  }

  /**
   * 注册插件API
   */
  private registerPluginAPI(): void {
    this.context.communication.register('kanban', {
      getKanbanData: this.getKanbanData.bind(this),
      moveCard: this.moveCard.bind(this),
      updateCard: this.updateCard.bind(this),
      addColumn: this.addColumn.bind(this),
      syncData: this.syncKanbanData.bind(this)
    })

    this.context.logger.info('Plugin API registered')
  }

  /**
   * 注册WebSocket事件
   */
  private registerWebSocketEvents(): void {
    const { api } = this.context

    api.websocket.onConnection((socket: any) => {
      // 处理订阅请求
      socket.on('kanban:subscribe', async (data: any) => {
        const { spreadsheetId } = data
        socket.join(`kanban:${spreadsheetId}`)

        // 发送初始数据
        const kanbanData = await this.getKanbanData(spreadsheetId)
        socket.emit('kanban:data', kanbanData)
      })

      // 处理取消订阅
      socket.on('kanban:unsubscribe', (data: any) => {
        const { spreadsheetId } = data
        socket.leave(`kanban:${spreadsheetId}`)
      })
    })

    this.context.logger.info('WebSocket events registered')
  }

  /**
   * 获取看板数据
   */
  private async getKanbanData(spreadsheetId: string): Promise<KanbanColumn[]> {
    // 从缓存获取
    if (this.kanbanData.has(spreadsheetId)) {
      return this.kanbanData.get(spreadsheetId)!
    }

    // 从数据库查询
    const { api } = this.context
    const query = `
      SELECT * FROM records
      WHERE spreadsheet_id = $1
      ORDER BY column_order, row_order
    `
    const records = await api.database.query(query, [spreadsheetId])

    // 转换为看板格式
    const columns = this.transformToKanbanData(records)

    // 缓存数据
    this.kanbanData.set(spreadsheetId, columns)

    return columns
  }

  /**
   * 转换为看板数据格式
   */
  private transformToKanbanData(records: any[]): KanbanColumn[] {
    const columnsMap = new Map<string, KanbanColumn>()

    for (const record of records) {
      const status = record.status || 'todo'

      if (!columnsMap.has(status)) {
        columnsMap.set(status, {
          id: status,
          title: this.getColumnTitle(status),
          cards: [],
          order: this.getColumnOrder(status)
        })
      }

      const column = columnsMap.get(status)!
      column.cards.push({
        id: record.id,
        title: record.title || record.name || `Record ${record.id}`,
        content: record.description || record.content,
        assignee: record.assignee ? {
          id: record.assignee_id,
          name: record.assignee_name,
          avatar: record.assignee_avatar
        } : undefined,
        status: status,
        priority: record.priority,
        dueDate: record.due_date ? new Date(record.due_date) : undefined,
        tags: record.tags ? JSON.parse(record.tags) : []
      })
    }

    // 按order排序
    return Array.from(columnsMap.values()).sort((a, b) => a.order - b.order)
  }

  /**
   * 获取列标题
   */
  private getColumnTitle(status: string): string {
    const titles: Record<string, string> = {
      'todo': '待处理',
      'in_progress': '进行中',
      'review': '审核中',
      'done': '已完成',
      'archived': '已归档'
    }
    return titles[status] || status
  }

  /**
   * 获取列顺序
   */
  private getColumnOrder(status: string): number {
    const orders: Record<string, number> = {
      'todo': 1,
      'in_progress': 2,
      'review': 3,
      'done': 4,
      'archived': 5
    }
    return orders[status] || 999
  }

  /**
   * 移动卡片
   */
  private async moveCard(
    spreadsheetId: string,
    cardId: string,
    fromColumn: string,
    toColumn: string,
    position: number
  ): Promise<void> {
    const { api } = this.context

    // 更新数据库
    const query = `
      UPDATE records
      SET status = $1, row_order = $2, updated_at = NOW()
      WHERE id = $3 AND spreadsheet_id = $4
    `
    await api.database.query(query, [toColumn, position, cardId, spreadsheetId])

    // 更新缓存
    await this.syncKanbanData(spreadsheetId)

    // 发送事件
    api.events.emit('kanban:card:moved', {
      spreadsheetId,
      cardId,
      fromColumn,
      toColumn,
      position
    })

    // 广播更新
    api.websocket.broadcastTo(`kanban:${spreadsheetId}`, 'kanban:cardMoved', {
      cardId,
      fromColumn,
      toColumn,
      position
    })
  }

  /**
   * 更新卡片
   */
  private async updateCard(
    spreadsheetId: string,
    cardId: string,
    updates: Partial<KanbanCard>
  ): Promise<void> {
    const { api } = this.context

    // 构建更新SQL
    const fields: string[] = []
    const values: any[] = []
    let index = 1

    if (updates.title !== undefined) {
      fields.push(`title = $${index++}`)
      values.push(updates.title)
    }
    if (updates.content !== undefined) {
      fields.push(`content = $${index++}`)
      values.push(updates.content)
    }
    if (updates.priority !== undefined) {
      fields.push(`priority = $${index++}`)
      values.push(updates.priority)
    }
    if (updates.dueDate !== undefined) {
      fields.push(`due_date = $${index++}`)
      values.push(updates.dueDate)
    }
    if (updates.tags !== undefined) {
      fields.push(`tags = $${index++}`)
      values.push(JSON.stringify(updates.tags))
    }

    fields.push(`updated_at = NOW()`)

    values.push(cardId, spreadsheetId)

    const query = `
      UPDATE records
      SET ${fields.join(', ')}
      WHERE id = $${index} AND spreadsheet_id = $${index + 1}
    `

    await api.database.query(query, values)

    // 更新缓存
    await this.syncKanbanData(spreadsheetId)

    // 广播更新
    api.websocket.broadcastTo(`kanban:${spreadsheetId}`, 'kanban:cardUpdated', {
      cardId,
      updates
    })
  }

  /**
   * 添加列
   */
  private async addColumn(
    spreadsheetId: string,
    title: string,
    position?: number
  ): Promise<KanbanColumn> {
    // 创建新列
    const column: KanbanColumn = {
      id: this.generateColumnId(title),
      title,
      cards: [],
      order: position || 999
    }

    // 更新缓存
    const columns = await this.getKanbanData(spreadsheetId)
    columns.push(column)
    columns.sort((a, b) => a.order - b.order)
    this.kanbanData.set(spreadsheetId, columns)

    // 广播更新
    this.context.api.websocket.broadcastTo(`kanban:${spreadsheetId}`, 'kanban:columnAdded', column)

    return column
  }

  /**
   * 生成列ID
   */
  private generateColumnId(title: string): string {
    return title.toLowerCase().replace(/[^a-z0-9]/g, '_')
  }

  /**
   * 同步看板数据
   */
  private async syncKanbanData(spreadsheetId: string): Promise<void> {
    // 清除缓存，强制重新加载
    this.kanbanData.delete(spreadsheetId)
    await this.getKanbanData(spreadsheetId)
  }

  /**
   * 处理记录创建
   */
  private async handleRecordCreated(data: any): Promise<void> {
    await this.syncKanbanData(data.spreadsheetId)

    this.context.api.websocket.broadcastTo(
      `kanban:${data.spreadsheetId}`,
      'kanban:recordCreated',
      data
    )
  }

  /**
   * 处理记录更新
   */
  private async handleRecordUpdated(data: any): Promise<void> {
    await this.syncKanbanData(data.spreadsheetId)

    this.context.api.websocket.broadcastTo(
      `kanban:${data.spreadsheetId}`,
      'kanban:recordUpdated',
      data
    )
  }

  /**
   * 处理记录删除
   */
  private async handleRecordDeleted(data: any): Promise<void> {
    await this.syncKanbanData(data.spreadsheetId)

    this.context.api.websocket.broadcastTo(
      `kanban:${data.spreadsheetId}`,
      'kanban:recordDeleted',
      data
    )
  }
}
