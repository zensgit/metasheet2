#!/usr/bin/env node
/**
 * Yjs Node.js validation client.
 *
 * Connects to /yjs namespace as a simulated browser user, subscribes to a record,
 * edits a text field via Y.Text, and verifies that the backend observes the Yjs
 * flow (doc count up, bridge flush triggers a patch to meta_records).
 *
 * Usage:
 *   YJS_BASE_URL=http://142.171.239.56:8081 \
 *   YJS_TOKEN=<jwt> \
 *   RECORD_ID=<recordId> \
 *   node scripts/ops/yjs-client-validation/yjs-node-client.mjs
 */

import * as Y from 'yjs'
import * as syncProtocol from 'y-protocols/sync'
import * as encoding from 'lib0/encoding'
import * as decoding from 'lib0/decoding'
import { io as socketIO } from 'socket.io-client'

const BASE_URL = process.env.YJS_BASE_URL || 'http://142.171.239.56:8081'
const TOKEN = process.env.YJS_TOKEN
const RECORD_ID = process.env.RECORD_ID
const FIELD_ID = process.env.FIELD_ID || 'fld_pilot_title'

if (!TOKEN || !RECORD_ID) {
  console.error('YJS_TOKEN and RECORD_ID are required env vars.')
  process.exit(1)
}

const MSG_SYNC = 0
const log = (label, data) => console.log(`[${new Date().toISOString()}] ${label}`, data ?? '')

async function fetchStatus() {
  const res = await fetch(`${BASE_URL}/api/admin/yjs/status`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  })
  if (!res.ok) {
    throw new Error(`status endpoint ${res.status} ${res.statusText} (token may be invalid/expired)`)
  }
  const json = await res.json()
  if (!json.yjs) {
    throw new Error(`status endpoint responded ok but had no yjs payload: ${JSON.stringify(json).slice(0, 200)}`)
  }
  return json.yjs
}

async function fetchRecord() {
  const res = await fetch(`${BASE_URL}/api/multitable/records/${RECORD_ID}?sheetId=sheet_multitable_pilot_smoke`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  })
  return res.json()
}

function handleIncomingMessage(doc, socket, message) {
  const decoder = decoding.createDecoder(message)
  const messageType = decoding.readVarUint(decoder)
  if (messageType !== MSG_SYNC) return
  const encoder = encoding.createEncoder()
  encoding.writeVarUint(encoder, MSG_SYNC)
  syncProtocol.readSyncMessage(decoder, encoder, doc, 'remote')
  const reply = encoding.toUint8Array(encoder)
  if (reply.length > 1) {
    socket.emit('yjs:message', { recordId: RECORD_ID, data: Array.from(reply) })
  }
}

function sendSyncStep1(doc, socket) {
  const encoder = encoding.createEncoder()
  encoding.writeVarUint(encoder, MSG_SYNC)
  syncProtocol.writeSyncStep1(encoder, doc)
  socket.emit('yjs:message', { recordId: RECORD_ID, data: Array.from(encoding.toUint8Array(encoder)) })
}

async function waitForYTextField(doc, fieldId, timeoutMs = 5000) {
  const fields = doc.getMap('fields')
  const current = fields.get(fieldId)
  if (current instanceof Y.Text) return current

  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      fields.unobserve(observer)
      reject(new Error(`timed out waiting for server-seeded Y.Text field ${fieldId}`))
    }, timeoutMs)

    const observer = (event) => {
      if (!event.keysChanged.has(fieldId)) return
      const next = fields.get(fieldId)
      if (!(next instanceof Y.Text)) return
      clearTimeout(timer)
      fields.unobserve(observer)
      resolve(next)
    }

    fields.observe(observer)
  })
}

async function run() {
  log('=== Yjs Node Client Validation ===')
  log('BASE_URL:', BASE_URL)
  log('RECORD_ID:', RECORD_ID)
  log('FIELD_ID:', FIELD_ID)

  log('\n[1/5] Pre-test status')
  const preStatus = await fetchStatus()
  log('  activeDocCount:', preStatus.sync.activeDocCount)
  log('  activeSocketCount:', preStatus.socket.activeSocketCount)
  log('  flushSuccess:', preStatus.bridge.flushSuccessCount)
  log('  flushFailure:', preStatus.bridge.flushFailureCount)

  log('\n[2/5] Pre-test record')
  const preRecord = await fetchRecord()
  const preTitle = preRecord.data?.record?.data?.[FIELD_ID] ?? '(empty)'
  log('  current title:', preTitle)

  log('\n[3/5] Connect to /yjs namespace')
  const doc = new Y.Doc()
  const socket = socketIO(`${BASE_URL}/yjs`, {
    transports: ['websocket'],
    auth: { token: TOKEN },
  })

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('connection timeout')), 10000)
    socket.on('connect', () => { clearTimeout(timer); resolve() })
    socket.on('connect_error', (err) => { clearTimeout(timer); reject(err) })
  })
  log('  socket connected:', socket.id)

  socket.on('yjs:error', (err) => log('  yjs:error', err))
  let requestedServerState = false
  socket.on('yjs:message', ({ recordId, data }) => {
    if (recordId !== RECORD_ID) return
    handleIncomingMessage(doc, socket, new Uint8Array(data))
    if (!requestedServerState) {
      requestedServerState = true
      sendSyncStep1(doc, socket)
    }
  })
  socket.on('yjs:update', ({ recordId, data }) => {
    if (recordId !== RECORD_ID) return
    Y.applyUpdate(doc, new Uint8Array(data), 'remote')
  })

  // Local updates → server
  doc.on('update', (update, origin) => {
    if (origin !== 'remote' && socket.connected) {
      socket.emit('yjs:update', { recordId: RECORD_ID, data: Array.from(update) })
    }
  })

  socket.emit('yjs:subscribe', { recordId: RECORD_ID })
  await new Promise((r) => setTimeout(r, 2000)) // allow sync handshake

  log('  subscribed to record, sync complete')

  log('\n[4/5] During-test status (with 1 Yjs client connected)')
  const midStatus = await fetchStatus()
  log('  activeDocCount:', midStatus.sync.activeDocCount, `(expected: ${preStatus.sync.activeDocCount + 1})`)
  log('  activeSocketCount:', midStatus.socket.activeSocketCount, `(expected: ${preStatus.socket.activeSocketCount + 1})`)

  log('\n  Injecting Y.Text edit via Y.Map("fields")')
  const yText = await waitForYTextField(doc, FIELD_ID)
  const stamp = `YJS-NODE-${new Date().toISOString().slice(11, 19)}`
  doc.transact(() => {
    yText.delete(0, yText.length)
    yText.insert(0, stamp)
  })
  log('  inserted:', stamp)

  // Wait for bridge flush (200ms merge + patch)
  log('\n  waiting 3s for bridge flush...')
  await new Promise((r) => setTimeout(r, 3000))

  const postFlushStatus = await fetchStatus()
  log('  flushSuccess:', postFlushStatus.bridge.flushSuccessCount, `(delta: ${postFlushStatus.bridge.flushSuccessCount - preStatus.bridge.flushSuccessCount})`)
  log('  flushFailure:', postFlushStatus.bridge.flushFailureCount, `(delta: ${postFlushStatus.bridge.flushFailureCount - preStatus.bridge.flushFailureCount})`)
  log('  pendingWrites:', postFlushStatus.bridge.pendingWriteCount)

  log('\n[5/5] Verify record was patched via bridge')
  const postRecord = await fetchRecord()
  const postTitle = postRecord.data?.record?.data?.[FIELD_ID] ?? '(empty)'
  log('  pre title:  ', preTitle)
  log('  post title: ', postTitle)
  log('  match stamp?', postTitle === stamp ? '✅ YES — bridge wrote to meta_records' : '❌ NO — bridge did not propagate')

  log('\n[Cleanup] disconnect')
  socket.emit('yjs:unsubscribe', { recordId: RECORD_ID })
  socket.disconnect()
  doc.destroy()

  // Wait a bit for release
  await new Promise((r) => setTimeout(r, 2000))
  const finalStatus = await fetchStatus()
  log('  activeDocCount after disconnect:', finalStatus.sync.activeDocCount)

  log('\n=== RESULT ===')
  const ok = {
    connected:
      midStatus.sync.activeDocCount >= preStatus.sync.activeDocCount
      && midStatus.socket.activeSocketCount > preStatus.socket.activeSocketCount,
    flushed: postFlushStatus.bridge.flushSuccessCount > preStatus.bridge.flushSuccessCount,
    noFailures: postFlushStatus.bridge.flushFailureCount === preStatus.bridge.flushFailureCount,
    bridgedToDB: postTitle === stamp,
  }
  log('  Yjs backend accepts connection:  ', ok.connected ? '✅' : '❌')
  log('  Bridge flushed at least once:    ', ok.flushed ? '✅' : '❌')
  log('  No flush failures:               ', ok.noFailures ? '✅' : '❌')
  log('  meta_records reflects Yjs edit:  ', ok.bridgedToDB ? '✅' : '❌')

  const allOk = Object.values(ok).every(Boolean)
  process.exit(allOk ? 0 : 2)
}

run().catch((err) => {
  console.error('FATAL', err)
  process.exit(1)
})
