import { computed, inject, type InjectionKey, type Ref, ref, watch } from 'vue'
import {
  isToolbarPinCommandId,
  moveToolbarPin,
  pinToolbarCommand,
  readToolbarPins,
  reorderToolbarPins,
  resetToolbarPins,
  TOOLBAR_PIN_CAP,
  toolbarPinScope,
  type ToolbarPinCommandId,
  unpinToolbarCommand,
  writeToolbarPins,
} from '../utils/toolbar-pins'

export type ToolbarPinsApi = {
  pins: Ref<ToolbarPinCommandId[]>
  isPinned: (id: string) => boolean
  canPin: (id: string) => boolean
  pin: (id: string) => void
  unpin: (id: string) => void
  toggle: (id: string) => void
  move: (id: string, delta: -1 | 1) => void
  reorder: (fromId: string, toId: string) => void
  reset: () => void
  atCap: Ref<boolean>
}

export const TOOLBAR_PINS_KEY: InjectionKey<ToolbarPinsApi> = Symbol('toolbar-pins')

export function useToolbarPins(options: {
  userId: Ref<string | null | undefined>
  sheetId: Ref<string | null | undefined>
}): ToolbarPinsApi {
  const pins = ref<ToolbarPinCommandId[]>([])

  function scope(): string {
    return toolbarPinScope(options.userId.value, options.sheetId.value)
  }

  function reload(): void {
    pins.value = readToolbarPins(scope())
  }

  watch([options.userId, options.sheetId], reload, { immediate: true })

  function persist(next: ToolbarPinCommandId[]): void {
    pins.value = writeToolbarPins(scope(), next)
  }

  function isPinned(id: string): boolean {
    return pins.value.includes(id as ToolbarPinCommandId)
  }

  function canPin(id: string): boolean {
    if (!isToolbarPinCommandId(id)) return false
    if (isPinned(id)) return true
    return pins.value.length < TOOLBAR_PIN_CAP
  }

  function pin(id: string): void {
    persist(pinToolbarCommand(pins.value, id))
  }

  function unpin(id: string): void {
    persist(unpinToolbarCommand(pins.value, id))
  }

  function toggle(id: string): void {
    if (isPinned(id)) unpin(id)
    else pin(id)
  }

  function move(id: string, delta: -1 | 1): void {
    persist(moveToolbarPin(pins.value, id, delta))
  }

  function reorder(fromId: string, toId: string): void {
    persist(reorderToolbarPins(pins.value, fromId, toId))
  }

  function reset(): void {
    pins.value = resetToolbarPins(scope())
  }

  return {
    pins,
    isPinned,
    canPin,
    pin,
    unpin,
    toggle,
    move,
    reorder,
    reset,
    atCap: computed(() => pins.value.length >= TOOLBAR_PIN_CAP),
  }
}

export function useInjectedToolbarPins(): ToolbarPinsApi | null {
  return inject(TOOLBAR_PINS_KEY, null)
}
