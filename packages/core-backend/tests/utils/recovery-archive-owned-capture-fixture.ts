import { randomUUID } from 'node:crypto'

import { Kysely, PostgresDialect } from 'kysely'
import type { Pool } from 'pg'

import * as views from '../../src/db/migrations/zzzz20260326124000_add_config_to_meta_views'
import * as autoNumber from '../../src/db/migrations/zzzz20260505110000_create_meta_field_auto_number_sequences'
import { createOwnedClaimFixture } from './recovery-archive-owned-claim-fixture'

export async function createOwnedCaptureFixture(admin: Pool) {
  const fixture = await createOwnedClaimFixture(admin)
  const db = new Kysely<unknown>({ dialect: new PostgresDialect({ pool: fixture.pool }) })
  try {
    await db.transaction().execute(views.up)
    await db.transaction().execute(autoNumber.up)
  } catch (error) {
    await fixture.dispose()
    throw error
  }
  const { pool, identity } = fixture
  const noteField = `${identity.sheetId}_note`
  const fileField = `${identity.sheetId}_files`
  const recordId = `${identity.sheetId}_record`
  const viewId = `${identity.sheetId}_view`
  const descriptors: Array<{ attachmentId: string; storageKey: string; immutableVersion: string;
    contentSha256: string; contentSizeBytes: string }> = []
  return { ...fixture, noteField, fileField, recordId, viewId, descriptors,
    async populate(attachmentCount = 2) {
      await pool.query(`INSERT INTO meta_fields (id,sheet_id,name,type,property,"order")
        VALUES ($1,$3,'Synthetic note','string','{}',1),($2,$3,'Synthetic files','attachment','{}',2)`,
      [noteField, fileField, identity.sheetId])
      await pool.query(`INSERT INTO meta_records (id,sheet_id,data) VALUES ($1,$2,$3::jsonb)`,
        [recordId, identity.sheetId, JSON.stringify({ [noteField]: 'original', [fileField]: [] })])
      await pool.query(`INSERT INTO meta_links (id,field_id,record_id,foreign_record_id)
        VALUES ($1,$2,$3,$4)`, [`${identity.sheetId}_link`, noteField, recordId, `${identity.sheetId}_foreign`])
      await pool.query(`INSERT INTO meta_field_value_tombstones
        (sheet_id,field_id,record_id,value,reason,config_revision_id)
        VALUES ($1,$2,$3,'{"old":true}','field_delete',$4::uuid)`, [identity.sheetId, noteField, recordId, randomUUID()])
      await pool.query(`INSERT INTO meta_link_tombstones
        (sheet_id,field_id,record_id,foreign_record_id,reason,source_revision_id)
        VALUES ($1,$2,$3,$4,'record_delete',$5::uuid)`, [identity.sheetId, noteField, recordId, `${identity.sheetId}_foreign`, randomUUID()])
      await pool.query(`INSERT INTO meta_field_auto_number_sequences (field_id,sheet_id,next_value)
        VALUES ($1,$2,9007199254740993)`, [noteField, identity.sheetId])
      await pool.query(`INSERT INTO meta_views (id,sheet_id,name,type,config)
        VALUES ($1,$2,'Synthetic','grid','{"original":true}')`, [viewId, identity.sheetId])
      for (let index = 0; index < attachmentCount; index += 1) {
        const attachmentId = `${identity.sheetId}_attachment_${index}`
        const storageId = randomUUID()
        const contentSha256 = String(index % 10).repeat(64)
        const storageKey = `${storageId}/sha256-${contentSha256}`
        await pool.query(`INSERT INTO multitable_attachments
          (id,sheet_id,record_id,field_id,storage_file_id,filename,mime_type,size,storage_path,storage_provider)
          VALUES ($1,$2,$3,$4,$5,'Synthetic','application/octet-stream',17,$6,'local')`,
        [attachmentId, identity.sheetId, recordId, fileField, storageId, storageKey])
        descriptors.push({ attachmentId, storageKey, immutableVersion: `sha256:${contentSha256}`,
          contentSha256, contentSizeBytes: '17' })
      }
      await pool.query(`UPDATE meta_records SET data=data||jsonb_build_object($2::text,$3::jsonb) WHERE id=$1`,
        [recordId, fileField, JSON.stringify(descriptors.map((descriptor) => descriptor.attachmentId))])
    },
  }
}

export type OwnedCaptureFixture = Awaited<ReturnType<typeof createOwnedCaptureFixture>>
