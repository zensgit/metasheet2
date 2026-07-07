// Shared provide/inject key linking <MtMenu> to its <MtMenuItem> children so selecting an item
// closes the menu, without MtMenu needing to walk/patch its slotted vnodes. Kept in its own
// module (not a .vue file) so both components can import the same InjectionKey instance.
import type { InjectionKey } from 'vue'

export const MT_MENU_CLOSE_KEY: InjectionKey<() => void> = Symbol('mt-menu-close')
