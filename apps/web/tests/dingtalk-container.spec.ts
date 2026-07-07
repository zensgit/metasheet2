import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ensureDingTalkJsApi,
  isDingTalkContainer,
  requestContainerAuthCode,
} from '../src/utils/dingtalkContainer'

const realUA = Object.getOwnPropertyDescriptor(navigator, 'userAgent')

function setUserAgent(value: string) {
  Object.defineProperty(navigator, 'userAgent', { value, configurable: true })
}

afterEach(() => {
  if (realUA) Object.defineProperty(navigator, 'userAgent', realUA)
  delete (window as unknown as { dd?: unknown }).dd
  document.querySelectorAll('script[data-dingtalk-jsapi]').forEach(node => node.remove())
  vi.restoreAllMocks()
})

describe('isDingTalkContainer', () => {
  it('detects a DingTalk WebView user agent', () => {
    setUserAgent('Mozilla/5.0 (Linux; Android) AliApp(DingTalk/7.0.0) Mobile')
    expect(isDingTalkContainer()).toBe(true)
  })

  it('detects an injected window.dd even without a UA match', () => {
    setUserAgent('Mozilla/5.0 (Macintosh) Chrome/120')
    ;(window as unknown as { dd?: unknown }).dd = { runtime: {} }
    expect(isDingTalkContainer()).toBe(true)
  })

  it('is false in a plain browser', () => {
    setUserAgent('Mozilla/5.0 (Macintosh) Chrome/120')
    expect(isDingTalkContainer()).toBe(false)
  })
})

describe('ensureDingTalkJsApi', () => {
  it('resolves immediately when window.dd is already injected', async () => {
    const dd = { runtime: {} }
    ;(window as unknown as { dd?: unknown }).dd = dd
    await expect(ensureDingTalkJsApi()).resolves.toBe(dd)
  })

  it('rejects on timeout when no window.dd and no load fires', async () => {
    await expect(ensureDingTalkJsApi(5)).rejects.toThrow(/timed out/i)
  })

  it('resolves once the injected script loads and populates window.dd', async () => {
    const promise = ensureDingTalkJsApi(2000)
    // simulate the CDN script loading + injecting window.dd
    await new Promise(resolve => setTimeout(resolve, 5))
    const script = document.querySelector<HTMLScriptElement>('script[data-dingtalk-jsapi]')
    expect(script, 'expected the jsapi script to be injected').toBeTruthy()
    ;(window as unknown as { dd?: unknown }).dd = {
      runtime: {},
      ready: (cb: () => void) => cb(),
    }
    script!.dispatchEvent(new Event('load'))
    await expect(promise).resolves.toMatchObject({ runtime: {} })
  })

  it('awaits dd.ready before resolving the CDN-load path (review P3-1)', async () => {
    const promise = ensureDingTalkJsApi(2000)
    await new Promise(resolve => setTimeout(resolve, 5))
    const script = document.querySelector<HTMLScriptElement>('script[data-dingtalk-jsapi]')!
    let readyCb: (() => void) | null = null
    ;(window as unknown as { dd?: unknown }).dd = {
      runtime: {},
      ready: (cb: () => void) => { readyCb = cb },
    }
    script.dispatchEvent(new Event('load'))
    // dd.ready has not fired yet — the promise must still be pending.
    let settled = false
    void promise.then(() => { settled = true }, () => { settled = true })
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(settled).toBe(false)
    readyCb!()
    await expect(promise).resolves.toMatchObject({ runtime: {} })
  })
})

describe('requestContainerAuthCode', () => {
  it('rejects when the JSAPI is unavailable', async () => {
    await expect(requestContainerAuthCode('corp-1')).rejects.toThrow(/unavailable/i)
  })

  it('resolves the authCode from onSuccess (code field)', async () => {
    ;(window as unknown as { dd?: unknown }).dd = {
      runtime: { permission: { requestAuthCode: (opts: any) => opts.onSuccess({ code: 'auth-123' }) } },
    }
    await expect(requestContainerAuthCode('corp-1')).resolves.toBe('auth-123')
  })

  it('accepts the legacy auth_code field too', async () => {
    ;(window as unknown as { dd?: unknown }).dd = {
      runtime: { permission: { requestAuthCode: (opts: any) => opts.onSuccess({ auth_code: 'legacy-9' }) } },
    }
    await expect(requestContainerAuthCode()).resolves.toBe('legacy-9')
  })

  it('rejects an empty authCode', async () => {
    ;(window as unknown as { dd?: unknown }).dd = {
      runtime: { permission: { requestAuthCode: (opts: any) => opts.onSuccess({ code: '' }) } },
    }
    await expect(requestContainerAuthCode()).rejects.toThrow(/empty/i)
  })

  it('rejects via onFail', async () => {
    ;(window as unknown as { dd?: unknown }).dd = {
      runtime: { permission: { requestAuthCode: (opts: any) => opts.onFail({ errorMessage: 'denied' }) } },
    }
    await expect(requestContainerAuthCode()).rejects.toBeInstanceOf(Error)
  })

  it('rejects on timeout when no callback fires', async () => {
    ;(window as unknown as { dd?: unknown }).dd = {
      runtime: { permission: { requestAuthCode: () => { /* never calls back */ } } },
    }
    await expect(requestContainerAuthCode('corp-1', 5)).rejects.toThrow(/timed out/i)
  })
})
