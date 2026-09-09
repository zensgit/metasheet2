/**
 * Quiet outline glyphs for sheet chrome (toolbar / rail / bell / comment).
 * Local SVGs only — no Lucide and no Element Plus icon pack.
 */
import { h, type FunctionalComponent } from 'vue'

type IconInner = Parameters<typeof h>[2]

function outline(name: string, inner: IconInner): FunctionalComponent {
  const Icon: FunctionalComponent = (_props, { attrs }) => h('svg', {
    class: 'ms-sheet-icon',
    viewBox: '0 0 16 16',
    width: '1em',
    height: '1em',
    fill: 'none',
    stroke: 'currentColor',
    'stroke-width': '1.35',
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
    'aria-hidden': 'true',
    'data-sheet-icon': name,
    ...attrs,
  }, inner)
  Icon.displayName = `SheetIcon(${name})`
  return Icon
}

const p = (d: string) => h('path', { d })
const line = (x1: number, y1: number, x2: number, y2: number) => h('line', { x1, y1, x2, y2 })
const circ = (cx: number, cy: number, r: number) => h('circle', { cx, cy, r })
const rect = (x: number, y: number, w: number, ht: number, rx = 0) => h('rect', { x, y, width: w, height: ht, rx })

export const SheetFields = outline('fields', [line(3, 4.5, 13, 4.5), line(3, 8, 13, 8), line(3, 11.5, 13, 11.5)])
export const SheetSort = outline('sort', [
  p('M5 3.5v9'), p('M5 3.5 3.2 5.5'), p('M5 3.5 6.8 5.5'),
  p('M11 12.5v-9'), p('M11 12.5 9.2 10.5'), p('M11 12.5 12.8 10.5'),
])
export const SheetFilter = outline('filter', p('M3 3.5h10l-3.6 4.4V13l-2.8-1.4V7.9L3 3.5Z'))
export const SheetGroup = outline('group', [rect(3, 3, 10, 3, 0.8), rect(4.5, 6.5, 7, 3, 0.8), rect(6, 10, 4, 3, 0.8)])
export const SheetUndo = outline('undo', p('M5 6.5H3.5A5.5 5.5 0 1 0 9 3.2M5 6.5 7.2 4.2M5 6.5 7.2 8.6'))
export const SheetRedo = outline('redo', p('M11 6.5h1.5A5.5 5.5 0 1 1 7 3.2M11 6.5 8.8 4.2M11 6.5 8.8 8.6'))
export const SheetSearch = outline('search', [circ(7, 7, 3.4), line(9.6, 9.6, 13, 13)])
export const SheetRowHeight = outline('row-height', [line(3, 4, 13, 4), line(3, 8, 13, 8), line(3, 12, 13, 12)])
export const SheetFit = outline('fit', [
  p('M3 6V3h3'), p('M13 6V3h-3'), p('M3 10v3h3'), p('M13 10v3h-3'),
])
export const SheetPrint = outline('print', [rect(4, 8.5, 8, 4.5, 0.6), rect(5.2, 3, 5.6, 3.2, 0.4), p('M4 10.2h8')])
export const SheetImport = outline('import', [p('M8 3.2v7'), p('M5.4 7.4 8 10.2 10.6 7.4'), p('M3.5 13h9')])
export const SheetExport = outline('export', [p('M8 12.8V5.8'), p('M5.4 8.6 8 5.8 10.6 8.6'), p('M3.5 13h9')])
export const SheetCheck = outline('check', p('M3.5 8.2 6.6 11.2 12.5 4.8'))
export const SheetMore = outline('more', [circ(4, 8, 0.9), circ(8, 8, 0.9), circ(12, 8, 0.9)])
export const SheetChat = outline('chat', p('M3.2 4.2h9.6v6.4H8.4L5.6 12.8V10.6H3.2V4.2Z'))
export const SheetGear = outline('gear', [circ(8, 8, 2.1), circ(8, 8, 5.2)])
export const SheetLock = outline('lock', [rect(3.6, 7.2, 8.8, 5.6, 1), p('M5.6 7.2V5.5a2.4 2.4 0 0 1 4.8 0v1.7')])
export const SheetBolt = outline('bolt', p('M9.2 2.5 4.8 9h3.2l-.8 4.5 5-7.2H8.8L9.2 2.5Z'))
export const SheetFiles = outline('files', [rect(5.2, 3.2, 7, 9, 0.8), p('M3.8 5.2v7.6a.8.8 0 0 0 .8.8h6.4')])
export const SheetDashboard = outline('dashboard', [rect(3, 3, 4.4, 4.4, 0.6), rect(8.6, 3, 4.4, 4.4, 0.6), rect(3, 8.6, 4.4, 4.4, 0.6), rect(8.6, 8.6, 4.4, 4.4, 0.6)])
export const SheetLink = outline('link', [p('M6.4 9.6 9.6 6.4'), p('M7.2 11.6 5 13.8a2.1 2.1 0 0 1-3-3L4.2 8.6'), p('M8.8 4.4 11 2.2a2.1 2.1 0 0 1 3 3L11.8 7.4')])
export const SheetKey = outline('key', [circ(5.4, 8, 2.4), p('M7.6 8h6.2l1.4 1.4v1.6H13v-1.2')])
export const SheetTrash = outline('trash', [p('M3.5 5h9'), p('M6 5V3.6h4V5'), p('M5 5l.5 8h5L11 5')])
export const SheetClock = outline('clock', [circ(8, 8, 5.2), p('M8 5.2V8l2.2 1.6')])
export const SheetFolder = outline('folder', [p('M2.8 5.2h4l1.2 1.4H13.2v6.2H2.8V5.2Z')])
export const SheetUser = outline('user', [circ(8, 5.4, 2.1), p('M3.6 13.2c.5-2.8 2.2-4.2 4.4-4.2s3.9 1.4 4.4 4.2')])
export const SheetInbox = outline('inbox', [p('M3 5.2 4.4 11h7.2L13 5.2H3Z'), p('M4.4 11 6 8.6h4L11.6 11')])
export const SheetBell = outline('bell', [p('M8 2.6a3.6 3.6 0 0 1 3.6 3.6v3.1l1.2 1.8H3.2l1.2-1.8V6.2A3.6 3.6 0 0 1 8 2.6Z'), p('M6.4 13.2a1.6 1.6 0 0 0 3.2 0')])

export const SheetViewGrid = outline('view-grid', [rect(3, 3, 10, 10, 0.8), line(8, 3, 8, 13), line(3, 8, 13, 8)])
export const SheetViewForm = outline('view-form', [rect(3.4, 3, 9.2, 10, 0.8), line(5.4, 6, 10.6, 6), line(5.4, 8.4, 10.6, 8.4), line(5.4, 10.8, 8.8, 10.8)])
export const SheetViewKanban = outline('view-kanban', [rect(2.8, 3, 3, 10, 0.6), rect(6.5, 3, 3, 7, 0.6), rect(10.2, 3, 3, 8.4, 0.6)])
export const SheetViewGallery = outline('view-gallery', [rect(3, 4, 10, 8, 0.8), p('M3.6 10.6 6.2 8l2.2 2 1.6-1.4 2.4 2')])
export const SheetViewCalendar = outline('view-calendar', [rect(3, 4, 10, 9, 0.8), line(3, 7, 13, 7), line(6, 3.2, 6, 5.2), line(10, 3.2, 10, 5.2)])
export const SheetViewTimeline = outline('view-timeline', [line(3, 8, 13, 8), circ(5, 8, 1.1), circ(8, 8, 1.1), circ(11.4, 8, 1.1)])
export const SheetViewGantt = outline('view-gantt', [rect(3, 3.6, 7, 2.2, 0.5), rect(6, 7, 7, 2.2, 0.5), rect(4.2, 10.4, 5.6, 2.2, 0.5)])
export const SheetViewHierarchy = outline('view-hierarchy', [p('M8 3v3.2'), p('M4.4 9.6V8h7.2v1.6'), circ(8, 3.6, 1.1), circ(4.4, 11.4, 1.1), circ(11.6, 11.4, 1.1)])
export const SheetCaretRight = outline('caret-right', p('M6 4.2 10.4 8 6 11.8'))
export const SheetCaretBottom = outline('caret-bottom', p('M4.2 6 8 10.4 11.8 6'))
export const SheetCaretTop = outline('caret-top', p('M4.2 10 8 5.6 11.8 10'))
export const SheetCheckbox = outline('checkbox', rect(3.2, 3.2, 9.6, 9.6, 1.4))
export const SheetCheckboxOn = outline('checkbox-on', [rect(3.2, 3.2, 9.6, 9.6, 1.4), p('M5.2 8.2 7.1 10.1 11 5.8')])
export const SheetPin = outline('pin', [
  p('M5.2 3.4h5.6l-1.2 4.2H6.4L5.2 3.4Z'),
  line(5.4, 3.4, 10.6, 3.4),
  line(8, 7.6, 8, 13),
])
const STAR_D = 'M8 2.6 9.7 6.2l4 .4-3 2.7.9 3.9L8 11.2l-3.6 2 .9-3.9-3-2.7 4-.4Z'
export const SheetStar = outline('star', p(STAR_D))
export const SheetStarFilled: FunctionalComponent = (_props, { attrs }) => h('svg', {
  class: 'ms-sheet-icon',
  viewBox: '0 0 16 16',
  width: '1em',
  height: '1em',
  fill: 'currentColor',
  stroke: 'none',
  'aria-hidden': 'true',
  'data-sheet-icon': 'star-filled',
  ...attrs,
}, p(STAR_D))
SheetStarFilled.displayName = 'SheetIcon(star-filled)'
