import assert from 'node:assert/strict'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { initializationBrowserFailure, runYidaInitializationFullApp, type YidaInitializationBrowserInput } from './stock-preparation-yida-initialization-full-app.ts'

const lines = createInterface({ input: process.stdin })
try {
  let payload = await new Promise<string>(resolve => lines.once('line', resolve))
  assert(payload.length < 262144, 'APP_BROWSER_YIDA_INIT_INPUT_LIMIT')
  const input = JSON.parse(payload) as YidaInitializationBrowserInput
  payload = ''
  assert.equal(new URL(input.apiOrigin).port, process.env.PLM_FULL_APP_PARENT_HTTP_PORT)
  const result = await runYidaInitializationFullApp(input, fileURLToPath(new URL('../../../../', import.meta.url)))
  // Private local pipe only. The owning parent strips all opaque DB handles.
  console.log('PLM_FULL_APP_YIDA_INIT_RESULT ' + JSON.stringify(result))
} catch (error) {
  console.log('PLM_FULL_APP_PROBE ' + JSON.stringify(initializationBrowserFailure(error)))
  process.exitCode = 1
} finally { lines.close(); process.stdin.pause() }
