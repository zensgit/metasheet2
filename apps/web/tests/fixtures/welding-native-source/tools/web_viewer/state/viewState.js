export class ViewState extends EventTarget {
  constructor() {
    super();
    this.zoom = 1;
    this.pan = { x: 0, y: 0 };
    this.minZoom = 0.1;
    this.maxZoom = 16;
    this.showGrid = false;
  }

  emitChange(reason, payload = {}) {
    this.dispatchEvent(
      new CustomEvent('change', {
        detail: {
          reason,
          payload,
          zoom: this.zoom,
          pan: { ...this.pan },
          showGrid: this.showGrid,
        },
      }),
    );
  }

  toJSON() {
    return {
      zoom: this.zoom,
      pan: { ...this.pan },
      minZoom: this.minZoom,
      maxZoom: this.maxZoom,
      showGrid: this.showGrid,
    };
  }

  restore(snapshot, { silent = false } = {}) {
    if (snapshot && typeof snapshot === 'object') {
      if (Number.isFinite(snapshot.zoom)) {
        this.zoom = Math.min(this.maxZoom, Math.max(this.minZoom, Number(snapshot.zoom)));
      }
      if (snapshot.pan && Number.isFinite(snapshot.pan.x) && Number.isFinite(snapshot.pan.y)) {
        this.pan = { x: Number(snapshot.pan.x), y: Number(snapshot.pan.y) };
      }
      if (typeof snapshot.showGrid === 'boolean') {
        this.showGrid = snapshot.showGrid;
      }
    }
    if (!silent) {
      this.emitChange('restore');
    }
  }

  setZoom(nextZoom, anchorScreenPoint = null) {
    const clamped = Math.min(this.maxZoom, Math.max(this.minZoom, Number(nextZoom)));
    if (!Number.isFinite(clamped) || clamped === this.zoom) {
      return;
    }

    if (anchorScreenPoint && Number.isFinite(anchorScreenPoint.x) && Number.isFinite(anchorScreenPoint.y)) {
      const worldPoint = this.screenToWorld(anchorScreenPoint);
      this.zoom = clamped;
      const projected = this.worldToScreen(worldPoint);
      this.pan.x += anchorScreenPoint.x - projected.x;
      this.pan.y += anchorScreenPoint.y - projected.y;
    } else {
      this.zoom = clamped;
    }

    this.emitChange('zoom', { zoom: this.zoom });
  }

  zoomBy(factor, anchorScreenPoint = null) {
    if (!Number.isFinite(factor) || factor <= 0) {
      return;
    }
    this.setZoom(this.zoom * factor, anchorScreenPoint);
  }

  panBy(deltaX, deltaY) {
    if (!Number.isFinite(deltaX) || !Number.isFinite(deltaY)) {
      return;
    }
    this.pan.x += deltaX;
    this.pan.y += deltaY;
    this.emitChange('pan', { pan: { ...this.pan } });
  }

  setShowGrid(showGrid) {
    const normalized = showGrid === true;
    if (this.showGrid === normalized) {
      return;
    }
    this.showGrid = normalized;
    this.emitChange('grid', { showGrid: normalized });
  }

  worldToScreen(worldPoint) {
    return {
      x: worldPoint.x * this.zoom + this.pan.x,
      y: worldPoint.y * this.zoom + this.pan.y,
    };
  }

  screenToWorld(screenPoint) {
    return {
      x: (screenPoint.x - this.pan.x) / this.zoom,
      y: (screenPoint.y - this.pan.y) / this.zoom,
    };
  }
}
