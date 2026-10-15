import { it, expect } from 'vitest'
import { readFile, writeFile, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { randomUUID, createHmac } from 'node:crypto'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import type { Pool } from 'pg'
import { PLMAdapter } from '../../src/data-adapters/PLMAdapter'
import { PlmBomReviewService, type BomReviewPool } from '../../src/multitable/plm-bom-review-service'
import { PlmBomNotificationWorker } from '../../src/multitable/plm-bom-notification-worker'

export function registerChangeCrossprocess(pool: Pool, tx: BomReviewPool) {
  const directory = process.env.W20_PROVIDER_DIR
  if (!directory) return // Explicit rehearsal only; the runner requires the provider and asserts this test ran.
  it('cross-process real Yuantus line/ECO -> durable listener -> signed HTTP, then revocation', async () => {
    const provider = JSON.parse(await readFile(join(directory,'connection.json'),'utf8'))
    const command = async (action: string) => {
      const id = randomUUID(),file = join(directory,`command-${id}.json`)
      await writeFile(file+'.tmp',JSON.stringify({ id,action })); await rename(file+'.tmp',file)
      for (let n=0;n<300;n++) {
        let result
        try { result=JSON.parse(await readFile(join(directory,`result-${id}.json`),'utf8')) } catch { /* atomic file arrival */ }
        if (result) { expect(result,result.error).toMatchObject({ ok: true }); return }
        await new Promise(resolve => setTimeout(resolve,30))
      }
      throw new Error('provider command timeout')
    }
    const adapter = new PLMAdapter({ get: () => undefined } as never,{ info: () => {},warn: () => {},error: () => {} } as never)
    const receiver = () => new PlmBomReviewService({ pool: tx,dataSourceManager: { getDataSource: () => adapter as never } })
    const config = { connection: { url: provider.url },credentials: { token: provider.token },
      options: { apiMode: 'yuantus',tenantId: provider.tenant,orgId: provider.org } }
    await pool.query("INSERT INTO data_sources(id,name,type,config,owner_id,is_active,scope_kind) VALUES('cross-source','Synthetic Yuantus','plm',$1,'owner',true,'user')",[JSON.stringify(config)])
    await pool.query("INSERT INTO user_permissions VALUES('owner','multitable:send_webhook')")
    const calls: Array<{ id: string; body: string; signature: string }> = []
    const accepted = new Set<string>()
    const peer = createServer((req,res) => {
      let body=''; req.on('data',chunk => { body+=chunk }); req.on('end',() => {
        calls.push({ id: String(req.headers['idempotency-key']),body,signature: String(req.headers['x-webhook-signature']) })
        accepted.add(String(req.headers['idempotency-key']))
        res.writeHead(204); res.end()
      })
    })
    await new Promise<void>(resolve => peer.listen(0,'127.0.0.1',resolve))
    const port=(peer.address() as { port: number }).port,target=randomUUID(),secret='synthetic-crossprocess-secret'
    await pool.query("INSERT INTO multitable_webhooks(id,name,url,secret,created_by) VALUES($1,'crossprocess',$2,$3,'owner')",[target,`http://127.0.0.1:${port}`,secret])
    const others=(await pool.query('SELECT id,active FROM multitable_webhooks WHERE id<>$1',[target])).rows
    const worker = new PlmBomNotificationWorker(tx,receiver(),() => undefined)
    const bindings: string[]=[]
    const failing = () => new PlmBomReviewService({ pool: { query: tx.query,
      transaction: fn => tx.transaction(({ query }) => fn({ query: async (sql,params) => {
        if (sql.includes('SET state=$2,last_http_status=$3')) throw new Error('fixture receipt commit unavailable')
        return query(sql,params)
      } })) },dataSourceManager: { getDataSource: () => adapter as never } })
    const recoverInNewProcess = (eventId: string) => new Promise<string>((resolve,reject) => {
      const child = spawn(process.execPath,[
        fileURLToPath(new URL('../../node_modules/tsx/dist/cli.mjs',import.meta.url)),
        fileURLToPath(new URL('./completion-recover.ts',import.meta.url)),eventId,
      ],{ env: process.env,stdio: ['ignore','pipe','pipe'] })
      let output=''
      child.stdout.on('data',chunk => { output+=chunk })
      child.stderr.on('data',chunk => { output+=chunk })
      const timer=setTimeout(() => { child.kill(); reject(new Error('recovery child timeout')) },20000)
      child.on('error',error => { clearTimeout(timer); reject(error) })
      child.on('close',code => {
        clearTimeout(timer)
        if (code !== 0) reject(new Error(`recovery child failed (${code}): ${output.slice(-2000)}`))
        else resolve(output)
      })
    })
    try {
      await pool.query('UPDATE multitable_webhooks SET active=false WHERE id<>$1',[target])
      for (const kind of ['bom_line_writeback','eco_batch_apply']) {
        const action=kind==='bom_line_writeback' ? 'line' : 'eco'
        // Real source writes before activation must be excluded by the captured baseline.
        await command(action)
        const preview=await receiver().preview('owner',{ dataSourceId: 'cross-source',partId: provider.part,baseId: 'base',name: 'Cross process' })
        const binding=await receiver().create('owner',{ previewId: preview.previewId,requestId: randomUUID() })
        bindings.push(binding.id)
        await receiver().completionWebhooks('owner',binding.id,{ expectedVersion: 0,webhooks: {
          reviewCompleted: { enabled: false,webhookId: null,granularity: null },
          plmChangeApplied: { enabled: true,webhookId: target,source: kind } } })
        const enabled=await receiver().changeListener('owner',binding.id,{ expectedVersion: binding.version })
        expect(enabled).toMatchObject({ status: 'active' })
        const prior=calls.length
        // A new service instance must consume persisted state, not an in-memory cursor.
        await receiver().pollChanges(binding.id)
        expect((await pool.query('SELECT count(*)::int n FROM meta_plm_bom_change_inbox WHERE binding_id=$1',[binding.id])).rows[0].n).toBe(0)
        await command(action)
        if (kind==='bom_line_writeback') {
          await receiver().pollChanges(binding.id)
          const eventId=(await pool.query('SELECT id FROM meta_plm_bom_review_completion_events WHERE binding_id=$1',[binding.id])).rows[0].id
          await expect(failing().deliverCompletion(eventId)).rejects.toThrow('fixture receipt commit unavailable')
          expect(calls.length).toBe(prior+1)
          expect((await pool.query('SELECT state,attempt_count FROM meta_plm_bom_review_completion_intents WHERE event_id=$1',[eventId])).rows[0])
            .toEqual({ state: 'prepared',attempt_count: 1 })
          // Accelerate only this fixture's abandoned lease, not a real 30-second wait.
          await pool.query("UPDATE meta_plm_bom_review_completion_intents SET lease_until=clock_timestamp()-interval '1 second' WHERE event_id=$1",[eventId])
          expect(await recoverInNewProcess(eventId)).toContain('RECOVERY_RESULT={"state":"delivered"}')
          expect(calls.length).toBe(prior+2)
          expect(calls[prior+1]).toEqual(calls[prior])
          expect(accepted.size).toBe(1)
          expect((await pool.query('SELECT attempt_count FROM meta_plm_bom_review_completion_intents WHERE event_id=$1',[eventId])).rows[0].attempt_count).toBe(2)
          await worker.start()
        } else await worker.tick()
        expect(calls.length).toBe(prior+(kind==='bom_line_writeback' ? 2 : 1))
        const received=JSON.parse(calls.at(-1)!.body)
        expect(received.change.kind).toBe(kind)
        expect(received.binding_id).toBe(binding.id)
        expect(calls.at(-1)!.signature).toBe(createHmac('sha256',secret).update(calls.at(-1)!.body).digest('hex'))
        expect((await pool.query('SELECT state FROM meta_plm_bom_review_completion_intents WHERE event_id=$1',[calls.at(-1)!.id])).rows[0].state).toBe('delivered')
        await worker.tick(); expect(calls.length).toBe(prior+(kind==='bom_line_writeback' ? 2 : 1))
      }
      // A new generation cancels an old accepted-but-unconfirmed delivery on recovery.
      const id=bindings[0]
      await command('line'); await receiver().pollChanges(id)
      const stale=(await pool.query(`SELECT e.id FROM meta_plm_bom_review_completion_events e
        LEFT JOIN meta_plm_bom_review_completion_intents i ON i.event_id=e.id
        WHERE e.binding_id=$1 AND i.event_id IS NULL`,[id])).rows[0].id
      await expect(failing().deliverCompletion(stale)).rejects.toThrow('fixture receipt commit unavailable')
      const version=Number((await pool.query('SELECT version FROM meta_plm_bom_review_bindings WHERE id=$1',[id])).rows[0].version)
      await receiver().changeListener('owner',id,{ expectedVersion: version })
      expect(await recoverInNewProcess(stale)).toContain('RECOVERY_RESULT={"state":"cancelled"}')
      expect(accepted.size).toBe(3)
      expect(calls).toHaveLength(4)
      await command('revoke')
      await worker.tick()
      for (const id of bindings) expect((await pool.query('SELECT status FROM meta_plm_bom_change_listeners WHERE binding_id=$1',[id])).rows[0].status).toBe('stopped')
      expect(calls).toHaveLength(4)
    } finally {
      await worker.stop()
      await pool.query('UPDATE multitable_webhooks SET active=false WHERE id=$1',[target])
      for (const other of others) await pool.query('UPDATE multitable_webhooks SET active=$2 WHERE id=$1',[other.id,other.active])
      await pool.query("DELETE FROM user_permissions WHERE user_id='owner' AND permission_code='multitable:send_webhook'")
      peer.closeAllConnections(); await new Promise<void>(resolve => peer.close(() => resolve()))
    }
  },60000)
}
