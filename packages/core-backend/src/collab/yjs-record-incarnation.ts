import type { Doc } from 'yjs'

export interface YjsRecordIncarnation {
  recordId: string
  incarnation: string | null
}

const documentOwners = new WeakMap<Doc, YjsRecordIncarnation>()

export function bindYjsRecord(doc: Doc, owner: YjsRecordIncarnation): void {
  documentOwners.set(doc, owner)
}

export function getYjsRecordOwner(doc: Doc): YjsRecordIncarnation | undefined {
  return documentOwners.get(doc)
}

export class YjsRecordRetiredError extends Error {
  constructor() {
    super('The collaborative record was removed or recreated.')
  }
}

export const lockYjsRecordSql = `SELECT 1 FROM meta_records
  WHERE id = $1 AND yjs_incarnation IS NOT DISTINCT FROM $2::uuid FOR KEY SHARE`
