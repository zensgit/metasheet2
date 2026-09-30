/**
 * O-8 / slice F8-1 — shared pieces of the approval member-surface English render scans.
 *
 * Same idea as the #5545 sweeps in templateCenterI18n.spec.ts / templateDetailI18n.spec.ts (whole
 * rendered subtree, same widened CJK class), with two deliberate differences:
 *
 *   1. It reads EVERY attribute value, not only aria-label / placeholder / title. Several element
 *      stubs in the host specs carry a prop (a dialog title, a form-item label, a tab label) in a
 *      `data-*` attribute instead of text, and a three-attribute sweep would not see it.
 *   2. Hits that come from a module this slice does not convert are listed as NAMED exceptions:
 *      exact rendered text, expected occurrence count, and the source file:line. Each is
 *      presence-checked, so a stale entry (the text disappeared) is red as well. #5545's render
 *      scans have no exception list at all — this is an extension of that shape, not a precedent.
 *
 * Fixtures fed to these scans are ASCII, so user data never has to be filtered out.
 */
import { expect } from 'vitest'
import { defineComponent, h, type Component } from 'vue'

// Same widened class as the #5545 specs: CJK Symbols/Punctuation + Unified Ideographs +
// Halfwidth/Fullwidth Forms.
export const CJK = /[\u3000-\u303f\u4e00-\u9fff\uff00-\uffef]/
const CJK_RUN = /[^\s|"'<>=]*[\u3000-\u303f\u4e00-\u9fff\uff00-\uffef][^\s|"'<>=]*/g

/** Whole rendered subtree: text plus every attribute value (see note 1 above). */
export function renderedTextAndAttributes(root: Element): string {
  const parts = [root.textContent ?? '']
  for (const el of [root, ...Array.from(root.querySelectorAll('*'))]) {
    for (const attr of Array.from(el.attributes)) {
      if (attr.value) parts.push(attr.value)
    }
  }
  return parts.join(' | ')
}

export type RenderedException = {
  /** Exact rendered text. */
  text: string
  /** Occurrences expected in the scanned string (text and attributes together). */
  count: number
  /** Where the text comes from, as file:line. */
  source: string
}

/**
 * Assert the scanned string has no CJK once the named exceptions are taken out, and that each
 * exception is present exactly `count` times. `label` names the surface in failure messages.
 */
export function expectNoCjkOutside(scanned: string, exceptions: RenderedException[], label: string): void {
  let rest = scanned
  for (const { text, count, source } of exceptions) {
    expect(CJK.test(text), `${label}: named exception without CJK (${source})`).toBe(true)
    expect(rest.split(text).length - 1, `${label}: named exception count changed: ${text} (${source})`).toBe(count)
    rest = rest.split(text).join(' ')
  }
  expect(rest.match(CJK_RUN) ?? [], `${label}: CJK outside the named exceptions`).toEqual([])
}

/**
 * Element Plus stand-ins that put the copy they receive as PROPS into the DOM as text, so the scan
 * sees it: dialog title (and the dialog body only while `modelValue` is true, like the real
 * lazily-rendered el-dialog), form-item / radio / tab / column labels, empty-state description,
 * alert title, popconfirm title, timeline timestamp. Inputs and selects keep their placeholder as
 * an attribute. Column stubs never call their scoped default slot (no row to pass).
 */
export function surfacingElementStubs(): Record<string, Component> {
  const passthrough = (name: string, tag = 'div') => defineComponent({
    name,
    setup(_props, { slots }) {
      return () => h(tag, { 'data-stub': name }, slots.default ? slots.default() : [])
    },
  })
  return {
    ElDivider: passthrough('ElDivider'),
    ElTable: passthrough('ElTable'),
    ElForm: passthrough('ElForm', 'form'),
    ElIcon: passthrough('ElIcon', 'i'),
    ElTag: passthrough('ElTag', 'span'),
    ElRadioGroup: passthrough('ElRadioGroup'),
    ElTimeline: passthrough('ElTimeline'),
    ElSkeleton: passthrough('ElSkeleton'),
    ElBadge: passthrough('ElBadge', 'span'),
    ElDialog: defineComponent({
      name: 'ElDialog',
      props: { modelValue: Boolean, title: String },
      setup(props, { slots }) {
        return () => (props.modelValue
          ? h('div', { 'data-el-dialog': 'open' }, [
              h('header', props.title ?? ''),
              ...(slots.header ? slots.header() : []),
              ...(slots.default ? slots.default() : []),
              ...(slots.footer ? slots.footer() : []),
            ])
          : null)
      },
    }),
    ElFormItem: defineComponent({
      name: 'ElFormItem',
      props: { label: String },
      setup(props, { slots }) {
        return () => h('div', { 'data-stub': 'ElFormItem' }, [
          props.label ? h('label', props.label) : null,
          ...(slots.label ? slots.label() : []),
          ...(slots.default ? slots.default() : []),
        ])
      },
    }),
    ElRadio: defineComponent({
      name: 'ElRadio',
      props: { label: [String, Number, Boolean] as never, value: [String, Number, Boolean] as never },
      setup(props, { slots }) {
        return () => h('label', [slots.default ? slots.default() : String(props.label ?? '')])
      },
    }),
    ElTabPane: defineComponent({
      name: 'ElTabPane',
      props: { label: String, name: String },
      setup(props, { slots }) {
        return () => h('div', { 'data-tab-pane': props.name }, [
          h('span', props.label ?? ''),
          ...(slots.label ? slots.label() : []),
          ...(slots.default ? slots.default() : []),
        ])
      },
    }),
    ElTableColumn: defineComponent({
      name: 'ElTableColumn',
      props: { label: String, prop: String },
      setup(props) {
        return () => h('span', { 'data-col': props.prop ?? '' }, props.label ?? '')
      },
    }),
    ElTimelineItem: defineComponent({
      name: 'ElTimelineItem',
      props: { timestamp: String },
      setup(props, { slots }) {
        return () => h('div', [h('span', props.timestamp ?? ''), ...(slots.default ? slots.default() : [])])
      },
    }),
    ElEmpty: defineComponent({
      name: 'ElEmpty',
      props: { description: String },
      setup(props, { slots }) {
        return () => h('div', { 'data-el-empty': 'true' }, [props.description ?? '', ...(slots.default ? slots.default() : [])])
      },
    }),
    ElAlert: defineComponent({
      name: 'ElAlert',
      props: { title: String, description: String, type: String },
      setup(props, { slots }) {
        return () => h('div', { 'data-el-alert': props.type ?? 'info' }, [
          props.title ?? '',
          props.description ?? '',
          ...(slots.default ? slots.default() : []),
        ])
      },
    }),
    ElPopconfirm: defineComponent({
      name: 'ElPopconfirm',
      props: { title: String },
      setup(props, { slots }) {
        return () => h('span', [h('span', props.title ?? ''), ...(slots.reference ? slots.reference() : [])])
      },
    }),
  }
}
