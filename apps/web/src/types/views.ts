// View type definitions for MetaSheet multi-view system

export type ViewType = 'grid' | 'kanban' | 'calendar' | 'gallery' | 'form'

export interface BaseViewConfig {
  id: string
  name: string
  type: ViewType
  description?: string
  createdAt: Date
  updatedAt: Date
  createdBy: string
  tableId?: string
  filters?: any[]
  sorting?: any[]
  visibleFields?: string[]
  group?: string
  config?: any
  // UI-specific properties
  icon?: string
  badge?: string | number
  shortName?: string
  editable?: boolean
  deletable?: boolean
  isDefault?: boolean
}

// Gallery View Configuration
export interface GalleryConfig extends BaseViewConfig {
  type: 'gallery'
  cardTemplate: {
    titleField: string
    contentFields: string[]
    imageField?: string
    tagFields?: string[]
  }
  layout: {
    columns: number // Grid columns (auto, 2, 3, 4, 5, 6)
    cardSize: 'small' | 'medium' | 'large'
    spacing: 'compact' | 'normal' | 'comfortable'
  }
  display: {
    showTitle: boolean
    showContent: boolean
    showImage: boolean
    showTags: boolean
    truncateContent: boolean
    maxContentLength?: number
  }
  filters?: {
    field: string
    operator: 'equals' | 'contains' | 'startsWith' | 'endsWith' | 'gt' | 'lt' | 'between'
    value: any
    values?: any[] // For 'between' operator or multiple values
  }[]
  sorting?: {
    field: string
    direction: 'asc' | 'desc'
  }[]
}

// Form View Configuration
export interface FormConfig extends BaseViewConfig {
  type: 'form'
  fields: FormField[]
  settings: {
    title: string
    description?: string
    submitButtonText: string
    successMessage?: string
    allowMultiple: boolean // Allow multiple submissions
    requireAuth: boolean // Require authentication
    enablePublicAccess: boolean // Allow public submissions
    notifyOnSubmission: boolean
    emailNotifications?: string[] // Email addresses to notify
  }
  validation: {
    enableValidation: boolean
    customRules?: ValidationRule[]
  }
  styling: {
    theme: 'default' | 'minimal' | 'modern'
    primaryColor?: string
    layout: 'single-column' | 'two-column'
  }
}

export interface FormField {
  id: string
  name: string
  label: string
  type: FieldType
  required: boolean
  placeholder?: string
  defaultValue?: any
  description?: string
  order: number
  width?: 'full' | 'half' | 'third' | 'quarter'
  options?: FormFieldOption[] // For select, radio, checkbox
  validation?: FieldValidation
  conditional?: ConditionalLogic
}

export type FieldType =
  | 'text'
  | 'textarea'
  | 'number'
  | 'email'
  | 'url'
  | 'phone'
  | 'date'
  | 'datetime'
  | 'time'
  | 'select'
  | 'multiselect'
  | 'radio'
  | 'checkbox'
  | 'file'
  | 'image'
  | 'rating'
  | 'slider'
  | 'color'
  | 'signature'

export interface FormFieldOption {
  value: string
  label: string
  color?: string
}

export interface FieldValidation {
  minLength?: number
  maxLength?: number
  min?: number
  max?: number
  pattern?: string
  custom?: string // Custom validation function
}

export interface ConditionalLogic {
  field: string
  operator: 'equals' | 'not_equals' | 'contains' | 'greater_than' | 'less_than'
  value: any
  action: 'show' | 'hide' | 'require' | 'disable'
}

export interface ValidationRule {
  id: string
  field: string
  rule: string
  message: string
}

// Form Response (for storing submitted data)
export interface FormResponse {
  id: string
  formId: string
  data: Record<string, any>
  submittedAt: Date
  submittedBy?: string // User ID if authenticated
  ipAddress?: string
  userAgent?: string
  status: 'submitted' | 'processed' | 'archived'
}

// Gallery Card Data (processed record)
export interface GalleryCard {
  id: string
  title: string
  content: string[]
  image?: string
  tags?: string[]
  data: Record<string, any> // Full record data
  metadata?: {
    createdAt?: Date
    updatedAt?: Date
    author?: string
  }
}

// View State Management
export interface ViewState {
  viewId: string
  filters: Record<string, any>
  sorting: {
    field: string
    direction: 'asc' | 'desc'
  }[]
  pagination: {
    page: number
    pageSize: number
    total: number
  }
  selectedItems: string[]
  lastModified: Date
}

// API Response Types
export interface ViewConfigResponse {
  success: boolean
  data: BaseViewConfig | null
  error?: string
}

export interface ViewDataResponse<T = any> {
  success: boolean
  data: T[]
  meta: {
    total: number
    page: number
    pageSize: number
    hasMore: boolean
  }
  error?: string
}

export interface FormSubmissionResponse {
  success: boolean
  data?: {
    id: string
    message: string
  }
  error?: string
}

// Calendar View Configuration
export interface CalendarConfig extends BaseViewConfig {
  type: 'calendar'
  defaultView: 'month' | 'week' | 'day' | 'list'
  weekStartsOn: 0 | 1 | 2 | 3 | 4 | 5 | 6 // 0 = Sunday, 1 = Monday, etc.
  timeFormat: 12 | 24
  fields: {
    title: string
    start: string
    startDate?: string // Alternative field name
    end?: string
    endDate?: string // Alternative field name
    allDay?: string
    color?: string
    description?: string
    category?: string
    location?: string
  }
  colors?: Record<string, string>
  colorRules?: any[] // Dynamic color assignment rules
  workingHours?: {
    start: string // e.g., '09:00'
    end: string   // e.g., '18:00'
  }
}

export interface CalendarEvent {
  id: string
  title: string
  start: Date
  end: Date
  allDay?: boolean
  color?: string
  description?: string
  data?: Record<string, any>
  // Extended properties
  startDate?: Date // Alternative date format
  endDate?: Date // Alternative date format
  startTime?: string
  location?: string
  attendees?: Array<{ id: string; name: string }> // Attendee objects
  category?: string
}

export interface CalendarDay {
  date: Date
  day: number // Day of month (1-31)
  isToday: boolean
  isWeekend: boolean
  isOtherMonth: boolean
  isCurrentMonth: boolean
  events: CalendarEvent[]
}

// Kanban View Configuration
export interface KanbanConfig extends BaseViewConfig {
  type: 'kanban'
  groupByField: string
  cardFields: {
    title: string
    description?: string
    tags?: string
    assignee?: string
    dueDate?: string
  }
  columns: {
    id: string
    name: string
    color?: string
    order: number
  }[]
  cardLayout: 'compact' | 'normal' | 'detailed'
  swimlanes?: {
    enabled: boolean
    groupBy?: string
  }
}

// Grid View Configuration
export interface GridConfig extends BaseViewConfig {
  type: 'grid'
  columns: {
    field: string
    width?: number
    frozen?: boolean
    hidden?: boolean
  }[]
  rowHeight: 'compact' | 'normal' | 'comfortable'
  showRowNumbers: boolean
  enableGrouping: boolean
  enableFiltering: boolean
  enableSorting: boolean
}

// Generic View type (union of all specific view types)
export type View = BaseViewConfig | GalleryConfig | FormConfig | CalendarConfig | KanbanConfig | GridConfig