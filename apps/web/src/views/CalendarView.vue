<template>
  <div class="calendar-container">
    <!-- Calendar Header -->
    <div class="calendar-header">
      <div class="header-left">
        <button @click="navigateMonth(-1)" class="nav-btn">
          <span>‹</span>
        </button>
        <button @click="goToToday" class="today-btn">今天</button>
        <button @click="navigateMonth(1)" class="nav-btn">
          <span>›</span>
        </button>
        <h2 class="current-month">{{ currentMonthYear }}</h2>
      </div>

      <div class="header-right">
        <!-- View Mode Selector -->
        <div class="view-mode-selector">
          <button
            v-for="mode in viewModes"
            :key="mode.value"
            @click="viewMode = mode.value"
            class="mode-btn"
            :class="{ active: viewMode === mode.value }"
          >
            {{ mode.label }}
          </button>
        </div>

        <!-- Settings -->
        <button @click="showConfigModal = true" class="config-btn">
          ⚙️ 设置
        </button>
      </div>
    </div>

    <!-- Loading State -->
    <div v-if="loading" class="loading-state">
      <div class="loading-spinner"></div>
      <p>加载日历数据中...</p>
    </div>

    <!-- Error State -->
    <div v-else-if="error" class="error-state">
      <p class="error-message">{{ error }}</p>
      <button @click="loadEvents" class="retry-btn">重试</button>
    </div>

    <!-- Calendar Views -->
    <div v-else class="calendar-content">
      <!-- Month View -->
      <div v-if="viewMode === 'month'" class="month-view">
        <div class="weekdays">
          <div v-for="day in weekDays" :key="day" class="weekday">
            {{ day }}
          </div>
        </div>

        <div class="calendar-grid">
          <div
            v-for="(day, index) in calendarDays"
            :key="index"
            class="calendar-day"
            :class="{
              'other-month': !day.isCurrentMonth,
              'is-today': day.isToday,
              'is-selected': isSelectedDate(day.date),
              'has-events': day.events.length > 0
            }"
            @click="selectDate(day)"
          >
            <div class="day-number">{{ day.day }}</div>

            <div v-if="day.events.length > 0" class="day-events">
              <div
                v-for="(event, idx) in day.events.slice(0, 3)"
                :key="event.id"
                class="event-item"
                :style="{ backgroundColor: event.color || '#667eea' }"
                @click.stop="openEventDetail(event)"
              >
                <span class="event-time" v-if="event.allDay !== true">
                  {{ formatEventTime(event.startTime) }}
                </span>
                <span class="event-title">{{ event.title }}</span>
              </div>
              <div v-if="day.events.length > 3" class="more-events">
                +{{ day.events.length - 3 }} 更多
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- Week View -->
      <div v-else-if="viewMode === 'week'" class="week-view">
        <div class="week-header">
          <div class="time-gutter"></div>
          <div
            v-for="day in weekViewDays"
            :key="day.date"
            class="week-day-header"
            :class="{ 'is-today': day.isToday }"
          >
            <div class="week-day-name">{{ day.dayName }}</div>
            <div class="week-day-number">{{ day.dayNumber }}</div>
          </div>
        </div>

        <div class="week-body">
          <div class="time-column">
            <div v-for="hour in 24" :key="hour" class="time-slot">
              {{ formatHour(hour - 1) }}
            </div>
          </div>

          <div class="week-grid">
            <div
              v-for="day in weekViewDays"
              :key="day.date"
              class="week-day-column"
            >
              <div v-for="hour in 24" :key="hour" class="hour-slot">
                <div
                  v-for="event in getEventsForHour(day.date, hour - 1)"
                  :key="event.id"
                  class="week-event"
                  :style="{
                    backgroundColor: event.color || '#667eea',
                    top: getEventTop(event),
                    height: getEventHeight(event)
                  }"
                  @click="openEventDetail(event)"
                >
                  <span class="week-event-time">
                    {{ formatEventTime(event.startTime) }}
                  </span>
                  <span class="week-event-title">{{ event.title }}</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- Day View -->
      <div v-else-if="viewMode === 'day'" class="day-view">
        <div class="day-header">
          <h3>{{ formatDate(selectedDate) }}</h3>
        </div>

        <div class="day-timeline">
          <div class="timeline-hours">
            <div v-for="hour in 24" :key="hour" class="hour-block">
              <div class="hour-label">{{ formatHour(hour - 1) }}</div>
              <div class="hour-content">
                <div
                  v-for="event in getEventsForHour(selectedDate, hour - 1)"
                  :key="event.id"
                  class="timeline-event"
                  :style="{ backgroundColor: event.color || '#667eea' }"
                  @click="openEventDetail(event)"
                >
                  <div class="timeline-event-time">
                    {{ formatEventTimeRange(event) }}
                  </div>
                  <div class="timeline-event-title">{{ event.title }}</div>
                  <div v-if="event.location" class="timeline-event-location">
                    📍 {{ event.location }}
                  </div>
                </div>
              </div>
            </div>
          </div>

          <!-- All-day events -->
          <div v-if="allDayEvents.length > 0" class="all-day-section">
            <h4>全天事件</h4>
            <div class="all-day-events">
              <div
                v-for="event in allDayEvents"
                :key="event.id"
                class="all-day-event"
                :style="{ backgroundColor: event.color || '#667eea' }"
                @click="openEventDetail(event)"
              >
                {{ event.title }}
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- List View -->
      <div v-else-if="viewMode === 'list'" class="list-view">
        <div class="list-controls">
          <select v-model="listRange" class="range-select">
            <option value="week">本周</option>
            <option value="month">本月</option>
            <option value="quarter">本季度</option>
          </select>
        </div>

        <div class="events-list">
          <div
            v-for="group in groupedEvents"
            :key="group.date"
            class="event-group"
          >
            <div class="group-header">
              <h3>{{ formatGroupDate(group.date) }}</h3>
              <span class="event-count">{{ group.events.length }} 个事件</span>
            </div>

            <div class="group-events">
              <div
                v-for="event in group.events"
                :key="event.id"
                class="list-event-item"
                @click="openEventDetail(event)"
              >
                <div class="event-color" :style="{ backgroundColor: event.color || '#667eea' }"></div>
                <div class="event-info">
                  <div class="event-title">{{ event.title }}</div>
                  <div class="event-meta">
                    <span class="event-time">
                      {{ event.allDay ? '全天' : formatEventTimeRange(event) }}
                    </span>
                    <span v-if="event.location" class="event-location">
                      📍 {{ event.location }}
                    </span>
                    <span v-if="event.attendees" class="event-attendees">
                      👥 {{ event.attendees.length }}
                    </span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- Event Detail Modal -->
    <div v-if="showEventModal" class="modal-overlay" @click="closeEventModal">
      <div class="event-modal" @click.stop>
        <div class="modal-header">
          <h2>事件详情</h2>
          <button @click="closeEventModal" class="close-btn">×</button>
        </div>

        <div v-if="selectedEvent" class="modal-body">
          <div class="event-detail">
            <h3 class="event-title">{{ selectedEvent.title }}</h3>

            <div class="detail-row">
              <span class="detail-label">时间:</span>
              <span class="detail-value">
                {{ selectedEvent.allDay ? '全天' : formatEventTimeRange(selectedEvent) }}
              </span>
            </div>

            <div v-if="selectedEvent.location" class="detail-row">
              <span class="detail-label">地点:</span>
              <span class="detail-value">{{ selectedEvent.location }}</span>
            </div>

            <div v-if="selectedEvent.description" class="detail-row">
              <span class="detail-label">描述:</span>
              <p class="detail-value">{{ selectedEvent.description }}</p>
            </div>

            <div v-if="selectedEvent.attendees && selectedEvent.attendees.length > 0" class="detail-row">
              <span class="detail-label">参与者:</span>
              <div class="attendees-list">
                <span
                  v-for="attendee in selectedEvent.attendees"
                  :key="attendee.id"
                  class="attendee-chip"
                >
                  {{ attendee.name }}
                </span>
              </div>
            </div>

            <div v-if="selectedEvent.category" class="detail-row">
              <span class="detail-label">分类:</span>
              <span class="category-badge" :style="{ backgroundColor: selectedEvent.color }">
                {{ selectedEvent.category }}
              </span>
            </div>
          </div>
        </div>

        <div class="modal-footer">
          <button @click="editEvent" class="edit-btn">编辑</button>
          <button @click="deleteEvent" class="delete-btn">删除</button>
        </div>
      </div>
    </div>

    <!-- Configuration Modal -->
    <div v-if="showConfigModal" class="modal-overlay" @click="closeConfigModal">
      <div class="config-modal" @click.stop>
        <div class="modal-header">
          <h2>日历设置</h2>
          <button @click="closeConfigModal" class="close-btn">×</button>
        </div>

        <div class="modal-body">
          <div class="config-section">
            <h3>显示设置</h3>

            <div class="form-group">
              <label>默认视图:</label>
              <select v-model="config.defaultView">
                <option value="month">月视图</option>
                <option value="week">周视图</option>
                <option value="day">日视图</option>
                <option value="list">列表视图</option>
              </select>
            </div>

            <div class="form-group">
              <label>每周起始日:</label>
              <select v-model="config.weekStartsOn">
                <option :value="0">周日</option>
                <option :value="1">周一</option>
              </select>
            </div>

            <div class="form-group">
              <label>时间格式:</label>
              <select v-model="config.timeFormat">
                <option value="12">12小时制</option>
                <option value="24">24小时制</option>
              </select>
            </div>
          </div>

          <div class="config-section">
            <h3>数据映射</h3>

            <div class="form-group">
              <label>标题字段:</label>
              <select v-model="config.fields.title">
                <option v-for="field in availableFields" :key="field" :value="field">
                  {{ field }}
                </option>
              </select>
            </div>

            <div class="form-group">
              <label>开始时间字段:</label>
              <select v-model="config.fields.startDate">
                <option v-for="field in dateFields" :key="field" :value="field">
                  {{ field }}
                </option>
              </select>
            </div>

            <div class="form-group">
              <label>结束时间字段:</label>
              <select v-model="config.fields.endDate">
                <option v-for="field in dateFields" :key="field" :value="field">
                  {{ field }}
                </option>
              </select>
            </div>

            <div class="form-group">
              <label>分类字段:</label>
              <select v-model="config.fields.category">
                <option value="">无</option>
                <option v-for="field in categoryFields" :key="field" :value="field">
                  {{ field }}
                </option>
              </select>
            </div>
          </div>

          <div class="config-section">
            <h3>颜色设置</h3>

            <div class="color-rules">
              <div
                v-for="(rule, index) in config.colorRules"
                :key="index"
                class="color-rule"
              >
                <select v-model="rule.field">
                  <option v-for="field in availableFields" :key="field" :value="field">
                    {{ field }}
                  </option>
                </select>
                <input v-model="rule.value" placeholder="值" />
                <input v-model="rule.color" type="color" />
                <button @click="removeColorRule(index)" class="remove-rule">×</button>
              </div>
            </div>
            <button @click="addColorRule" class="add-rule-btn">+ 添加颜色规则</button>
          </div>
        </div>

        <div class="modal-footer">
          <button @click="saveConfig" class="save-btn">保存</button>
          <button @click="closeConfigModal" class="cancel-btn">取消</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue'
import { useRoute } from 'vue-router'
import type { CalendarConfig, CalendarEvent, CalendarDay } from '../types/views'
import { ViewManager } from '../services/ViewManager'

// Props and route
const route = useRoute()
const viewId = computed(() => {
  const id = route.params.viewId
  return typeof id === 'string' ? id : 'calendar1'
})

// Services
const viewManager = ViewManager.getInstance()

// Reactive data
const loading = ref(true)
const error = ref('')
const events = ref<CalendarEvent[]>([])
const config = ref<CalendarConfig>({
  id: viewId.value,
  name: '日历视图',
  type: 'calendar',
  defaultView: 'month',
  weekStartsOn: 1,
  timeFormat: 24,
  fields: {
    title: 'title',
    start: 'startDate',
    end: 'endDate',
    startDate: 'startDate',
    endDate: 'endDate',
    category: 'category',
    location: 'location'
  },
  colorRules: [],
  filters: [],
  createdAt: new Date(),
  updatedAt: new Date(),
  createdBy: 'system'
})

// UI State
const currentDate = ref(new Date())
const selectedDate = ref(new Date())
const viewMode = ref<'month' | 'week' | 'day' | 'list'>('month')
const showEventModal = ref(false)
const showConfigModal = ref(false)
const selectedEvent = ref<CalendarEvent | null>(null)
const listRange = ref<'week' | 'month' | 'quarter'>('month')

// Available fields for configuration
const availableFields = ref(['title', 'description', 'category', 'status', 'priority'])
const dateFields = ref(['startDate', 'endDate', 'dueDate', 'createdAt', 'updatedAt'])
const categoryFields = ref(['category', 'type', 'status', 'priority'])

// View modes
const viewModes: Array<{ value: 'month' | 'week' | 'day' | 'list'; label: string }> = [
  { value: 'month', label: '月' },
  { value: 'week', label: '周' },
  { value: 'day', label: '日' },
  { value: 'list', label: '列表' }
]

// Computed properties
const weekDays = computed(() => {
  const days = ['日', '一', '二', '三', '四', '五', '六']
  if (config.value.weekStartsOn === 1) {
    return [...days.slice(1), days[0]]
  }
  return days
})

const currentMonthYear = computed(() => {
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: 'long'
  }).format(currentDate.value)
})

const calendarDays = computed((): CalendarDay[] => {
  const year = currentDate.value.getFullYear()
  const month = currentDate.value.getMonth()
  const firstDay = new Date(year, month, 1)
  const lastDay = new Date(year, month + 1, 0)

  const startOffset = (firstDay.getDay() - config.value.weekStartsOn + 7) % 7
  const totalDays = lastDay.getDate()
  const totalCells = Math.ceil((totalDays + startOffset) / 7) * 7

  const days: CalendarDay[] = []
  const today = new Date()

  for (let i = 0; i < totalCells; i++) {
    const dayDate = new Date(year, month, i - startOffset + 1)
    const isCurrentMonth = dayDate.getMonth() === month
    const isToday = dayDate.toDateString() === today.toDateString()

    days.push({
      date: dayDate,
      day: dayDate.getDate(),
      isCurrentMonth,
      isToday,
      isWeekend: dayDate.getDay() === 0 || dayDate.getDay() === 6,
      isOtherMonth: !isCurrentMonth,
      events: getEventsForDate(dayDate)
    })
  }

  return days
})

const weekViewDays = computed(() => {
  const days = []
  const startOfWeek = getStartOfWeek(currentDate.value)

  for (let i = 0; i < 7; i++) {
    const date = new Date(startOfWeek)
    date.setDate(startOfWeek.getDate() + i)

    days.push({
      date: date.toISOString(),
      dayName: weekDays.value[i],
      dayNumber: date.getDate(),
      isToday: date.toDateString() === new Date().toDateString()
    })
  }

  return days
})

const allDayEvents = computed(() => {
  return getEventsForDate(selectedDate.value).filter(e => e.allDay)
})

const groupedEvents = computed(() => {
  const grouped: { date: string; events: CalendarEvent[] }[] = []
  const eventsByDate = new Map<string, CalendarEvent[]>()

  const filteredEvents = getEventsInRange(listRange.value)

  filteredEvents.forEach(event => {
    if (!event.startDate) return
    const dateKey = new Date(event.startDate).toDateString()
    if (!eventsByDate.has(dateKey)) {
      eventsByDate.set(dateKey, [])
    }
    const dayEvents = eventsByDate.get(dateKey)
    if (dayEvents) {
      dayEvents.push(event)
    }
  })

  Array.from(eventsByDate.entries())
    .sort(([a], [b]) => new Date(a).getTime() - new Date(b).getTime())
    .forEach(([date, events]) => {
      grouped.push({ date, events })
    })

  return grouped
})

// Methods
async function loadEvents() {
  loading.value = true
  error.value = ''

  try {
    // Load configuration
    const savedConfig = await viewManager.loadViewConfig<CalendarConfig>(viewId.value)
    if (savedConfig) {
      config.value = savedConfig
      viewMode.value = savedConfig.defaultView
    }

    // Load events
    const response = await viewManager.loadViewData(viewId.value)
    events.value = transformDataToEvents(response.data)
  } catch (err) {
    console.error('Failed to load calendar:', err)
    error.value = '加载日历数据失败'
  } finally {
    loading.value = false
  }
}

function transformDataToEvents(data: any[]): CalendarEvent[] {
  if (!data || !Array.isArray(data)) return []

  const fields = config.value.fields

  return data.map((item, index) => {
    const startDateValue = item[fields.startDate || 'startDate']
    const endDateValue = item[fields.endDate || 'endDate']
    const descriptionField = fields.description || 'description'
    const categoryField = fields.category || 'category'

    const startDate = startDateValue ? new Date(startDateValue) : new Date()
    const endDate = endDateValue ? new Date(endDateValue) : new Date()

    return {
      id: item.id || `event-${index}`,
      title: item[fields.title] || '未命名事件',
      start: startDate,
      end: endDate,
      startDate,
      endDate: endDateValue ? endDate : undefined,
      allDay: typeof startDateValue === 'string' ? !startDateValue.includes('T') : false,
      location: item[fields.location || 'location'],
      description: item[descriptionField],
      category: item[categoryField],
      color: getEventColor(item),
      attendees: Array.isArray(item.attendees) ? item.attendees : [],
      startTime: startDateValue,
      endTime: endDateValue
    }
  })
}

function getEventColor(item: any): string {
  for (const rule of (config.value.colorRules || [])) {
    if (item[rule.field] === rule.value) {
      return rule.color
    }
  }

  // Default colors by category
  const categoryColors: Record<string, string> = {
    meeting: '#4CAF50',
    task: '#2196F3',
    reminder: '#FF9800',
    birthday: '#E91E63',
    holiday: '#9C27B0'
  }

  return categoryColors[item.category] || '#667eea'
}

function getEventsForDate(date: Date): CalendarEvent[] {
  if (!Array.isArray(events.value)) return []

  return events.value.filter(event => {
    if (!event || !event.startDate) return false
    const eventDate = new Date(event.startDate)
    return eventDate.toDateString() === date.toDateString()
  })
}

function getEventsForHour(date: string | Date, hour: number): CalendarEvent[] {
  if (!Array.isArray(events.value)) return []

  const targetDate = typeof date === 'string' ? new Date(date) : date
  if (isNaN(targetDate.getTime())) return []

  return events.value.filter(event => {
    if (!event || !event.startDate || event.allDay) return false

    const eventDate = new Date(event.startDate)
    if (isNaN(eventDate.getTime()) || eventDate.toDateString() !== targetDate.toDateString()) return false

    const eventHour = eventDate.getHours()
    return eventHour === hour
  })
}

function getEventsInRange(range: 'week' | 'month' | 'quarter'): CalendarEvent[] {
  if (!Array.isArray(events.value)) return []

  const now = new Date()
  const start = new Date(now)
  const end = new Date(now)

  switch (range) {
    case 'week':
      start.setDate(now.getDate() - now.getDay())
      end.setDate(start.getDate() + 7)
      break
    case 'month':
      start.setDate(1)
      end.setMonth(now.getMonth() + 1, 0)
      break
    case 'quarter':
      const quarter = Math.floor(now.getMonth() / 3)
      start.setMonth(quarter * 3, 1)
      end.setMonth(quarter * 3 + 3, 0)
      break
  }

  return events.value.filter(event => {
    if (!event || !event.startDate) return false
    const eventDate = new Date(event.startDate)
    return !isNaN(eventDate.getTime()) && eventDate >= start && eventDate <= end
  })
}

function getStartOfWeek(date: Date): Date {
  const d = new Date(date)
  const day = d.getDay()
  const diff = (day - config.value.weekStartsOn + 7) % 7
  d.setDate(d.getDate() - diff)
  d.setHours(0, 0, 0, 0)
  return d
}

function navigateMonth(direction: number) {
  const newDate = new Date(currentDate.value)
  newDate.setMonth(newDate.getMonth() + direction)
  currentDate.value = newDate
}

function goToToday() {
  currentDate.value = new Date()
  selectedDate.value = new Date()
}

function selectDate(day: CalendarDay) {
  if (!day || !day.date) return

  selectedDate.value = new Date(day.date)
  if (Array.isArray(day.events) && day.events.length > 0 && viewMode.value === 'month') {
    viewMode.value = 'day'
  }
}

function isSelectedDate(date: Date): boolean {
  return date.toDateString() === selectedDate.value.toDateString()
}

function formatHour(hour: number): string {
  if (config.value.timeFormat === 12) {
    const h = hour % 12 || 12
    const ampm = hour < 12 ? 'AM' : 'PM'
    return `${h}:00 ${ampm}`
  }
  return `${hour.toString().padStart(2, '0')}:00`
}

function formatEventTime(time: string | Date | undefined): string {
  if (!time) return ''

  const date = new Date(time)
  if (isNaN(date.getTime())) return ''

  const hour = date.getHours()
  const minute = date.getMinutes()

  if (config.value.timeFormat === 12) {
    const h = hour % 12 || 12
    const ampm = hour < 12 ? 'AM' : 'PM'
    return `${h}:${minute.toString().padStart(2, '0')} ${ampm}`
  }

  return `${hour.toString().padStart(2, '0')}:${minute.toString().padStart(2, '0')}`
}

function formatEventTimeRange(event: CalendarEvent): string {
  if (!event) return ''
  if (event.allDay) return '全天'

  const start = formatEventTime(event.startDate)
  if (!start) return ''

  const end = event.endDate ? formatEventTime(event.endDate) : ''

  return end ? `${start} - ${end}` : start
}

function formatDate(date: Date): string {
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    weekday: 'long'
  }).format(date)
}

function formatGroupDate(dateStr: string): string {
  const date = new Date(dateStr)
  const today = new Date()
  const yesterday = new Date(today)
  yesterday.setDate(yesterday.getDate() - 1)
  const tomorrow = new Date(today)
  tomorrow.setDate(tomorrow.getDate() + 1)

  if (date.toDateString() === today.toDateString()) {
    return '今天'
  } else if (date.toDateString() === yesterday.toDateString()) {
    return '昨天'
  } else if (date.toDateString() === tomorrow.toDateString()) {
    return '明天'
  }

  return new Intl.DateTimeFormat('zh-CN', {
    month: 'short',
    day: 'numeric',
    weekday: 'short'
  }).format(date)
}

function getEventTop(event: CalendarEvent): string {
  if (!event || !event.startDate) return '0%'

  const date = new Date(event.startDate)
  if (isNaN(date.getTime())) return '0%'

  const minutes = date.getHours() * 60 + date.getMinutes()
  return `${(minutes / 1440) * 100}%`
}

function getEventHeight(event: CalendarEvent): string {
  if (!event || event.allDay) return '20px'

  const start = event.start
  const end = event.end

  if (isNaN(start.getTime()) || isNaN(end.getTime())) return '20px'

  const duration = (end.getTime() - start.getTime()) / (1000 * 60)
  if (duration <= 0) return '20px'

  return `${Math.max(20, (duration / 1440) * 100)}%`
}

function openEventDetail(event: CalendarEvent) {
  selectedEvent.value = event
  showEventModal.value = true
}

function closeEventModal() {
  showEventModal.value = false
  selectedEvent.value = null
}

function editEvent() {
  // Implement event editing
  console.log('Edit event:', selectedEvent.value)
  closeEventModal()
}

function deleteEvent() {
  if (confirm('确定要删除这个事件吗？')) {
    // Implement event deletion
    console.log('Delete event:', selectedEvent.value)
    closeEventModal()
  }
}

function closeConfigModal() {
  showConfigModal.value = false
}

function addColorRule() {
  if (!config.value.colorRules) {
    config.value.colorRules = []
  }
  config.value.colorRules.push({
    field: 'category',
    value: '',
    color: '#667eea'
  })
}

function removeColorRule(index: number) {
  if (config.value.colorRules) {
    config.value.colorRules.splice(index, 1)
  }
}

async function saveConfig() {
  const success = await viewManager.saveViewConfig(config.value)
  if (success) {
    showConfigModal.value = false
    loadEvents() // Reload with new config
  } else {
    alert('保存配置失败')
  }
}

// Lifecycle
onMounted(() => {
  loadEvents()
})

// Watch for view ID changes
watch(() => viewId.value, () => {
  loadEvents()
})
</script>

<style scoped>
.calendar-container {
  height: 100vh;
  display: flex;
  flex-direction: column;
  background: #f8f9fa;
}

.calendar-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 1rem 1.5rem;
  background: white;
  border-bottom: 1px solid #e0e0e0;
}

.header-left {
  display: flex;
  align-items: center;
  gap: 1rem;
}

.nav-btn {
  width: 36px;
  height: 36px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: white;
  border: 1px solid #ddd;
  border-radius: 6px;
  cursor: pointer;
  font-size: 1.2rem;
}

.nav-btn:hover {
  background: #f0f0f0;
}

.today-btn {
  padding: 0.5rem 1rem;
  background: white;
  border: 1px solid #ddd;
  border-radius: 6px;
  cursor: pointer;
}

.today-btn:hover {
  background: #f0f0f0;
}

.current-month {
  margin: 0;
  font-size: 1.25rem;
  font-weight: 600;
  color: #333;
}

.header-right {
  display: flex;
  align-items: center;
  gap: 1rem;
}

.view-mode-selector {
  display: flex;
  background: #f0f0f0;
  border-radius: 6px;
  padding: 2px;
}

.mode-btn {
  padding: 0.375rem 0.75rem;
  background: transparent;
  border: none;
  border-radius: 4px;
  cursor: pointer;
  transition: all 0.2s;
}

.mode-btn.active {
  background: white;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1);
}

.config-btn {
  padding: 0.5rem 1rem;
  background: white;
  border: 1px solid #ddd;
  border-radius: 6px;
  cursor: pointer;
}

.config-btn:hover {
  background: #f0f0f0;
}

/* Loading and Error States */
.loading-state,
.error-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 400px;
  color: #666;
}

.loading-spinner {
  width: 40px;
  height: 40px;
  border: 4px solid #f0f0f0;
  border-top: 4px solid #667eea;
  border-radius: 50%;
  animation: spin 1s linear infinite;
  margin-bottom: 1rem;
}

@keyframes spin {
  0% { transform: rotate(0deg); }
  100% { transform: rotate(360deg); }
}

.error-message {
  color: #ef4444;
  margin-bottom: 1rem;
}

.retry-btn {
  padding: 0.5rem 1rem;
  background: #667eea;
  color: white;
  border: none;
  border-radius: 6px;
  cursor: pointer;
}

/* Calendar Content */
.calendar-content {
  flex: 1;
  overflow: auto;
}

/* Month View */
.month-view {
  padding: 1rem;
}

.weekdays {
  display: grid;
  grid-template-columns: repeat(7, 1fr);
  gap: 0;
  margin-bottom: 0.5rem;
}

.weekday {
  text-align: center;
  font-weight: 600;
  color: #666;
  padding: 0.5rem;
  font-size: 0.875rem;
}

.calendar-grid {
  display: grid;
  grid-template-columns: repeat(7, 1fr);
  gap: 1px;
  background: #e0e0e0;
  border: 1px solid #e0e0e0;
}

.calendar-day {
  background: white;
  min-height: 100px;
  padding: 0.5rem;
  cursor: pointer;
  transition: background-color 0.2s;
}

.calendar-day:hover {
  background: #f8f9fa;
}

.calendar-day.other-month {
  background: #fafafa;
  color: #999;
}

.calendar-day.is-today {
  background: #e8f5e9;
}

.calendar-day.is-selected {
  background: #e3f2fd;
}

.day-number {
  font-weight: 500;
  margin-bottom: 0.25rem;
  font-size: 0.875rem;
}

.day-events {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.event-item {
  padding: 2px 4px;
  border-radius: 3px;
  color: white;
  font-size: 0.75rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  cursor: pointer;
}

.event-item:hover {
  opacity: 0.9;
}

.event-time {
  font-weight: 500;
  margin-right: 4px;
}

.more-events {
  font-size: 0.75rem;
  color: #666;
  margin-top: 2px;
}

/* Week View */
.week-view {
  display: flex;
  flex-direction: column;
  height: 100%;
}

.week-header {
  display: flex;
  background: white;
  border-bottom: 1px solid #e0e0e0;
}

.time-gutter {
  width: 60px;
  flex-shrink: 0;
}

.week-day-header {
  flex: 1;
  text-align: center;
  padding: 0.75rem 0.5rem;
  border-left: 1px solid #e0e0e0;
}

.week-day-header.is-today {
  background: #e8f5e9;
}

.week-day-name {
  font-size: 0.75rem;
  color: #666;
  text-transform: uppercase;
}

.week-day-number {
  font-size: 1.25rem;
  font-weight: 600;
  margin-top: 0.25rem;
}

.week-body {
  flex: 1;
  display: flex;
  overflow: auto;
}

.time-column {
  width: 60px;
  flex-shrink: 0;
  background: white;
  border-right: 1px solid #e0e0e0;
}

.time-slot {
  height: 60px;
  border-bottom: 1px solid #f0f0f0;
  padding: 4px 8px;
  font-size: 0.75rem;
  color: #666;
}

.week-grid {
  flex: 1;
  display: flex;
}

.week-day-column {
  flex: 1;
  border-right: 1px solid #e0e0e0;
}

.hour-slot {
  height: 60px;
  border-bottom: 1px solid #f0f0f0;
  position: relative;
}

.week-event {
  position: absolute;
  left: 2px;
  right: 2px;
  padding: 2px 4px;
  border-radius: 3px;
  color: white;
  font-size: 0.75rem;
  cursor: pointer;
  overflow: hidden;
}

.week-event-time {
  font-weight: 500;
  display: block;
}

.week-event-title {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* Day View */
.day-view {
  padding: 1rem;
}

.day-header {
  margin-bottom: 1rem;
}

.day-header h3 {
  margin: 0;
  font-size: 1.25rem;
  color: #333;
}

.day-timeline {
  background: white;
  border-radius: 8px;
  padding: 1rem;
}

.timeline-hours {
  display: flex;
  flex-direction: column;
}

.hour-block {
  display: flex;
  min-height: 80px;
  border-bottom: 1px solid #f0f0f0;
}

.hour-block:last-child {
  border-bottom: none;
}

.hour-label {
  width: 60px;
  flex-shrink: 0;
  padding: 0.5rem;
  font-size: 0.875rem;
  color: #666;
}

.hour-content {
  flex: 1;
  padding: 0.5rem;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.timeline-event {
  padding: 0.75rem;
  border-radius: 6px;
  color: white;
  cursor: pointer;
}

.timeline-event:hover {
  opacity: 0.9;
}

.timeline-event-time {
  font-size: 0.75rem;
  font-weight: 500;
  margin-bottom: 0.25rem;
}

.timeline-event-title {
  font-weight: 500;
}

.timeline-event-location {
  font-size: 0.875rem;
  margin-top: 0.25rem;
  opacity: 0.9;
}

.all-day-section {
  margin-top: 1rem;
  padding-top: 1rem;
  border-top: 2px solid #f0f0f0;
}

.all-day-section h4 {
  margin: 0 0 0.5rem 0;
  color: #666;
  font-size: 0.875rem;
}

.all-day-events {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.all-day-event {
  padding: 0.75rem;
  border-radius: 6px;
  color: white;
  cursor: pointer;
}

/* List View */
.list-view {
  padding: 1rem;
}

.list-controls {
  margin-bottom: 1rem;
}

.range-select {
  padding: 0.5rem;
  border: 1px solid #ddd;
  border-radius: 6px;
  background: white;
}

.events-list {
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.event-group {
  background: white;
  border-radius: 8px;
  overflow: hidden;
}

.group-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 1rem;
  background: #f8f9fa;
  border-bottom: 1px solid #e0e0e0;
}

.group-header h3 {
  margin: 0;
  font-size: 1rem;
  color: #333;
}

.event-count {
  font-size: 0.875rem;
  color: #666;
}

.group-events {
  padding: 0.5rem;
}

.list-event-item {
  display: flex;
  align-items: center;
  padding: 0.75rem;
  border-radius: 6px;
  cursor: pointer;
  transition: background-color 0.2s;
}

.list-event-item:hover {
  background: #f8f9fa;
}

.event-color {
  width: 4px;
  height: 40px;
  border-radius: 2px;
  margin-right: 1rem;
  flex-shrink: 0;
}

.event-info {
  flex: 1;
}

.event-title {
  font-weight: 500;
  margin-bottom: 0.25rem;
}

.event-meta {
  display: flex;
  align-items: center;
  gap: 1rem;
  font-size: 0.875rem;
  color: #666;
}

/* Modal Styles */
.modal-overlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
}

.event-modal,
.config-modal {
  background: white;
  border-radius: 8px;
  max-width: 600px;
  width: 90vw;
  max-height: 90vh;
  display: flex;
  flex-direction: column;
}

.modal-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 1.5rem;
  border-bottom: 1px solid #e0e0e0;
}

.modal-header h2 {
  margin: 0;
  font-size: 1.25rem;
  color: #333;
}

.close-btn {
  background: none;
  border: none;
  font-size: 1.5rem;
  cursor: pointer;
  color: #666;
}

.modal-body {
  flex: 1;
  padding: 1.5rem;
  overflow-y: auto;
}

.event-detail {
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.detail-row {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}

.detail-label {
  font-size: 0.875rem;
  color: #666;
  font-weight: 500;
}

.detail-value {
  color: #333;
}

.attendees-list {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
  margin-top: 0.5rem;
}

.attendee-chip {
  padding: 0.25rem 0.75rem;
  background: #f0f0f0;
  border-radius: 16px;
  font-size: 0.875rem;
}

.category-badge {
  display: inline-block;
  padding: 0.25rem 0.75rem;
  border-radius: 4px;
  color: white;
  font-size: 0.875rem;
}

.modal-footer {
  display: flex;
  justify-content: flex-end;
  gap: 0.5rem;
  padding: 1rem 1.5rem;
  border-top: 1px solid #e0e0e0;
}

.edit-btn,
.delete-btn,
.save-btn,
.cancel-btn {
  padding: 0.5rem 1rem;
  border: none;
  border-radius: 6px;
  cursor: pointer;
  font-weight: 500;
}

.edit-btn,
.save-btn {
  background: #667eea;
  color: white;
}

.delete-btn {
  background: #ef4444;
  color: white;
}

.cancel-btn {
  background: #f0f0f0;
  color: #333;
}

/* Config Modal */
.config-section {
  margin-bottom: 1.5rem;
}

.config-section h3 {
  margin: 0 0 1rem 0;
  font-size: 1rem;
  color: #333;
}

.form-group {
  margin-bottom: 1rem;
}

.form-group label {
  display: block;
  margin-bottom: 0.25rem;
  font-size: 0.875rem;
  color: #666;
}

.form-group select,
.form-group input {
  width: 100%;
  padding: 0.5rem;
  border: 1px solid #ddd;
  border-radius: 4px;
}

.color-rules {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  margin-bottom: 0.5rem;
}

.color-rule {
  display: flex;
  gap: 0.5rem;
  align-items: center;
}

.color-rule select,
.color-rule input[type="text"] {
  flex: 1;
  padding: 0.5rem;
  border: 1px solid #ddd;
  border-radius: 4px;
}

.color-rule input[type="color"] {
  width: 50px;
  height: 36px;
  border: 1px solid #ddd;
  border-radius: 4px;
  cursor: pointer;
}

.remove-rule {
  padding: 0.5rem;
  background: #fee2e2;
  border: none;
  border-radius: 4px;
  color: #dc2626;
  cursor: pointer;
}

.add-rule-btn {
  padding: 0.5rem 1rem;
  background: #f0f0f0;
  border: 1px solid #ddd;
  border-radius: 4px;
  cursor: pointer;
}

/* Responsive */
@media (max-width: 768px) {
  .calendar-header {
    flex-direction: column;
    gap: 1rem;
  }

  .header-left,
  .header-right {
    width: 100%;
  }

  .calendar-grid {
    gap: 0;
  }

  .calendar-day {
    min-height: 80px;
    padding: 0.25rem;
  }

  .weekdays {
    font-size: 0.75rem;
  }

  .day-number {
    font-size: 0.75rem;
  }

  .event-item {
    font-size: 0.625rem;
  }
}
</style>