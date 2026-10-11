import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { createInterface } from 'node:readline'
import { runConfiguredAppBrowser, type ConfiguredAppBrowserInput } from './stock-preparation-plm-full-app-browser.ts'
import type { AutomationCheckpoint, AutomationCheckpointReply } from './stock-preparation-automation-full-app-browser.ts'

const lines = createInterface({ input: process.stdin })
const replies = new Map<number, { expectsRequest: boolean; resolve(reply: AutomationCheckpointReply): void; reject(error: Error): void }>()
let serial = 0
try {
  let payload = await new Promise<string>(resolve => lines.once('line', resolve))
  assert(payload.length < 262144)
  const input = JSON.parse(payload) as ConfiguredAppBrowserInput
  payload = ''
  assert.equal(new URL(input.apiOrigin).port, process.env.PLM_FULL_APP_PARENT_HTTP_PORT)
  // Derive ESM location here: the sibling .ts helpers live in a CommonJS package.
  const repositoryRoot = fileURLToPath(new URL('../../../../', import.meta.url))
  lines.on('line', line => {
    try {
      assert(line.length < 2048)
      const response = JSON.parse(line) as { id: number; ok: boolean; requestId?: string }
      const pending = replies.get(response.id)
      assert(pending && typeof response.ok === 'boolean')
      assert.deepEqual(Object.keys(response).sort(), ['id', 'ok', ...(pending.expectsRequest && response.ok ? ['requestId'] : [])].sort())
      if (pending.expectsRequest && response.ok) assert(typeof response.requestId === 'string' && /^[a-f0-9-]{36}$/.test(response.requestId))
      replies.delete(response.id)
      if (response.ok) pending.resolve(response.requestId ? { requestId: response.requestId } : undefined)
      else pending.reject(new Error('APP_BROWSER_AUTOMATION_CHECKPOINT_REFUSED'))
    } catch {
      for (const pending of replies.values()) pending.reject(new Error('APP_BROWSER_AUTOMATION_CHECKPOINT_INVALID'))
      replies.clear()
    }
  })
  const checkpoint = async (command: AutomationCheckpoint) => {
    const id = ++serial
    assert(id <= 126 && replies.size === 0)
    return await new Promise<AutomationCheckpointReply>((resolve, reject) => {
      const timer = setTimeout(() => { replies.delete(id); reject(new Error('APP_BROWSER_AUTOMATION_CHECKPOINT_TIMEOUT')) },
        command.phase === 'await-completed' || command.phase === 'interval-completed' ? 35000
          : ['interval-preactivation-tick', 'interval-admitted', 'interval-budget-tick'].includes(command.phase) ? 40000 : 20000)
      replies.set(id, { expectsRequest: command.phase === 'interval-admitted',
        resolve(reply) { clearTimeout(timer); resolve(reply) }, reject(error) { clearTimeout(timer); reject(error) } })
      // Private local protocol: carries opaque IDs, never emitted as public evidence.
      console.log('PLM_FULL_APP_UI_CHECKPOINT ' + JSON.stringify({ id, command }))
    })
  }
  const result = await runConfiguredAppBrowser(input, repositoryRoot, checkpoint)
  // This framed pipe message is exclusively consumed by the owning local parent.
  // It contains opaque DB-verification handles; never forward it to evidence logs.
  console.log('PLM_FULL_APP_UI_RESULT ' + JSON.stringify(result))
} catch (error) {
  const diagnostic = error instanceof Error && /^APP_BROWSER_[A-Z_]+$/.test(error.message)
    ? error.message : 'APP_BROWSER_CHILD_FAILED'
  console.log('PLM_FULL_APP_PROBE ' + JSON.stringify({ stage: 'isolated-browser-failed', diagnostic }))
  process.exitCode = 1
} finally {
  lines.close()
  process.stdin.pause()
}
