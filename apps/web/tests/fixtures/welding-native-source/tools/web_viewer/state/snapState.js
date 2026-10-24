const DEFAULT_OPTIONS = {
  endpoint: true,
  midpoint: true,
  quadrant: true,
  center: true,
  intersection: true,
  nearest: false,
  tangent: false,
  ortho: false,
  grid: false,
  gridSize: 10,
  snapRadiusPx: 14,
};

export class SnapState extends EventTarget {
  constructor(initial = {}) {
    super();
    this.options = { ...DEFAULT_OPTIONS, ...(initial || {}) };
    this.options.gridSize = Number.isFinite(this.options.gridSize)
      ? Math.max(0.5, Number(this.options.gridSize))
      : DEFAULT_OPTIONS.gridSize;
    this.options.snapRadiusPx = Number.isFinite(this.options.snapRadiusPx)
      ? Math.max(2, Number(this.options.snapRadiusPx))
      : DEFAULT_OPTIONS.snapRadiusPx;
  }

  emitChange(reason, payload = {}) {
    this.dispatchEvent(
      new CustomEvent('change', {
        detail: {
          reason,
          payload,
          options: this.toJSON(),
        },
      }),
    );
  }

  toJSON() {
    return { ...this.options };
  }

  restore(snapshot, { silent = false } = {}) {
    this.options = {
      ...DEFAULT_OPTIONS,
      ...(snapshot && typeof snapshot === 'object' ? snapshot : {}),
    };
    this.options.gridSize = Number.isFinite(this.options.gridSize)
      ? Math.max(0.5, Number(this.options.gridSize))
      : DEFAULT_OPTIONS.gridSize;
    this.options.snapRadiusPx = Number.isFinite(this.options.snapRadiusPx)
      ? Math.max(2, Number(this.options.snapRadiusPx))
      : DEFAULT_OPTIONS.snapRadiusPx;
    if (!silent) {
      this.emitChange('restore');
    }
  }

  setOption(name, value) {
    if (!Object.prototype.hasOwnProperty.call(this.options, name)) {
      return;
    }
    if (name === 'gridSize') {
      value = Number.isFinite(value) ? Math.max(0.5, Number(value)) : this.options.gridSize;
    }
    if (name === 'snapRadiusPx') {
      value = Number.isFinite(value) ? Math.max(2, Number(value)) : this.options.snapRadiusPx;
    }
    if (this.options[name] === value) {
      return;
    }
    this.options[name] = value;
    this.emitChange('set-option', { name, value });
  }

  toggle(name) {
    if (!Object.prototype.hasOwnProperty.call(this.options, name)) {
      return;
    }
    if (typeof this.options[name] !== 'boolean') {
      return;
    }
    this.setOption(name, !this.options[name]);
  }
}
