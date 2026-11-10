/**
 * Synthetic WeCom tenants and a recording `fetchFn` stub. Values are fabricated; nothing here
 * reaches a network. The stub records the method exactly as passed (undefined when the caller
 * passed none), origin, path, headers, body and query with `access_token`, `corpsecret` and `code`
 * masked, and keeps the abort signal of each request.
 */

export const WECOM_FIXTURE_CORP_ID = 'wwfixturecorp0001'
export const WECOM_FIXTURE_SECRET = 'fixture-secret-alpha'
export const WECOM_FIXTURE_AGENT_ID = '1000002'
export const WECOM_FIXTURE_TOKEN = 'fixture-access-token-1'

export type WeComStubReply =
  | { kind: 'json'; body: unknown; status: number }
  | { kind: 'raw'; text: string; status: number }
  | { kind: 'throw'; error: unknown }
  | { kind: 'bodyError'; error: unknown; status: number }
  /** Headers arrive, then the body stream errors with the request's abort reason once the signal fires. */
  | { kind: 'stalledBody'; status: number }

export type WeComStubResponder = WeComStubReply | ((call: number) => WeComStubReply)

export const ok = (body: unknown): WeComStubReply => ({ kind: 'json', body, status: 200 })
export const httpStatus = (status: number, body: unknown = {}): WeComStubReply => ({ kind: 'json', body, status })
export const rawBody = (text: string, status = 200): WeComStubReply => ({ kind: 'raw', text, status })
export const failWith = (error: unknown): WeComStubReply => ({ kind: 'throw', error })
export const bodyFailWith = (error: unknown, status = 200): WeComStubReply => ({ kind: 'bodyError', error, status })
export const stalledBody = (status = 200): WeComStubReply => ({ kind: 'stalledBody', status })
export const errcodeReply = (errcode: number, errmsg = 'provider-text-that-must-not-leak'): WeComStubReply =>
  ok({ errcode, errmsg })

export function abortError(): Error {
  const error = new Error('aborted')
  error.name = 'TimeoutError'
  return error
}

export interface RecordedRequest {
  /** As passed to `fetch`; `undefined` when the caller passed none. */
  method: string | undefined
  route: 'gettoken' | 'agent' | 'departments' | 'users' | 'other'
  origin: string
  path: string
  query: Record<string, string>
  headers: Record<string, string>
  body: unknown
  signal: AbortSignal | undefined
}

const MASKED_QUERY_KEYS = new Set(['access_token', 'corpsecret', 'code'])

function routeOf(pathname: string): RecordedRequest['route'] {
  if (pathname === '/cgi-bin/gettoken') return 'gettoken'
  if (pathname === '/cgi-bin/agent/get') return 'agent'
  if (pathname === '/cgi-bin/department/list') return 'departments'
  if (pathname === '/cgi-bin/user/list') return 'users'
  return 'other'
}

export interface WeComStubSpec {
  token?: WeComStubResponder
  agent?: WeComStubResponder
  departments?: WeComStubResponder
  /** One responder for every department, or one per department id. */
  users?: WeComStubResponder | Record<string, WeComStubResponder>
  /** Runs for every request before the reply is produced (clock advance, ordering probes). */
  onRequest?: (request: RecordedRequest) => void
}

export interface WeComFetchStub {
  fetchFn: typeof fetch
  requests: RecordedRequest[]
  count(route: RecordedRequest['route']): number
  pathsOf(route: RecordedRequest['route']): string[]
}

function isResponderMap(value: WeComStubSpec['users']): value is Record<string, WeComStubResponder> {
  return typeof value === 'object' && value !== null && !('kind' in value)
}

export function createWeComFetchStub(spec: WeComStubSpec): WeComFetchStub {
  const requests: RecordedRequest[] = []
  const calls = new Map<string, number>()

  const resolve = (key: string, responder: WeComStubResponder | undefined): WeComStubReply => {
    if (responder === undefined) throw new Error(`fixture stub: no responder for ${key}`)
    const call = (calls.get(key) ?? 0) + 1
    calls.set(key, call)
    return typeof responder === 'function' ? responder(call) : responder
  }

  const fetchFn = (async (input: unknown, init?: RequestInit) => {
    const url = new URL(String(input))
    const query: Record<string, string> = {}
    for (const [key, value] of url.searchParams) query[key] = MASKED_QUERY_KEYS.has(key) ? '***' : value
    const route = routeOf(url.pathname)
    const request: RecordedRequest = {
      method: init?.method,
      route,
      origin: url.origin,
      path: url.pathname,
      query,
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body: init?.body,
      signal: init?.signal ?? undefined,
    }
    requests.push(request)
    spec.onRequest?.(request)

    let reply: WeComStubReply
    if (route === 'gettoken') {
      reply = resolve('gettoken', spec.token ?? ok({ errcode: 0, errmsg: 'ok', access_token: WECOM_FIXTURE_TOKEN, expires_in: 7200 }))
    } else if (route === 'agent') {
      reply = resolve('agent', spec.agent)
    } else if (route === 'departments') {
      reply = resolve('departments', spec.departments)
    } else if (route === 'users') {
      const departmentId = url.searchParams.get('department_id') ?? ''
      const responder = isResponderMap(spec.users) ? spec.users[departmentId] : spec.users
      reply = resolve(`users:${departmentId}`, responder)
    } else {
      throw new Error(`fixture stub: unexpected path ${url.pathname}`)
    }

    if (reply.kind === 'throw') throw reply.error
    if (reply.kind === 'bodyError') {
      const response = new Response('{}', { status: reply.status })
      Object.defineProperty(response, 'json', { value: async () => { throw reply.error } })
      return response
    }
    if (reply.kind === 'stalledBody') {
      const signal = init?.signal
      const body = new ReadableStream({
        start(controller) {
          const fail = () => controller.error(signal?.reason)
          if (signal?.aborted) fail()
          else signal?.addEventListener('abort', fail, { once: true })
        },
      })
      return new Response(body, { status: reply.status })
    }
    if (reply.kind === 'raw') return new Response(reply.text, { status: reply.status })
    return new Response(JSON.stringify(reply.body), { status: reply.status, headers: { 'content-type': 'application/json' } })
  }) as unknown as typeof fetch

  return {
    fetchFn,
    requests,
    count: (route) => requests.filter((request) => request.route === route).length,
    pathsOf: (route) => requests.filter((request) => request.route === route).map((request) => request.query.department_id ?? request.path),
  }
}

// ── Payload builders ─────────────────────────────────────────────────────────────────────────────

export interface AgentOptions {
  agentid?: unknown
  close?: unknown
  parties?: unknown[]
  users?: unknown[]
  tags?: unknown[]
  extra?: Record<string, unknown>
}

export function agentPayload(options: AgentOptions = {}): Record<string, unknown> {
  return {
    errcode: 0,
    errmsg: 'ok',
    agentid: options.agentid ?? Number(WECOM_FIXTURE_AGENT_ID),
    name: 'fixture app',
    close: options.close ?? 0,
    redirect_domain: 'fixture.example.test',
    allow_userinfos: { user: options.users ?? [] },
    allow_partys: { partyid: options.parties ?? [1] },
    allow_tags: { tagid: options.tags ?? [] },
    ...(options.extra ?? {}),
  }
}

export function departmentsPayload(departments: unknown[]): Record<string, unknown> {
  return { errcode: 0, errmsg: 'ok', department: departments }
}

export function usersPayload(userlist: unknown): Record<string, unknown> {
  return { errcode: 0, errmsg: 'ok', userlist }
}

export const dept = (id: number, parentid: number, name = `dept-${id}`, order?: number): Record<string, unknown> => ({
  id,
  name,
  parentid,
  ...(order === undefined ? {} : { order }),
})

export const person = (userid: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  userid,
  name: `name-${userid}`,
  status: 1,
  ...extra,
})

/** The post-2022-06-20 baseline: a real root, three departments, six members, no contact keys. */
export function baselineSpec(): Required<Pick<WeComStubSpec, 'agent' | 'departments'>> & { users: Record<string, WeComStubResponder> } {
  return {
    agent: ok(agentPayload()),
    departments: ok(
      departmentsPayload([dept(1, 0, 'Root Co', 100000000), dept(2, 1, 'Sales', 10), dept(3, 1, 'Support', 5), dept(4, 2, 'Sales East', 1)]),
    ),
    users: {
      '1': ok(usersPayload([person('Root.Admin', { name: 'Root Admin', department: [1], main_department: 1, position: 'Admin', order: [0], is_leader_in_dept: [1] })])),
      '2': ok(
        usersPayload([
          person('alice', { name: 'Alice', department: [2, 4], main_department: 4, position: 'Rep', order: [1, 2], is_leader_in_dept: [0, 1], avatar: 'https://img.example.test/a.png' }),
          person('bob', { name: 'Bob', department: [2], main_department: 2, order: [0], is_leader_in_dept: [0] }),
        ]),
      ),
      '3': ok(
        usersPayload([
          person('carol', { name: 'Carol', department: [3], main_department: 3, order: [0], is_leader_in_dept: [0] }),
          person('erin', { name: 'Erin', department: [3, 2], order: [0, 0], is_leader_in_dept: [0, 0] }),
        ]),
      ),
      '4': ok(
        usersPayload([
          person('alice', { name: 'Alice', department: [2, 4], main_department: 4, position: 'Rep', order: [1, 2], is_leader_in_dept: [0, 1] }),
          person('dave', { name: 'Dave', department: [4], main_department: 4, status: 4, order: [0], is_leader_in_dept: [0] }),
        ]),
      ),
    },
  }
}
