/**
 * UF-4 spec helpers: drive Element Plus selects from raw-DOM tests the way the
 * suites used to drive native <select> elements.
 *
 * An el-select renders its trigger in place and (by default) teleports its
 * dropdown to document.body; the trigger's combobox input points at the
 * dropdown list via aria-controls, so both teleported and inline poppers
 * resolve the same way. Every el-option in these components carries a
 * `data-value` attribute mirroring its bound value, and Element Plus keeps the
 * option list mounted (persistent tooltip), so options are clickable without
 * opening the dropdown first.
 */

export interface EpOptionView {
  value: string
  textContent: string | null
  disabled: boolean
  el: HTMLElement
}

function optionList(select: Element): Element | null {
  const combobox = select.querySelector('[role="combobox"]')
  const listId = combobox?.getAttribute('aria-controls')
  if (listId) {
    const byId = document.getElementById(listId)
    if (byId) return byId
  }
  return select.querySelector('.el-select-dropdown__list')
}

/** All options of an el-select, in DOM order (mirror of HTMLSelectElement#options). */
export function epOptions(select: Element | null): EpOptionView[] {
  if (!select) throw new Error('epOptions: select element not found')
  const list = optionList(select)
  if (!list) return []
  return Array.from(list.querySelectorAll('li.el-select-dropdown__item')).map((li) => ({
    value: li.getAttribute('data-value') ?? '',
    textContent: li.textContent,
    disabled: li.classList.contains('is-disabled'),
    el: li as HTMLElement,
  }))
}

/**
 * Select an option by value — the el-select analogue of
 * `select.value = v; select.dispatchEvent(new Event('change'))`.
 * For `multiple` selects this toggles the option, like flipping
 * `option.selected` on a native multi-select.
 */
export function epSetSelect(select: Element | null, value: string): void {
  if (!select) throw new Error('epSetSelect: select element not found')
  const option = epOptions(select).find((item) => item.value === value)
  if (!option) {
    const available = epOptions(select).map((item) => item.value)
    throw new Error(`epSetSelect: option "${value}" not found (available: ${available.join(', ')})`)
  }
  option.el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
}

/** Read the selected value of a single el-select (mirror of HTMLSelectElement#value). */
export function epSelectValue(select: Element | null): string {
  if (!select) throw new Error('epSelectValue: select element not found')
  const selected = epOptions(select).filter((item) => item.el.classList.contains('is-selected'))
  return selected[0]?.value ?? ''
}

/** Read the selected values of a `multiple` el-select. */
export function epSelectValues(select: Element | null): string[] {
  if (!select) throw new Error('epSelectValues: select element not found')
  return epOptions(select)
    .filter((item) => item.el.classList.contains('is-selected'))
    .map((item) => item.value)
}
