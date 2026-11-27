import { readFileSync } from 'node:fs'
import { collectImportEdges, NON_LITERAL_SPECIFIER, type ImportEdge } from './import-edge-allowlist'

export const CAPABILITY_MODULE =
  /(?:directory-integration-capabilities-flag|provider-capability-registry|integration-capability-implementations|integration-capability-evaluate|integration-capability-resolve|integration-capability-resolve-background|integration-capability-resolve-core|integration-capability-witness|directory-integration-capabilities-service|directory-integration-capabilities-write-service|admin-directory-capabilities)(?:\.[cm]?[jt]s)?$/
export const BACKGROUND_MODULE = /(?:^|\/)integration-capability-resolve-background(?:\.[cm]?[jt]s)?$/
// Consumers are registered only once their production files and actual imports exist.
export const BACKGROUND_IMPORT_EDGES: ReadonlyArray<ImportEdge> = [
  ['services/task-routed-reminders.ts', '../integrations/integration-capability-resolve-background'],
]

export function collectCapabilityImportEdges(root: string): ImportEdge[] {
  return collectImportEdges(root, /integration-capabilit|provider-capability-registry|admin-directory-capabilities/,
    (file) => readFileSync(file, 'utf8')).filter(([, specifier]) => specifier === NON_LITERAL_SPECIFIER || CAPABILITY_MODULE.test(specifier))
}
