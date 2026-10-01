import { readFileSync } from 'node:fs'
import { expect, test, type Page, type Request } from '@playwright/test'

// ---------------------------------------------------------------------------
// F3-E1 审批中心「导出 CSV」, real Chromium (2026-09-30).
//
// The jsdom specs (approval-center.spec.ts, approvalApiErrorSurfacing.spec.ts) pin the view logic
// and the client's request/header handling. This lane drives the real download: the REAL
// ApprovalCenterView (real Vue Router, Pinia, Element Plus) over the REAL fetch path, with
// `page.route()` standing in for the server, and reads back the file the browser saved.
//
// Asserted from download / network / DOM evidence:
//   * the saved file's name is the server's, its bytes equal the bytes the route served (so the
//     UTF-8 BOM, CJK text and CRLF line ends arrive untouched — no CSV is built or re-encoded in the
//     page), and its data-line count equals the served `X-Approval-Export-Row-Count`;
//   * the export request carries the auth header, `format=csv`, and exactly the filters of the list
//     request that produced the rows on screen — no paging;
//   * the four `X-Approval-Export-*` headers were readable in the browser (the notice reports the
//     served count, not "cannot confirm"), and a capped export is reported as incomplete while the
//     file is still saved;
//   * with the PLM source selected through the real dropdown, the button is disabled with its
//     reason on screen and no export request is sent.
//
// "Bytes equal" is a comparison against this route's fixture, not against a live server; the
// server's own body / header contract is covered by the backend real-DB export test.
// ---------------------------------------------------------------------------

const HARNESS = '/verification/approval-list-csv-download-harness.html'
const HARNESS_TOKEN = 'tok_f3e1_csv_export'
const ROW_TITLE = '差旅报销（导出验收）'
const EXPORT_FILE_NAME = 'approvals-export.csv'
const BOM = Buffer.from([0xef, 0xbb, 0xbf])

interface Interception {
  listRequests: URLSearchParams[]
  exportRequests: Array<{ params: URLSearchParams; headers: Record<string, string> }>
}

interface CsvFixture {
  body: Buffer
  rowCount: number
  capped: boolean
}

function csvFixture(rowCount: number, capped = false): CsvFixture {
  const lines = ['审批编号,标题,状态,发起人,创建时间']
  for (let i = 1; i <= rowCount; i += 1) {
    lines.push(`AP-${String(i).padStart(4, '0')},"差旅报销，第 ${i} 笔",pending,张三,2026-09-01T10:00:00.000Z`)
  }
  const text = `${lines.join('\r\n')}\r\n`
  return { body: Buffer.concat([BOM, Buffer.from(text, 'utf8')]), rowCount, capped }
}

function listRow(id: string, title: string): Record<string, unknown> {
  return {
    id,
    sourceSystem: 'platform',
    title,
    status: 'pending',
    templateId: null,
    templateVersionId: null,
    requestNo: `AP-${id}`,
    requester: { id: 'user_requester', name: '发起人' },
    currentStep: 1,
    totalSteps: 2,
    currentNodeKey: 'approval_1',
    createdAt: '2026-09-01T10:00:00.000Z',
    updatedAt: '2026-09-01T10:00:00.000Z',
    assignments: [],
  }
}

function json(body: unknown) {
  return { status: 200, contentType: 'application/json', body: JSON.stringify(body) }
}

function withoutPaging(params: URLSearchParams): Record<string, string> {
  const entries = Object.fromEntries(params.entries())
  delete entries.page
  delete entries.pageSize
  return entries
}

async function openHarness(page: Page, csv: CsvFixture): Promise<Interception> {
  const seen: Interception = { listRequests: [], exportRequests: [] }

  // ONE handler for the whole API surface (same discipline as the other approval harness specs):
  // Playwright resolves overlapping routes by registration order, so a single dispatcher keeps the
  // list and the export on one, inspectable path.
  await page.route('**/api/**', async (route) => {
    const request: Request = route.request()
    const url = new URL(request.url())

    if (url.pathname === '/api/approvals' && request.method() === 'GET') {
      if (url.searchParams.get('format') === 'csv') {
        seen.exportRequests.push({ params: url.searchParams, headers: await request.allHeaders() })
        return route.fulfill({
          status: 200,
          headers: {
            'Content-Type': 'text/csv; charset=utf-8',
            'Content-Disposition': `attachment; filename="${EXPORT_FILE_NAME}"`,
            'X-Approval-Export-Row-Count': String(csv.rowCount),
            'X-Approval-Export-Row-Limit': '500',
            'X-Approval-Export-Row-Cap': '500',
            'X-Approval-Export-Capped': csv.capped ? 'true' : 'false',
          },
          body: csv.body,
        })
      }
      seen.listRequests.push(url.searchParams)
      return route.fulfill(json({ data: [listRow('apv_export_1', ROW_TITLE)], total: 1 }))
    }

    if (url.pathname === '/api/approvals/pending-count') return route.fulfill(json({ count: 1, unreadCount: 1 }))
    if (url.pathname === '/api/approval-templates') return route.fulfill(json({ data: [], total: 0 }))
    if (url.pathname === '/api/plugins') return route.fulfill(json({ plugins: [] }))
    return route.fulfill(json({ ok: true, data: {} }))
  })

  await page.goto(HARNESS)
  await page.waitForFunction(() => window.__F3E1_CSV_EXPORT_READY__ === true)
  // The list on screen came from the network (the harness disables the in-process fixture path).
  await expect(page.getByText(ROW_TITLE).first()).toBeVisible()
  expect(seen.listRequests.length).toBeGreaterThan(0)
  return seen
}

async function pickSource(page: Page, label: string): Promise<void> {
  await page.getByTestId('approval-source-filter').click()
  await page.locator('.el-select-dropdown__item:visible', { hasText: label }).click()
}

async function exportAndSave(page: Page): Promise<{ fileName: string; bytes: Buffer }> {
  const downloadPromise = page.waitForEvent('download')
  await page.getByTestId('approval-export-csv').click()
  const download = await downloadPromise
  const path = await download.path()
  return { fileName: download.suggestedFilename(), bytes: readFileSync(path) }
}

function dataLineCount(bytes: Buffer): number {
  const lines = bytes.subarray(BOM.length).toString('utf8').split('\r\n').filter((line) => line.length > 0)
  return lines.length - 1 // minus the header row
}

test.describe('approval center — 导出 CSV', () => {
  test('saves the server file byte-for-byte, with the list filters, the auth header and a readable row count', async ({ page }) => {
    const csv = csvFixture(3)
    const seen = await openHarness(page, csv)

    // Apply two filters through the real controls so the comparison below is not between defaults.
    await pickSource(page, '平台审批')
    await expect.poll(() => seen.listRequests.at(-1)?.get('sourceSystem')).toBe('platform')
    // Element Plus puts non-class attributes on the inner <input>; accept either placement.
    const search = page.locator('input[data-testid="approval-search-input"], [data-testid="approval-search-input"] input').first()
    await search.fill('PO-2026')
    await search.press('Enter')
    await expect.poll(() => seen.listRequests.at(-1)?.get('search')).toBe('PO-2026')
    await expect(page.getByText(ROW_TITLE).first()).toBeVisible()

    const saved = await exportAndSave(page)

    expect(saved.fileName).toBe(EXPORT_FILE_NAME)
    expect(saved.bytes.subarray(0, 3).equals(BOM)).toBe(true)
    expect(saved.bytes.equals(csv.body)).toBe(true)
    expect(dataLineCount(saved.bytes)).toBe(csv.rowCount)
    expect(saved.bytes.toString('utf8')).toContain('差旅报销，第 3 笔')

    expect(seen.exportRequests).toHaveLength(1)
    const [exportRequest] = seen.exportRequests
    expect(exportRequest.headers.authorization).toBe(`Bearer ${HARNESS_TOKEN}`)
    expect(exportRequest.headers.accept).toBe('text/csv')
    expect(exportRequest.params.getAll('format')).toEqual(['csv'])
    expect(exportRequest.params.has('page')).toBe(false)
    expect(exportRequest.params.has('pageSize')).toBe(false)
    const { format, ...exportFilters } = Object.fromEntries(exportRequest.params.entries())
    expect(format).toBe('csv')
    const lastList = seen.listRequests.at(-1)!
    // Positive control: the list request really carried paging and the two applied filters.
    expect(lastList.get('page')).toBe('1')
    expect(lastList.get('pageSize')).not.toBeNull()
    expect(exportFilters).toEqual(withoutPaging(lastList))
    expect(exportFilters).toMatchObject({ tab: 'pending', sourceSystem: 'platform', search: 'PO-2026' })

    // The export headers were readable in the page: the notice reports the served count.
    const notice = page.getByTestId('approval-export-notice')
    await expect(notice).toHaveAttribute('data-export-outcome', 'complete')
    await expect(notice).toHaveText('已导出 3 行。')
  })

  test('a capped export still saves the file and says it is incomplete, naming the limit', async ({ page }) => {
    const csv = csvFixture(500, true)
    await openHarness(page, csv)

    const saved = await exportAndSave(page)

    expect(saved.fileName).toBe(EXPORT_FILE_NAME)
    expect(saved.bytes.equals(csv.body)).toBe(true)
    expect(dataLineCount(saved.bytes)).toBe(500)
    const notice = page.getByTestId('approval-export-notice')
    await expect(notice).toHaveAttribute('data-export-outcome', 'capped')
    await expect(notice).toContainText('已导出 500 行，但文件不完整')
    await expect(notice).toContainText('单次导出上限（500 行）')
  })

  test('PLM source: the button is disabled with its reason on screen, and no export request is sent', async ({ page }) => {
    const seen = await openHarness(page, csvFixture(1))
    const button = page.getByTestId('approval-export-csv')
    const hint = page.getByTestId('approval-export-hint')

    // Positive control: enabled, with the ordinary scope hint, before the source changes.
    await expect(button).toBeEnabled()
    await expect(hint).toContainText('导出行数可能少于列表显示的总数')

    await pickSource(page, 'PLM 审批')
    // The list really reloaded for the PLM source, so the disabled state below belongs to it.
    await expect.poll(() => seen.listRequests.at(-1)?.get('sourceSystem')).toBe('plm')

    await expect(button).toBeDisabled()
    await expect(hint).toContainText('PLM 来源的审批不支持导出 CSV')
    await button.click({ force: true })
    await page.waitForTimeout(300)
    expect(seen.exportRequests).toHaveLength(0)
    await expect(page.getByTestId('approval-export-notice')).toHaveCount(0)

    // Leaving PLM re-enables it.
    await pickSource(page, '全部来源')
    await expect.poll(() => seen.listRequests.at(-1)?.get('sourceSystem')).toBe('all')
    await expect(button).toBeEnabled()
  })
})
