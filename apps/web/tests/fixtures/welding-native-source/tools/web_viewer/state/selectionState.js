export class SelectionState extends EventTarget {
  constructor() {
    super();
    this.entityIds = [];
    this.primaryId = null;
    this.boxSelectEnabled = true;
  }

  emitChange(reason, payload = {}) {
    this.dispatchEvent(
      new CustomEvent('change', {
        detail: {
          reason,
          payload,
          model: this.toJSON(),
        },
      }),
    );
  }

  toJSON() {
    return {
      entityIds: [...this.entityIds],
      primaryId: this.primaryId,
      boxSelectEnabled: this.boxSelectEnabled,
    };
  }

  restore(snapshot, { silent = false } = {}) {
    const ids = Array.isArray(snapshot?.entityIds)
      ? snapshot.entityIds.filter((id) => Number.isFinite(id)).map((id) => Number(id))
      : [];
    this.entityIds = [...new Set(ids)];
    this.primaryId = Number.isFinite(snapshot?.primaryId)
      ? Number(snapshot.primaryId)
      : (this.entityIds[0] ?? null);
    this.boxSelectEnabled = snapshot?.boxSelectEnabled !== false;
    if (!silent) {
      this.emitChange('restore');
    }
  }

  setSelection(ids, primaryId = null) {
    const next = Array.isArray(ids)
      ? ids.filter((id) => Number.isFinite(id)).map((id) => Number(id))
      : [];
    this.entityIds = [...new Set(next)];
    if (Number.isFinite(primaryId) && this.entityIds.includes(primaryId)) {
      this.primaryId = Number(primaryId);
    } else {
      this.primaryId = this.entityIds[0] ?? null;
    }
    this.emitChange('set');
  }

  add(id) {
    if (!Number.isFinite(id)) return;
    const numericId = Number(id);
    if (!this.entityIds.includes(numericId)) {
      this.entityIds.push(numericId);
    }
    this.primaryId = numericId;
    this.emitChange('add', { entityId: numericId });
  }

  remove(id) {
    if (!Number.isFinite(id)) return;
    const numericId = Number(id);
    const before = this.entityIds.length;
    this.entityIds = this.entityIds.filter((entityId) => entityId !== numericId);
    if (before === this.entityIds.length) {
      return;
    }
    if (this.primaryId === numericId) {
      this.primaryId = this.entityIds[0] ?? null;
    }
    this.emitChange('remove', { entityId: numericId });
  }

  toggle(id) {
    if (!Number.isFinite(id)) return;
    const numericId = Number(id);
    if (this.entityIds.includes(numericId)) {
      this.remove(numericId);
      return;
    }
    this.add(numericId);
  }

  clear({ silent = false } = {}) {
    if (this.entityIds.length === 0 && this.primaryId == null) {
      return;
    }
    this.entityIds = [];
    this.primaryId = null;
    if (!silent) {
      this.emitChange('clear');
    }
  }

  setBoxSelectEnabled(enabled) {
    const normalized = enabled !== false;
    if (this.boxSelectEnabled === normalized) {
      return;
    }
    this.boxSelectEnabled = normalized;
    this.emitChange('box-select', { enabled: normalized });
  }
}
