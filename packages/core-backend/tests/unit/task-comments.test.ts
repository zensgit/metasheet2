import { describe, expect, it } from 'vitest'
import { TASK_ROLES, type TaskRole } from '../../src/tasks/task-access'
import {
  TASK_COMMENT_BODY_MAX_CHARS,
  canComment,
  canDeleteComment,
  canEditComment,
  normalizeCommentBody,
  toCommentView,
  type TaskCommentRow,
} from '../../src/tasks/task-comments'

const CREATED_AT = new Date('2026-09-28T09:00:00.000Z')

function commentRow(overrides: Partial<TaskCommentRow> = {}): TaskCommentRow {
  return {
    id: 'tcmt_1',
    taskId: 'tsk_1',
    authorId: 'author',
    body: 'hello',
    deleted: false,
    createdAt: CREATED_AT,
    ...overrides,
  }
}

describe('task-comments', () => {
  describe('TASK_COMMENT_BODY_MAX_CHARS', () => {
    it('is 5000, matching APPROVAL_COMMENT_BODY_MAX_CHARS', () => {
      expect(TASK_COMMENT_BODY_MAX_CHARS).toBe(5000)
    })
  })

  describe('normalizeCommentBody', () => {
    it('rejects blank / whitespace-only as "blank"', () => {
      expect(normalizeCommentBody('')).toEqual({ ok: false, reason: 'blank' })
      expect(normalizeCommentBody('   ​  ')).toEqual({ ok: false, reason: 'blank' })
      expect(normalizeCommentBody(undefined)).toEqual({ ok: false, reason: 'blank' })
      expect(normalizeCommentBody(42)).toEqual({ ok: false, reason: 'blank' })
    })
    it('trims edges and NFC-normalizes, same as normalizeUserText', () => {
      expect(normalizeCommentBody('  hello  ')).toEqual({ ok: true, body: 'hello' })
    })
    it('exactly at the boundary (5000 code points) is ok', () => {
      const body = 'a'.repeat(TASK_COMMENT_BODY_MAX_CHARS)
      const result = normalizeCommentBody(body)
      expect(result).toEqual({ ok: true, body })
    })
    it('one past the boundary (5001 code points) is too_long', () => {
      const body = 'a'.repeat(TASK_COMMENT_BODY_MAX_CHARS + 1)
      expect(normalizeCommentBody(body)).toEqual({ ok: false, reason: 'too_long' })
    })
    // Mutant guard: counts by Unicode CODE POINT, not UTF-16 code unit. An astral-plane emoji is
    // ONE code point but TWO UTF-16 units — a `.length`-based check would wrongly reject this.
    it('counts an astral-plane character as ONE code point, not two UTF-16 units', () => {
      const body = 'a'.repeat(TASK_COMMENT_BODY_MAX_CHARS - 1) + '\u{1F600}' // 4999 'a' + 1 emoji
      expect(body.length).toBe(TASK_COMMENT_BODY_MAX_CHARS + 1) // UTF-16 units: 4999 + 2 = 5001
      expect([...body].length).toBe(TASK_COMMENT_BODY_MAX_CHARS) // code points: 4999 + 1 = 5000
      expect(normalizeCommentBody(body)).toEqual({ ok: true, body })
    })
    it('an astral-plane character pushing code points past the boundary is too_long', () => {
      const body = 'a'.repeat(TASK_COMMENT_BODY_MAX_CHARS) + '\u{1F600}' // 5000 'a' + 1 emoji = 5001 code points
      expect(normalizeCommentBody(body)).toEqual({ ok: false, reason: 'too_long' })
    })
  })

  describe('canComment', () => {
    it('every role EXCEPT none can comment (creator/assignee/follower/list-editor/list-reader)', () => {
      for (const role of TASK_ROLES) {
        const expected = role !== 'none'
        expect(canComment([role])).toBe(expected)
      }
    })
    it('a role UNION grants comment if any member role does', () => {
      expect(canComment(['none', 'follower'] as TaskRole[])).toBe(true)
      expect(canComment(['none'])).toBe(false)
    })
  })

  describe('canEditComment / canDeleteComment', () => {
    it('A3: only the author, and only when not deleted, may edit', () => {
      expect(canEditComment({ authorId: 'a', actorId: 'a', deleted: false })).toBe(true)
      expect(canEditComment({ authorId: 'a', actorId: 'b', deleted: false })).toBe(false)
      expect(canEditComment({ authorId: 'a', actorId: 'a', deleted: true })).toBe(false)
    })
    it('A3: only the author, and only when not deleted, may delete', () => {
      expect(canDeleteComment({ authorId: 'a', actorId: 'a', deleted: false })).toBe(true)
      expect(canDeleteComment({ authorId: 'a', actorId: 'b', deleted: false })).toBe(false)
      expect(canDeleteComment({ authorId: 'a', actorId: 'a', deleted: true })).toBe(false)
    })
  })

  describe('toCommentView', () => {
    it('a live comment passes its body through', () => {
      const row = commentRow({ body: 'hello world' })
      expect(toCommentView(row)).toEqual({
        id: 'tcmt_1',
        taskId: 'tsk_1',
        authorId: 'author',
        body: 'hello world',
        deleted: false,
        createdAt: CREATED_AT,
      })
    })
    it('tombstone shape: a deleted comment reads body as null, same as approval comments', () => {
      const row = commentRow({ body: 'secret', deleted: true })
      expect(toCommentView(row)).toEqual({
        id: 'tcmt_1',
        taskId: 'tsk_1',
        authorId: 'author',
        body: null,
        deleted: true,
        createdAt: CREATED_AT,
      })
    })
  })
})

describe('task-c review round 1: NFC', () => {
  it('stores decomposed input in composed (NFC) form', () => {
    const result = normalizeCommentBody('Café')
    expect(result).toEqual({ ok: true, body: 'Café' })
  })
  it('counts code points AFTER NFC: 5000 decomposed pairs compose to 5000 code points and pass', () => {
    const raw = 'é'.repeat(TASK_COMMENT_BODY_MAX_CHARS)
    expect([...raw].length).toBe(TASK_COMMENT_BODY_MAX_CHARS * 2)
    const result = normalizeCommentBody(raw)
    expect(result.ok).toBe(true)
  })
  it('5001 decomposed pairs compose to 5001 code points and are too_long', () => {
    const result = normalizeCommentBody('é'.repeat(TASK_COMMENT_BODY_MAX_CHARS + 1))
    expect(result).toEqual({ ok: false, reason: 'too_long' })
  })
})
