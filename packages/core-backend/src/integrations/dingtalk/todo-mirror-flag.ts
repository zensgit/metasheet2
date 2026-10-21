/**
 * Feature gate for the DingTalk approval-todo ONE-WAY mirror (plan B).
 *
 * Design: docs/development/takeover-beiliao-20260821/dingtalk-todo-mirror-b-design-20260916.md §2.5/§7.
 *
 * DEFAULT OFF, exact literal 'true' after trim+lowercase — the same shape as the repo's other
 * default-OFF runtime flags (`isDurableDeliveryEnabled`, `isElearningFlagEnabled`). Registered in
 * `config/flags.ts` so `getEnabledFeatures()` can report it, but the RUNTIME gate is this function:
 * every gate site passes its own `env` so a test never has to mutate `process.env` globally.
 *
 * What OFF means (load-bearing, not cosmetic):
 *   - the durable consumer `dingtalk-todo-mirror` ACKs its outbox row and writes NOTHING (an ACK-less
 *     consumer would pile the outbox up forever; a writing consumer would build a shadow ledger for a
 *     feature nobody enabled);
 *   - the eventBus leg returns before any query;
 *   - `index.ts` never starts the delivery worker, so no row can ever be sent.
 * Deliberately NO import of anything (pure module): `config/flags.ts` imports it and must stay free of
 * the DingTalk client/worker import graph.
 */
export const DINGTALK_TODO_MIRROR_ENABLED = 'DINGTALK_TODO_MIRROR_ENABLED' as const

export function isDingTalkTodoMirrorEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return String(env[DINGTALK_TODO_MIRROR_ENABLED] ?? '').trim().toLowerCase() === 'true'
}
