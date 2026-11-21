/**
 * Structural pin for the draft-attachment bind call sites.
 *
 * A file uploaded before its record exists (a create form) is stored with `record_id` NULL, and the draft
 * sweep deletes such rows after the retention time unless a record write binds them. Five write paths bind
 * through `bindOwnDraftAttachments`: form submit (edit and create) in routes/univer-meta.ts,
 * RecordService.createRecord / patchRecord, and RecordWriteService.patchRecords.
 *
 * Their behaviour is covered end to end by tests/integration/multitable-form-draft-attachment-bind.db.test.ts,
 * which runs only in the tasks-realdb workflow. This file runs in the default unit job, so removing a call
 * site, or handing it something other than the write transaction's own `query`, also turns that job red.
 *
 * It pins presence and argument shape only. Where each call sits inside its transaction (after the record
 * row is written) is covered by the real-DB file.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

import { describe, expect, test } from 'vitest'

const SRC = join(__dirname, '../../src')
const CALL_START = 'await bindOwnDraftAttachments({'

function listTsFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...listTsFiles(full))
    else if (entry.isFile() && entry.name.endsWith('.ts')) out.push(full)
  }
  return out
}

/** The object literal of every `await bindOwnDraftAttachments({ … })` call, whitespace collapsed. */
function bindCalls(source: string): string[] {
  const calls: string[] = []
  let from = 0
  for (;;) {
    const start = source.indexOf(CALL_START, from)
    if (start < 0) return calls
    const end = source.indexOf('})', start)
    if (end < 0) throw new Error('unterminated bindOwnDraftAttachments call')
    calls.push(source.slice(start + CALL_START.length, end).replace(/\s+/g, ' ').trim())
    from = end
  }
}

const EXPECTED: Record<string, { count: number; actors: string[] }> = {
  'routes/univer-meta.ts': { count: 2, actors: ['actorId: getRequestActorId(req)', 'actorId: createActorId'] },
  'multitable/record-service.ts': { count: 2, actors: ['actorId', 'actorId: patchActorId'] },
  'multitable/record-write-service.ts': { count: 1, actors: ['actorId'] },
}

describe('draft-attachment bind call sites', () => {
  test('the awaited bind calls live in exactly the three record-writing files', () => {
    const files = listTsFiles(SRC)
      .filter((full) => readFileSync(full, 'utf8').includes(CALL_START))
      .map((full) => relative(SRC, full).split(sep).join('/'))
      .sort()
    expect(files).toEqual(Object.keys(EXPECTED).sort())
  })

  for (const [file, expected] of Object.entries(EXPECTED)) {
    test(`${file}: ${expected.count} bind call(s), each on the transaction's own query`, () => {
      const source = readFileSync(join(SRC, file), 'utf8')
      expect(source).toMatch(/import\s*\{[^}]*\bbindOwnDraftAttachments\b[^}]*\}\s*from\s*'(\.\.\/multitable|\.)\/attachment-service'/)

      const calls = bindCalls(source)
      expect(calls).toHaveLength(expected.count)
      for (const call of calls) {
        // `query` first, by shorthand: the `{ query }` destructured from the write's transaction callback.
        expect(call.startsWith('query,')).toBe(true)
        expect(call).toMatch(/\brecordId\b/)
        expect(call).toMatch(/\bfieldId\b/)
        expect(call).toContain('attachmentIds: ids')
      }
      for (const actor of expected.actors) {
        expect(calls.some((call) => call.replace(/,$/, '').endsWith(actor))).toBe(true)
      }
    })
  }
})
