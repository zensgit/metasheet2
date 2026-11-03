import { describe, expect, it } from 'vitest'
import {
  TASK_DELIVERY_TAG_PREFIX,
  TASK_DELIVERY_TITLES,
  TASK_DIGEST_MAX_ITEMS,
  renderTaskDailyDigestMessage,
  renderTaskDeliveryTag,
  renderTaskEventMessage,
  renderTaskListEventMessage,
  renderTaskReminderMessage,
  sanitizeTaskTextForMarkdown,
  type TaskDigestItem,
} from '../../src/tasks/task-notification-text'
import { TASK_NOTIFIABLE_EVENTS } from '../../src/tasks/task-notifications'

const ID = 'deadbeef-1234-4abc-8def-0123456789ab'
const ID2 = 'cafe0001-1234-4abc-8def-0123456789ab'
const TAG = '编号 deadbeef'

function lastLine(content: string): string {
  const lines = content.split('\n')
  return lines[lines.length - 1]
}

describe('task-notification-text', () => {
  describe('sanitizeTaskTextForMarkdown (design §8.3 / §10.4)', () => {
    it('maps each of the twelve markdown characters to its full-width form, in place', () => {
      expect(sanitizeTaskTextForMarkdown('[]()<>!#*_~`')).toBe('［］（）＜＞！＃＊＿～｀')
    })

    it('a markdown link no longer contains "](" and has no newline', () => {
      const out = sanitizeTaskTextForMarkdown('[点我](https://x)')
      expect(out).toBe('［点我］（https：//x）')
      expect(out).not.toContain('](')
      expect(out).not.toMatch(/[\r\n]/)
    })

    it('renders ":" as "：" before the escapes (RULED(2026-10-09)): no ASCII colon is left, and the escapes still apply', () => {
      const out = sanitizeTaskTextForMarkdown('复核 a:b c:[x] 09:30 d::e')
      expect(out).toBe('复核 a：b c：［x］ 09：30 d：：e')
      expect(out).not.toContain(':')
      expect(sanitizeTaskTextForMarkdown('：')).toBe('：')
      expect(sanitizeTaskTextForMarkdown(':[')).toBe('：［')
    })

    it('CR, LF, TAB and other ASCII control characters each become one space', () => {
      expect(sanitizeTaskTextForMarkdown('a\r\nb\tc\u0000d\u007fe')).toBe('a  b c d e')
    })

    it('a title starting with # cannot become a heading; a fenced block cannot open', () => {
      expect(sanitizeTaskTextForMarkdown('# 标题')).toBe('＃ 标题')
      expect(sanitizeTaskTextForMarkdown('```js')).toBe('｀｀｀js')
    })

    it('plain text is unchanged; the function is idempotent', () => {
      const plain = '备料复核 2026-10-07 / Q4, 100%'
      expect(sanitizeTaskTextForMarkdown(plain)).toBe(plain)
      const once = sanitizeTaskTextForMarkdown('*a* [b]')
      expect(sanitizeTaskTextForMarkdown(once)).toBe(once)
    })

    it('rejects a non-string', () => {
      expect(() => sanitizeTaskTextForMarkdown(42 as never)).toThrow(TypeError)
      expect(() => sanitizeTaskTextForMarkdown(null as never)).toThrow(TypeError)
    })
  })

  describe('renderTaskDeliveryTag ([own-3b-20])', () => {
    it('is the fixed prefix plus the first 8 hex digits of the outbox row id, lower-cased', () => {
      expect(TASK_DELIVERY_TAG_PREFIX).toBe('编号 ')
      expect(renderTaskDeliveryTag(ID)).toBe(TAG)
      expect(renderTaskDeliveryTag('DEADBEEF-1234-4abc-8def-0123456789ab')).toBe(TAG)
      expect(renderTaskDeliveryTag(ID)).toMatch(/^编号 [0-9a-f]{8}$/)
    })

    it('rejects a non-string and an id that does not start with 8 hex digits', () => {
      expect(() => renderTaskDeliveryTag('x')).toThrow(TypeError)
      expect(() => renderTaskDeliveryTag('')).toThrow(TypeError)
      expect(() => renderTaskDeliveryTag('zzzzzzzz-1234')).toThrow(TypeError)
      expect(() => renderTaskDeliveryTag('deadbee')).toThrow(TypeError)
      expect(() => renderTaskDeliveryTag(7 as never)).toThrow(TypeError)
    })
  })

  describe('titles', () => {
    it('are fixed per family', () => {
      expect(TASK_DELIVERY_TITLES).toEqual({
        task_event: '任务动态',
        task_reminder: '任务提醒',
        task_daily: '今日任务',
        task_list_event: '清单动态',
      })
    })
  })

  describe('renderTaskEventMessage', () => {
    it('one sentence per event type, then the tag as the last line', () => {
      const expected: Record<string, string> = {
        completed: '任务「T」已完成',
        completed_by_any: '任务「T」已完成',
        reopened: '任务「T」已重启',
        deleted: '任务「T」已被删除',
        commented: '任务「T」有新评论',
      }
      for (const event of TASK_NOTIFIABLE_EVENTS) {
        const msg = renderTaskEventMessage({ event, taskTitle: 'T', deliveryId: ID })
        expect(msg).toEqual({ title: '任务动态', content: `${expected[event]}\n\n${TAG}` })
        expect(lastLine(msg.content)).toBe(TAG)
      }
    })

    it('two rows for the same commented event render different bodies (differ only in the tag)', () => {
      const a = renderTaskEventMessage({ event: 'commented', taskTitle: 'T', deliveryId: ID }).content
      const b = renderTaskEventMessage({ event: 'commented', taskTitle: 'T', deliveryId: ID2 }).content
      expect(a).not.toBe(b)
      expect(a.replace(TAG, '')).toBe(b.replace('编号 cafe0001', ''))
    })

    it('completed → reopened → completed as three rows render three distinct bodies', () => {
      const bodies = [
        renderTaskEventMessage({ event: 'completed', taskTitle: 'T', deliveryId: 'aaaaaaaa-0' }).content,
        renderTaskEventMessage({ event: 'reopened', taskTitle: 'T', deliveryId: 'bbbbbbbb-0' }).content,
        renderTaskEventMessage({ event: 'completed', taskTitle: 'T', deliveryId: 'cccccccc-0' }).content,
      ]
      expect(new Set(bodies).size).toBe(3)
    })

    it('the title is escaped: a # cannot start a heading, a link cannot survive', () => {
      const msg = renderTaskEventMessage({ event: 'completed', taskTitle: '# [x](https://e)', deliveryId: ID })
      expect(msg.content).toBe(`任务「＃ ［x］（https：//e）」已完成\n\n${TAG}`)
      expect(msg.content.split('\n').some((l) => l.startsWith('#'))).toBe(false)
    })

    it('rejects an event outside the closed set, a non-string title / id, and a non-object input', () => {
      expect(() => renderTaskEventMessage({ event: 'self_completed' as never, taskTitle: 'T', deliveryId: ID })).toThrow(TypeError)
      expect(() => renderTaskEventMessage({ event: 'completed', taskTitle: 1 as never, deliveryId: ID })).toThrow(TypeError)
      expect(() => renderTaskEventMessage({ event: 'completed', taskTitle: 'T', deliveryId: 'x' })).toThrow(TypeError)
      expect(() => renderTaskEventMessage('x' as never)).toThrow(TypeError)
    })
  })

  describe('renderTaskReminderMessage', () => {
    it('scheduled task: sentence, due line with date + time + zone, tag', () => {
      const msg = renderTaskReminderMessage({ taskTitle: 'T', dueDate: '2026-10-07', dueTime: '09:30', timeZone: 'Asia/Shanghai', deliveryId: ID })
      expect(msg).toEqual({ title: '任务提醒', content: `任务「T」的提醒时间已到\n\n截止：2026-10-07 09:30（Asia/Shanghai）\n\n${TAG}` })
    })

    it('all-day task: due line without a time', () => {
      const msg = renderTaskReminderMessage({ taskTitle: 'T', dueDate: '2026-10-07', dueTime: null, timeZone: 'UTC', deliveryId: ID })
      expect(msg.content).toBe(`任务「T」的提醒时间已到\n\n截止：2026-10-07（UTC）\n\n${TAG}`)
    })

    it('the stored time form HH:MM:SS (due_time::text): zero seconds show as HH:MM, other seconds as stored', () => {
      const at = (dueTime: string) =>
        renderTaskReminderMessage({ taskTitle: 'T', dueDate: '2026-10-07', dueTime, timeZone: 'Asia/Shanghai', deliveryId: ID }).content
      expect(at('09:30:00')).toBe(`任务「T」的提醒时间已到\n\n截止：2026-10-07 09:30（Asia/Shanghai）\n\n${TAG}`)
      expect(at('09:30:00')).toBe(at('09:30'))
      expect(at('09:30:15')).toContain('截止：2026-10-07 09:30:15（Asia/Shanghai）')
    })

    it('no due date: no due line', () => {
      const msg = renderTaskReminderMessage({ taskTitle: 'T', dueDate: null, dueTime: null, timeZone: 'UTC', deliveryId: ID })
      expect(msg.content).toBe(`任务「T」的提醒时间已到\n\n${TAG}`)
    })

    it('an undated task has no zone (time_zone is null): no due line, no error', () => {
      const msg = renderTaskReminderMessage({ taskTitle: 'T', dueDate: null, dueTime: null, timeZone: null, deliveryId: ID })
      expect(msg.content).toBe(`任务「T」的提醒时间已到\n\n${TAG}`)
    })

    it('the zone name is escaped like any user text', () => {
      const msg = renderTaskReminderMessage({ taskTitle: 'T', dueDate: '2026-10-07', dueTime: null, timeZone: 'America/New_York', deliveryId: ID })
      expect(msg.content).toContain('截止：2026-10-07（America/New＿York）')
    })

    it('rejects a malformed date or time, a dated task without a zone, and a non-object input', () => {
      const ok = { taskTitle: 'T', dueDate: '2026-10-07', dueTime: '09:30', timeZone: 'UTC', deliveryId: ID }
      expect(() => renderTaskReminderMessage({ ...ok, dueDate: '2026/10/07' })).toThrow(TypeError)
      for (const dueTime of ['9:30', '930', '09:30:0', '09:30:00.5', '09:30:00:00', 930]) {
        expect(() => renderTaskReminderMessage({ ...ok, dueTime: dueTime as never }), String(dueTime)).toThrow(TypeError)
      }
      expect(() => renderTaskReminderMessage({ ...ok, timeZone: null })).toThrow(TypeError)
      expect(() => renderTaskReminderMessage({ ...ok, taskTitle: undefined as never })).toThrow(TypeError)
      expect(() => renderTaskReminderMessage('x' as never)).toThrow(TypeError)
    })
  })

  describe('renderTaskDailyDigestMessage', () => {
    const item = (title: string, dueDate = '2026-10-07', dueTime: string | null = null, timeZone = 'UTC'): TaskDigestItem => ({ title, dueDate, dueTime, timeZone })

    it('TASK_DIGEST_MAX_ITEMS is 20', () => {
      expect(TASK_DIGEST_MAX_ITEMS).toBe(20)
    })

    const items = (n: number) => Array.from({ length: n }, (_, i) => item(`T${i + 1}`))

    it('one item per line, scheduled items show the time (stored HH:MM:SS shows as HH:MM), then the tag', () => {
      const msg = renderTaskDailyDigestMessage({
        items: [item('A', '2026-10-07', '09:30:00', 'Asia/Shanghai'), item('B', '2026-10-08')],
        totalCount: 2,
        deliveryId: ID,
      })
      expect(msg).toEqual({ title: '今日任务', content: `- 「A」（2026-10-07 09:30，Asia/Shanghai）\n- 「B」（2026-10-08，UTC）\n\n${TAG}` })
    })

    it('MAX + 3 in total, fetched as MAX + 1 rows (design §7.4): the first MAX lines and 另有 3 项', () => {
      const msg = renderTaskDailyDigestMessage({ items: items(TASK_DIGEST_MAX_ITEMS + 1), totalCount: TASK_DIGEST_MAX_ITEMS + 3, deliveryId: ID })
      const lines = msg.content.split('\n')
      expect(lines.filter((l) => l.startsWith('- 「'))).toHaveLength(TASK_DIGEST_MAX_ITEMS)
      expect(lines[0]).toBe('- 「T1」（2026-10-07，UTC）')
      expect(lines[TASK_DIGEST_MAX_ITEMS - 1]).toBe('- 「T20」（2026-10-07，UTC）')
      expect(msg.content).toContain('\n\n另有 3 项\n\n')
      expect(msg.content).not.toContain('T21')
      expect(lastLine(msg.content)).toBe(TAG)
    })

    it('the overflow line counts totalCount, not the rows passed in', () => {
      expect(renderTaskDailyDigestMessage({ items: items(1), totalCount: 5, deliveryId: ID }).content).toBe(
        `- 「T1」（2026-10-07，UTC）\n\n另有 4 项\n\n${TAG}`,
      )
      expect(renderTaskDailyDigestMessage({ items: items(TASK_DIGEST_MAX_ITEMS + 3), totalCount: TASK_DIGEST_MAX_ITEMS + 3, deliveryId: ID }).content).toContain('另有 3 项')
    })

    it('exactly MAX in total: no 另有 line; MAX + 1 in total: 另有 1 项', () => {
      const exact = renderTaskDailyDigestMessage({ items: items(TASK_DIGEST_MAX_ITEMS), totalCount: TASK_DIGEST_MAX_ITEMS, deliveryId: ID })
      expect(exact.content).not.toContain('另有')
      const plusOne = renderTaskDailyDigestMessage({ items: items(TASK_DIGEST_MAX_ITEMS + 1), totalCount: TASK_DIGEST_MAX_ITEMS + 1, deliveryId: ID })
      expect(plusOne.content).toContain('另有 1 项')
    })

    it('item titles are escaped', () => {
      const msg = renderTaskDailyDigestMessage({ items: [item('[x](https://e)')], totalCount: 1, deliveryId: ID })
      expect(msg.content).toBe(`- 「［x］（https：//e）」（2026-10-07，UTC）\n\n${TAG}`)
    })

    it('an empty digest is never rendered (TypeError); malformed items, totalCount and non-object input are rejected', () => {
      expect(() => renderTaskDailyDigestMessage({ items: [], totalCount: 0, deliveryId: ID })).toThrow(TypeError)
      expect(() => renderTaskDailyDigestMessage({ items: 'x' as never, totalCount: 1, deliveryId: ID })).toThrow(TypeError)
      expect(() => renderTaskDailyDigestMessage({ items: [item('A', 'x')], totalCount: 1, deliveryId: ID })).toThrow(TypeError)
      expect(() => renderTaskDailyDigestMessage({ items: [item('A', '2026-10-07', '930')], totalCount: 1, deliveryId: ID })).toThrow(TypeError)
      expect(() => renderTaskDailyDigestMessage({ items: ['A' as never], totalCount: 1, deliveryId: ID })).toThrow(TypeError)
      for (const totalCount of [undefined, 1, 1.5, Number.NaN, '3', -1]) {
        expect(() => renderTaskDailyDigestMessage({ items: items(2), totalCount: totalCount as never, deliveryId: ID }), String(totalCount)).toThrow(TypeError)
      }
      expect(() => renderTaskDailyDigestMessage('x' as never)).toThrow(TypeError)
    })
  })

  describe('renderTaskListEventMessage', () => {
    it('archived: sentence then the tag', () => {
      const msg = renderTaskListEventMessage({ event: 'archived', listName: 'L', deliveryId: ID })
      expect(msg).toEqual({ title: '清单动态', content: `清单「L」已归档\n\n${TAG}` })
    })

    it('the list name is escaped', () => {
      const msg = renderTaskListEventMessage({ event: 'archived', listName: '*L*', deliveryId: ID })
      expect(msg.content).toBe(`清单「＊L＊」已归档\n\n${TAG}`)
    })

    it('rejects any other list event, a non-string name, and a non-object input', () => {
      expect(() => renderTaskListEventMessage({ event: 'renamed' as never, listName: 'L', deliveryId: ID })).toThrow(TypeError)
      expect(() => renderTaskListEventMessage({ event: 'archived', listName: 1 as never, deliveryId: ID })).toThrow(TypeError)
      expect(() => renderTaskListEventMessage('x' as never)).toThrow(TypeError)
    })
  })

  describe('every family', () => {
    it('user text renders ":" as "：" in every body; the fixed parts (the due time) keep theirs (RULED(2026-10-09))', () => {
      const event = renderTaskEventMessage({ event: 'commented', taskTitle: 'a:b', deliveryId: ID })
      expect(event.content).toBe(`任务「a：b」有新评论\n\n${TAG}`)
      const reminder = renderTaskReminderMessage({ taskTitle: 'x:y', dueDate: '2030-01-15', dueTime: '09:30', timeZone: 'Asia/Shanghai', deliveryId: ID })
      expect(reminder.content).toBe(`任务「x：y」的提醒时间已到\n\n截止：2030-01-15 09:30（Asia/Shanghai）\n\n${TAG}`)
      const digest = renderTaskDailyDigestMessage({
        items: [{ title: 'p:q', dueDate: '2030-01-15', dueTime: '18:00', timeZone: 'Asia/Shanghai' }],
        totalCount: 1,
        deliveryId: ID,
      })
      expect(digest.content).toBe(`- 「p：q」（2030-01-15 18:00，Asia/Shanghai）\n\n${TAG}`)
      const list = renderTaskListEventMessage({ event: 'archived', listName: 'l:m', deliveryId: ID })
      expect(list.content).toBe(`清单「l：m」已归档\n\n${TAG}`)
    })

    it('ends its body with the tag of its own delivery id and never contains a newline inside user text', () => {
      const bodies = [
        renderTaskEventMessage({ event: 'deleted', taskTitle: 'a\nb', deliveryId: ID }).content,
        renderTaskReminderMessage({ taskTitle: 'a\nb', dueDate: null, dueTime: null, timeZone: 'UTC', deliveryId: ID }).content,
        renderTaskDailyDigestMessage({ items: [{ title: 'a\nb', dueDate: '2026-10-07', dueTime: null, timeZone: 'UTC' }], totalCount: 1, deliveryId: ID }).content,
        renderTaskListEventMessage({ event: 'archived', listName: 'a\nb', deliveryId: ID }).content,
      ]
      for (const body of bodies) {
        expect(lastLine(body)).toBe(renderTaskDeliveryTag(ID))
        expect(body).toContain('a b')
        expect(body).not.toContain('a\nb')
      }
    })
  })
})
