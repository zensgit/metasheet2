/**
 * UAT §0-a: the corp-anchor record must actually REACH THE TRANSPORT — not merely be "called".
 *
 * The instrument is `logger.info`, and `Logger` reads its level AT CONSTRUCTION
 * (`core/logger.ts`: `level: process.env.LOG_LEVEL || 'info'`). On a box started with `LOG_LEVEL=warn`
 * — which `scripts/dev-optimized-start.sh` does by default — winston DROPS the record silently.
 *
 * The sibling real-DB test asserts the values-free contract by spying `Logger.prototype.info`. That spy
 * fires even when winston has suppressed the line, so it proves the METHOD was called with safe
 * arguments — it CANNOT prove the record was emitted, and so cannot detect a level-suppressed
 * instrument. (The integration harness pins `LOG_LEVEL='error'`, so the record really is suppressed
 * there and the spy passes anyway.)
 *
 * The gap is operationally sharp: a silent instrument makes "the log shows nothing" mean BOTH "the real
 * frame carries no corp anchor → close the flag" AND "your log level ate it → change nothing". That is
 * the exact ambiguity §0-a exists to destroy.
 *
 * So this pins the level gate at the TRANSPORT: Console.prototype.log is winston's write entry point and
 * runs only if the level passes. The emission case is the POSITIVE CONTROL — without it the suppression
 * case below would pass vacuously against a broken capture (which is exactly what the first draft of
 * this file did).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import winston from 'winston'

const ANCHOR_MSG = 'DingTalk interactive-card callback corp anchor'

describe('UAT §0-a: the corp-anchor record survives the winston level gate', () => {
  const originalLevel = process.env.LOG_LEVEL
  let transportLog: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    // Console.prototype.log is only reached when the configured level admits the record.
    transportLog = vi.spyOn(winston.transports.Console.prototype, 'log' as never).mockImplementation(
      ((_info: unknown, next?: () => void) => { if (typeof next === 'function') next() }) as never,
    )
  })

  afterEach(() => {
    transportLog.mockRestore()
    if (originalLevel === undefined) delete process.env.LOG_LEVEL
    else process.env.LOG_LEVEL = originalLevel
    vi.resetModules()
  })

  const emitAnchor = async (level: string): Promise<Array<Record<string, unknown>>> => {
    process.env.LOG_LEVEL = level
    vi.resetModules()
    const { Logger } = await import('../../src/core/logger')
    const logger = new Logger('DingTalkInteractiveCardCallback')
    logger.info(ANCHOR_MSG, {
      deliveryId: 'd-0a',
      headerEventCorpIdPresent: true,
      bodyCorpIdPresent: false,
    })
    return transportLog.mock.calls.map((c) => c[0] as Record<string, unknown>)
  }

  it('POSITIVE CONTROL — at LOG_LEVEL=info the record REACHES the transport, with the presence booleans and no corp value', async () => {
    const emitted = await emitAnchor('info')
    const anchor = emitted.find((i) => i.message === ANCHOR_MSG)

    expect(anchor).toBeDefined()
    expect(anchor).toMatchObject({ headerEventCorpIdPresent: true, bodyCorpIdPresent: false })
    // The instrument must never become an exfiltration channel for the identifier it exists to count.
    expect(JSON.stringify(anchor)).not.toMatch(/corp_[A-Za-z0-9]/)
  })

  it('THE TRAP — at LOG_LEVEL=warn the SAME record never reaches the transport: silence does NOT mean "no anchor"', async () => {
    const emitted = await emitAnchor('warn')
    expect(emitted.find((i) => i.message === ANCHOR_MSG)).toBeUndefined()
    // ⇒ §0-a MUST self-check that the probe is live (see the UAT checklist) before reading silence as
    // "the real frame carries no corp field". Otherwise the flag gets closed for the wrong reason.
  })
})
