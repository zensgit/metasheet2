/**
 * DT-HARDEN-11: the staging deploy template is copied verbatim by the operator (no value injection),
 * so a stale comment or a live value becomes the deployed configuration.
 * This guard pins the DingTalk-related lines that were found stale:
 *
 *  - APPROVAL_CARD_LINK_SECRET is declared and EMPTY, like ENCRYPTION_* (blank uses the stored
 *    per-integration secret — approval-card-config.ts);
 *  - the E1 container-login path, wherever a template mentions it, is the mounted route
 *    /api/auth/login/dingtalk/container (routes/auth.ts under /api/auth), never the bare legacy form;
 *  - DINGTALK_NOTIFY_AGENT_ID is never a live non-empty assignment (DINGTALK_AGENT_ID is read first,
 *    so a live alias next to a filled DINGTALK_AGENT_ID is dead text — client.ts readStringEnv);
 *  - the lifecycle-canary block carries no "NOT EXECUTABLE: alias / pending / deprovision" status
 *    (the executable actions and their results live in the canary GO doc, not in the template);
 *  - DINGTALK_TODO_MIRROR_ENABLED is present and never live with a value other than false.
 *
 * Values-free by construction: it asserts key presence, emptiness and comment shape, never a value.
 * Modelled on deploy-template-encryption-material.test.ts.
 */
import fs from 'node:fs'
import * as path from 'node:path'
import { describe, expect, it } from 'vitest'

const REPO_ROOT = path.resolve(__dirname, '../../../..')

const STAGING_TEMPLATE = 'docker/app.staging.env.example'
const PRODUCTION_TEMPLATE = 'docker/app.env.example'

const E1_ROUTE = '/api/auth/login/dingtalk/container'

function readTemplate(rel: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8')
}

function readTemplateLines(rel: string): string[] {
  return readTemplate(rel).split(/\r?\n/)
}

/** Live (uncommented) assignment lines for `key`, as their trimmed right-hand values. */
function liveAssignmentValues(lines: string[], key: string): string[] {
  const re = new RegExp(`^\\s*${key}=(.*)$`)
  return lines.flatMap(line => {
    const m = line.match(re)
    return m ? [m[1].trim()] : []
  })
}

describe('staging deploy template: DingTalk lines', () => {
  it('declares APPROVAL_CARD_LINK_SECRET live and empty', () => {
    const lines = readTemplateLines(STAGING_TEMPLATE)
    const values = liveAssignmentValues(lines, 'APPROVAL_CARD_LINK_SECRET')
    expect(values, `${STAGING_TEMPLATE} has no live APPROVAL_CARD_LINK_SECRET= line`).toHaveLength(1)
    // Shipped blank, like ENCRYPTION_*: blank uses the stored per-integration secret.
    expect(values[0]).toBe('')
  })

  for (const rel of [STAGING_TEMPLATE, PRODUCTION_TEMPLATE]) {
    it(`${rel} names the E1 container-login route only in its mounted form`, () => {
      const lines = readTemplateLines(rel)
      const mentions = lines.filter(line => line.includes('dingtalk/container'))
      // Positive control: both templates document the route, so an empty filter is a regression.
      expect(mentions.length, `${rel} no longer mentions the E1 container-login route`).toBeGreaterThan(0)
      for (const line of mentions) {
        expect(line, `${rel} names the E1 route in a form other than ${E1_ROUTE}`).toContain(E1_ROUTE)
        expect(line, `${rel} still names the bare legacy E1 path`).not.toMatch(/\/auth\/dingtalk\/container/)
      }
    })
  }

  it('never ships DINGTALK_NOTIFY_AGENT_ID as a live non-empty assignment', () => {
    const lines = readTemplateLines(STAGING_TEMPLATE)
    // Positive control: the alias stays documented (commented or blank), it is not deleted.
    expect(lines.some(line => /^#?\s*DINGTALK_NOTIFY_AGENT_ID=/.test(line))).toBe(true)
    for (const value of liveAssignmentValues(lines, 'DINGTALK_NOTIFY_AGENT_ID')) {
      expect(value, 'DINGTALK_NOTIFY_AGENT_ID is shipped live with a value').toBe('')
    }
  })

  it('lifecycle-canary block carries no NOT EXECUTABLE status for alias / pending / deprovision', () => {
    const text = readTemplate(STAGING_TEMPLATE)
    // Positive control: the block itself is still there (the canary contract requires it too).
    expect(text).toMatch(/lifecycle.*canary|canary.*lifecycle/i)
    expect(text).not.toMatch(/NOT EXECUTABLE[^\n]*(alias|pending|deprovision)/)
  })

  it('documents DINGTALK_TODO_MIRROR_ENABLED and never ships it live with a value other than false', () => {
    const lines = readTemplateLines(STAGING_TEMPLATE)
    // Positive control: the key is present (commented sample or live), so the loop below is not vacuous.
    expect(lines.some(line => /^#?\s*DINGTALK_TODO_MIRROR_ENABLED=/.test(line))).toBe(true)
    for (const value of liveAssignmentValues(lines, 'DINGTALK_TODO_MIRROR_ENABLED')) {
      expect(value.toLowerCase(), 'DINGTALK_TODO_MIRROR_ENABLED is shipped live and not false').toBe('false')
    }
  })
})
