/**
 * DELETE method-override middleware (customer egress drops HTTP DELETE, 2026-09-14 field incident).
 *
 * A customer's outbound network silently drops every HTTP DELETE (zero DELETE reached the server
 * since 09-14; GET/POST/PATCH arrive), so deleting sheets/records/templates showed "无法连接服务器
 * （未收到任何响应）". The web client falls back to `POST` + `X-HTTP-Method-Override: DELETE`; this
 * middleware rewrites such a request back into the DELETE the routers already implement.
 *
 * Acceptance is deliberately narrow:
 *   - ONLY `POST` carrying an override header whose value is exactly `DELETE` (case-insensitive) is
 *     rewritten. Any other value (PUT/PATCH/GET/garbage) is ignored and the request proceeds as the
 *     plain POST it is — a tunnel for every verb would let a caller reach PUT/PATCH handlers through a
 *     POST-shaped request and bypass any method-bound allowlist upstream.
 *   - A non-POST request with the header is ignored (a GET cannot become a DELETE).
 *   - It is a NO-OP unless authentication already attached `req.user`. It is mounted AFTER the global
 *     JWT gate in index.ts, so an unauthenticated override is just an unauthenticated request (401
 *     from the gate, handler never runs). The `req.user` condition is kept in the middleware itself
 *     rather than relying on mount order alone because the gate lets two shapes through WITHOUT
 *     setting `req.user`: whitelisted paths and the OAPI `mst_` method-bound allowlist (which admits
 *     specific POST (method, path) pairs for per-route apiTokenAuth). Neither may be turned into a
 *     DELETE by a header: the allowlist decision was made for a POST.
 *
 * `req.methodOverride = 'DELETE'` is set so audit/log hooks can record that the DELETE arrived through
 * the tunnel (values-free: the marker is the verb name only).
 */
import type { NextFunction, Request, Response } from 'express'

export const METHOD_OVERRIDE_HEADER = 'x-http-method-override'

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** Set to 'DELETE' when the request arrived as POST + X-HTTP-Method-Override: DELETE. */
      methodOverride?: 'DELETE'
    }
  }
}

function headerValue(raw: unknown): string {
  if (Array.isArray(raw)) return headerValue(raw[0])
  return typeof raw === 'string' ? raw.trim().toUpperCase() : ''
}

/** Pure decision, exported so the unit spec can pin the accept set without a server. */
export function resolveMethodOverride(req: Pick<Request, 'method' | 'headers' | 'user'>): 'DELETE' | null {
  if (req.method !== 'POST') return null
  if (!req.user) return null
  const value = headerValue(req.headers[METHOD_OVERRIDE_HEADER])
  return value === 'DELETE' ? 'DELETE' : null
}

export function methodOverrideMiddleware(req: Request, _res: Response, next: NextFunction): void {
  const override = resolveMethodOverride(req)
  if (override) {
    req.method = override
    req.methodOverride = override
  }
  next()
}
