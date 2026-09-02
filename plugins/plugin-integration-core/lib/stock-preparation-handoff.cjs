'use strict'

// 通知下一步 —— 备料多人接力的「轮到谁了」。
//
// WHAT THIS IS. On a real 备料 project several people each fill their OWN fields on the same prep
// rows, in an agreed order. The first one finishes and says "next"; the next person is told it is
// their turn; when the LAST one finishes, 仓库 and 采购 are told the project's material list is ready
// to export. Until this module existed the product had none of that: 「通知下一步」 was a zero-hit
// string in the codebase, there was no advance/notify route anywhere in the stock-prep family, and
// nothing recorded whose turn it was. People coordinated in a DingTalk chat and by walking over.
//
// WHAT THIS IS *NOT* — READ THIS BEFORE BUILDING ON IT.
//
//   1. IT IS NOT A PERMISSION MECHANISM. `currentStepKey` is a VISIBLE TURN SIGNAL and nothing more.
//      It does not, and must not be read as if it does, gate who may WRITE which column on a prep
//      row. Per-column write enforcement is a separate, deliberately deferred decision; today every
//      principal holding stock-prep:operate can write every operator-writable field regardless of
//      whose turn this module says it is. If a future change wants turn-based write enforcement it
//      must be built as an explicit guard on the write path and tested as one — silently treating
//      this field as if it already were that guard is the failure mode this paragraph exists to
//      prevent.
//
//   2. IT IS NOT AN APPROVAL GRAPH. Owner ruling: build the LIGHT version first, NOT a binding to
//      the full Approval engine, because the ordered sequence is not yet proven stable in real use
//      and cementing it into an approval graph now would be premature. So there are no nodes, no
//      epochs, no delegation, no rejection/return path, no parallel branches — one ordered list and
//      one cursor into it. When the order HAS proven stable, the migration path is to replace this
//      module with an approval template, not to grow branches here.
//
//   3. IT DOES NOT IMPERSONATE ANYONE. The terminal notice names the last approver IN ITS BODY and
//      is sent by the SYSTEM. It is not sent "as" them. The existing engine already dispatches
//      approval.completed from a system identity and explicitly bans start_approval on that trigger;
//      true send-as-a-person delegation needs DingTalk-side authorization and a security review, and
//      is out of scope here.
//
// TWO ALTERNATIVES THAT LOOK OBVIOUS AND ARE BOTH CLOSED. Recorded here so the next person does not
// spend the afternoon rediscovering them:
//
//   * "EMIT AN EVENT AND LET AN AUTOMATION RULE NOTIFY." There is nothing subscribed. The plugin's
//     write paths (refresh / apply / sync / confirm) emit NO automation events at all — which is
//     exactly why docs/development/general-prep-dept-collaboration-config-pack-20260722.md records
//     「批次刷新 → 自动通知采购/仓库」 as inexpressible today. An emitter here would publish into a
//     void that looks like success. So the route calls the DingTalk destination machinery DIRECTLY.
//     Building a general automation-event primitive is its own project and is not in this scope.
//
//   * "PUT THE TURN ON THE EXISTING DEPARTMENT COLUMNS." The frozen main template has exactly two
//     department-facing columns, `procurementReply` (采购回复) and `warehouseConfirmation` (仓库确认),
//     and both are `human_preserved` free text with no date, no actor and no done flag
//     (stock-preparation-templates.cjs). They are the humans' own notes. Overloading them would
//     destroy what people typed and still could not express an ordered cursor — see the store module
//     for why the turn lives in its own row instead.
//
// AND ONE THING THAT DOES NOT EXIST TO BUILD ON: there is no per-role WRITE enforcement anywhere in
// stock-prep. The three departments appear in code only as customer-pack `roleViews`, whose schema is
// fail-closed at four keys (viewId / label / hideOwnerships / hideFieldIds) — column HIDING only,
// structurally incapable of expressing a row filter or a write permission. That is the second reason
// the header above insists this module is a signal and not a guard: there is no guard here to join.
//
// VALUES DISCIPLINE. Nothing this module produces may carry a customer row VALUE. The notification
// bodies it composes are built from exactly three things: the business `projectNo` (a navigation
// handle, the same class the audit trail already carries in `project_id`), a step key drawn from
// the CLOSED vocabulary below plus its COMMITTED Chinese label from this file, and an actor
// identity. No material name, drawing number, specification or quantity is reachable from any of
// them — which is why the labels live here as committed constants rather than being taken from
// deploy config, where a customer's own wording could otherwise ride in. This follows the approval
// lane's precedent (packages/core-backend ApprovalTaskCreatedEvent.ts: metadata-only, "NO form
// values ride on the event"), not the record-triggered automation lane, which deliberately does
// render `{{record.*}}` values into DingTalk bodies.
//
// PURE. No I/O, no clock, no randomness. The durable half is stock-preparation-handoff-store.cjs;
// the wiring, the permission gate and the notification dispatch are in http-routes.cjs.

// ---------------------------------------------------------------------------
// The CLOSED step vocabulary.
//
// A deployment does not invent step names: it picks an ORDERED SUBSET of these keys. Same discipline
// as STOCK_PREP_AUDIT_ACTIONS (stock-preparation-audit-store.cjs) and for the same two reasons —
// the keys reach the values-free audit trail, where `detail` admits only enum-shaped ASCII strings
// (SAFE_STRING_PATTERN), and a closed set is what lets the front end translate every step it can
// ever be shown instead of falling back to a raw token.
//
// PROVISIONAL BY CONSTRUCTION. The owner ruling above says the real-world order is not yet proven,
// so this list is the set of roles the described flow actually names, and no more. Adding a key is a
// code change here plus a matching entry in the front end's plainLanguage.ts — cheap, deliberate,
// and reviewable, which is the point.
//
// 仓库 / 采购 ARE DELIBERATELY NOT STEPS, and getting this wrong would be a real modelling bug. The
// shape of the business is: an ORDERED RELAY among the upstream production fillers (this list), and
// then a TERMINAL FAN-OUT to the two departments TOGETHER — in parallel with each other, not one
// after the other. Making them the last two links of one serial chain would make 采购 wait on 仓库 (or
// the reverse) for no reason the business has. So they are `terminal.groupDestinationIds`, a SET
// notified in one hop, and the host notifier is required to keep one destination's failure from
// silencing the other.
//
// They also do not RE-ENTER data: much of what 采购 and 仓库 need is already in the production
// columns (材料类型 / 毛胚类型 / 毛胚尺寸 / 需求日期 / 提前周期). 采购 reads them to know what to buy
// and by when; 仓库 reads them to know what to prepare and when it is due. Which is precisely why the
// terminal message below is a POINTER ("these rows are ready, here is where they live") and never a
// summary of the values — see buildStockPreparationHandoffNotification.
//
// HOW THIS COMPOSES WITH THE PER-DEPARTMENT COMPLETION MARKERS (landing separately). A sibling change
// adds human-owned completion columns to the main template (采购完成 + 采购回复日期, 仓库完成 +
// 实际到货日期) — the machine-readable "this department has finished" signal that does not exist
// today. These are two DIFFERENT notions and must stay that way: this relay tracks WHOSE TURN IT IS
// among the upstream fillers and ends when the last one hands off; those columns record WHETHER A
// DOWNSTREAM DEPARTMENT IS DONE, per row, after the fan-out. Nothing here reads or writes them, on
// purpose — they may still move. When they land, the composition is "relay ends -> fan-out ->
// departments mark their own columns", not a third overlapping notion of done bolted onto this file.
// ---------------------------------------------------------------------------
const STOCK_PREP_HANDOFF_STEPS = Object.freeze([
  'prep_entry',
  'process',
  'planning',
  'technical',
  'production',
  'final_review',
])
const STEP_SET = new Set(STOCK_PREP_HANDOFF_STEPS)

// COMMITTED Chinese labels — see the values-discipline note above for why these are here and not in
// deploy config. The front end carries its own bilingual mirror in plainLanguage.ts for the screen;
// this copy exists because the NOTIFICATION BODY is composed server-side and must be readable by a
// person in DingTalk who never opens the workbench.
const STOCK_PREP_HANDOFF_STEP_LABELS = Object.freeze({
  prep_entry: '备料填写',
  process: '工艺',
  planning: '计划',
  technical: '技术',
  production: '生产',
  final_review: '终审',
})

// The ONE server-config key. Deliberately one key with no env fallback, the same posture as
// stock-preparation-customer-pack-catalog.cjs's CUSTOMER_PACK_CONFIG_KEY: an environment variable
// cannot carry an ordered step list with its handler rosters, and a half-configured chain must be an
// UNCONFIGURED one, never a partial one — a chain missing its last step would notify nobody at the
// exact moment the whole feature exists to notify someone.
const HANDOFF_CONFIG_KEY = 'stockPreparationHandoff'

class StockPreparationHandoffError extends Error {
  constructor(status, code, message, details = {}) {
    super(message)
    this.name = 'StockPreparationHandoffError'
    this.status = status
    this.code = code
    this.details = details
  }
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function optionalString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function stringList(value) {
  if (!Array.isArray(value)) return []
  const out = []
  for (const entry of value) {
    const normalized = optionalString(entry)
    if (normalized && !out.includes(normalized)) out.push(normalized)
  }
  return out
}

// The CLOSED key sets of the deploy-time config object. Same discipline as the routes' request-body
// allowlists: a key the parser does not know is a TYPO until proven otherwise, and the whole reason
// this config exists is that a typo here means nobody gets told anything.
const HANDOFF_TOP_LEVEL_KEYS = Object.freeze(['steps', 'notify', 'terminal'])
const STEP_KEYS = Object.freeze(['key', 'handlerUserIds'])
const NOTIFY_KEYS = Object.freeze(['groupDestinationId'])
const TERMINAL_KEYS = Object.freeze(['groupDestinationIds', 'exportPath'])

/** Refuse any key outside the closed set, naming the FIELD (never the value it carried). */
function assertNoUnknownKeys(object, allowed, prefix) {
  for (const key of Object.keys(object)) {
    if (allowed.includes(key)) continue
    const field = prefix ? `${prefix}.${key}` : key
    throw new StockPreparationHandoffError(
      500,
      'STOCK_PREPARATION_HANDOFF_CONFIG_INVALID',
      'handoff config carries a key this deployment does not understand — most likely a typo, and a typo here silences the whole chain',
      { field },
    )
  }
}

/** A config string that must be present and non-empty. Names the field; never echoes the value. */
function requiredConfigString(value, field) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new StockPreparationHandoffError(
      500,
      'STOCK_PREPARATION_HANDOFF_CONFIG_INVALID',
      `${field} must be a non-empty string`,
      { field },
    )
  }
  return value.trim()
}

/**
 * The committed Chinese label for a step key, or the key itself for anything outside the closed
 * vocabulary. Never throws: a label is display text, and a lookup miss must not be able to fail an
 * advance that has already been decided.
 */
function stockPreparationHandoffStepLabel(stepKey) {
  return STOCK_PREP_HANDOFF_STEP_LABELS[stepKey] || String(stepKey || '')
}

/**
 * Read the deploy-time chain out of server config.
 *
 * ABSENT CONFIG IS THE DEFAULT AND IS INERT. No key -> `{ configured: false, steps: [] }` -> the
 * status read reports `configured: false`, the advance route refuses with a named 501, no
 * notification can be composed and no row is ever written to the handoff table. A deployment that
 * never sets this key behaves EXACTLY as it did before this feature existed. That is asserted by a
 * deep-equal pin in the test suite, not merely asserted here in prose.
 *
 * MALFORMED CONFIG IS NOT INERT — IT THROWS. Same reason readDeployJsonObjectFile throws rather than
 * degrading (packages/core-backend plugin-runtime-config.ts): a typo must never be indistinguishable
 * from "nothing configured", because for a notification chain those two states differ by exactly
 * whether anyone gets told anything. The thrown error names the FIELD, never a value.
 *
 * WHICH MEANS THE PARSE IS STRICT, AND THAT IS THE WHOLE POINT OF THE PARAGRAPH ABOVE. The first cut
 * of this function read `notify` and `terminal` with `isPlainObject(x) ? x : {}` and then picked the
 * keys it wanted out of them, which quietly accepted every shape a real deployer actually gets wrong:
 *
 *   terminal: { groupDestinationId: 'x' }   (SINGULAR — the plural is the real key)
 *   terminal: 'x'                           (a bare id where an object belongs)
 *   notify:   { groupDestinationId: 42 }    (an id that is not a string)
 *   notifyy:  { … }                         (a misspelt top-level key)
 *
 * Every one of them parsed to "configured, but with no destinations", so the route burned its
 * at-most-once notification claim and answered `notifyOutcome: 'not_configured'` — the deployment
 * believed it had wired up 通知下一步 and nobody was ever told anything. That is precisely the state
 * the header paragraph promises cannot exist. So: UNKNOWN KEYS ARE REFUSED at all three levels (the
 * config object, `notify`, `terminal`), wrong TYPES are refused, and a destination that is present
 * must be non-empty.
 *
 * NOTIFICATIONS ARE ALL-OR-NOTHING, deliberately. Either the chain declares NEITHER `notify` NOR
 * `terminal` — the turn-state-only deployment, which is legitimate and stays legitimate: turn state
 * is useful on its own and every advance simply reports `notifyOutcome: 'not_configured'` — or it
 * declares BOTH, each non-empty. A chain with only one of them is the half-configured case this
 * module's HANDOFF_CONFIG_KEY note already refuses to tolerate: it would notify at some hops and
 * silently skip others, and the hop it skips is the one somebody is waiting on. The single exception
 * is a ONE-STEP chain, which has no mid-chain hop at all and therefore needs no `notify`.
 */
function parseStockPreparationHandoffConfig(config) {
  const raw = config && isPlainObject(config[HANDOFF_CONFIG_KEY]) ? config[HANDOFF_CONFIG_KEY] : null
  if (!raw) {
    return Object.freeze({
      configured: false,
      steps: Object.freeze([]),
      notifyGroupDestinationId: null,
      terminalGroupDestinationIds: Object.freeze([]),
      exportPath: null,
    })
  }

  if (!Array.isArray(raw.steps) || raw.steps.length === 0) {
    throw new StockPreparationHandoffError(
      500,
      'STOCK_PREPARATION_HANDOFF_CONFIG_INVALID',
      'handoff config must declare a non-empty ordered steps array',
      { field: 'steps' },
    )
  }

  const steps = []
  const seen = new Set()
  for (let index = 0; index < raw.steps.length; index += 1) {
    const entry = raw.steps[index]
    if (!isPlainObject(entry)) {
      throw new StockPreparationHandoffError(500, 'STOCK_PREPARATION_HANDOFF_CONFIG_INVALID', 'each step must be an object', { field: `steps[${index}]` })
    }
    assertNoUnknownKeys(entry, STEP_KEYS, `steps[${index}]`)
    const key = optionalString(entry.key)
    if (!key || !STEP_SET.has(key)) {
      // The offending value is a config token, not customer data, but the closed vocabulary is
      // small and public — naming the field is enough and keeps this error shaped like every other
      // one in the family.
      throw new StockPreparationHandoffError(500, 'STOCK_PREPARATION_HANDOFF_CONFIG_INVALID', 'step key is not in the closed handoff vocabulary', { field: `steps[${index}].key` })
    }
    if (seen.has(key)) {
      // A repeated step would make the cursor ambiguous: "advance from `process`" could mean either
      // occurrence, and the CAS below could never decide which. Refuse at parse time.
      throw new StockPreparationHandoffError(500, 'STOCK_PREPARATION_HANDOFF_CONFIG_INVALID', 'a step key may appear at most once in the chain', { field: `steps[${index}].key` })
    }
    seen.add(key)
    const handlerUserIds = stringList(entry.handlerUserIds)
    if (handlerUserIds.length === 0) {
      throw new StockPreparationHandoffError(500, 'STOCK_PREPARATION_HANDOFF_CONFIG_INVALID', 'each step must name at least one handler', { field: `steps[${index}].handlerUserIds` })
    }
    steps.push(Object.freeze({
      key,
      order: index,
      handlerUserIds: Object.freeze(handlerUserIds),
    }))
  }

  assertNoUnknownKeys(raw, HANDOFF_TOP_LEVEL_KEYS, null)

  const hasNotify = raw.notify !== undefined && raw.notify !== null
  const hasTerminal = raw.terminal !== undefined && raw.terminal !== null
  const singleStep = steps.length === 1

  // ALL-OR-NOTHING (see the doc comment): a chain that names one destination surface and forgets the
  // other notifies at some hops and silently skips others.
  if (hasNotify && !hasTerminal) {
    throw new StockPreparationHandoffError(500, 'STOCK_PREPARATION_HANDOFF_CONFIG_INVALID', 'a chain that configures notify must also configure terminal — a half-notified chain is the failure this key exists to prevent', { field: 'terminal' })
  }
  if (hasTerminal && !hasNotify && !singleStep) {
    throw new StockPreparationHandoffError(500, 'STOCK_PREPARATION_HANDOFF_CONFIG_INVALID', 'a multi-step chain that configures terminal must also configure notify — otherwise the mid-chain hops tell nobody', { field: 'notify' })
  }

  let notifyGroupDestinationId = null
  if (hasNotify) {
    if (!isPlainObject(raw.notify)) {
      throw new StockPreparationHandoffError(500, 'STOCK_PREPARATION_HANDOFF_CONFIG_INVALID', 'notify must be an object', { field: 'notify' })
    }
    assertNoUnknownKeys(raw.notify, NOTIFY_KEYS, 'notify')
    notifyGroupDestinationId = requiredConfigString(raw.notify.groupDestinationId, 'notify.groupDestinationId')
  }

  let terminalGroupDestinationIds = []
  let exportPath = null
  if (hasTerminal) {
    if (!isPlainObject(raw.terminal)) {
      throw new StockPreparationHandoffError(500, 'STOCK_PREPARATION_HANDOFF_CONFIG_INVALID', 'terminal must be an object', { field: 'terminal' })
    }
    assertNoUnknownKeys(raw.terminal, TERMINAL_KEYS, 'terminal')
    if (!Array.isArray(raw.terminal.groupDestinationIds)) {
      throw new StockPreparationHandoffError(500, 'STOCK_PREPARATION_HANDOFF_CONFIG_INVALID', 'terminal.groupDestinationIds must be an array of destination ids', { field: 'terminal.groupDestinationIds' })
    }
    for (const entry of raw.terminal.groupDestinationIds) {
      if (typeof entry !== 'string' || !entry.trim()) {
        throw new StockPreparationHandoffError(500, 'STOCK_PREPARATION_HANDOFF_CONFIG_INVALID', 'terminal.groupDestinationIds must contain non-empty strings', { field: 'terminal.groupDestinationIds' })
      }
    }
    terminalGroupDestinationIds = stringList(raw.terminal.groupDestinationIds)
    if (terminalGroupDestinationIds.length === 0) {
      // 仓库 and 采购 are the whole reason the terminal hop exists. An empty set here is a chain that
      // completes into silence at the exact moment the feature is supposed to speak.
      throw new StockPreparationHandoffError(500, 'STOCK_PREPARATION_HANDOFF_CONFIG_INVALID', 'terminal.groupDestinationIds must name at least one destination', { field: 'terminal.groupDestinationIds' })
    }
    if (raw.terminal.exportPath !== undefined && raw.terminal.exportPath !== null) {
      exportPath = requiredConfigString(raw.terminal.exportPath, 'terminal.exportPath')
    }
  }

  return Object.freeze({
    configured: true,
    steps: Object.freeze(steps),
    // OPTIONAL, but only in the ALL-OR-NOTHING sense above. A chain that declares neither `notify`
    // nor `terminal` still tracks whose turn it is — the turn state is useful on its own — and every
    // advance reports `notifyOutcome: 'not_configured'` instead of failing. What is NOT possible any
    // more is arriving in that state by TYPO.
    notifyGroupDestinationId,
    terminalGroupDestinationIds: Object.freeze(terminalGroupDestinationIds),
    exportPath,
  })
}

/**
 * Does this chain name a destination for the hop that completes `fromStepIndex`?
 *
 * The route asks BEFORE it claims the at-most-once notification: claiming a notification that has
 * no destination to go to would burn the claim and make the next click a replay, so a deployment
 * that later adds a destination would find that hop permanently unnotifiable. With the strict parse
 * above, "configured but empty" is only reachable for the turn-state-only chain — this predicate is
 * what keeps that chain's claim unspent rather than silently consumed.
 */
function chainHasDestinationForHop(chain, terminal) {
  if (!chain || !chain.configured) return false
  return terminal
    ? chain.terminalGroupDestinationIds.length > 0
    : Boolean(chain.notifyGroupDestinationId)
}

/** The values-free projection the status read returns: keys, order, and COUNTS — never a handler id. */
function projectHandoffSteps(chain) {
  return chain.steps.map((step) => ({
    key: step.key,
    order: step.order,
    handlerCount: step.handlerUserIds.length,
  }))
}

function findStepIndex(chain, stepKey) {
  if (!stepKey) return -1
  return chain.steps.findIndex((step) => step.key === stepKey)
}

/** Is this principal a configured handler of the step at `stepIndex`? Identity match only, no roles. */
function isHandlerOfStep(chain, stepIndex, actorId) {
  const step = chain.steps[stepIndex]
  if (!step) return false
  const actor = optionalString(actorId)
  if (!actor) return false
  return step.handlerUserIds.includes(actor)
}

/**
 * Decide what an advance request means, given the chain and the CURRENT persisted cursor.
 *
 * Returns one of:
 *   { decision: 'advance',  toStepIndex, terminal }  — the caller holds the current step; move on.
 *   { decision: 'replay' }                            — this exact transition already happened.
 *   throws STOCK_PREPARATION_HANDOFF_STEP_MISMATCH (409) — the cursor is somewhere else entirely.
 *
 * IDEMPOTENCY SEMANTICS, chosen deliberately and pinned by tests.
 *
 * The request names the step it is handing off FROM (`fromStepKey`), so the advance is a
 * compare-and-set rather than a blind increment. That makes a double click, a retried request and
 * two people racing all decidable without a client-supplied nonce:
 *
 *   cursor === fromIndex        -> a real advance.
 *   cursor === fromIndex + 1    -> the same transition, already applied. REPLAY: 200, `changed:
 *                                  false`, and NO notification. This is the double-click case, and
 *                                  answering it with an error would train people to ignore errors.
 *   anything else               -> 409. The chain is not where the caller thinks it is; refusing is
 *                                  the only safe answer, because "advance anyway" would silently
 *                                  skip or repeat somebody's step.
 *
 * AT-MOST-ONCE NOTIFICATION, and it is a real trade-off. `notifiedStepIndex` records that a
 * notification was DISPATCHED for a step, and it is stamped in the same transaction as the advance —
 * so a send that FAILS is not retried by clicking again (the second click is a replay). The
 * alternative, at-least-once, would let a flaky DingTalk turn one handoff into a stream of duplicate
 * pings at the exact moment people are already confused. The failure is instead reported honestly to
 * the operator (`notifyOutcome: 'failed'`, and the UI says the turn moved but the message did not go
 * out, so tell the next person yourself), which is a thing a human can act on.
 */
function planStockPreparationHandoffAdvance({ chain, currentStepIndex, fromStepKey, actorId } = {}) {
  if (!chain || !chain.configured) {
    throw new StockPreparationHandoffError(
      501,
      'STOCK_PREPARATION_HANDOFF_NOT_CONFIGURED',
      'this deployment has no stock-preparation handoff chain configured',
    )
  }
  const fromIndex = findStepIndex(chain, fromStepKey)
  if (fromIndex < 0) {
    throw new StockPreparationHandoffError(
      400,
      'STOCK_PREPARATION_HANDOFF_REQUEST_INVALID',
      'fromStepKey is not a step of this deployment\'s handoff chain',
      { field: 'fromStepKey' },
    )
  }
  const cursor = Number.isInteger(currentStepIndex) ? currentStepIndex : 0

  // THE TURN CHECK, AND IT COMES FIRST — BEFORE THE REPLAY SHORT-CIRCUIT. Note what it is and is
  // not: it refuses to let someone ADVANCE a step that is not theirs. It does not, and this module
  // must never be read as if it does, stop them writing the prep-row fields themselves (see the
  // header). Platform admins are not exempted here on purpose — an admin advancing someone else's
  // step would make the trail say a person handed off when they did not.
  //
  // IT IS THE `fromStepKey`'S ROSTER THAT IS CHECKED, NOT THE CURRENT CURSOR'S, which is exactly why
  // this can sit above the replay branch without breaking the double click it exists to serve: 张三,
  // clicking a second time on the step he already handed off, is still a configured handler OF THAT
  // STEP even though the cursor has moved past it. An earlier version put the replay return above
  // this check and justified it with "the person who already handed off is no longer the current
  // handler" — true of the cursor, false of the roster being consulted, and the cost of the mistake
  // was that ANY stock-prep:operate holder who was nobody's handler got a 200 and an audit row
  // reading "replayed" under their own identity for a handoff they had no part in.
  if (!isHandlerOfStep(chain, fromIndex, actorId)) {
    throw new StockPreparationHandoffError(
      403,
      'STOCK_PREPARATION_HANDOFF_NOT_CURRENT_HANDLER',
      'only a configured handler of the current step may hand it off',
    )
  }

  if (cursor === fromIndex + 1 || (fromIndex === chain.steps.length - 1 && cursor >= chain.steps.length)) {
    // Replay of the transition this request describes: 200, `changed: false`, no notification.
    return { decision: 'replay', fromStepIndex: fromIndex, toStepIndex: fromIndex + 1 }
  }
  if (cursor !== fromIndex) {
    // THE PLANNER'S OWN COMPARE. It is not redundant with the store's compare-and-set even though
    // both answer STEP_MISMATCH: this one refuses BEFORE any durable write is attempted, which is
    // what keeps a stale click out of the audit trail entirely, while the store's is the racing
    // writer's last line of defence. Deleting either one must red a test — see the suite's
    // planner-level and store-level mismatch witnesses, which exercise them separately.
    throw new StockPreparationHandoffError(
      409,
      'STOCK_PREPARATION_HANDOFF_STEP_MISMATCH',
      'the handoff chain is no longer at that step',
      { field: 'fromStepKey' },
    )
  }
  return {
    decision: 'advance',
    fromStepIndex: fromIndex,
    toStepIndex: fromIndex + 1,
    terminal: fromIndex === chain.steps.length - 1,
  }
}

const NOTIFICATION_TITLE = '备料接力'

/**
 * Compose the notification for a completed step. VALUES-FREE — see the module header for the exact
 * three ingredients admitted, and stock-preparation-handoff.test.cjs for the canary that proves a
 * seeded material name can never appear in one of these bodies.
 *
 * Two shapes, because the two audiences need different sentences:
 *   - a mid-chain handoff tells the NEXT step's people it is their turn;
 *   - the terminal handoff tells 仓库/采购 (BOTH, in one fan-out, never one-then-the-other) the
 *     project is ready, NAMES the approver who finished it (the relaxed form of "in the name of the
 *     last approver" — the system sends it, the body says who), and points at where the data lives.
 *
 * THE TERMINAL MESSAGE IS A POINTER, NOT A SUMMARY, and that is a deliberate content decision rather
 * than an oversight. What 采购 and 仓库 actually need is already in the production columns (材料类型 /
 * 毛胚类型 / 毛胚尺寸 / 需求日期 / 提前周期) and their job is to LAND ON THOSE ROWS. Summarising them
 * into a chat message would (a) breach the values discipline this module is built around, (b) go
 * stale the moment anyone edits a row, and (c) be truncated by DingTalk long before a real project's
 * material list fitted. So the body carries `exportPath` and nothing else about the data.
 */
function buildStockPreparationHandoffNotification({ chain, projectNo, fromStepIndex, actorLabel, terminal } = {}) {
  const project = optionalString(projectNo) || ''
  const fromStep = chain.steps[fromStepIndex]
  const fromLabel = stockPreparationHandoffStepLabel(fromStep && fromStep.key)
  const actor = optionalString(actorLabel) || '未知账号'

  if (terminal) {
    const lines = [
      `项目 ${project} 的备料接力已全部完成。`,
      `最后一步「${fromLabel}」由 ${actor} 完成。`,
      '请仓库和采购按项目导出物料清单。',
    ]
    if (chain.exportPath) lines.push(`导出入口:${chain.exportPath}`)
    // 这条通知由系统发出,不是以任何人的身份代发 —— 完成人写在正文里。
    lines.push('(本条由系统发送)')
    return {
      title: `${NOTIFICATION_TITLE}·完成`,
      body: lines.join('\n'),
      destinationIds: chain.terminalGroupDestinationIds.slice(),
      kind: 'terminal',
    }
  }

  const nextStep = chain.steps[fromStepIndex + 1]
  const nextLabel = stockPreparationHandoffStepLabel(nextStep && nextStep.key)
  return {
    title: `${NOTIFICATION_TITLE}·下一步`,
    body: [
      `项目 ${project}:「${fromLabel}」已由 ${actor} 完成。`,
      `现在轮到「${nextLabel}」。`,
      '(本条由系统发送)',
    ].join('\n'),
    destinationIds: chain.notifyGroupDestinationId ? [chain.notifyGroupDestinationId] : [],
    kind: 'next',
  }
}

module.exports = {
  HANDOFF_CONFIG_KEY,
  STOCK_PREP_HANDOFF_STEPS,
  STOCK_PREP_HANDOFF_STEP_LABELS,
  StockPreparationHandoffError,
  parseStockPreparationHandoffConfig,
  planStockPreparationHandoffAdvance,
  buildStockPreparationHandoffNotification,
  chainHasDestinationForHop,
  projectHandoffSteps,
  findStepIndex,
  isHandlerOfStep,
  stockPreparationHandoffStepLabel,
}
