/**
 * Dashboard model definitions for multitable dashboard V1.
 */

export interface DashboardPanel {
  id: string
  chartId: string
  position: { x: number; y: number; w: number; h: number } // grid layout
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
