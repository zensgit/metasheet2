import { query } from '../../src/db/pg'

export async function createDirectoryDeprovisionRun(
  integrationId: string,
  triggeredBy = 'test:directory-deprovision',
): Promise<string> {
  const result = await query<{ id: string }>(
    `INSERT INTO directory_sync_runs (integration_id, status, triggered_by, trigger_source)
     VALUES ($1::uuid, 'success', $2::text, 'manual')
     RETURNING id::text AS id`,
    [integrationId, triggeredBy],
  )
  return result.rows[0].id
}

export async function deleteDirectoryDeprovisionEvidence(
  integrationIds: string[],
): Promise<void> {
  if (integrationIds.length === 0) return
  await query(
    `DELETE FROM directory_deprovision_events
      WHERE integration_id = ANY($1::uuid[])`,
    [integrationIds],
  )
}
