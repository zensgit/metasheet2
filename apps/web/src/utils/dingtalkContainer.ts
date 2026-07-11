// DingTalk container (micro-app WebView) integration — detection, JSAPI
// readiness, and enterprise 免登 authCode. Powers E2 container login wiring
// (attendance-e2-container-shell design-lock). Pure w.r.t. module load: all
// window/navigator access happens inside functions, so it is safe to import
// anywhere and unit-testable by stubbing globals.

interface DingTalkRuntimePermission {
  requestAuthCode?: (options: {
    corpId?: string
    onSuccess?: (result: { code?: string; auth_code?: string }) => void
    onFail?: (error: unknown) => void
  }) => void
}

interface DingTalkRuntime {
  permission?: DingTalkRuntimePermission
}

interface DingTalkGlobal {
  runtime?: DingTalkRuntime
  ready?: (cb: () => void) => void
}

function getDingTalkGlobal(): DingTalkGlobal | null {
  if (typeof window === 'undefined') return null
  const dd = (window as unknown as { dd?: DingTalkGlobal }).dd
  return dd && typeof dd === 'object' ? dd : null
}

/**
 * Are we running inside a DingTalk container? The DingTalk WebView UA carries
 * "DingTalk" (and "AliApp(DingTalk/…)"); the injected `window.dd` is a second
 * signal for the micro-app runtime.
 */
export function isDingTalkContainer(): boolean {
  if (typeof navigator !== 'undefined' && /dingtalk/i.test(String(navigator.userAgent || ''))) {
    return true
  }
  return getDingTalkGlobal() !== null
}

const JSAPI_SRC = 'https://g.alicdn.com/dingding/dingtalk-jsapi/2.13.42/dingtalk.open.development.js'

/**
 * Resolve once the DingTalk JSAPI (`window.dd`) is usable. In a real container
 * `window.dd` is pre-injected, so this resolves immediately. Otherwise it makes
 * one best-effort dynamic-load attempt with a timeout; the caller must treat a
 * rejection as fail-soft (fall back to normal login).
 */
export function ensureDingTalkJsApi(timeoutMs = 5000): Promise<DingTalkGlobal> {
  const existing = getDingTalkGlobal()
  if (existing) return Promise.resolve(existing)
  if (typeof document === 'undefined') {
    return Promise.reject(new Error('DingTalk JSAPI unavailable (no document)'))
  }

  return new Promise<DingTalkGlobal>((resolve, reject) => {
    let settled = false
    const finish = (fn: () => void) => {
      if (settled) return
      settled = true
      fn()
    }
    const timer = setTimeout(() => {
      finish(() => reject(new Error('DingTalk JSAPI load timed out')))
    }, timeoutMs)

    const existingScript = document.querySelector<HTMLScriptElement>('script[data-dingtalk-jsapi]')
    const onReady = () => {
      const dd = getDingTalkGlobal()
      if (!dd) {
        finish(() => { clearTimeout(timer); reject(new Error('DingTalk JSAPI loaded without window.dd')) })
        return
      }
      // Wait one dd.ready tick before declaring the bridge usable (review
      // #3795 P3-1): on the CDN-load path the script's `load` fires before the
      // JSAPI bridge is fully wired, so a requestAuthCode right after could
      // fail early on a real device. When dd.ready is absent, resolve directly.
      if (typeof dd.ready === 'function') {
        dd.ready(() => finish(() => { clearTimeout(timer); resolve(dd) }))
      } else {
        finish(() => { clearTimeout(timer); resolve(dd) })
      }
    }

    if (existingScript) {
      existingScript.addEventListener('load', onReady, { once: true })
      existingScript.addEventListener('error', () => finish(() => { clearTimeout(timer); reject(new Error('DingTalk JSAPI failed to load')) }), { once: true })
      return
    }

    const script = document.createElement('script')
    script.src = JSAPI_SRC
    script.async = true
    script.setAttribute('data-dingtalk-jsapi', '1')
    script.addEventListener('load', onReady, { once: true })
    script.addEventListener('error', () => finish(() => { clearTimeout(timer); reject(new Error('DingTalk JSAPI failed to load')) }), { once: true })
    document.head.appendChild(script)
  })
}

/**
 * Exchange the in-container enterprise 免登 grant for a single-use authCode via
 * dd.runtime.permission.requestAuthCode. Promise-wraps the callback API.
 */
export function requestContainerAuthCode(corpId?: string, timeoutMs = 8000): Promise<string> {
  const dd = getDingTalkGlobal()
  const requestAuthCode = dd?.runtime?.permission?.requestAuthCode
  if (typeof requestAuthCode !== 'function') {
    return Promise.reject(new Error('DingTalk requestAuthCode is unavailable'))
  }

  return new Promise<string>((resolve, reject) => {
    let settled = false
    const done = (fn: () => void) => { if (!settled) { settled = true; fn() } }
    const timer = setTimeout(() => done(() => reject(new Error('DingTalk requestAuthCode timed out'))), timeoutMs)
    try {
      requestAuthCode({
        corpId,
        onSuccess: (result) => {
          const code = String(result?.code ?? result?.auth_code ?? '').trim()
          if (code) done(() => { clearTimeout(timer); resolve(code) })
          else done(() => { clearTimeout(timer); reject(new Error('DingTalk returned an empty authCode')) })
        },
        onFail: (error) => done(() => { clearTimeout(timer); reject(error instanceof Error ? error : new Error('DingTalk requestAuthCode failed')) }),
      })
    } catch (error) {
      done(() => { clearTimeout(timer); reject(error instanceof Error ? error : new Error('DingTalk requestAuthCode threw')) })
    }
  })
}
