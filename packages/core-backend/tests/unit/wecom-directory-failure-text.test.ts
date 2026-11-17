import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import * as directoryErrors from '../../src/directory/adapters/wecom-directory-errors'
import {
  WECOM_DIRECTORY_FAILURE_SENTENCES,
  WeComAppClosedError,
  WeComAppTypeUnsupportedError,
  WeComMemberShapeViolationError,
  WeComPullTooLargeError,
  WeComRootDepartmentNotVisibleError,
  WeComScopeChangedError,
  WeComScopeKindUnsupportedError,
  WeComScopeUnacknowledgedError,
  weComDirectoryFailureText,
} from '../../src/directory/adapters/wecom-directory-errors'
import { createWeComDirectoryAdapter } from '../../src/directory/adapters/wecom-directory-adapter'
import { DingTalkBusinessError } from '../../src/integrations/dingtalk/transport'
import * as client from '../../src/integrations/wecom/client'
import {
  WeComBusinessError,
  WeComIncompleteResponseError,
  WeComInvalidInputError,
  WeComRequestError,
  WeComTimeoutError,
  WeComTransportError,
} from '../../src/integrations/wecom/client'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SRC = path.resolve(HERE, '../../src')
const ERRORS_FILE = path.join(SRC, 'directory/adapters/wecom-directory-errors.ts')
const ADAPTER_FILE = path.join(SRC, 'directory/adapters/wecom-directory-adapter.ts')
const CLIENT_FILE = path.join(SRC, 'integrations/wecom/client.ts')
const CANARY = 'CANARY-MESSAGE-4f1c'

const classNamesIn = (file: string): string[] =>
  [...fs.readFileSync(file, 'utf8').matchAll(/class\s+(\w+)\s+extends\s+Error\b/g)].map((match) => match[1])

describe('WeCom directory failure text: fixed sentences', () => {
  const S = WECOM_DIRECTORY_FAILURE_SENTENCES

  it('maps each typed adapter error to its fixed sentence', () => {
    const table: Array<[Error, string]> = [
      [new WeComScopeUnacknowledgedError(), S.scopeUnacknowledged],
      [new WeComScopeChangedError(), S.scopeChanged],
      [new WeComAppClosedError(), S.appClosed],
      [new WeComAppTypeUnsupportedError(), S.appTypeUnsupported],
      [new WeComScopeKindUnsupportedError(), S.scopeKindUnsupported],
      [new WeComRootDepartmentNotVisibleError(), S.rootDepartmentNotVisible],
      [new WeComPullTooLargeError(), S.pullTooLarge],
      [new WeComIncompleteResponseError('user_list'), S.incompleteResponse],
      [new WeComInvalidInputError('corpId'), S.invalidInput],
      [new WeComTransportError(), S.transport],
      [new WeComTimeoutError(5000), S.timeout],
    ]
    for (const [error, sentence] of table) expect(weComDirectoryFailureText(error)).toEqual({ text: sentence })
    for (const [error] of table) expect(error.message.length).toBeGreaterThan(0)
  })

  it('adds the isolated count to the member-shape sentence', () => {
    expect(weComDirectoryFailureText(new WeComMemberShapeViolationError(7))).toEqual({ text: `${S.memberShapeViolation} (7 isolated)` })
  })

  it('adds only the numeric code for provider rejections', () => {
    expect(weComDirectoryFailureText(new WeComBusinessError('provider text', 60020, { errmsg: 'body text' }))).toEqual({
      text: `${S.businessRejected} (errcode 60020)`, providerCode: 60020, providerCodeKind: 'errcode',
    })
    expect(weComDirectoryFailureText(new WeComRequestError('provider text', 503, null))).toEqual({
      text: `${S.requestStatus} (HTTP 503)`, providerCode: 503, providerCodeKind: 'http_status',
    })
    expect(weComDirectoryFailureText(new WeComBusinessError('provider text', Number.NaN, null))).toEqual({ text: S.businessRejected })
  })

  it('is exposed as the adapter failure hook', () => {
    expect(createWeComDirectoryAdapter().failureText).toBe(weComDirectoryFailureText)
  })
})

describe('WeCom directory failure text: unknown values', () => {
  it('returns null for anything that is not one of the adapter classes', () => {
    class LookalikeBusinessError extends Error {
      errcode = 60020
    }
    const lookalike = new Error(CANARY)
    lookalike.name = 'WeComBusinessError'
    const values: unknown[] = [
      new Error(CANARY), new TypeError(CANARY), new LookalikeBusinessError(CANARY), lookalike,
      new DingTalkBusinessError(CANARY, { errcode: 1 }), CANARY, 42, undefined, null, { errcode: 60020, message: CANARY }, [],
    ]
    for (const value of values) expect(weComDirectoryFailureText(value)).toBeNull()
  })
})

describe('WeCom directory failure text: every WeCom error class', () => {
  const adapterClasses = classNamesIn(ERRORS_FILE)
  const clientClasses = classNamesIn(CLIENT_FILE)

  it('pins the class population of both source files', () => {
    expect(adapterClasses.sort()).toEqual([
      'WeComAppClosedError', 'WeComAppTypeUnsupportedError', 'WeComMemberShapeViolationError', 'WeComPullTooLargeError',
      'WeComRootDepartmentNotVisibleError', 'WeComScopeChangedError', 'WeComScopeKindUnsupportedError', 'WeComScopeUnacknowledgedError',
    ])
    expect(clientClasses.sort()).toEqual([
      'WeComBusinessError', 'WeComIncompleteResponseError', 'WeComInvalidInputError', 'WeComRequestError', 'WeComTimeoutError', 'WeComTransportError',
    ])
  })

  const instances = (): Array<[string, Error]> => {
    const make = (name: string, namespace: Record<string, unknown>): [string, Error] => {
      const ctor = namespace[name] as new (...args: unknown[]) => Error
      expect(typeof ctor).toBe('function')
      return [name, Reflect.construct(ctor, [CANARY, 500, { errmsg: CANARY }])]
    }
    return [
      ...classNamesIn(ERRORS_FILE).map((name) => make(name, directoryErrors as Record<string, unknown>)),
      ...classNamesIn(CLIENT_FILE).map((name) => make(name, client as Record<string, unknown>)),
    ]
  }

  it('maps every class to a sentence and never emits the message, body or any other field', () => {
    for (const [name, instance] of instances()) {
      Object.defineProperty(instance, 'stack', { value: CANARY, configurable: true })
      Object.defineProperty(instance, 'message', { value: CANARY, configurable: true })
      const output = weComDirectoryFailureText(instance)
      expect(output, name).not.toBeNull()
      expect(JSON.stringify(output), name).not.toContain(CANARY)
    }
  })

  it('does not read message, stack, body or cause of the value it formats', () => {
    for (const [name, instance] of instances()) {
      void instance.stack // materialize the lazily formatted stack before the accessors below exist
      for (const key of ['stack', 'responseBody', 'cause', 'toString', 'message']) {
        Object.defineProperty(instance, key, { get() { throw new Error(`${name}.${key} was read`) }, configurable: true })
      }
      expect(() => weComDirectoryFailureText(instance), name).not.toThrow()
      expect(weComDirectoryFailureText(instance), name).not.toBeNull()
    }
  })

  it('never reads an error message in the sources that format failures', () => {
    for (const file of [ERRORS_FILE, ADAPTER_FILE]) {
      const text = fs.readFileSync(file, 'utf8')
      expect(text, file).not.toMatch(/\.message\b/)
      expect(text, file).not.toMatch(/\.stack\b/)
      expect(text, file).not.toMatch(/\.responseBody\b/)
    }
  })

  it('declares each adapter error with a literal sentence and no message rewrite', () => {
    const text = fs.readFileSync(ERRORS_FILE, 'utf8')
    for (const match of text.matchAll(/super\(([^)]*)\)/g)) {
      expect(match[1]).toMatch(/^WECOM_DIRECTORY_FAILURE_SENTENCES\.\w+$/)
    }
    expect(text).not.toMatch(/this\.(message|stack)\s*=/)
  })
})
