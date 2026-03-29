import { nextTick, onBeforeUnmount, onMounted, watch, type ComputedRef, type Ref } from 'vue'
import type { AdminSectionNavItem } from './useAttendanceAdminRail'

type ReadonlyBoolRef = Readonly<Ref<boolean> | ComputedRef<boolean>>
type ReadonlyStringRef = Readonly<Ref<string> | ComputedRef<string>>
type ReadonlyItemsRef = Readonly<Ref<AdminSectionNavItem[]> | ComputedRef<AdminSectionNavItem[]>>

type UseAttendanceAdminRailNavigationOptions = {
  showAdmin: ReadonlyBoolRef
  adminForbidden: ReadonlyBoolRef
  adminFocusCurrentSectionOnly?: ReadonlyBoolRef
  previousAdminSectionId?: ReadonlyStringRef
  nextAdminSectionId?: ReadonlyStringRef
  adminNavStorageScope: ReadonlyStringRef
  adminActiveSectionId: Ref<string>
  adminSectionNavItems: ReadonlyItemsRef
  isKnownAdminSectionId: (id: string | null | undefined) => id is string
  readLastAdminSection: (scope: string) => string | null
  isCompactAdminNav: Ref<boolean>
  adminCompactNavOpen: Ref<boolean>
}

export function useAttendanceAdminRailNavigation({
  showAdmin,
  adminForbidden,
  adminFocusCurrentSectionOnly,
  previousAdminSectionId,
  nextAdminSectionId,
  adminNavStorageScope,
  adminActiveSectionId,
  adminSectionNavItems,
  isKnownAdminSectionId,
  readLastAdminSection,
  isCompactAdminNav,
  adminCompactNavOpen,
}: UseAttendanceAdminRailNavigationOptions) {
  const adminSectionElements = new Map<string, HTMLElement>()
  let adminSectionObserver: IntersectionObserver | null = null
  let adminHashSyncReady = false
  let adminHashRestoreCompleted = false
  let adminHashRestorePending = false

  function resolveAdminKeyboardTarget(direction: 'previous' | 'next'): string | null {
    const candidate = direction === 'previous'
      ? previousAdminSectionId?.value
      : nextAdminSectionId?.value
    return isKnownAdminSectionId(candidate) ? candidate : null
  }

  function isInteractiveAdminKeyboardTarget(target: EventTarget | null): boolean {
    if (target instanceof HTMLElement) {
      if (target.isContentEditable) return true
      const tagName = target.tagName.toLowerCase()
      if (tagName === 'input' || tagName === 'textarea' || tagName === 'select' || tagName === 'button') {
        return true
      }
      if (target.closest('input, textarea, select, button, [contenteditable="true"]')) return true
    }
    const activeElement = typeof document !== 'undefined' ? document.activeElement : null
    if (!(activeElement instanceof HTMLElement)) return false
    if (activeElement.isContentEditable) return true
    const tagName = activeElement.tagName.toLowerCase()
    return tagName === 'input' || tagName === 'textarea' || tagName === 'select'
  }

  function setAdminSectionRef(id: string, element: Element | null): void {
    if (element instanceof HTMLElement) {
      adminSectionElements.set(id, element)
      return
    }
    adminSectionElements.delete(id)
  }

  function adminSectionBinding(id: string): Record<string, unknown> {
    return {
      id,
      'data-admin-section': id,
      ref: (element: Element | null) => setAdminSectionRef(id, element),
    }
  }

  function resolveAdminSectionElements(): HTMLElement[] {
    if (typeof document === 'undefined') return []
    return adminSectionNavItems.value
      .map(item => adminSectionElements.get(item.id) ?? document.getElementById(item.id))
      .filter((element): element is HTMLElement => element instanceof HTMLElement)
  }

  function disconnectAdminSectionObserver(): void {
    adminSectionObserver?.disconnect()
    adminSectionObserver = null
  }

  function readAdminSectionHash(): string | null {
    if (typeof window === 'undefined') return null
    const hash = window.location.hash.replace(/^#/, '').trim()
    return isKnownAdminSectionId(hash) ? hash : null
  }

  function readLastKnownAdminSection(): string | null {
    const id = readLastAdminSection(adminNavStorageScope.value)
    return isKnownAdminSectionId(id) ? id : null
  }

  function syncAdminSectionHash(id: string): void {
    if (typeof window === 'undefined' || !isKnownAdminSectionId(id)) return
    const nextHash = `#${id}`
    if (window.location.hash === nextHash) return
    window.history.replaceState(window.history.state, '', nextHash)
  }

  async function restoreAdminSectionFromHash(maxAttempts = 4): Promise<boolean> {
    if (adminHashRestoreCompleted || adminHashRestorePending) return false
    const restoreId = readAdminSectionHash() ?? readLastKnownAdminSection()
    if (!restoreId) return false
    adminHashRestorePending = true
    try {
      for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
        const target = adminSectionElements.get(restoreId) ?? document.getElementById(restoreId)
        if (target instanceof HTMLElement) {
          target.scrollIntoView({ behavior: 'auto', block: 'start' })
          adminActiveSectionId.value = restoreId
          adminHashRestoreCompleted = true
          return true
        }
        await nextTick()
      }
      return false
    } finally {
      adminHashRestorePending = false
    }
  }

  function syncAdminSectionObserver(): void {
    disconnectAdminSectionObserver()
    if (typeof window === 'undefined' || adminForbidden.value || !showAdmin.value) return
    const elements = resolveAdminSectionElements()
    if (elements.length === 0) return
    const initialId = readAdminSectionHash() ?? readLastKnownAdminSection() ?? elements[0].id
    adminActiveSectionId.value = initialId
    if (typeof window.IntersectionObserver === 'undefined') return
    adminSectionObserver = new window.IntersectionObserver(
      entries => {
        const visible = entries
          .filter(entry => entry.isIntersecting)
          .sort((left, right) => {
            const ratioDelta = right.intersectionRatio - left.intersectionRatio
            if (Math.abs(ratioDelta) > 0.001) return ratioDelta
            return left.boundingClientRect.top - right.boundingClientRect.top
          })
        const nextId = visible[0]?.target?.id
        if (nextId) adminActiveSectionId.value = nextId
      },
      {
        rootMargin: '-96px 0px -60% 0px',
        threshold: [0.15, 0.35, 0.6],
      },
    )
    elements.forEach(element => adminSectionObserver?.observe(element))
  }

  async function syncAdminSectionNavigationState(): Promise<void> {
    await nextTick()
    syncAdminSectionObserver()
    await restoreAdminSectionFromHash()
    adminHashSyncReady = true
  }

  function resolveActiveAdminNavLink(id: string): HTMLElement | null {
    if (typeof document === 'undefined' || !isKnownAdminSectionId(id)) return null
    const groupedLink = document.querySelector<HTMLElement>(`[data-admin-anchor="${id}"]`)
    if (groupedLink instanceof HTMLElement) return groupedLink
    const recentLink = document.querySelector<HTMLElement>(`[data-admin-anchor-recent="${id}"]`)
    return recentLink instanceof HTMLElement ? recentLink : null
  }

  async function syncActiveAdminNavLinkIntoView(id: string): Promise<void> {
    if (typeof window === 'undefined' || !showAdmin.value || !isKnownAdminSectionId(id)) return
    await nextTick()
    const link = resolveActiveAdminNavLink(id)
    if (!(link instanceof HTMLElement)) return
    link.scrollIntoView({ behavior: 'auto', block: 'center', inline: 'nearest' })
  }

  function scrollToAdminSection(id: string): void {
    if (typeof document === 'undefined') return
    const target = adminSectionElements.get(id) ?? document.getElementById(id)
    if (!(target instanceof HTMLElement)) return
    const content = target.closest<HTMLElement>('[data-admin-content="true"]')
    adminActiveSectionId.value = id
    adminHashSyncReady = true
    syncAdminSectionHash(id)
    if (isCompactAdminNav.value) {
      adminCompactNavOpen.value = false
    }
    if (content instanceof HTMLElement) {
      content.scrollIntoView({ behavior: 'smooth', block: 'start' })
    }
    if (adminFocusCurrentSectionOnly?.value) return
    target.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  function handleAdminSectionKeyboardNavigation(event: KeyboardEvent): void {
    if (!showAdmin.value || adminForbidden.value) return
    if (!event.altKey || event.metaKey || event.ctrlKey) return
    if (event.defaultPrevented || isInteractiveAdminKeyboardTarget(event.target)) return
    const direction = event.key === 'ArrowUp'
      ? 'previous'
      : event.key === 'ArrowDown'
        ? 'next'
        : null
    if (!direction) return
    const targetId = resolveAdminKeyboardTarget(direction)
    if (!targetId) return
    event.preventDefault()
    scrollToAdminSection(targetId)
  }

  function syncAdminNavViewportState(): void {
    if (typeof window === 'undefined') return
    const compact = window.innerWidth <= 768
    const wasCompact = isCompactAdminNav.value
    isCompactAdminNav.value = compact
    if (!compact) {
      adminCompactNavOpen.value = false
      return
    }
    if (!wasCompact) {
      adminCompactNavOpen.value = false
    }
  }

  onMounted(() => {
    syncAdminNavViewportState()
    if (typeof window !== 'undefined') {
      window.addEventListener('resize', syncAdminNavViewportState)
      window.addEventListener('keydown', handleAdminSectionKeyboardNavigation)
    }
    if (showAdmin.value && !adminForbidden.value) {
      nextTick().then(() => restoreAdminSectionFromHash())
      void syncAdminSectionNavigationState()
    }
  })

  onBeforeUnmount(() => {
    disconnectAdminSectionObserver()
    if (typeof window !== 'undefined') {
      window.removeEventListener('resize', syncAdminNavViewportState)
      window.removeEventListener('keydown', handleAdminSectionKeyboardNavigation)
    }
  })

  watch([showAdmin, adminForbidden], async ([isAdminView, forbidden]) => {
    if (!isAdminView || forbidden) {
      disconnectAdminSectionObserver()
      adminHashSyncReady = false
      adminHashRestoreCompleted = false
      adminHashRestorePending = false
      return
    }
    await syncAdminSectionNavigationState()
  })

  watch(adminNavStorageScope, async (scope, previousScope) => {
    if (scope === previousScope) return
    if (!showAdmin.value || adminForbidden.value) return
    adminHashSyncReady = false
    adminHashRestoreCompleted = false
    adminHashRestorePending = false
    await syncAdminSectionNavigationState()
  })

  watch(adminActiveSectionId, id => {
    if (!showAdmin.value || !adminHashSyncReady || !isKnownAdminSectionId(id)) return
    syncAdminSectionHash(id)
  })

  watch(adminActiveSectionId, id => {
    if (!showAdmin.value || !isKnownAdminSectionId(id)) return
    void syncActiveAdminNavLinkIntoView(id)
  })

  return {
    adminSectionBinding,
    scrollToAdminSection,
  }
}
