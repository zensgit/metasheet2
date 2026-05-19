// Global localStorage polyfill for the web test suite.
//
// Root cause (probed, vitest 1.6.1 + jsdom): the default about:blank
// (opaque) origin yields a non-functional `localStorage` — at env baseline
// it is a methodless plain `{}` (typeof object, no getItem/removeItem).
// `environmentOptions.jsdom.url` did not take effect in this vitest version.
// Specs that need localStorage historically each hand-rolled an in-memory
// store; this setup file promotes that to one deterministic global fix.
//
// Install order matters (review #1): a spec's top-level `import` runs
// BEFORE its `beforeEach`. Modules that read localStorage at module-init
// (e.g. useLocale.ts resolveInitialLocale()/setDocumentLang()) would still
// see the broken `{}` if we only installed in beforeEach. So install once
// at setup-file load, then re-install a fresh store before every test.
import { beforeEach } from 'vitest'

function makeStorage(): Storage {
  let store: Record<string, string> = {}
  return {
    get length() {
      return Object.keys(store).length
    },
    clear() {
      store = {}
    },
    getItem(key: string) {
      return Object.prototype.hasOwnProperty.call(store, key) ? store[key] : null
    },
    key(index: number) {
      return Object.keys(store)[index] ?? null
    },
    removeItem(key: string) {
      delete store[key]
    },
    setItem(key: string, value: string) {
      store[key] = String(value)
    },
  } as Storage
}

function installLocalStorage(): void {
  const ls = makeStorage()
  Object.defineProperty(globalThis, 'localStorage', {
    value: ls,
    configurable: true,
    writable: true,
  })
  if (typeof window !== 'undefined') {
    Object.defineProperty(window, 'localStorage', {
      value: ls,
      configurable: true,
      writable: true,
    })
  }
}

// ① at setup-file load (before any spec top-level import executes)
installLocalStorage()

// ② fresh store per test (isolation + heals specs that replaced it w/o restore)
beforeEach(() => {
  installLocalStorage()
})
