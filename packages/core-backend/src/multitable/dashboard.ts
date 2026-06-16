/**
 * Dashboard model definitions for multitable dashboard V1.
 *
 * NOTE: panels are stored as OPAQUE JSONB — this type is documentation only and
 * is NOT used to validate or reshape the persisted panel (DashboardService spreads
 * `input.panels` straight into the row). The de-facto contract is the frontend
 * `DashboardPanel` (apps/web/src/multitable/types.ts). Kept in sync for honesty.
 *
 * B4: a panel is a tagged union over an OPTIONAL `type` discriminator. A legacy
 * panel (no `type`) is a chart; consumers read `type ?? 'chart'`. No migration is
 * needed because the panel round-trips opaquely.
 */

export type DashboardPanelType = 'chart' | 'metric' | 'text' | 'filter'

export interface DashboardPanel {
  id: string
  /** Absent → 'chart' (legacy panels). */
  type?: DashboardPanelType
  /** Required for a chart panel; absent for metric/text/filter widgets. */
  chartId?: string
  /** Optional widget title for non-chart panels. */
  title?: string
  /** Per-widget config (only the active widget's sub-object is meaningful). */
  metricConfig?: { aggregation: string; valueFieldId?: string; prefix?: string; suffix?: string }
  textConfig?: { content: string }
  filterConfig?: { fieldId?: string }
  size?: 'small' | 'medium' | 'large'
  order?: number
  /** Legacy V1 grid layout (superseded by `size`/`order`); tolerated on read. */
  position?: { x: number; y: number; w: number; h: number }
}

export interface Dashboard {
  id: string
  name: string
  sheetId: string
  panels: DashboardPanel[]
  createdBy: string
  createdAt: string
  updatedAt?: string
}

export interface DashboardCreateInput {
  name: string
  sheetId: string
  createdBy?: string
}

export interface DashboardUpdateInput {
  name?: string
  panels?: DashboardPanel[]
}
