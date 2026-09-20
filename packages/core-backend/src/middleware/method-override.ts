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
 *   - It never rewrites unless authentication already attached `req.user`. It is mounted AFTER the
 *     global JWT gate in index.ts, so an unauthenticated override is just an unauthenticated request
 *     (401 from the gate, handler never runs). The `req.user` condition is kept in the middleware
 *     itself rather than relying on mount order alone because the gate lets two shapes through
 *     WITHOUT setting `req.user`: whitelisted paths and the OAPI `mst_` method-bound allowlist
 *     (which admits specific POST (method, path) pairs for per-route apiTokenAuth). Neither may be
 *     turned into a DELETE by a header: the allowlist decision was made for a POST.
 *   - Such an UNHONOURED CLAIM is REFUSED (405), not passed through. A POST that asked to be a
 *     DELETE and did not become one would otherwise run the path's POST handler — see the receipt
 *     note below for why that is the dangerous case. Refusing closes it by construction on every
 *     gate-exception path; only this project's web client ever sends the header, and only for a
 *     delete it wants performed, so nothing legitimate is refused.
 *
 * `req.methodOverride = 'DELETE'` is set so audit/log hooks can record that the DELETE arrived through
 * the tunnel (values-free: the marker is the verb name only), and the RESPONSE carries
 * `X-Method-Overridden: DELETE` as a receipt.
 *
 * WHY THE RECEIPT HEADER EXISTS. Without it a client in override mode cannot distinguish "the server
 * rewrote my POST into the DELETE I meant" from "a proxy stripped my override header and a same-path
 * POST twin handled the request". That is not hypothetical: `DELETE /api/comments/:id/reactions`
 * (routes/comments.ts) has a POST twin on the SAME path that ADDS a reaction — the exact inversion of
 * the caller's intent, answered 2xx. The web client refuses any 2xx/3xx override response that does
 * not carry this receipt (apps/web/src/utils/delete-fallback.ts). It is set on the REQUEST path, before
 * `next()`, so it is present whatever the route then answers (200, 404, 500).
 *
 * WHAT THE RECEIPT DOES NOT DO. It is a DETECTION, not a prevention, for the one variant this server
 * cannot see: a hop that strips the REQUEST header. Then the POST arrives as an ordinary POST, the
 * twin handler runs and commits BEFORE any client-side check exists to run, and the receipt only
 * lets the client refuse the 2xx afterwards and latch 'override-unavailable'. The damage is bounded
 * to a single request per session and is surfaced to the user — it is not zero. The variant this
 * server CAN see (header present, rewrite not applied) is refused outright, see above.
 */
import type { NextFunction, Request, Response } from 'express'

export const METHOD_OVERRIDE_HEADER = 'x-http-method-override'
/** Response receipt: proof that THIS server performed the rewrite. */
export const METHOD_OVERRIDDEN_HEADER = 'X-Method-Overridden'

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

/**
 * The HEADER CLAIM alone: 'DELETE' when the override header carries exactly that value, whatever the
 * request method is and whether or not authentication has run. Used by the pre-auth request log,
 * which must not (and cannot) decide whether the rewrite will be applied. NEVER use this to gate a
 * rewrite — `resolveMethodOverride` is the decision.
 */
export function readMethodOverrideHeader(req: Pick<Request, 'headers'>): 'DELETE' | null {
  return headerValue(req.headers[METHOD_OVERRIDE_HEADER]) === 'DELETE' ? 'DELETE' : null
}

/** Pure decision, exported so the unit spec can pin the accept set without a server. */
export function resolveMethodOverride(req: Pick<Request, 'method' | 'headers' | 'user'>): 'DELETE' | null {
  if (req.method !== 'POST') return null
  if (!req.user) return null
  return readMethodOverrideHeader(req)
}

export function methodOverrideMiddleware(req: Request, res: Response, next: NextFunction): void {
  const override = resolveMethodOverride(req)
  if (override) {
    req.method = override
    req.methodOverride = override
    // Receipt, set before the route runs so it survives any status the route answers with.
    res.setHeader(METHOD_OVERRIDDEN_HEADER, override)
    next()
    return
  }
  // FAIL CLOSED on an UNHONOURED CLAIM. A POST that asks to be a DELETE and is NOT rewritten (the
  // only reason left here is "no `req.user`": a gate-whitelisted path or the OAPI `mst_`
  // method-bound allowlist) must not simply fall through — it would land on whatever POST handler
  // owns that path, and on several paths that POST does the OPPOSITE of the delete
  // (`POST /api/comments/:id/reactions` ADDS what the DELETE removes, 201). The client's receipt
  // check only DETECTS such an inversion afterwards; refusing here PREVENTS it by construction for
  // every gate-exception path. Nothing legitimate is refused: the only sender of this header is our
  // own web client, and it only sends it for a delete it wants performed.
  //
  // Scope, deliberately: POST only. A GET/PUT/PATCH carrying the header cannot be turned into a
  // wrong write by a POST twin, so those stay ignored (the request proceeds as the verb it is).
  if (req.method === 'POST' && readMethodOverrideHeader(req)) {
    res.status(405).json({
      ok: false,
      error: {
        code: 'METHOD_OVERRIDE_NOT_HONORED',
        message: 'This request asked to be handled as DELETE but the override was not applied.',
      },
    })
    return
  }
  next()
}
