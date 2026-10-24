import fs from 'node:fs';
import { WeldingOverlayDocumentState, createWeldingOverlayController } from '../../adapters/welding_overlay_adapter.js';
import { SelectionState } from '../../state/selectionState.js';
import { SnapState } from '../../state/snapState.js';
import { ViewState } from '../../state/viewState.js';
import { CommandBus } from '../../commands/command_bus.js';
import { registerCadCommands } from '../../commands/command_registry.js';
const overlay = JSON.parse(fs.readFileSync(new URL('../fixtures/welding_overlay_v1.json', import.meta.url)));
export function context(key = 'plan/version/source') {
  return { context_key: key, overlay: structuredClone(overlay), cadgf_document: { cadgf_version: '1.0.0', schema_version: 1, feature_flags: {}, metadata: { unit_name: 'mm', label: '', author: '', comment: '' }, settings: { unit_scale: 1 }, layers: [{ id: 0, name: '0', color: 0xff0000, visible: 1, locked: 0, printable: 1, frozen: 0, construction: 0 }], entities: [{ id: 101, type: 2, layer_id: 0, line: [[0, 80], [20, 80]] }] } };
}
export function workspace() {
  const document = new WeldingOverlayDocumentState(), selection = new SelectionState(), ctx = { document, selection, snap: new SnapState(), viewport: new ViewState() };
  const commands = new CommandBus(ctx); ctx.commandBus = commands; registerCadCommands(commands, ctx);
  const controller = createWeldingOverlayController({ document, selection, commands, setUnderlay() {} });
  return { ...controller, document, selection, commands, importPayload() { throw new Error('Welding entry must not import into the editable document'); } };
}
export function installDom() {
  globalThis.window = { location: { search: '' } };
  globalThis.document = { getElementById() { return { classList: { add() {}, remove() {}, toggle() {} }, setAttribute() {}, removeAttribute() {} }; } };
}
export function cleanupDom() { delete globalThis.window; delete globalThis.document; }
export function gate() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
