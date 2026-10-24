import { vi } from 'vitest'
import { reactive } from 'vue'
import { useWeldingResourceImportSession } from '../../src/views/welding/useWeldingResourceImportSession'
import { clone, type WeldingOwner } from '../../src/services/welding/planRecovery'
import { equalImportPending, validateImportPending, type ResourceImportPending } from '../../src/services/welding/resourceImportContracts'
import type { ResourceImportRecoveryStore } from '../../src/services/welding/commandRecovery'
import type { WeldingPlanClient } from '../../src/services/welding/planClient'
import { importOwner, importPreview, importRaw, importReceipt } from './weldingResourceImportFixtures'
export function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { promise, resolve } }
export function importMemory() {
  const rows = new Map<string, ResourceImportPending>(), listeners = new Set<() => void>(), key = (owner: WeldingOwner) => JSON.stringify(owner)
  const store: ResourceImportRecoveryStore = {
    getResourceImport: vi.fn(async owner => { const value = rows.get(key(owner)); return value ? validateImportPending(value) : null }),
    claimResourceImport: vi.fn(async input => {
      const value = validateImportPending(input), old = rows.get(key(value.owner))
      if (old) return equalImportPending(old, value)
      rows.set(key(value.owner), value); return true
    }),
    clearResourceImport: vi.fn(async value => {
      if (!equalImportPending(rows.get(key(value.owner)) ?? null, value)) return false
      rows.delete(key(value.owner)); return true
    }),
    subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener) }, close: vi.fn(),
  }
  return { store, rows, emit: () => { for (const listener of listeners) listener() } }
}
export function importHarness(memory = importMemory(), count = 1) {
  const flags = reactive({ active: true, writable: true }), current = { owner: clone(importOwner) }
  const api = {
    authority: vi.fn(async () => clone(current.owner)),
    previewResourceImport: vi.fn(async () => importPreview(count)),
    commitResourceImport: vi.fn(async (pending: ResourceImportPending) => importReceipt(pending)),
    resourceImportTemplate: vi.fn(async () => ({ blob: new Blob(['template']), filename: 'welding-resource-import-v1.csv' })),
    readResource: vi.fn(async (resource: string, version: string) => ({ resource_id: resource, item_version_id: version, name: '资料 0', number: '000', kind: 'material',
      state: 'Draft', version_label: '1.A', content_hash: 'd'.repeat(64), payload: importPreview().rows[0].payload, sources: {} })),
  }
  const session = useWeldingResourceImportSession({ active: () => flags.active, writable: () => flags.writable, client: api as unknown as WeldingPlanClient,
    openStore: async () => memory.store, uuid: () => 'batch-original' })
  const file = (bytes = importRaw(), name = 'synthetic.csv') => ({ name, size: bytes.byteLength, arrayBuffer: async () => bytes.slice(0) }) as File
  async function ready() { await session.initialize(); await session.selectFile(file()); await session.preview() }
  return { memory, flags, current, api, session, file, ready }
}
