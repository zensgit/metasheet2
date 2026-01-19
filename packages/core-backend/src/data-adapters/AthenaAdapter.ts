export interface AthenaDocument {
  id: string
  name: string
  type?: string
  size?: number
  version?: string
  created_at?: string
  updated_at?: string
  checked_out_by?: string | null
  checked_out_at?: string | null
  [key: string]: unknown
}

export interface DocumentVersion {
  version: string
  created_at: string
  created_by?: string | null
  [key: string]: unknown
}
