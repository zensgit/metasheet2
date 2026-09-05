// mount-meta-cell-editor — shared DOM-mount helper for MetaCellEditor-focused specs.
//
// NIT (grid-commit-reliability round 4): tests/multitable-yjs-cell-editor.spec.ts's own local
// `mountEditor` wrapper used to inline this render call inside a `createApp(defineComponent({
// ... }))` (or, briefly, a plain `createApp({ render() { ... } })`) literal directly in that spec
// file. Either shape is itself picked up by `vue/one-component-per-file` as "a component" once a
// file already has more than one such definition — that spec file already carries two pre-existing
// `defineComponent` literals (each already flagged; see that file's own ledger note for the
// 2-warning baseline this must not grow), so adding a THIRD render call in the SAME file, in ANY
// shape, adds a THIRD warning. The only shape that adds zero warnings is one that isn't in that file
// at all: this module holds the ONE render call, in a file of its own — `vue/one-component-per-file`
// only fires when a single file holds more than one, so a file with exactly one (this one) is clean,
// and the spec file that calls it goes back to carrying only its own two pre-existing literals.
import { createApp, h, type App, type Component } from 'vue'

/**
 * Mounts `component` with `props` into `container` via a bare `createApp({ render: () => h(...) })`
 * — no `defineComponent` wrapper, no local component identity beyond this one render call. Returns
 * the mounted `App` so the caller can `app.unmount()` it.
 */
export function mountMetaCellEditor(
  container: HTMLElement,
  component: Component,
  props: Record<string, unknown>,
): App<Element> {
  const app = createApp({ render: () => h(component, props) })
  app.mount(container)
  return app
}
