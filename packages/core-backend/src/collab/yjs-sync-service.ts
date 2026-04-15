import * as Y from 'yjs'
import type { YjsPersistenceAdapter } from './yjs-persistence-adapter'

export class YjsSyncService {
  private docs = new Map<string, { doc: Y.Doc; lastAccess: number }>()
  private persistence: YjsPersistenceAdapter
  private cleanupTimer: NodeJS.Timeout

  constructor(persistence: YjsPersistenceAdapter) {
    this.persistence = persistence
    // Cleanup idle docs every 30 seconds
    this.cleanupTimer = setInterval(() => this.cleanupIdleDocs(), 30_000)
    this.cleanupTimer.unref()
  }

  async getOrCreateDoc(recordId: string): Promise<Y.Doc> {
    const existing = this.docs.get(recordId)
    if (existing) {
      existing.lastAccess = Date.now()
      return existing.doc
    }

    const doc = new Y.Doc()

    // Load persisted state
    const state = await this.persistence.loadDoc(recordId)
    if (state) {
      Y.applyUpdate(doc, state, 'persistence')
    }

    // Listen for updates to persist incrementally
    doc.on('update', (update: Uint8Array, origin: unknown) => {
      if (origin !== 'persistence') {
        this.persistence.storeUpdate(recordId, update).catch((err) =>
          console.error(`Failed to persist yjs update for ${recordId}:`, err),
        )
      }
    })

    this.docs.set(recordId, { doc, lastAccess: Date.now() })
    return doc
  }

  getDoc(recordId: string): Y.Doc | undefined {
    const entry = this.docs.get(recordId)
    if (entry) entry.lastAccess = Date.now()
    return entry?.doc
  }

  async releaseDoc(recordId: string): Promise<void> {
    const entry = this.docs.get(recordId)
    if (entry) {
      // Snapshot before releasing so cross-restart recovery works
      try {
        await this.persistence.storeSnapshot(recordId, entry.doc)
      } catch (err) {
        console.error(`[yjs] Failed to snapshot doc ${recordId} on release:`, err)
      }
      entry.doc.destroy()
      this.docs.delete(recordId)
    }
  }

  async cleanupIdleDocs(idleThreshold = 60_000): Promise<void> {
    const now = Date.now()
    for (const [recordId, entry] of this.docs) {
      if (now - entry.lastAccess > idleThreshold) {
        try {
          await this.persistence.storeSnapshot(recordId, entry.doc)
        } catch (err) {
          console.error(`[yjs] Failed to snapshot idle doc ${recordId}:`, err)
        }
        entry.doc.destroy()
        this.docs.delete(recordId)
      }
    }
  }

  async destroy(): Promise<void> {
    clearInterval(this.cleanupTimer)
    for (const [recordId, entry] of this.docs) {
      try {
        await this.persistence.storeSnapshot(recordId, entry.doc)
      } catch (err) {
        console.error(`[yjs] Failed to snapshot doc ${recordId} on destroy:`, err)
      }
      entry.doc.destroy()
    }
    this.docs.clear()
  }

  /** Expose doc count for testing */
  get size(): number {
    return this.docs.size
  }
}
