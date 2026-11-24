/**
 * Realtime record editing through the real server start-up code, on a real PostgreSQL.
 *
 * Connects only when EXPECT_DB=1 and DATABASE_URL are both set; a skip is not a pass.
 *
 * The whole server is started with realtime record editing switched on, so everything between the
 * transport and the record table is what production runs: the token verifier, the record access
 * checker, the fresh field-write checker, the adapter, the bridge with its per-contributor re-check
 * and its write-input builder, the record write service and the persisted document state. Clients
 * are real socket.io clients speaking the real sync protocol; permissions are rows in the database.
 *
 * One server in one process: this is not a two-process acceptance.
 */
import { randomBytes } from 'node:crypto'
import * as decoding from 'lib0/decoding'
import * as encoding from 'lib0/encoding'
import { Pool } from 'pg'
import { io as ioClient, type Socket as ClientSocket } from 'socket.io-client'
import * as syncProtocol from 'y-protocols/sync'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { authService, type User } from '../../src/auth/AuthService'
import { MetaSheetServer } from '../../src/index'

const databaseUrl = process.env.DATABASE_URL ?? ''
if (process.env.EXPECT_DB === '1' && databaseUrl.length === 0) {
  throw new Error('EXPECT_DB=1 requires DATABASE_URL for realtime-yjs-startup-wiring.db.test.ts')
}
const describeDb = process.env.EXPECT_DB === '1' ? describe : describe.skip

const RUN = `a2yw${randomBytes(5).toString('hex')}`
const BASE_ID = `base_${RUN}`
const SHEET_ID = `sheet_${RUN}`
const F_OPEN = `fld_${RUN}_open`
const F_LOCKED = `fld_${RUN}_locked`
const RESTRICTED = `${RUN}-restricted`
const UNRESTRICTED = `${RUN}-unrestricted`
const READER = `${RUN}-reader`

let admin: Pool
let server: MetaSheetServer | undefined
let baseUrl = ''
const previous: Record<string, string | undefined> = {}
const clients: ClientSocket[] = []

async function until(condition: () => boolean | Promise<boolean>, timeoutMs: number, label: string): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await condition()) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error(`timed out waiting for ${label}`)
}

async function makeUser(id: string, permissions: string[]): Promise<User> {
  await admin.query(
    `INSERT INTO users(
       id, username, email, name, password_hash, role, permissions, is_admin, is_active,
       activation_status, must_change_password, local_password_set, created_at, updated_at
     ) VALUES ($1, $1, $2, 'Synthetic user', 'x', 'member', $3::jsonb, FALSE, TRUE, 'activated', FALSE, TRUE, NOW(), NOW())`,
    [id, `${id}@synthetic.invalid`, JSON.stringify(permissions)],
  )
  return { id, email: `${id}@synthetic.invalid`, name: 'Synthetic user', role: 'member', permissions, created_at: new Date(), updated_at: new Date() }
}

async function seedRecord(label: string): Promise<string> {
  const recordId = `rec_${RUN}_${label}`
  await admin.query('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,1)', [
    recordId, SHEET_ID, JSON.stringify({ [F_OPEN]: 'open-before', [F_LOCKED]: 'locked-before' }),
  ])
  return recordId
}

async function stored(recordId: string): Promise<{ data: Record<string, unknown>; version: number }> {
  const result = await admin.query('SELECT data, version FROM meta_records WHERE id = $1', [recordId])
  return { data: result.rows[0].data as Record<string, unknown>, version: Number(result.rows[0].version) }
}

interface Editor {
  socket: ClientSocket
  doc: Y.Doc
  errors: Array<{ code: string }>
  invalidated: unknown[]
  text(fieldId: string): string | undefined
}

/** Connects with a real session token, subscribes and completes the initial sync. */
async function editor(user: User, recordId: string, options: { expectError?: boolean } = {}): Promise<Editor> {
  const socket = ioClient(`${baseUrl}/yjs`, { transports: ['websocket'], reconnection: false, forceNew: true, auth: { token: authService.createToken(user) } })
  clients.push(socket)
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('connect timeout')), 8000)
    socket.once('connect', () => { clearTimeout(timer); resolve() })
    socket.once('connect_error', (error) => { clearTimeout(timer); reject(error) })
  })
  const doc = new Y.Doc()
  const self: Editor = {
    socket, doc, errors: [], invalidated: [],
    text: (fieldId) => {
      const value = doc.getMap('fields').get(fieldId)
      return value instanceof Y.Text ? value.toString() : (value as string | undefined)
    },
  }
  socket.on('yjs:error', (error: { code: string }) => self.errors.push(error))
  socket.on('yjs:invalidated', (payload: unknown) => self.invalidated.push(payload))
  socket.on('yjs:update', ({ data }: { data: number[] }) => Y.applyUpdate(doc, new Uint8Array(data), 'remote'))
  let serverReady = false
  let synced = false
  socket.on('yjs:message', ({ data }: { data: number[] }) => {
    const decoder = decoding.createDecoder(new Uint8Array(data))
    decoding.readVarUint(decoder)
    const reply = encoding.createEncoder()
    encoding.writeVarUint(reply, 0)
    const type = syncProtocol.readSyncMessage(decoder, reply, doc, 'remote')
    if (type === syncProtocol.messageYjsSyncStep1) serverReady = true
    if (type === syncProtocol.messageYjsSyncStep2) synced = true
    if (encoding.length(reply) > 1) socket.emit('yjs:message', { recordId, data: Array.from(encoding.toUint8Array(reply)) })
  })
  socket.emit('yjs:subscribe', { recordId })
  if (options.expectError) {
    await until(() => self.errors.length > 0, 8000, 'the subscription refusal')
    return self
  }
  await until(() => serverReady, 8000, 'the first sync step of the server')
  const step1 = encoding.createEncoder()
  encoding.writeVarUint(step1, 0)
  syncProtocol.writeSyncStep1(step1, doc)
  socket.emit('yjs:message', { recordId, data: Array.from(encoding.toUint8Array(step1)) })
  await until(() => synced, 8000, 'the document state')
  return self
}

function write(target: Editor, recordId: string, fieldId: string, value: string): void {
  const before = Y.encodeStateVector(target.doc)
  const fields = target.doc.getMap('fields')
  target.doc.transact(() => {
    const current = fields.get(fieldId)
    if (current instanceof Y.Text) {
      current.delete(0, current.length)
      current.insert(0, value)
    } else {
      const text = new Y.Text()
      text.insert(0, value)
      fields.set(fieldId, text)
    }
  }, 'local')
  target.socket.emit('yjs:update', { recordId, data: Array.from(Y.encodeStateAsUpdate(target.doc, before)) })
}

let restricted: User
let unrestricted: User
let reader: User

beforeAll(async () => {
  if (process.env.EXPECT_DB !== '1') return
  for (const key of ['ENABLE_YJS_COLLAB', 'RBAC_TOKEN_TRUST', 'EXTERNAL_LOGIN_REALTIME_REVALIDATION_ENABLED']) previous[key] = process.env[key]
  process.env.ENABLE_YJS_COLLAB = 'true'
  process.env.RBAC_TOKEN_TRUST = 'false'
  delete process.env.EXTERNAL_LOGIN_REALTIME_REVALIDATION_ENABLED
  admin = new Pool({ connectionString: databaseUrl, max: 3 })

  await admin.query('INSERT INTO meta_bases (id, name) VALUES ($1,$2)', [BASE_ID, 'Realtime wiring base'])
  await admin.query('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1,$2,$3)', [SHEET_ID, BASE_ID, 'Realtime wiring sheet'])
  await admin.query('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [F_OPEN, SHEET_ID, 'Open', 'string', '{}', 1])
  await admin.query('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [F_LOCKED, SHEET_ID, 'Locked', 'string', '{}', 2])
  restricted = await makeUser(RESTRICTED, ['multitable:write'])
  unrestricted = await makeUser(UNRESTRICTED, ['multitable:write'])
  reader = await makeUser(READER, ['multitable:read'])
  // F_LOCKED is read-only for the restricted user only.
  await admin.query(
    'INSERT INTO field_permissions (sheet_id, field_id, subject_type, subject_id, visible, read_only) VALUES ($1,$2,$3,$4,$5,$6)',
    [SHEET_ID, F_LOCKED, 'user', RESTRICTED, true, true],
  )

  server = new MetaSheetServer({ port: 0, host: '127.0.0.1' })
  await server.start()
  const address = server.getAddress()
  if (!address || !address.port) throw new Error('server did not listen')
  baseUrl = `http://127.0.0.1:${address.port}`
}, 120_000)

afterAll(async () => {
  if (process.env.EXPECT_DB !== '1') return
  for (const socket of clients) socket.close()
  if (server) await server.stop()
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  try {
    await admin.query('DELETE FROM field_permissions WHERE sheet_id = $1', [SHEET_ID])
    await admin.query('DELETE FROM meta_record_revisions WHERE sheet_id = $1', [SHEET_ID]).catch(() => undefined)
    await admin.query(`DELETE FROM meta_record_yjs_updates WHERE record_id LIKE $1`, [`rec_${RUN}_%`]).catch(() => undefined)
    await admin.query(`DELETE FROM meta_record_yjs_states WHERE record_id LIKE $1`, [`rec_${RUN}_%`]).catch(() => undefined)
    await admin.query('DELETE FROM meta_records WHERE sheet_id = $1', [SHEET_ID])
    await admin.query('DELETE FROM meta_fields WHERE sheet_id = $1', [SHEET_ID])
    await admin.query('DELETE FROM meta_sheets WHERE id = $1', [SHEET_ID])
    await admin.query('DELETE FROM meta_bases WHERE id = $1', [BASE_ID])
    await admin.query('DELETE FROM users WHERE id LIKE $1', [`${RUN}-%`])
  } finally {
    await admin.end()
  }
}, 60_000)

describeDb('realtime record editing through the server start-up code', () => {
  it('the server is running with realtime record editing on and realtime revalidation off', () => {
    expect(process.env.ENABLE_YJS_COLLAB).toBe('true')
    expect(process.env.EXTERNAL_LOGIN_REALTIME_REVALIDATION_ENABLED).toBeUndefined()
    expect(baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
  })

  it('a writer changes a field it may write: the other editor sees it and the record is written once', async () => {
    const recordId = await seedRecord('allowed')
    const a = await editor(unrestricted, recordId)
    const b = await editor(restricted, recordId)
    expect(a.text(F_OPEN)).toBe('open-before')
    write(a, recordId, F_OPEN, 'open-after')
    await until(() => b.text(F_OPEN) === 'open-after', 8000, 'the relayed change')
    await until(async () => (await stored(recordId)).data[F_OPEN] === 'open-after', 8000, 'the record write')
    const after = await stored(recordId)
    expect(after.data[F_LOCKED]).toBe('locked-before')
    expect(after.version).toBe(2)
    expect(a.errors).toEqual([])
    expect(a.invalidated).toEqual([])
  })

  it('a change to a field that is read-only for its sender is refused when it arrives: not shared, not written', async () => {
    const recordId = await seedRecord('refused')
    const sender = await editor(restricted, recordId)
    const other = await editor(unrestricted, recordId)
    write(sender, recordId, F_LOCKED, 'forbidden-write')
    await until(() => sender.errors.length === 1, 8000, 'the refusal')
    expect(sender.errors[0].code).toBe('FORBIDDEN')
    await new Promise((resolve) => setTimeout(resolve, 900))
    expect(other.text(F_LOCKED)).toBe('locked-before')
    expect(other.invalidated).toEqual([])
    const after = await stored(recordId)
    expect(after.data[F_LOCKED]).toBe('locked-before')
    expect(after.version).toBe(1)
    // The same field written by a user without the restriction lands.
    write(other, recordId, F_LOCKED, 'allowed-write')
    await until(async () => (await stored(recordId)).data[F_LOCKED] === 'allowed-write', 8000, 'the unrestricted write')
  })

  it('two users with different field permissions, each changing a field it may write, in one merge window: both are written in one record write', async () => {
    const recordId = await seedRecord('both')
    const a = await editor(restricted, recordId)
    const b = await editor(unrestricted, recordId)
    write(a, recordId, F_OPEN, 'by-restricted')
    write(b, recordId, F_LOCKED, 'by-unrestricted')
    await until(async () => {
      const row = await stored(recordId)
      return row.data[F_OPEN] === 'by-restricted' && row.data[F_LOCKED] === 'by-unrestricted'
    }, 8000, 'both record writes')
    expect((await stored(recordId)).version).toBe(2)
    expect(a.invalidated).toEqual([])
    expect(b.invalidated).toEqual([])
    expect(a.errors).toEqual([])
    expect(b.errors).toEqual([])
  })

  it('a user that may only read subscribes and reads, and its change is refused', async () => {
    const recordId = await seedRecord('reader')
    const viewer = await editor(reader, recordId)
    expect(viewer.text(F_OPEN)).toBe('open-before')
    write(viewer, recordId, F_OPEN, 'reader-write')
    await until(() => viewer.errors.length === 1, 8000, 'the refusal')
    expect(viewer.errors[0].code).toBe('FORBIDDEN')
    await new Promise((resolve) => setTimeout(resolve, 900))
    expect((await stored(recordId)).data[F_OPEN]).toBe('open-before')
  })

  it('a record that does not exist is answered as not found', async () => {
    const nobody = await editor(unrestricted, `rec_${RUN}_absent`, { expectError: true })
    expect(nobody.errors[0].code).toBe('NOT_FOUND')
  })
})
