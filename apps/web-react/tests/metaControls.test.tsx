import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { MetaControls } from '../src/components/MetaControls'
import { VIEW_TYPE_FILTER_OPTIONS } from '../src/viewFilters'

function renderMetaControls(overrides: Partial<Parameters<typeof MetaControls>[0]> = {}) {
  return renderToStaticMarkup(
    <MetaControls
      autoRefresh={true}
      autoRefreshLabel="auto: on"
      canApply={true}
      canRefresh={true}
      canRetryData={false}
      canRetryViews={true}
      copyStatus="idle"
      dataErrorAt={null}
      error={null}
      groupedViews={[
        {
          type: 'calendar',
          label: 'Calendar',
          views: [{ id: 'view-2', name: 'Ops Calendar' }],
        },
      ]}
      isRefreshing={false}
      lastErrorInfo={null}
      lastErrorLabel=""
      lastRefreshAt="12:00:00"
      lastViewsAt="12:00:00"
      refreshIntervalOptions={[10, 30, 60]}
      refreshIntervalSec={30}
      sheetIdInput="sheet-1"
      showViewIdInput={false}
      showViewSelect={true}
      status="ready"
      useBackend={true}
      viewId="view-2"
      viewIdInput=""
      viewsError={null}
      viewsErrorAt={null}
      viewsStatus="ready"
      viewSearch="ops"
      viewTypeFilter="calendar"
      viewTypeFilterOptions={VIEW_TYPE_FILTER_OPTIONS}
      viewTypeLabel="type: Calendar"
      onApply={vi.fn()}
      onClearState={vi.fn()}
      onCopyError={vi.fn()}
      onRefresh={vi.fn()}
      onRefreshIntervalChange={vi.fn()}
      onReset={vi.fn()}
      onRetryData={vi.fn()}
      onRetryViews={vi.fn()}
      onSetAutoRefresh={vi.fn()}
      onSetSheetIdInput={vi.fn()}
      onSetUseBackend={vi.fn()}
      onSetViewIdInput={vi.fn()}
      onSetViewSearch={vi.fn()}
      onSetViewTypeFilter={vi.fn()}
      onViewSelect={vi.fn()}
      {...overrides}
    />,
  )
}

describe('MetaControls', () => {
  it('renders the grouped view selector and retry actions when backend views are available', () => {
    const markup = renderMetaControls()

    expect(markup).toContain('Backend ON')
    expect(markup).toContain('Auto Refresh ON')
    expect(markup).toContain('View List')
    expect(markup).toContain('Ops Calendar')
    expect(markup).toContain('Retry views')
    expect(markup).not.toContain('name="viewIdInput"')
  })

  it('renders the manual view input and copy status when no grouped views are available', () => {
    const markup = renderMetaControls({
      copyStatus: 'failed',
      lastErrorInfo: { message: 'HTTP 500' },
      lastErrorLabel: 'data HTTP 500 @ 12:00:00',
      showViewIdInput: true,
      showViewSelect: false,
      useBackend: false,
      viewIdInput: 'manual-view',
    })

    expect(markup).toContain('Backend OFF')
    expect(markup).toContain('name="viewIdInput"')
    expect(markup).toContain('Copy error')
    expect(markup).toContain('copy failed')
    expect(markup).not.toContain('View List')
  })
})
