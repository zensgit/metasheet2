import type { ViewTypeFilter } from '../viewFilters'

interface GroupedViewOption {
  type: string
  label: string
  views: Array<{
    id: string
    name?: string
  }>
}

interface MetaControlsProps {
  autoRefresh: boolean
  autoRefreshLabel: string
  canApply: boolean
  canRefresh: boolean
  canRetryData: boolean
  canRetryViews: boolean
  copyStatus: 'idle' | 'copied' | 'failed'
  dataErrorAt: string | null
  error: string | null
  groupedViews: GroupedViewOption[]
  isRefreshing: boolean
  lastErrorInfo: { message: string } | null
  lastErrorLabel: string
  lastRefreshAt: string | null
  lastViewsAt: string | null
  refreshIntervalOptions: readonly number[]
  refreshIntervalSec: number
  sheetIdInput: string
  showViewIdInput: boolean
  showViewSelect: boolean
  status: 'local' | 'loading' | 'ready' | 'error'
  useBackend: boolean
  viewId: string
  viewIdInput: string
  viewsError: string | null
  viewsErrorAt: string | null
  viewsStatus: 'idle' | 'loading' | 'ready' | 'error'
  viewSearch: string
  viewTypeFilter: ViewTypeFilter
  viewTypeFilterOptions: ReadonlyArray<{ id: ViewTypeFilter; label: string }>
  viewTypeLabel: string
  onApply(): void
  onClearState(): void
  onCopyError(): void
  onRefresh(): void
  onRefreshIntervalChange(value: number): void
  onReset(): void
  onRetryData(): void
  onRetryViews(): void
  onSetAutoRefresh(next: boolean): void
  onSetSheetIdInput(value: string): void
  onSetUseBackend(next: boolean): void
  onSetViewIdInput(value: string): void
  onSetViewSearch(value: string): void
  onSetViewTypeFilter(value: ViewTypeFilter): void
  onViewSelect(value: string): void
}

export function MetaControls(props: MetaControlsProps) {
  return (
    <div className="app-actions">
      <button
        className={`toggle ${props.useBackend ? 'active' : ''}`}
        type="button"
        onClick={() => props.onSetUseBackend(!props.useBackend)}
      >
        {props.useBackend ? 'Backend ON' : 'Backend OFF'}
      </button>
      <button
        className={`toggle ${props.autoRefresh ? 'active' : ''}`}
        type="button"
        onClick={() => props.onSetAutoRefresh(!props.autoRefresh)}
        disabled={!props.useBackend}
      >
        {props.autoRefresh ? 'Auto Refresh ON' : 'Auto Refresh OFF'}
      </button>
      <label className="interval">
        Interval
        <select
          value={props.refreshIntervalSec}
          onChange={(event) => props.onRefreshIntervalChange(Number.parseInt(event.target.value, 10))}
          disabled={!props.useBackend}
        >
          {props.refreshIntervalOptions.map((option) => (
            <option key={option} value={option}>
              {option}s
            </option>
          ))}
        </select>
      </label>
      <div className="status">
        <span>{props.status}</span>
        {props.error ? <span className="error">({props.error})</span> : null}
        {props.useBackend ? <span className="hint">views: {props.viewsStatus}</span> : null}
        {props.viewsStatus === 'error' && props.viewsError ? (
          <span className="error">({props.viewsError})</span>
        ) : null}
        {props.dataErrorAt ? <span className="error">(err@ {props.dataErrorAt})</span> : null}
        {props.viewsErrorAt ? <span className="error">(views@ {props.viewsErrorAt})</span> : null}
        {props.lastRefreshAt ? <span className="hint">last: {props.lastRefreshAt}</span> : null}
        {props.lastViewsAt ? <span className="hint">views@ {props.lastViewsAt}</span> : null}
        {props.viewTypeLabel ? <span className="hint">{props.viewTypeLabel}</span> : null}
        {props.useBackend ? <span className="hint">{props.autoRefreshLabel}</span> : null}
        {props.lastErrorInfo ? <span className="error">last error: {props.lastErrorLabel}</span> : null}
        {props.lastErrorInfo ? (
          <button className="copy" type="button" onClick={props.onCopyError}>
            Copy error
          </button>
        ) : null}
        {props.copyStatus === 'copied' ? <span className="hint">copied</span> : null}
        {props.copyStatus === 'failed' ? <span className="error">copy failed</span> : null}
      </div>
      <button className="refresh" type="button" onClick={props.onRefresh} disabled={!props.canRefresh}>
        {props.isRefreshing ? 'Refreshing...' : 'Refresh'}
      </button>
      {props.canRetryViews ? (
        <button className="retry" type="button" onClick={props.onRetryViews}>
          Retry views
        </button>
      ) : null}
      {props.canRetryData ? (
        <button className="retry" type="button" onClick={props.onRetryData}>
          Retry data
        </button>
      ) : null}
      <div className="param-group">
        <label htmlFor="sheetIdInput">
          Sheet
          <input
            id="sheetIdInput"
            name="sheetIdInput"
            value={props.sheetIdInput}
            onChange={(event) => props.onSetSheetIdInput(event.target.value)}
          />
        </label>
        {props.showViewIdInput ? (
          <label htmlFor="viewIdInput">
            View
            <input
              id="viewIdInput"
              name="viewIdInput"
              value={props.viewIdInput}
              onChange={(event) => props.onSetViewIdInput(event.target.value)}
            />
          </label>
        ) : null}
        {props.showViewSelect ? (
          <label htmlFor="viewSelect">
            View List
            <select
              id="viewSelect"
              name="viewSelect"
              value={props.viewId}
              onChange={(event) => props.onViewSelect(event.target.value)}
              disabled={!props.useBackend || props.viewsStatus === 'loading'}
            >
              <option value="">Default view</option>
              {props.groupedViews.map((group) => (
                <optgroup key={group.type} label={group.label}>
                  {group.views.map((view) => (
                    <option key={view.id} value={view.id}>
                      {view.name || view.id}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          </label>
        ) : null}
        {props.showViewSelect ? (
          <label htmlFor="viewSearchInput">
            Search
            <input
              id="viewSearchInput"
              name="viewSearchInput"
              className="view-search"
              value={props.viewSearch}
              onChange={(event) => props.onSetViewSearch(event.target.value)}
              placeholder="name or id"
            />
          </label>
        ) : null}
        {props.showViewSelect ? (
          <div className="view-filters">
            {props.viewTypeFilterOptions.map((filter) => (
              <button
                key={filter.id}
                type="button"
                className={`filter ${props.viewTypeFilter === filter.id ? 'active' : ''}`}
                onClick={() => props.onSetViewTypeFilter(filter.id)}
                disabled={!props.useBackend}
              >
                {filter.label}
              </button>
            ))}
          </div>
        ) : null}
        <button
          className="apply"
          type="button"
          onClick={props.onApply}
          disabled={!props.canApply}
        >
          Apply
        </button>
        <button className="reset" type="button" onClick={props.onReset}>
          Reset
        </button>
        <button className="reset" type="button" onClick={props.onClearState}>
          Clear State
        </button>
      </div>
    </div>
  )
}
