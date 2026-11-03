/**
 * Values-free 500 envelope for the /api/admin router tree.
 *
 * The tree is what `initAdminRoutes()` returns and index.ts mounts at `/api/admin`: admin-routes.ts
 * itself plus the two sub-routers it mounts at its foot — snapshot-labels.ts (`/snapshots`) and
 * protection-rules.ts (`/safety/rules`). Every unhandled-failure (500) branch in those three files
 * answers through one of the two responders below; none of them serializes the caught value.
 *
 * SECURITY (ADM-05 follow-up, closing the residual #5903 left): #5903 redacted the 13 read-side GETs
 * of admin-routes.ts itself and kept everything else — the write-side branches of that file and
 * every branch of the two sub-routers — echoing `err.message`. The errors that reach those branches
 * are the same driver/infra errors: pg connection failures carry host, port, database and role in
 * their text (`connect ECONNREFUSED <host>:<port>`, `password authentication failed for user
 * "<role>"`), Redis and pool errors carry the same shape, and a stack-bearing Error from a subsystem
 * can carry absolute server paths. A platform admin is trusted — but the HTTP body is not the right
 * channel for it: it lands in browser devtools, in proxy and CDN access logs, in screenshots pasted
 * into issues, and in any ops dashboard that renders `error` verbatim. And one route in the tree,
 * `POST /health/check`, is deliberately ungated (a registered permanent exemption in
 * tests/unit/admin-routes-write-endpoints-structural-gate.test.ts), so its 500 body is readable by
 * any authenticated caller. The operator needs the detail; the wire does not carry it. So the
 * original error goes to logger.error() (message + stack, server side only) and the body carries a
 * stable machine-readable code plus a fixed human string.
 *
 * Shape note (unchanged from #5903): the body keeps `success: false` and keeps `error` a STRING.
 * util/response.ts's jsonError() emits `{ ok: false, error: { code, message } }`, a different
 * envelope from the `{ success, error }` one every route in this tree and every existing admin spec
 * reads, so reusing it would turn a redaction into a breaking response-shape change. `code` is added
 * alongside, which is additive for existing consumers. Status codes are unchanged: a 500 stays a 500.
 *
 * Read vs write: the code is chosen by the route's HTTP method — GET answers ADMIN_READ_FAILED
 * (the #5903 code, kept verbatim), every other method answers ADMIN_WRITE_FAILED.
 */
import type { Response } from 'express';

/** Stable code every GET in the /api/admin tree returns on its 500 branch (#5903, unchanged). */
export const ADMIN_READ_FAILED_CODE = 'ADMIN_READ_FAILED';

/** Fixed, values-free human string for a failed read. Carries no driver, host, path or identifier. */
export const ADMIN_READ_FAILED_MESSAGE = '读取失败，详情见服务端日志';

/** Stable code every non-GET route in the /api/admin tree returns on its 500 branch. */
export const ADMIN_WRITE_FAILED_CODE = 'ADMIN_WRITE_FAILED';

/** Fixed, values-free human string for a failed write. Carries no driver, host, path or identifier. */
export const ADMIN_WRITE_FAILED_MESSAGE = '操作失败，详情见服务端日志';

/** The one logger method the responders need; satisfied by core/logger.ts's Logger. */
export interface AdminFailureLogger {
  error(message: string, error?: Error): void;
}

/** Logged in place of a thrown value that cannot be read or turned into text at all. */
const UNRENDERABLE_THROWN_VALUE = 'thrown value could not be rendered as text';

/**
 * core/logger.ts's error() duck-reads `.message` and `.stack` off its second argument. Before this
 * envelope existed every site in the tree passed the caught value straight through (`error as Error`),
 * so the log already carried the detail of any error-LIKE value. This keeps that and adds the cases
 * the raw pass-through lost, all SERVER SIDE — the value returned here never reaches the response:
 *   - an Error of this realm is passed through unchanged;
 *   - an error-like object (a string `message` or `stack`: a plain `{ message }` rejection, an Error
 *     from another realm such as a `vm` context, where `instanceof Error` is false) keeps its own
 *     message, name and ORIGINAL stack (no stack when it had none) — never this module's frames, so
 *     the logger reads exactly what it read from the raw value before;
 *   - anything else (a string, a number, an object without a message) is rendered with String();
 *   - a value that cannot be read or rendered at all (`Object.create(null)`, a throwing `toString`
 *     or property getter, a revoked Proxy) yields a fixed placeholder instead of throwing.
 * This function never throws, so an odd thrown value can no longer stop a responder before it
 * reaches `res.status(500)` (the raw `String(error)` it replaces threw on `Object.create(null)`).
 */
function toLoggableError(error: unknown): Error {
  try {
    if (error instanceof Error) return error;
    if (error !== null && (typeof error === 'object' || typeof error === 'function')) {
      const { message, stack, name } = error as { message?: unknown; stack?: unknown; name?: unknown };
      if (typeof message === 'string' || typeof stack === 'string') {
        const wrapped = new Error(typeof message === 'string' ? message : '');
        if (typeof name === 'string') wrapped.name = name;
        // Its own stack, or none (as the direct pass-through logged it) — never this module's frames.
        wrapped.stack = typeof stack === 'string' ? stack : undefined;
        return wrapped;
      }
    }
    return new Error(String(error));
  } catch {
    return new Error(UNRENDERABLE_THROWN_VALUE);
  }
}

export interface AdminFailureResponders {
  /**
   * Log the real error server side, then send the redacted 500 for a GET.
   *
   * @param context  static log context (e.g. 'Failed to list protection rules'); log only
   * @param error    the caught value; its message/stack go to the log, never to the body
   * @param extra    NON-SENSITIVE fields the route already returned on its 500, taken from the
   *                 caller's own request path (e.g. `pluginId`). They cannot override `success`,
   *                 `code` or `error`: the fixed fields are written after them.
   */
  sendAdminReadFailure(res: Response, context: string, error: unknown, extra?: Record<string, unknown>): void;
  /** Same contract as sendAdminReadFailure, for POST / PUT / PATCH / DELETE routes. */
  sendAdminWriteFailure(res: Response, context: string, error: unknown, extra?: Record<string, unknown>): void;
}

/** Bind the two responders to a router's own logger, so the log context stays per-router. */
export function createAdminFailureResponders(logger: AdminFailureLogger): AdminFailureResponders {
  const send = (
    res: Response,
    code: string,
    message: string,
    context: string,
    error: unknown,
    extra?: Record<string, unknown>
  ): void => {
    logger.error(context, toLoggableError(error));
    res.status(500).json({
      ...(extra ?? {}),
      success: false,
      code,
      error: message
    });
  };

  return {
    sendAdminReadFailure: (res, context, error, extra) =>
      send(res, ADMIN_READ_FAILED_CODE, ADMIN_READ_FAILED_MESSAGE, context, error, extra),
    sendAdminWriteFailure: (res, context, error, extra) =>
      send(res, ADMIN_WRITE_FAILED_CODE, ADMIN_WRITE_FAILED_MESSAGE, context, error, extra)
  };
}
