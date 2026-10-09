import { describe, expect, it } from 'vitest'
import type { TaskRole } from '../../src/tasks/task-access'
import {
  TASK_ATTACHMENT_ALLOWED_MIME_TYPES,
  TASK_ATTACHMENT_BIND_KINDS,
  TASK_ATTACHMENT_INITIAL_SCAN_STATE,
  TASK_ATTACHMENT_LIMITS,
  TASK_ATTACHMENT_MIME_EXTENSIONS,
  TASK_ATTACHMENT_SCAN_STATES,
  TASK_ATTACHMENT_SIGNATURE_MIME_TYPES,
  TASK_ATTACHMENT_STATUSES,
  TASK_ATTACHMENT_STORAGE_PREFIX,
  TASK_ATTACHMENT_UNBOUND_TTL_MS,
  authorizeTaskAttachmentDownload,
  buildTaskAttachmentDownloadHeaders,
  canAddAttachment,
  canRemoveAttachment,
  checkCommentAttachmentTotals,
  checkTaskAttachmentQuota,
  deriveTaskAttachmentStorageKey,
  isUnboundAttachmentExpired,
  normalizeAttachmentDisplayName,
  parseAttachmentRefIds,
  planAttachmentAddedEvents,
  planCommentAttachmentBind,
  planRemoveAttachment,
  validateAttachmentCandidate,
  type TaskAttachmentRowForDownload,
  type TaskAttachmentRowForRemoval,
} from '../../src/tasks/task-attachments'

const NOW = new Date('2026-10-07T08:00:00.000Z')

const bytes = (...parts: Array<number[] | string>): Uint8Array =>
  Uint8Array.from(parts.flatMap((p) => (typeof p === 'string' ? [...Buffer.from(p, 'latin1')] : p)))

const PNG = bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const JPEG = bytes([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10])
const GIF = bytes('GIF89a')
const WEBP = bytes('RIFF', [0x24, 0, 0, 0], 'WEBPVP8 ')
const PDF = bytes('%PDF-1.7\n')
const BMP = bytes('BM', [0, 0, 0, 0])
const TEXT = bytes('hello, world\n')

const candidate = (mimeType: unknown, fileName: unknown, head: Uint8Array, sizeBytes: unknown = 1024) =>
  validateAttachmentCandidate({ mimeType, fileName, sizeBytes, head })

const ALL_ROLES: TaskRole[] = ['creator', 'assignee', 'follower', 'list-editor', 'list-reader', 'none']

describe('task-attachments', () => {
  describe('constants', () => {
    it('one MIME → extension table drives the allowlist (RULED(2026-10-09): [S18])', () => {
      expect(TASK_ATTACHMENT_MIME_EXTENSIONS).toEqual({
        'application/pdf': ['pdf'],
        'image/png': ['png'],
        'image/jpeg': ['jpg', 'jpeg'],
        'image/gif': ['gif'],
        'image/webp': ['webp'],
        'text/plain': ['txt'],
        'text/csv': ['csv'],
      })
      expect(TASK_ATTACHMENT_ALLOWED_MIME_TYPES).toEqual(Object.keys(TASK_ATTACHMENT_MIME_EXTENSIONS))
      expect(TASK_ATTACHMENT_SIGNATURE_MIME_TYPES).toEqual(['application/pdf', 'image/png', 'image/jpeg', 'image/gif', 'image/webp'])
    })
    it('limits, TTL, prefix and closed sets', () => {
      expect(TASK_ATTACHMENT_LIMITS).toEqual({
        maxFileBytes: 10485760,
        maxPerTask: 20,
        maxPerComment: 5,
        maxCommentBytes: 26214400,
        maxRefIds: 200,
        maxRefBodyBytes: 65536,
        maxDisplayNameCodePoints: 255,
      })
      expect(TASK_ATTACHMENT_UNBOUND_TTL_MS).toBe(168 * 3600 * 1000)
      expect(TASK_ATTACHMENT_STORAGE_PREFIX).toBe('task-attachments/')
      expect(TASK_ATTACHMENT_STATUSES).toEqual(['unbound', 'bound', 'deleted'])
      expect(TASK_ATTACHMENT_BIND_KINDS).toEqual(['task', 'comment'])
      expect(TASK_ATTACHMENT_SCAN_STATES).toEqual(['unscanned', 'clean', 'infected'])
      expect(TASK_ATTACHMENT_INITIAL_SCAN_STATE).toBe('unscanned')
    })
  })

  describe('validateAttachmentCandidate', () => {
    it.each([
      ['application/pdf', 'a.pdf', PDF, 'pdf'],
      ['image/png', 'a.png', PNG, 'png'],
      ['image/jpeg', 'a.jpg', JPEG, 'jpg'],
      ['image/jpeg', 'a.jpeg', JPEG, 'jpg'],
      ['image/gif', 'a.gif', GIF, 'gif'],
      ['image/webp', 'a.webp', WEBP, 'webp'],
      ['text/plain', 'a.txt', TEXT, 'txt'],
      ['text/csv', 'a.csv', TEXT, 'csv'],
    ])('accepts %s named %s with a matching body', (mime, name, head, ext) => {
      expect(candidate(mime, name, head)).toEqual({ ok: true, mimeType: mime, storageExtension: ext })
    })
    it('normalizes the declared type and the extension case', () => {
      expect(candidate('  IMAGE/PNG ', 'Photo.PNG', PNG)).toEqual({ ok: true, mimeType: 'image/png', storageExtension: 'png' })
    })
    describe('size', () => {
      it('must be a positive safe integer', () => {
        for (const size of [0, -1, 1.5, '10', Number.NaN, null]) {
          expect(candidate('image/png', 'a.png', PNG, size), String(size)).toEqual({ ok: false, reason: 'invalid_size' })
        }
      })
      it('10 MiB is the ceiling', () => {
        expect(candidate('image/png', 'a.png', PNG, 10485760).ok).toBe(true)
        expect(candidate('image/png', 'a.png', PNG, 10485761)).toEqual({ ok: false, reason: 'file_too_large' })
      })
    })
    it('types outside the allowlist', () => {
      for (const mime of ['image/svg+xml', 'text/html', 'application/zip', 'image/bmp', 'application/octet-stream', '', 7]) {
        expect(candidate(mime, 'a.png', PNG), String(mime)).toEqual({ ok: false, reason: 'mime_not_allowed' })
      }
    })
    it('object-prototype names are just unknown types (own-key lookup)', () => {
      for (const mime of ['__proto__', 'constructor', 'toString', 'hasOwnProperty']) {
        expect(candidate(mime, 'a.png', PNG), mime).toEqual({ ok: false, reason: 'mime_not_allowed' })
      }
    })
    it('a type with parameters is not on the allowlist (own choice)', () => {
      expect(candidate('text/plain; charset=utf-8', 'a.txt', TEXT)).toEqual({ ok: false, reason: 'mime_not_allowed' })
    })
    it('the extension must be allowlisted and agree with the type', () => {
      expect(candidate('application/pdf', 'a.exe', PDF)).toEqual({ ok: false, reason: 'extension_not_allowed' })
      expect(candidate('application/pdf', 'README', PDF)).toEqual({ ok: false, reason: 'extension_not_allowed' })
      expect(candidate('image/png', 'a.svg', PNG)).toEqual({ ok: false, reason: 'extension_not_allowed' })
      expect(candidate('image/png', null, PNG)).toEqual({ ok: false, reason: 'extension_not_allowed' })
      expect(candidate('image/jpeg', 'a.png', JPEG)).toEqual({ ok: false, reason: 'extension_mime_mismatch' })
      expect(candidate('text/plain', 'a.csv', TEXT)).toEqual({ ok: false, reason: 'extension_mime_mismatch' })
    })
    describe('content signature', () => {
      it('a signature-bearing type needs a matching signature', () => {
        expect(candidate('application/pdf', 'a.pdf', PNG)).toEqual({ ok: false, reason: 'content_mime_mismatch' })
        expect(candidate('image/png', 'a.png', JPEG)).toEqual({ ok: false, reason: 'content_mime_mismatch' })
        expect(candidate('image/png', 'a.png', TEXT)).toEqual({ ok: false, reason: 'content_mime_mismatch' })
        expect(candidate('image/gif', 'a.gif', new Uint8Array())).toEqual({ ok: false, reason: 'content_mime_mismatch' })
      })
      it('a BMP body declared as png is refused', () => {
        expect(candidate('image/png', 'a.png', BMP)).toEqual({ ok: false, reason: 'content_mime_mismatch' })
      })
      it('a declared PDF needs all four bytes of its magic (near-miss headers are refused)', () => {
        expect(candidate('application/pdf', 'a.pdf', bytes([0x25, 0x50, 0x44, 0x00]))).toEqual({ ok: false, reason: 'content_mime_mismatch' })
        expect(candidate('application/pdf', 'a.pdf', bytes('%PD'))).toEqual({ ok: false, reason: 'content_mime_mismatch' })
        expect(candidate('application/pdf', 'a.pdf', bytes('%PDx-1.7\n'))).toEqual({ ok: false, reason: 'content_mime_mismatch' })
        expect(candidate('application/pdf', 'a.pdf', bytes('x%PDF-1.7\n'))).toEqual({ ok: false, reason: 'content_mime_mismatch' })
      })
      // ASSUMPTION(task-e, own choice): [S18] a txt/csv upload is refused only when its bytes are an
      // image or a PDF: the PDF magic, or an image signature with a non-text byte in the first 16 bytes.
      describe('txt/csv: refused only when the bytes are an image or a PDF', () => {
        const GIF_REAL = bytes('GIF89a', [0x01, 0x00, 0x01, 0x00, 0x80, 0x00, 0x00]) // a 1x1 GIF header
        it.each([
          ['a PNG header', PNG],
          ['a JPEG header', JPEG],
          ['a GIF header with its screen descriptor', GIF_REAL],
          ['a WEBP header', WEBP],
          ['a BMP header', BMP],
          ['a PDF header', PDF],
        ])('%s declared as text is refused', (_label, head) => {
          expect(candidate('text/plain', 'a.txt', head)).toEqual({ ok: false, reason: 'content_mime_mismatch' })
          expect(candidate('text/csv', 'a.csv', head)).toEqual({ ok: false, reason: 'content_mime_mismatch' })
        })
        it.each([
          ['a CSV that starts with BMI', 'text/csv', 'health.csv', 'BMI,Height,Weight\n22,170,64\n'],
          ['a note that starts with BMW', 'text/plain', 'notes.txt', 'BMW sales Q3 report'],
          ['a note that starts with GIF89a', 'text/plain', 'notes.txt', 'GIF89a is a format\n'],
          ['a CSV that starts with GIF8', 'text/csv', 'frames.csv', 'GIF8 frames,count\n1,2\n'],
          ['a note that starts with RIFF and WEBP', 'text/plain', 'notes.txt', 'RIFF1234WEBP notes'],
          ['TAB, CR and LF right after BM', 'text/plain', 'scores.txt', 'BM\tscore\r\n1\t2\r\n'],
        ])('%s is accepted', (_label, mime, name, text) => {
          expect(candidate(mime, name, bytes(text))).toEqual({ ok: true, mimeType: mime, storageExtension: name.slice(-3) })
        })
        it('a non-text byte after the first 16 bytes does not count', () => {
          expect(candidate('text/csv', 'a.csv', bytes('BMI,', 'a'.repeat(12), [0x00]))).toEqual({ ok: true, mimeType: 'text/csv', storageExtension: 'csv' })
          expect(candidate('text/csv', 'a.csv', bytes('BMI,', 'a'.repeat(11), [0x00])).ok).toBe(false)
        })
        it('bytes with no recognised signature are never refused as text (NULs alone do not count)', () => {
          expect(candidate('text/plain', 'a.txt', bytes([0xff, 0xfe, 0x61, 0x00, 0x62, 0x00])).ok).toBe(true) // UTF-16LE with a BOM
          expect(candidate('text/plain', 'a.txt', bytes([0x00, 0x01, 0x02, 0x03])).ok).toBe(true)
        })
        it('text that starts with the PDF magic is refused (own choice: the magic is the only evidence)', () => {
          expect(candidate('text/plain', 'a.txt', bytes('%PDF is not a note'))).toEqual({ ok: false, reason: 'content_mime_mismatch' })
        })
      })
      it('text with an empty body is fine', () => {
        expect(candidate('text/plain', 'a.txt', new Uint8Array()).ok).toBe(true)
      })
      it('the head is a view into a larger buffer: only its own bytes count', () => {
        const backing = new Uint8Array([0x00, 0x00, ...PNG])
        expect(candidate('image/png', 'a.png', backing.subarray(2)).ok).toBe(true)
      })
    })
    it('check order: size, then type, then extension, then content', () => {
      expect(candidate('image/svg+xml', 'a.exe', TEXT, 10485761)).toEqual({ ok: false, reason: 'file_too_large' })
      expect(candidate('image/svg+xml', 'a.exe', TEXT)).toEqual({ ok: false, reason: 'mime_not_allowed' })
      expect(candidate('image/png', 'a.exe', TEXT)).toEqual({ ok: false, reason: 'extension_not_allowed' })
      expect(candidate('image/png', 'a.gif', TEXT)).toEqual({ ok: false, reason: 'extension_mime_mismatch' })
    })
    it('the bytes are required', () => {
      expect(() => validateAttachmentCandidate({ mimeType: 'image/png', fileName: 'a.png', sizeBytes: 10 } as never)).toThrow(TypeError)
      expect(() => candidate('image/png', 'a.png', 'x' as never)).toThrow(TypeError)
    })
  })

  describe('normalizeAttachmentDisplayName (ASSUMPTION(task-e): [D5])', () => {
    it('normalizes and keeps an ordinary name', () => {
      expect(normalizeAttachmentDisplayName('  季度报告.pdf ')).toEqual({ ok: true, name: '季度报告.pdf' })
    })
    it('cuts at 255 code points', () => {
      expect(normalizeAttachmentDisplayName('a'.repeat(300))).toEqual({ ok: true, name: 'a'.repeat(255) })
    })
    it('never splits a surrogate pair when cutting', () => {
      const name = 'a'.repeat(254) + '\u{1F600}' + 'b'
      expect(normalizeAttachmentDisplayName(name)).toEqual({ ok: true, name: 'a'.repeat(254) + '\u{1F600}' })
    })
    it('counts code points, not UTF-16 units (own choice; D5 writes slice(0, 255))', () => {
      const astral = '\u{1F600}'.repeat(255)
      expect(normalizeAttachmentDisplayName(astral)).toEqual({ ok: true, name: astral })
      expect(normalizeAttachmentDisplayName(astral + 'x')).toEqual({ ok: true, name: astral })
    })
    describe('a cut keeps an allowlisted extension (own choice)', () => {
      it('the stem is shortened and the extension kept, in its own letter case', () => {
        expect(normalizeAttachmentDisplayName('A'.repeat(250) + '.html.png')).toEqual({ ok: true, name: 'A'.repeat(250) + '..png' })
        expect(normalizeAttachmentDisplayName('a'.repeat(300) + '.PDF')).toEqual({ ok: true, name: 'a'.repeat(251) + '.PDF' })
        expect(normalizeAttachmentDisplayName('\u{1F600}'.repeat(300) + '.jpeg')).toEqual({ ok: true, name: '\u{1F600}'.repeat(250) + '.jpeg' })
      })
      it('an extension that is not allowlisted is cut like the rest; a name within 255 is untouched', () => {
        expect(normalizeAttachmentDisplayName('a'.repeat(300) + '.exe')).toEqual({ ok: true, name: 'a'.repeat(255) })
        expect(normalizeAttachmentDisplayName('a.html.png')).toEqual({ ok: true, name: 'a.html.png' })
        expect(normalizeAttachmentDisplayName('a'.repeat(251) + '.png')).toEqual({ ok: true, name: 'a'.repeat(251) + '.png' })
      })
      it('end to end: the served name keeps the extension the upload was checked against', () => {
        const raw = 'A'.repeat(250) + '.html.png'
        expect(candidate('image/png', raw, PNG)).toEqual({ ok: true, mimeType: 'image/png', storageExtension: 'png' })
        const shown = normalizeAttachmentDisplayName(raw)
        expect(shown.ok && shown.name.endsWith('.png')).toBe(true)
        const disposition = buildTaskAttachmentDownloadHeaders({ mimeType: 'image/png', fileName: shown.ok ? shown.name : '' })['Content-Disposition']
        expect(disposition.endsWith(`..png"; filename*=UTF-8''${'A'.repeat(250)}..png`)).toBe(true)
      })
    })
    it('refuses blank names, control characters, U+FFFD and non-strings', () => {
      for (const raw of ['   ', 'a\u0000b.txt', 'a\u0085b.txt', 'lost\uFFFD.txt', 42, null]) {
        expect(normalizeAttachmentDisplayName(raw), JSON.stringify(raw)).toEqual({ ok: false, reason: 'invalid_name' })
      }
    })
  })

  describe('deriveTaskAttachmentStorageKey', () => {
    it('prefix, UTC year-month, caller suffix, extension from the type', () => {
      expect(deriveTaskAttachmentStorageKey('image/jpeg', NOW, 'abc123')).toBe('task-attachments/2026-10/abc123.jpg')
      expect(deriveTaskAttachmentStorageKey('application/pdf', NOW, '3f2b9c1e-7a4d-4e8b-9c2a-1d5e6f7a8b9c')).toBe(
        'task-attachments/2026-10/3f2b9c1e-7a4d-4e8b-9c2a-1d5e6f7a8b9c.pdf',
      )
    })
    it('uses the UTC month', () => {
      expect(deriveTaskAttachmentStorageKey('text/csv', new Date('2026-10-31T23:30:00-05:00'), 'k')).toBe('task-attachments/2026-11/k.csv')
    })
    it('refuses unsafe suffixes', () => {
      for (const suffix of ['', '../x', 'a/b', 'a.b', '-a', 'a-', 'a--b', 'a b', 'a'.repeat(129)]) {
        expect(() => deriveTaskAttachmentStorageKey('image/png', NOW, suffix), suffix).toThrow(TypeError)
      }
    })
    it('refuses types that are not canonical allowlist entries', () => {
      for (const mime of ['image/svg+xml', 'IMAGE/PNG', ' image/png', '__proto__']) {
        expect(() => deriveTaskAttachmentStorageKey(mime, NOW, 'k'), mime).toThrow(TypeError)
      }
    })
  })

  describe('authorizeTaskAttachmentDownload (RULED(2026-10-09): [S21])', () => {
    const BOUND: TaskAttachmentRowForDownload = { orgId: 'org1', uploaderId: 'up', status: 'bound', boundAt: NOW, scanState: 'unscanned' }
    const UNBOUND: TaskAttachmentRowForDownload = { ...BOUND, status: 'unbound', boundAt: null }
    const decide = (row: TaskAttachmentRowForDownload | null, viewerId: string, roles: TaskRole[], viewerOrgId = 'org1') =>
      authorizeTaskAttachmentDownload({ row, viewerId, viewerOrgId, roles }).decision

    it('a missing row is not_found', () => {
      expect(decide(null, 'up', ['creator'])).toBe('not_found')
    })
    it('org first: another org, a blank viewer org, or a blank row org are not_found — even for the uploader', () => {
      expect(decide(BOUND, 'up', ['creator'], 'org2')).toBe('not_found')
      expect(decide(BOUND, 'up', ['creator'], '')).toBe('not_found')
      expect(decide({ ...BOUND, orgId: '' }, 'up', ['creator'], '')).toBe('not_found')
      expect(decide(UNBOUND, 'up', [], 'org2')).toBe('not_found')
    })
    it('a never-bound row: the uploader only', () => {
      expect(decide(UNBOUND, 'up', ['none'])).toBe('allow')
      expect(decide(UNBOUND, 'someone', ['creator'])).toBe('not_found')
      expect(decide(UNBOUND, '', ['creator'])).toBe('not_found')
    })
    it('a never-bound row: a blank viewer never matches a blank uploader', () => {
      expect(decide({ ...UNBOUND, uploaderId: '' }, '', ['creator'])).toBe('not_found')
      expect(decide({ ...UNBOUND, uploaderId: '' }, '', [])).toBe('not_found')
      expect(decide({ ...UNBOUND, uploaderId: '' }, 'someone', ['creator'])).toBe('not_found')
    })
    it('a bound row: view on the task decides (every role with view, nobody without)', () => {
      for (const role of ALL_ROLES) {
        expect(decide(BOUND, 'viewer', [role]), role).toBe(role === 'none' ? 'not_found' : 'allow')
      }
    })
    it('a bound row: the uploader without view on the task is not_found', () => {
      expect(decide(BOUND, 'up', ['none'])).toBe('not_found')
    })
    it('deleted or infected answers gone, but only after authorization', () => {
      expect(decide({ ...BOUND, status: 'deleted' }, 'viewer', ['follower'])).toBe('gone')
      expect(decide({ ...BOUND, status: 'deleted' }, 'viewer', ['none'])).toBe('not_found')
      expect(decide({ ...BOUND, scanState: 'infected' }, 'viewer', ['assignee'])).toBe('gone')
      expect(decide({ ...BOUND, scanState: 'infected' }, 'viewer', ['none'])).toBe('not_found')
      expect(decide({ ...BOUND, status: 'deleted' }, 'viewer', ['creator'], 'org2')).toBe('not_found')
    })
    it('a deleted never-bound row: gone for its uploader, not_found for everyone else', () => {
      const row: TaskAttachmentRowForDownload = { ...UNBOUND, status: 'deleted' }
      expect(decide(row, 'up', [])).toBe('gone')
      expect(decide(row, 'other', ['creator'])).toBe('not_found')
    })
    it('a row whose status and boundAt contradict each other is corrupt data (TypeError)', () => {
      expect(() => decide({ ...UNBOUND, boundAt: NOW }, 'up', ['none'])).toThrow(TypeError)
      expect(() => decide({ ...BOUND, boundAt: null }, 'up', ['none'])).toThrow(TypeError)
      expect(decide({ ...BOUND, status: 'deleted', boundAt: null }, 'up', [])).toBe('gone')
      expect(decide({ ...BOUND, status: 'deleted' }, 'viewer', ['follower'])).toBe('gone')
    })
    it('rejects malformed input with TypeError', () => {
      expect(() => decide({ ...BOUND, status: 'archived' as never }, 'v', ['creator'])).toThrow(TypeError)
      expect(() => decide({ ...BOUND, scanState: 'pending' as never }, 'v', ['creator'])).toThrow(TypeError)
      expect(() => authorizeTaskAttachmentDownload({ row: BOUND, viewerId: 'v', viewerOrgId: 'org1', roles: 'x' as never })).toThrow(TypeError)
    })
  })

  describe('add / remove permissions (RULED(2026-10-09): [S20])', () => {
    it('task-level add needs attach; comment-level add needs comment', () => {
      const task = ALL_ROLES.filter((r) => canAddAttachment([r], 'task'))
      const comment = ALL_ROLES.filter((r) => canAddAttachment([r], 'comment'))
      expect(task).toEqual(['creator', 'assignee', 'list-editor'])
      expect(comment).toEqual(['creator', 'assignee', 'follower', 'list-editor', 'list-reader'])
      expect(() => canAddAttachment(['creator'], 'inline' as never)).toThrow(TypeError)
    })
    it('remove: the uploader (any binding); attach holders only for task-level attachments', () => {
      expect(canRemoveAttachment({ roles: ['follower'], isUploader: true, bindKind: 'comment' })).toBe(true)
      expect(canRemoveAttachment({ roles: ['list-reader'], isUploader: true, bindKind: 'task' })).toBe(true)
      expect(canRemoveAttachment({ roles: ['assignee'], isUploader: false, bindKind: 'task' })).toBe(true)
      expect(canRemoveAttachment({ roles: ['list-editor'], isUploader: false, bindKind: 'task' })).toBe(true)
      expect(canRemoveAttachment({ roles: ['creator'], isUploader: false, bindKind: 'comment' })).toBe(false)
      expect(canRemoveAttachment({ roles: ['follower'], isUploader: false, bindKind: 'task' })).toBe(false)
      expect(canRemoveAttachment({ roles: ['list-reader'], isUploader: false, bindKind: 'task' })).toBe(false)
    })
    it('remove: nobody without view on the task, the uploader included (lock §5.1)', () => {
      for (const bindKind of ['task', 'comment'] as const) {
        expect(canRemoveAttachment({ roles: ['none'], isUploader: true, bindKind }), bindKind).toBe(false)
        expect(canRemoveAttachment({ roles: [], isUploader: true, bindKind }), bindKind).toBe(false)
        expect(canRemoveAttachment({ roles: ['none'], isUploader: false, bindKind }), bindKind).toBe(false)
      }
    })
  })

  describe('planRemoveAttachment', () => {
    const row = (overrides: Partial<TaskAttachmentRowForRemoval> = {}): TaskAttachmentRowForRemoval => ({
      id: 'tatt_1',
      taskId: 'tsk_1',
      uploaderId: 'up',
      status: 'bound',
      bindKind: 'task',
      boundAt: NOW,
      ...overrides,
    })
    const plan = (r: TaskAttachmentRowForRemoval | null, actorId: string, roles: TaskRole[]) => planRemoveAttachment({ row: r, actorId, roles, now: NOW })
    const removed = (actorId: string) => ({
      ok: true,
      events: [{ taskId: 'tsk_1', type: 'attachment_removed', userId: actorId, occurredAt: NOW, payload: { attachmentId: 'tatt_1' } }],
    })

    it('missing or already deleted ⇒ not_found', () => {
      expect(plan(null, 'up', ['creator'])).toEqual({ ok: false, reason: 'not_found' })
      expect(plan(row({ status: 'deleted' }), 'up', ['creator'])).toEqual({ ok: false, reason: 'not_found' })
    })
    it('a never-bound row: the uploader removes it with no task event; others get not_found', () => {
      const staged = row({ status: 'unbound', boundAt: null, taskId: null, bindKind: 'comment' })
      expect(plan(staged, 'up', [])).toEqual({ ok: true, events: [] })
      expect(plan(staged, 'other', ['creator'])).toEqual({ ok: false, reason: 'not_found' })
    })
    it('a task-level attachment: an attach holder removes it', () => {
      expect(plan(row(), 'assignee1', ['assignee'])).toEqual(removed('assignee1'))
    })
    it('a comment-level attachment: only its uploader (a follower removing their own upload)', () => {
      expect(plan(row({ bindKind: 'comment' }), 'up', ['follower'])).toEqual(removed('up'))
      expect(plan(row({ bindKind: 'comment' }), 'editor', ['list-editor'])).toEqual({ ok: false, reason: 'forbidden' })
    })
    it('a viewer who may not remove it gets forbidden; a stranger gets not_found', () => {
      expect(plan(row(), 'f', ['follower'])).toEqual({ ok: false, reason: 'forbidden' })
      expect(plan(row(), 'stranger', ['none'])).toEqual({ ok: false, reason: 'not_found' })
    })
    it('a bound row: the uploader without a role on the task gets the same not_found as a missing row (lock §5.1)', () => {
      const missing = plan(null, 'up', ['none'])
      expect(missing).toEqual({ ok: false, reason: 'not_found' })
      for (const bindKind of ['task', 'comment'] as const) {
        // ['none'] is also what the caller passes when the owning task is gone or soft-deleted.
        expect(plan(row({ bindKind }), 'up', ['none']), bindKind).toEqual(missing)
        expect(plan(row({ bindKind }), 'up', []), bindKind).toEqual(missing)
      }
    })
    it('a never-bound row: roles do not matter; the uploader removes it, anyone else gets the missing-row answer', () => {
      const staged = row({ status: 'unbound', boundAt: null, taskId: null, bindKind: 'comment' })
      const missing = plan(null, 'other', ['creator'])
      expect(plan(staged, 'up', ['none'])).toEqual({ ok: true, events: [] })
      expect(plan({ ...staged, bindKind: 'task' }, 'up', ['none'])).toEqual({ ok: true, events: [] })
      expect(plan(staged, 'other', ['creator'])).toEqual(missing)
      expect(plan(staged, 'other', ['none'])).toEqual(missing)
    })
    it('a bound row must carry its task id', () => {
      expect(() => plan(row({ taskId: null }), 'up', ['creator'])).toThrow(TypeError)
    })
    it('a row whose status and boundAt contradict each other is corrupt data (TypeError), as in the download decision', () => {
      expect(() => plan(row({ status: 'bound', boundAt: null }), 'up', ['creator'])).toThrow(TypeError)
      expect(() => plan(row({ status: 'unbound', boundAt: NOW }), 'up', ['creator'])).toThrow(TypeError)
      expect(() => plan(row({ status: 'archived' as never }), 'up', ['creator'])).toThrow(TypeError)
      expect(plan(row({ status: 'deleted', boundAt: null }), 'up', ['creator'])).toEqual({ ok: false, reason: 'not_found' })
    })
  })

  describe('event and binding plans', () => {
    it('planAttachmentAddedEvents: one attachment_added per distinct id (RULED(2026-10-09): [S19])', () => {
      expect(planAttachmentAddedEvents({ taskId: 'tsk_1', attachmentIds: ['tatt_a', 'tatt_b', 'tatt_a'], bindKind: 'comment', actorId: 'u1', now: NOW })).toEqual([
        { taskId: 'tsk_1', type: 'attachment_added', userId: 'u1', occurredAt: NOW, payload: { attachmentId: 'tatt_a', bindKind: 'comment' } },
        { taskId: 'tsk_1', type: 'attachment_added', userId: 'u1', occurredAt: NOW, payload: { attachmentId: 'tatt_b', bindKind: 'comment' } },
      ])
    })
    it('planCommentAttachmentBind: absent ⇒ none; at most 5 distinct ids', () => {
      expect(planCommentAttachmentBind({})).toEqual({ ok: true, ids: [] })
      const five = ['tatt_1', 'tatt_2', 'tatt_3', 'tatt_4', 'tatt_5']
      expect(planCommentAttachmentBind({ attachmentIds: [...five, 'tatt_1'] })).toEqual({ ok: true, ids: five })
      expect(planCommentAttachmentBind({ attachmentIds: [...five, 'tatt_6'] })).toEqual({ ok: false, reason: 'limit' })
    })
    it('planCommentAttachmentBind: malformed ids are invalid_ids', () => {
      expect(planCommentAttachmentBind({ attachmentIds: 'tatt_1' })).toEqual({ ok: false, reason: 'invalid_ids' })
      expect(planCommentAttachmentBind({ attachmentIds: ['tatt__1'] })).toEqual({ ok: false, reason: 'invalid_ids' })
      expect(planCommentAttachmentBind({ attachmentIds: [7] })).toEqual({ ok: false, reason: 'invalid_ids' })
    })
    it('checkCommentAttachmentTotals: at most 5 rows and 25 MiB together', () => {
      expect(checkCommentAttachmentTotals([1, 2, 3, 4, 5])).toEqual({ ok: true })
      expect(checkCommentAttachmentTotals([1, 2, 3, 4, 5, 6])).toEqual({ ok: false, reason: 'limit' })
      expect(checkCommentAttachmentTotals([10485760, 10485760, 5242880])).toEqual({ ok: true })
      expect(checkCommentAttachmentTotals([10485760, 10485760, 5242881])).toEqual({ ok: false, reason: 'limit' })
      expect(() => checkCommentAttachmentTotals([0])).toThrow(TypeError)
    })
    it('checkTaskAttachmentQuota: at most 20 per task', () => {
      expect(checkTaskAttachmentQuota({ existingCount: 19, adding: 1 })).toEqual({ ok: true })
      expect(checkTaskAttachmentQuota({ existingCount: 20, adding: 1 })).toEqual({ ok: false, reason: 'limit' })
      expect(checkTaskAttachmentQuota({ existingCount: 15, adding: 5 })).toEqual({ ok: true })
      expect(checkTaskAttachmentQuota({ existingCount: 15, adding: 6 })).toEqual({ ok: false, reason: 'limit' })
      expect(() => checkTaskAttachmentQuota({ existingCount: 1, adding: 0 })).toThrow(TypeError)
    })
    it('parseAttachmentRefIds: at most 200 entries in the raw array (before de-duplication), each well-formed', () => {
      const ids = (n: number) => Array.from({ length: n }, (_, i) => `tatt_${i}`)
      expect(parseAttachmentRefIds(ids(200))).toEqual({ ok: true, ids: ids(200) })
      expect(parseAttachmentRefIds([...ids(199), 'tatt_0'])).toEqual({ ok: true, ids: ids(199) })
      expect(parseAttachmentRefIds([...ids(200), 'tatt_0'])).toEqual({ ok: false, reason: 'limit' })
      expect(parseAttachmentRefIds([...ids(200), ...Array.from({ length: 5000 }, () => 'tatt_0')])).toEqual({ ok: false, reason: 'limit' })
      expect(parseAttachmentRefIds(ids(201))).toEqual({ ok: false, reason: 'limit' })
      // the length is checked before the ids, as in the approval precedent
      expect(parseAttachmentRefIds([...ids(200), '_x'])).toEqual({ ok: false, reason: 'limit' })
      expect(parseAttachmentRefIds({ ids: [] })).toEqual({ ok: false, reason: 'invalid_ids' })
      expect(parseAttachmentRefIds(['_x'])).toEqual({ ok: false, reason: 'invalid_ids' })
    })
  })

  describe('buildTaskAttachmentDownloadHeaders (RULED(2026-10-09): [S21]; ASSUMPTION(task-e): [D6])', () => {
    const disposition = (fileName: string) => buildTaskAttachmentDownloadHeaders({ mimeType: 'text/plain', fileName })['Content-Disposition']
    it('the four fixed headers', () => {
      expect(buildTaskAttachmentDownloadHeaders({ mimeType: 'application/pdf', fileName: 'report.pdf' })).toEqual({
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="report.pdf"; filename*=UTF-8''report.pdf`,
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'",
      })
    })
    it('non-ASCII names: an ASCII fallback plus the UTF-8 filename*', () => {
      expect(disposition('报告 (final)*.txt')).toBe(`attachment; filename="__ (final)*.txt"; filename*=UTF-8''%E6%8A%A5%E5%91%8A%20%28final%29%2A.txt`)
    })
    it("filename* encodes ' ( ) * as well", () => {
      expect(disposition("it's(1)*.txt")).toBe(`attachment; filename="it's(1)*.txt"; filename*=UTF-8''it%27s%281%29%2A.txt`)
    })
    it('the quoted fallback never contains a quote, a backslash, CR or LF', () => {
      expect(disposition('a"b\\c\r\nd.txt')).toBe(`attachment; filename="a_b_c__d.txt"; filename*=UTF-8''a%22b%5Cc%0D%0Ad.txt`)
    })
    it('an empty name falls back to "attachment"; a lone surrogate does not throw', () => {
      expect(disposition('')).toBe(`attachment; filename="attachment"; filename*=UTF-8''attachment`)
      expect(disposition('\uD800x.txt')).toBe(`attachment; filename="_x.txt"; filename*=UTF-8''%EF%BF%BDx.txt`)
    })
    it('never inline', () => {
      for (const mime of TASK_ATTACHMENT_ALLOWED_MIME_TYPES) {
        expect(buildTaskAttachmentDownloadHeaders({ mimeType: mime, fileName: 'f' })['Content-Disposition'].startsWith('attachment;'), mime).toBe(true)
      }
    })
    it('only an allowlisted stored type can be served', () => {
      expect(() => buildTaskAttachmentDownloadHeaders({ mimeType: 'text/html', fileName: 'a.html' })).toThrow(TypeError)
      expect(() => buildTaskAttachmentDownloadHeaders({ mimeType: 'image/png', fileName: 7 as never })).toThrow(TypeError)
    })
  })

  describe('isUnboundAttachmentExpired', () => {
    it('expires exactly 168 hours after creation', () => {
      const createdAt = new Date('2026-10-01T00:00:00.000Z')
      expect(isUnboundAttachmentExpired({ createdAt, now: new Date('2026-10-08T00:00:00.000Z') })).toBe(true)
      expect(isUnboundAttachmentExpired({ createdAt, now: new Date('2026-10-07T23:59:59.999Z') })).toBe(false)
    })
  })
})
