/**
 * Task feature — notification text for the four outbox families (M4 PR-3b design §8.3, §10.4).
 * PURE, no I/O. Added by PR-3b S1.
 *
 * The delivery worker calls these at send time with the task / list row it has just re-read; the
 * outbox row itself holds no text (ASSUMPTION(task-m4): [own-3b-09]). Every user-sourced string
 * passes through `sanitizeTaskTextForMarkdown` before it is placed in a markdown body. The last
 * line of every body is `renderTaskDeliveryTag(deliveryId)` so that no two outbox rows render the
 * same body (ASSUMPTION(task-m4): [own-3b-20]). No deep link, no actor name (owner question §13-Q6).
 * Items the owner ruled on 2026-10-07 are tagged RULED(2026-10-07); the rest stay ASSUMPTION(task-m4).
 */
import { TASK_NOTIFIABLE_EVENTS, TASK_NOTIFIABLE_LIST_EVENTS, type TaskNotifiableEvent, type TaskNotifiableListEvent } from './task-notifications'

/** What a channel sends: a fixed title and a markdown body. */
export interface TaskDeliveryMessage {
  title: string
  content: string
}

/** Fixed titles, one per family (design §8.3). */
export const TASK_DELIVERY_TITLES = Object.freeze({
  task_event: '任务动态',
  task_reminder: '任务提醒',
  task_daily: '今日任务',
  task_list_event: '清单动态',
} as const)

/** Digest bodies list at most this many items; the rest is one `另有 N 项` line (ASSUMPTION(task-m4): [own-3b-08]). */
export const TASK_DIGEST_MAX_ITEMS = 20

/** Prefix of the per-row tag line (ASSUMPTION(task-m4): [own-3b-20]). */
export const TASK_DELIVERY_TAG_PREFIX = '编号 '

// ASSUMPTION(task-m4): [own-3b-09] markdown control characters in user text are replaced by their
// full-width forms so they can neither open markup nor be read as a link; CR / LF and the other
// ASCII control characters become one space so a title stays on its own line. The mapping is
// fixed by the test file; this is the only escaping the task line does (no deep link, so a URL
// never has to survive it).
const MARKDOWN_FULL_WIDTH: Readonly<Record<string, string>> = Object.freeze({
  '[': '［',
  ']': '］',
  '(': '（',
  ')': '）',
  '<': '＜',
  '>': '＞',
  '!': '！',
  '#': '＃',
  '*': '＊',
  '_': '＿',
  '~': '～',
  '`': '｀',
})

// eslint-disable-next-line no-control-regex
const ASCII_CONTROL_RE = /[\u0000-\u001f\u007f]/g
const MARKDOWN_SPECIAL_RE = /[[\]()<>!#*_~`]/g
// RULED(2026-10-09): user text in a notification body renders ':' as '：' (full-width), applied
// before the escapes above. The fixed parts of a body (labels, a due time) are not user text and
// keep their own characters.
const ASCII_COLON_RE = /:/g
const FULL_WIDTH_COLON = '：'

/**
 * Replaces `:` with its full-width form, then `[ ] ( ) < > ! # * _ ~ \`` with theirs and every
 * ASCII control character (including CR and LF) with a space. Throws for a non-string.
 */
export function sanitizeTaskTextForMarkdown(text: string): string {
  if (typeof text !== 'string') {
    throw new TypeError('sanitizeTaskTextForMarkdown: text must be a string')
  }
  return text
    .replace(ASCII_COLON_RE, FULL_WIDTH_COLON)
    .replace(ASCII_CONTROL_RE, ' ')
    .replace(MARKDOWN_SPECIAL_RE, (ch) => MARKDOWN_FULL_WIDTH[ch] ?? ch)
}

const DELIVERY_ID_HEX_PREFIX_RE = /^[0-9a-fA-F]{8}/

/**
 * `编号 <first 8 hex digits of the outbox row id, lower case>`. The id is a uuid, so its first eight
 * characters are hex; anything else is rejected (the tag must never carry arbitrary text).
 */
export function renderTaskDeliveryTag(deliveryId: string): string {
  if (typeof deliveryId !== 'string') {
    throw new TypeError('renderTaskDeliveryTag: deliveryId must be a string')
  }
  const m = DELIVERY_ID_HEX_PREFIX_RE.exec(deliveryId)
  if (!m) {
    throw new TypeError('renderTaskDeliveryTag: deliveryId must start with 8 hex digits')
  }
  return `${TASK_DELIVERY_TAG_PREFIX}${m[0].toLowerCase()}`
}

const CALENDAR_DATE_RE = /^\d{4}-\d{2}-\d{2}$/
// The task's `due_time` as the services read it (`due_time::text`): the write path stores the
// canonical `HH:MM:SS` and the domain grammar accepts `HH:MM` too, so both shapes are accepted.
const TIME_OF_DAY_RE = /^(\d{2}:\d{2})(:\d{2})?$/

function requireInput(fn: string, input: unknown): asserts input is Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new TypeError(`${fn}: input must be an object`)
  }
}

function requireText(fn: string, name: string, value: unknown): asserts value is string {
  if (typeof value !== 'string') {
    throw new TypeError(`${fn}: ${name} must be a string`)
  }
}

// ASSUMPTION(task-m4): [own-3b-10] [own-3b-25] the due line shows the task's own columns, not
// converted to the recipient's zone: `<due_date>[ <due_time>]` and the escaped zone name. A time
// with zero seconds (the stored form of an `HH:MM` input) is shown as `HH:MM`; non-zero seconds
// are shown as stored.
/** `when` = `<due_date>[ <due_time>]`, `zone` = the escaped zone name. Formats are checked. */
function formatDue(fn: string, dueDate: unknown, dueTime: unknown, timeZone: unknown): { when: string; zone: string } {
  if (typeof dueDate !== 'string' || !CALENDAR_DATE_RE.test(dueDate)) {
    throw new TypeError(`${fn}: dueDate must be YYYY-MM-DD`)
  }
  let time: string | null = null
  if (dueTime !== null && dueTime !== undefined) {
    const m = typeof dueTime === 'string' ? TIME_OF_DAY_RE.exec(dueTime) : null
    if (!m) {
      throw new TypeError(`${fn}: dueTime must be HH:MM, HH:MM:SS or null`)
    }
    time = m[2] === undefined || m[2] === ':00' ? m[1] : m[0]
  }
  requireText(fn, 'timeZone', timeZone)
  const when = time === null ? dueDate : `${dueDate} ${time}`
  return { when, zone: sanitizeTaskTextForMarkdown(timeZone) }
}

/** Paragraphs joined by a blank line; the tag is always the last line. */
function body(paragraphs: readonly string[], deliveryId: string): string {
  return [...paragraphs, renderTaskDeliveryTag(deliveryId)].join('\n\n')
}

export interface RenderTaskEventMessageInput {
  event: TaskNotifiableEvent
  /** The task's current title (user text; escaped here). */
  taskTitle: string
  deliveryId: string
}

const EVENT_SENTENCES: Readonly<Record<TaskNotifiableEvent, (title: string) => string>> = Object.freeze({
  completed: (t) => `任务「${t}」已完成`,
  completed_by_any: (t) => `任务「${t}」已完成`,
  reopened: (t) => `任务「${t}」已重启`,
  deleted: (t) => `任务「${t}」已被删除`,
  commented: (t) => `任务「${t}」有新评论`,
})

/** Family 3: 「任务动态」 + one sentence per event type + the tag. */
export function renderTaskEventMessage(input: RenderTaskEventMessageInput): TaskDeliveryMessage {
  const fn = 'renderTaskEventMessage'
  requireInput(fn, input)
  const { event, taskTitle, deliveryId } = input
  if (!(TASK_NOTIFIABLE_EVENTS as readonly string[]).includes(event as string)) {
    throw new TypeError(`${fn}: unknown event "${String(event)}"`)
  }
  requireText(fn, 'taskTitle', taskTitle)
  requireText(fn, 'deliveryId', deliveryId)
  const sentence = EVENT_SENTENCES[event as TaskNotifiableEvent](sanitizeTaskTextForMarkdown(taskTitle))
  return { title: TASK_DELIVERY_TITLES.task_event, content: body([sentence], deliveryId) }
}

export interface RenderTaskReminderMessageInput {
  taskTitle: string
  dueDate: string | null
  /** `HH:MM` or `HH:MM:SS` (`due_time::text`), or `null` for an all-day task. */
  dueTime: string | null
  /** The task's own zone; `null` only on an undated task (a dated task always has one). */
  timeZone: string | null
  deliveryId: string
}

/** Family 1: 「任务提醒」 + `任务「T」的提醒时间已到` [+ `截止：…`] + the tag. */
export function renderTaskReminderMessage(input: RenderTaskReminderMessageInput): TaskDeliveryMessage {
  const fn = 'renderTaskReminderMessage'
  requireInput(fn, input)
  const { taskTitle, dueDate, dueTime, timeZone, deliveryId } = input
  requireText(fn, 'taskTitle', taskTitle)
  requireText(fn, 'deliveryId', deliveryId)
  const paragraphs = [`任务「${sanitizeTaskTextForMarkdown(taskTitle)}」的提醒时间已到`]
  if (dueDate !== null && dueDate !== undefined) {
    const due = formatDue(fn, dueDate, dueTime, timeZone)
    paragraphs.push(`截止：${due.when}（${due.zone}）`)
  }
  return { title: TASK_DELIVERY_TITLES.task_reminder, content: body(paragraphs, deliveryId) }
}

export interface TaskDigestItem {
  title: string
  /** Every digest item has a due date (the digest set is overdue ∪ due by tomorrow). */
  dueDate: string
  /** `HH:MM` or `HH:MM:SS` (`due_time::text`), or `null` for an all-day task. */
  dueTime: string | null
  timeZone: string
}

export interface RenderTaskDailyDigestMessageInput {
  /** The first rows of the recipient's digest in display order (the worker's query orders them and
   * may fetch `TASK_DIGEST_MAX_ITEMS + 1`); at least one. Rows past the cap are not shown. */
  items: readonly TaskDigestItem[]
  /** How many rows the whole digest has (≥ `items.length`), e.g. `count(*) OVER ()` of the same query. */
  totalCount: number
  deliveryId: string
}

// RULED(2026-10-07): [R07] an empty digest is one skipped row and is never sent. ASSUMPTION(task-m4):
// [own-3b-03] the worker records `skipped` / `empty_digest` before reaching here, so zero items is
// a contract violation.
// ASSUMPTION(task-m4): [own-3b-25] each item line is `- 「T」（<due_date>[ <due_time>]，<zone>）`;
// the overflow line `另有 N 项` counts `totalCount` minus the lines shown, so the caller passes the
// digest's total row count rather than every row (design §7.4: item list and total).
/** Family 2: 「今日任务」 + up to `TASK_DIGEST_MAX_ITEMS` lines `- 「T」（<due>）` [+ `另有 N 项`] + the tag. */
export function renderTaskDailyDigestMessage(input: RenderTaskDailyDigestMessageInput): TaskDeliveryMessage {
  const fn = 'renderTaskDailyDigestMessage'
  requireInput(fn, input)
  const { items, totalCount, deliveryId } = input
  if (!Array.isArray(items) || items.length === 0) {
    throw new TypeError(`${fn}: items must be a non-empty array`)
  }
  if (!Number.isSafeInteger(totalCount) || totalCount < items.length) {
    throw new TypeError(`${fn}: totalCount must be an integer ≥ items.length`)
  }
  requireText(fn, 'deliveryId', deliveryId)
  const shown = items.slice(0, TASK_DIGEST_MAX_ITEMS).map((item) => {
    requireInput(fn, item)
    requireText(fn, 'item.title', item.title)
    const due = formatDue(fn, item.dueDate, item.dueTime, item.timeZone)
    return `- 「${sanitizeTaskTextForMarkdown(item.title)}」（${due.when}，${due.zone}）`
  })
  const paragraphs = [shown.join('\n')]
  const rest = totalCount - shown.length
  if (rest > 0) paragraphs.push(`另有 ${rest} 项`)
  return { title: TASK_DELIVERY_TITLES.task_daily, content: body(paragraphs, deliveryId) }
}

export interface RenderTaskListEventMessageInput {
  event: TaskNotifiableListEvent
  /** The list's current name (user text; escaped here). */
  listName: string
  deliveryId: string
}

const LIST_EVENT_SENTENCES: Readonly<Record<TaskNotifiableListEvent, (name: string) => string>> = Object.freeze({
  archived: (n) => `清单「${n}」已归档`,
})

/** Family 4: 「清单动态」 + `清单「L」已归档` + the tag. */
export function renderTaskListEventMessage(input: RenderTaskListEventMessageInput): TaskDeliveryMessage {
  const fn = 'renderTaskListEventMessage'
  requireInput(fn, input)
  const { event, listName, deliveryId } = input
  if (!(TASK_NOTIFIABLE_LIST_EVENTS as readonly string[]).includes(event as string)) {
    throw new TypeError(`${fn}: unknown list event "${String(event)}"`)
  }
  requireText(fn, 'listName', listName)
  requireText(fn, 'deliveryId', deliveryId)
  const sentence = LIST_EVENT_SENTENCES[event as TaskNotifiableListEvent](sanitizeTaskTextForMarkdown(listName))
  return { title: TASK_DELIVERY_TITLES.task_list_event, content: body([sentence], deliveryId) }
}
