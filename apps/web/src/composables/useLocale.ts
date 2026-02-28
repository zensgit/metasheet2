import { computed, ref } from 'vue'

export type AppLocale = 'en' | 'zh-CN'

const LOCALE_STORAGE_KEY = 'metasheet_locale'

const localeState = ref<AppLocale>(resolveInitialLocale())
let storageListenerBound = false

function normalizeLocale(value: unknown): AppLocale {
  if (typeof value !== 'string') return 'en'
  const normalized = value.trim().toLowerCase()
  if (normalized === 'zh' || normalized === 'zh-cn' || normalized === 'zh-hans') {
    return 'zh-CN'
  }
  return 'en'
}

function resolveInitialLocale(): AppLocale {
  if (typeof window === 'undefined') return 'en'
  const fromStorage = window.localStorage.getItem(LOCALE_STORAGE_KEY)
  if (fromStorage) return normalizeLocale(fromStorage)
  if (typeof navigator !== 'undefined') {
    return normalizeLocale(navigator.language)
  }
  return 'en'
}

function setDocumentLang(locale: AppLocale): void {
  if (typeof document === 'undefined') return
  document.documentElement.lang = locale
}

function persistLocale(locale: AppLocale): void {
  if (typeof window === 'undefined') return
  window.localStorage.setItem(LOCALE_STORAGE_KEY, locale)
}

function ensureStorageListener(): void {
  if (storageListenerBound || typeof window === 'undefined') return
  window.addEventListener('storage', (event) => {
    if (event.key !== LOCALE_STORAGE_KEY) return
    const next = normalizeLocale(event.newValue)
    localeState.value = next
    setDocumentLang(next)
  })
  storageListenerBound = true
}

setDocumentLang(localeState.value)

export function useLocale() {
  ensureStorageListener()

  const locale = computed(() => localeState.value)
  const isZh = computed(() => localeState.value === 'zh-CN')

  function setLocale(nextLocale: unknown): void {
    const normalized = normalizeLocale(nextLocale)
    if (localeState.value === normalized) return
    localeState.value = normalized
    persistLocale(normalized)
    setDocumentLang(normalized)
  }

  return {
    locale,
    isZh,
    setLocale,
    normalizeLocale,
    supportedLocales: ['en', 'zh-CN'] as const,
  }
}

