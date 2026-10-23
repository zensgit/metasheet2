/**
 * Method-override middleware.
 *
 * DELETE (customer egress drops HTTP DELETE, 2026-09-14 field incident). A customer's outbound
 * network silently drops every HTTP DELETE (zero DELETE reached the server since 09-14; GET/POST/PATCH
 * arrived), so deleting sheets/records/templates showed "无法连接服务器（未收到任何响应）". The web
 * client falls back to `POST` + `X-HTTP-Method-Override: DELETE`; this middleware rewrites that request
 * back into the DELETE the routers already implement.
 *
 * PUT and PATCH (QA attendance shift update, 2026-10-23). On the QA host, a browser at 10.10.52.13
 * could list (GET) and create (POST) shifts, but edit (PUT /api/attendance/shifts/:id) surfaced the
 * same "无法连接服务器，未收到任何响应". The server log for that window had zero PUT, PATCH, or OPTIONS
 * for that path, while GET and POST from the same client arrived. Probes that did not traverse the
 * client path reached the backend with PUT. The same tunnel now also accepts `PUT` and `PATCH`, so a
 * browser that can only POST still runs the existing update handler. DELETE behaviour is unchanged.
 *
 * Acceptance stays narrow:
 *   - ONLY `POST` carrying an override header whose value is exactly `DELETE`, `PUT`, or `PATCH`
 *     (case-insensitive, trimmed) is rewritten. Any other value (GET/POST/OPTIONS/garbage) is an
 *     invalid claim and is REFUSED (405), not passed through as the POST — a fall-through would run
 *     the path's POST handler, which on several paths does the opposite of the caller's intent.
 *   - A non-POST request with the header is ignored (a GET cannot become a PUT).
 *   - It never rewrites unless authentication already attached `req.user`. It is mounted AFTER the
 *     global JWT gate in index.ts, so an unauthenticated override is just an unauthenticated request
 *     (401 from the gate, handler never runs). The `req.user` condition is kept in the middleware
 *     itself rather than relying on mount order alone because the gate lets two shapes through
 *     WITHOUT setting `req.user`: whitelisted paths and the OAPI `mst_` method-bound allowlist
 *     (which admits specific POST (method, path) pairs for per-route apiTokenAuth). Neither may be
 *     turned into another verb by a header: the allowlist decision was made for a POST.
 *   - Such an UNHONOURED CLAIM is REFUSED (405), not passed through. A POST that asked to be a
 *     DELETE/PUT/PATCH and did not become one would otherwise run the path's POST handler — see the
 *     receipt note below for why that is the dangerous case. Refusing closes it by construction on
 *     every gate-exception path; only this project's web client ever sends the header, and only for
 *     a write it wants performed, so nothing legitimate is refused.
 *
 * `req.methodOverride` is set to the honoured verb so audit/log hooks can record that the write
 * arrived through the tunnel (values-free: the marker is the verb name only), and the RESPONSE carries
 * `X-Method-Overridden: <VERB>` as a receipt.
 *
 * WHY THE RECEIPT HEADER EXISTS. Without it a client in override mode cannot distinguish "the server
 * rewrote my POST into the verb I meant" from "a proxy stripped my override header and a same-path
 * POST twin handled the request". That is not hypothetical: `DELETE /api/comments/:id/reactions`
 * (routes/comments.ts) has a POST twin on the SAME path that ADDS a reaction — the exact inversion of
 * the caller's intent, answered 2xx. The web client refuses any 2xx/3xx override response that does
 * not carry this receipt (apps/web/src/utils/delete-fallback.ts). It is set on the REQUEST path, before
 * `next()`, so it is present whatever the route then answers (200, 400, 404, 500) — including a shift
 * update whose body fails the existing PUT validation.
 *
 * WHAT THE RECEIPT DOES NOT DO. It is a DETECTION, not a prevention, for the one variant this server
 * cannot see: a hop that strips the REQUEST header. Then the POST arrives as an ordinary POST, the
 * twin handler runs and commits BEFORE any client-side check exists to run, and the receipt only
 * lets the client refuse the 2xx afterwards and latch 'override-unavailable'. The damage is bounded
 * to a single request per session and is surfaced to the user — it is not zero. The variant this
 * server CAN see (header present, rewrite not applied) is refused outright, see above.
 */
import type { NextFunction, Request, Response } from 'express'
import { Logger } from '../core/logger'

/**
 * VALUES-FREE BY CONSTRUCTION: every line below logs the VERB NAMES and the request path only —
 * never the header's raw text, never a token, never a body. The path is already logged for every
 * request by the pre-auth request logger in index.ts, so this adds no new exposure; what it adds is
 * the one fact that logger cannot carry (its text and shape are pinned by the e-learning pipeline
 * anchor and by the attendance W6 `this`-census): whether an override claim arrived and whether it
 * was HONOURED. That is exactly what a customer-network diagnosis needs — a hop that strips the
 * header leaves no 'honoured' line at all.
 */
const logger = new Logger('MethodOverride')

export const METHOD_OVERRIDE_HEADER = 'x-http-method-override'
/** Response receipt: proof that THIS server performed the rewrite. */
export const METHOD_OVERRIDDEN_HEADER = 'X-Method-Overridden'

/** Verbs a POST may be rewritten into. OPTIONS/GET/POST/HEAD stay refused: they are not writes. */
export const METHOD_OVERRIDE_VERBS = ['DELETE', 'PUT', 'PATCH'] as const
export type MethodOverrideVerb = (typeof METHOD_OVERRIDE_VERBS)[number]

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /**
       * Set to the honoured verb when the request arrived as POST + X-HTTP-Method-Override.
       * Values-free: one of DELETE, PUT, PATCH.
       */
      methodOverride?: MethodOverrideVerb
    }
  }
}

function headerValue(raw: unknown): string {
  if (Array.isArray(raw)) return headerValue(raw[0])
  return typeof raw === 'string' ? raw.trim().toUpperCase() : ''
}

function isMethodOverrideVerb(value: string): value is MethodOverrideVerb {
  return (METHOD_OVERRIDE_VERBS as readonly string[]).includes(value)
}

/**
 * The HEADER CLAIM alone: the verb when the override header carries exactly DELETE, PUT, or PATCH,
 * whatever the request method is and whether or not authentication has run. Reports what the sender
 * ASKED for, never whether the rewrite will be applied. NEVER use this to gate a rewrite —
 * `resolveMethodOverride` is the decision. An unsupported value is `null` here; the middleware still
 * refuses the POST so it cannot fall through to a POST twin.
 */
export function readMethodOverrideHeader(req: Pick<Request, 'headers'>): MethodOverrideVerb | null {
  const value = headerValue(req.headers[METHOD_OVERRIDE_HEADER])
  return isMethodOverrideVerb(value) ? value : null
}

/** True when the override header is present and non-empty, including unsupported values. */
export function hasMethodOverrideClaim(req: Pick<Request, 'headers'>): boolean {
  return headerValue(req.headers[METHOD_OVERRIDE_HEADER]).length > 0
}

/** Pure decision, exported so the unit spec can pin the accept set without a server. */
export function resolveMethodOverride(req: Pick<Request, 'method' | 'headers' | 'user'>): MethodOverrideVerb | null {
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
    logger.info(`method-override HONOURED: POST -> ${override} ${req.path}`)
    next()
    return
  }
  // FAIL CLOSED on an UNHONOURED CLAIM. A POST that asks to be rewritten and is NOT (no `req.user`,
  // or a verb outside DELETE/PUT/PATCH) must not simply fall through — it would land on whatever
  // POST handler owns that path, and on several paths that POST does the OPPOSITE of the requested
  // write (`POST /api/comments/:id/reactions` ADDS what the DELETE removes, 201). The client's
  // receipt check only DETECTS such an inversion afterwards; refusing here PREVENTS it by
  // construction for every gate-exception path. Nothing legitimate is refused: the only sender of
  // this header is our own web client, and it only sends a supported verb for a write it wants
  // performed.
  //
  // Scope, deliberately: POST only. A GET/PUT/PATCH carrying the header cannot be turned into a
  // wrong write by a POST twin, so those stay ignored (the request proceeds as the verb it is).
  // The log names the reason, never the header's raw text (values-free: a garbage claim can carry
  // anything, and a supported verb is already one of three literals).
  if (req.method === 'POST' && hasMethodOverrideClaim(req)) {
    const supported = readMethodOverrideHeader(req)
    const reason = supported ? 'claim not honoured, no req.user' : 'claim not a supported verb'
    logger.warn(`method-override REFUSED (${reason}): POST ${req.path}`)
    res.status(405).json({
      ok: false,
      error: {
        code: 'METHOD_OVERRIDE_NOT_HONORED',
        message: supported
          ? `This request asked to be handled as ${supported} but the override was not applied.`
          : 'This request asked for an HTTP method override that is not supported.',
      },
    })
    return
  }
  next()
}
