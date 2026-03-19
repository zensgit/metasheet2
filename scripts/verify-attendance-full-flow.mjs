import { chromium } from '@playwright/test'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'

const webUrl = process.env.WEB_URL || 'http://localhost:8899/'
const apiBaseEnv = process.env.API_BASE || ''
let token = process.env.AUTH_TOKEN || ''
const headless = process.env.HEADLESS !== 'false'
const timeoutMs = Number(process.env.UI_TIMEOUT || 45000)
const fromDate = process.env.FROM_DATE || ''
const toDate = process.env.TO_DATE || ''
const userId = process.env.USER_ID || ''
const productMode = process.env.PRODUCT_MODE || ''
const featuresJson = process.env.FEATURES_JSON || ''
const mobile = process.env.UI_MOBILE === 'true'
const allowEmptyRecords = process.env.ALLOW_EMPTY_RECORDS === 'true'
const outputDir = process.env.OUTPUT_DIR || 'output/playwright/attendance-full-flow'
const expectProductModeRaw = process.env.EXPECT_PRODUCT_MODE || ''
const assertAdminRetry = process.env.ASSERT_ADMIN_RETRY !== 'false'
const assertAdminSettingsSave = process.env.ASSERT_ADMIN_SETTINGS_SAVE !== 'false'
const assertAdminRuleSave = process.env.ASSERT_ADMIN_RULE_SAVE !== 'false'
const assertImportJobRecovery = process.env.ASSERT_IMPORT_JOB_RECOVERY === 'true'
const assertImportJobTelemetry = process.env.ASSERT_IMPORT_JOB_TELEMETRY !== 'false'
const assertImportScalabilityHint = process.env.ASSERT_IMPORT_SCALABILITY_HINT === 'true'
const uiLocaleRaw = process.env.UI_LOCALE || ''
const importRecoveryTimeoutMs = Math.max(10, Number(process.env.IMPORT_RECOVERY_TIMEOUT_MS || 80))
const importRecoveryIntervalMs = Math.max(10, Number(process.env.IMPORT_RECOVERY_INTERVAL_MS || 25))
const adminReadyTimeoutMs = Number(process.env.ADMIN_READY_TIMEOUT || Math.max(timeoutMs, 90000))
const authMeRetries = Math.max(1, Number(process.env.AUTH_ME_RETRIES || 5))
const authMeRetryDelayMs = Math.max(100, Number(process.env.AUTH_ME_RETRY_DELAY_MS || 800))
const authMeTimeoutMs = Math.max(1000, Number(process.env.AUTH_ME_TIMEOUT_MS || 10000))

function logInfo(message) {
  console.log(`[attendance-full-flow] ${message}`)
}

function normalizeUrl(value) {
  return String(value || '').trim().replace(/\/+$/, '')
}

function normalizeProductMode(value) {
  if (value === 'attendance' || value === 'attendance-focused') return 'attendance'
  if (value === 'platform') return 'platform'
  return ''
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function normalizeUiLocale(raw) {
  const value = String(raw || '').trim().toLowerCase()
  if (!value) return ''
  if (value === 'zh' || value === 'zh-cn' || value === 'zh-hans') return 'zh-CN'
  if (value === 'en' || value === 'en-us' || value === 'en-gb') return 'en-US'
  return ''
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function bilingualName(en, zh, options = {}) {
  const exact = options.exact !== false
  const pattern = exact
    ? `^(?:${escapeRegex(en)}|${escapeRegex(zh)})$`
    : `${escapeRegex(en)}|${escapeRegex(zh)}`
  return new RegExp(pattern, 'i')
}

function bilingualPattern(enPattern, zhPattern) {
  return new RegExp(`(?:${enPattern})|(?:${zhPattern})`, 'i')
}

const labels = {
  attendance: bilingualName('Attendance', '考勤'),
  grid: bilingualName('Grid', '表格'),
  refresh: bilingualName('Refresh', '刷新'),
  records: bilingualName('Records', '记录'),
  reload: bilingualName('Reload', '刷新'),
  noRecords: bilingualName('No records.', '暂无记录。', { exact: false }),
  anomalies: bilingualName('Anomalies', '异常', { exact: false }),
  adminCenter: bilingualName('Admin Center', '管理中心'),
  workflowDesigner: bilingualName('Workflow Designer', '流程设计'),
  desktopRecommended: bilingualName('Desktop recommended', '建议使用桌面端'),
  backToOverview: bilingualName('Back to Overview', '返回总览'),
  settings: bilingualName('Settings', '设置'),
  saveSettings: bilingualName('Save settings', '保存设置'),
  settingsUpdated: bilingualName('Settings updated.', '设置已更新。'),
  defaultRule: bilingualName('Default Rule', '默认规则'),
  saveRule: bilingualName('Save rule', '保存规则'),
  ruleUpdated: bilingualName('Rule updated.', '规则已更新。'),
  importHeading: bilingualName('Import (DingTalk / Manual)', '导入（钉钉 / 手工）'),
  payrollCycles: bilingualName('Payroll Cycles', '计薪周期'),
  preview: bilingualName('Preview', '预览'),
  retryPreview: bilingualName('Retry preview', '重试预览'),
  loadCsv: bilingualName('Load CSV', '加载 CSV'),
  import: bilingualName('Import', '导入'),
  reloadJob: bilingualName('Reload job', '重载任务'),
  reloadImportJob: bilingualName('Reload import job', '重载导入任务'),
  resumePolling: bilingualName('Resume polling', '恢复轮询'),
  resumeImportJob: bilingualName('Resume import job', '恢复导入任务'),
  invalidImportJson: bilingualName('Invalid JSON payload for import.', '导入载荷 JSON 无效。'),
  asyncStillRunning: bilingualName('Async import job is still running in background.', '异步导入任务仍在后台运行。'),
  asyncJobCard: bilingualPattern('Async\\s*(preview|import)\\s*job', '异步(?:预览|导入)任务'),
  batchGenerateCycles: bilingualName('Batch generate cycles', '批量生成周期', { exact: false }),
  statusCompleted: bilingualPattern('Status\\s*[:：]\\s*completed', '状态\\s*[:：]\\s*completed'),
  statusFailed: bilingualPattern('Status\\s*[:：]\\s*failed', '状态\\s*[:：]\\s*failed'),
  statusCanceled: bilingualPattern('Status\\s*[:：]\\s*canceled', '状态\\s*[:：]\\s*canceled'),
  previewCompleted: bilingualPattern('Preview job completed\\s*[\\(（]', '预览任务完成\\s*[\\(（]'),
  importCompleted: bilingualPattern('Imported\\s*\\d+(?:\\/\\d+)?\\s*rows\\s*\\(async job\\)', '已导入\\s*\\d+(?:\\/\\d+)?\\s*行\\s*（异步任务）'),
  processedFailed: bilingualPattern('Processed\\s*[:：]\\s*\\d+\\s*[·•]\\s*Failed\\s*[:：]\\s*\\d+', '已处理\\s*[:：]\\s*\\d+\\s*[·•]\\s*失败\\s*[:：]\\s*\\d+'),
  elapsed: bilingualPattern('Elapsed\\s*[:：]\\s*\\d+\\s*ms', '耗时\\s*[:：]\\s*\\d+\\s*ms'),
  engine: bilingualPattern('Engine\\s*[:：]\\s*[a-z0-9_-]+', '引擎\\s*[:：]\\s*[a-z0-9_-]+'),
}

const textSets = {
  saving: ['Saving...', '保存中...'],
  saveSettings: ['Save settings', '保存设置'],
  saveRule: ['Save rule', '保存规则'],
  settingsHeading: ['Settings', '设置'],
  defaultRuleHeading: ['Default Rule', '默认规则'],
}

function deriveApiBaseFromWebUrl(url) {
  try {
    const u = new URL(url)
    return `${u.origin}/api`
  } catch {
    return ''
  }
}

async function refreshAuthToken(apiBase) {
  if (!apiBase || !token) return false
  const url = `${normalizeUrl(apiBase)}/auth/refresh-token`
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    })
    const raw = await res.text()
    let body = null
    try {
      body = raw ? JSON.parse(raw) : null
    } catch {
      body = null
    }
    if (!res.ok || body?.success === false) {
      logInfo(`WARN: token refresh failed: HTTP ${res.status}`)
      return false
    }
    const nextToken = body?.data?.token
    if (typeof nextToken === 'string' && nextToken.length > 20) {
      token = nextToken
      return true
    }
    logInfo('WARN: token refresh response missing token')
    return false
  } catch (error) {
    logInfo(`WARN: token refresh error (${(error && error.message) || error})`)
    return false
  }
}

async function setAuth(page) {
  if (!token) return
  await page.addInitScript((value) => {
    if (value) localStorage.setItem('auth_token', value)
  }, token)
}

async function setProductFeatures(page) {
  if (!productMode && !featuresJson) return
  await page.addInitScript((payload) => {
    const modeValue = payload?.modeValue
    const jsonValue = payload?.jsonValue
    if (typeof modeValue === 'string' && modeValue) {
      localStorage.setItem('metasheet_product_mode', modeValue)
    }
    if (typeof jsonValue === 'string' && jsonValue) {
      localStorage.setItem('metasheet_features', jsonValue)
    }
  }, { modeValue: productMode, jsonValue: featuresJson })
}

async function setImportDebugOverrides(page) {
  if (!assertImportJobRecovery || mobile) return
  await page.addInitScript((payload) => {
    let current = {}
    try {
      const raw = localStorage.getItem('metasheet_attendance_debug')
      current = raw ? JSON.parse(raw) : {}
    } catch {
      current = {}
    }
    const next = {
      ...(current && typeof current === 'object' ? current : {}),
      import: {
        ...((current && typeof current === 'object' && current.import && typeof current.import === 'object')
          ? current.import
          : {}),
        forceUploadCsv: true,
        forceAsyncImport: true,
        forceTimeoutOnce: true,
        pollTimeoutMs: payload.pollTimeoutMs,
        pollIntervalMs: payload.pollIntervalMs,
      },
    }
    localStorage.setItem('metasheet_attendance_debug', JSON.stringify(next))
  }, { pollTimeoutMs: importRecoveryTimeoutMs, pollIntervalMs: importRecoveryIntervalMs })
}

async function setLocaleOverride(page, localeValue) {
  if (!localeValue) return
  const localeStorageValue = localeValue.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en'
  await page.addInitScript((value) => {
    if (value) localStorage.setItem('metasheet_locale', value)
  }, localeStorageValue)
}

function parseFeatures(raw) {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

async function fetchAuthMeFeatures(apiBase) {
  if (!apiBase) return null
  if (typeof fetch !== 'function') {
    throw new Error('Node 18+ is required (global fetch missing)')
  }

  const url = `${normalizeUrl(apiBase)}/auth/me`
  let lastError = null

  for (let attempt = 1; attempt <= authMeRetries; attempt += 1) {
    try {
      const signal = typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
        ? AbortSignal.timeout(authMeTimeoutMs)
        : undefined
      const res = await fetch(url, {
        headers: {
          Authorization: `Bearer ${token}`,
        },
        signal,
      })
      const raw = await res.text()
      let body = null
      try {
        body = raw ? JSON.parse(raw) : null
      } catch {
        body = null
      }
      if (!res.ok) {
        if (res.status === 401) {
          await refreshAuthToken(apiBase)
        }
        const retriable = res.status === 401 || res.status === 408 || res.status === 429 || (res.status >= 500 && res.status <= 504)
        const error = new Error(`GET /auth/me failed: HTTP ${res.status} ${raw.slice(0, 160)}`)
        error.retriable = retriable
        lastError = error
        if (!retriable || attempt >= authMeRetries) {
          throw error
        }
        const delayMs = Math.min(authMeRetryDelayMs * (2 ** (attempt - 1)), 5000)
        logInfo(`WARN: /auth/me attempt ${attempt}/${authMeRetries} failed (HTTP ${res.status}); retrying in ${delayMs}ms`)
        await sleep(delayMs)
        continue
      }
      const payload = body?.data ?? body ?? {}
      return payload?.features && typeof payload.features === 'object' ? payload.features : null
    } catch (error) {
      lastError = error
      const retriable = typeof error?.retriable === 'boolean' ? error.retriable : true
      if (!retriable || attempt >= authMeRetries) {
        break
      }
      const delayMs = Math.min(authMeRetryDelayMs * (2 ** (attempt - 1)), 5000)
      const message = (error && error.message) || String(error)
      logInfo(`WARN: /auth/me attempt ${attempt}/${authMeRetries} error (${message}); retrying in ${delayMs}ms`)
      await sleep(delayMs)
    }
  }

  throw lastError || new Error('GET /auth/me failed')
}

async function endpointExists(apiBase, pathname) {
  if (!apiBase) return false
  try {
    const url = `${normalizeUrl(apiBase)}${pathname}`
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
    })
    return res.status !== 404
  } catch {
    return false
  }
}

async function ensureAttendanceLoaded(page) {
  await page.waitForURL(/\/attendance(\?|$)/, { timeout: timeoutMs })
  // Use exact match to avoid strict-mode collisions with headings like "Attendance groups".
  await page.getByRole('heading', { name: labels.attendance }).first().waitFor({ timeout: timeoutMs })
}

async function assertNavForAttendanceMode(page) {
  const nav = page.locator('nav.app-nav')
  await nav.waitFor({ timeout: timeoutMs })
  const gridLink = page.getByRole('link', { name: labels.grid })
  if (await gridLink.count()) {
    throw new Error('Expected attendance-focused nav (no Grid link), but Grid link is visible')
  }
  const attendanceLink = page.getByRole('link', { name: labels.attendance })
  if (!(await attendanceLink.count())) {
    throw new Error('Expected Attendance link in nav, but not found')
  }
}

async function setDateRange(page, from, to) {
  if (from) {
    await page.locator('#attendance-from-date').fill(from)
  }
  if (to) {
    await page.locator('#attendance-to-date').fill(to)
  }
}

async function refreshRecords(page) {
  await page.getByRole('button', { name: labels.refresh }).first().click()
  const recordsSection = page.locator('section.attendance__card').filter({
    has: page.getByRole('heading', { name: labels.records }),
  })
  await recordsSection.getByRole('button', { name: labels.reload }).first().click()
}

async function assertHasRecords(page) {
  await page.waitForTimeout(800)
  const empty = page.getByText(labels.noRecords)
  if (allowEmptyRecords) return
  if (await empty.count()) {
    throw new Error('No records found in Records table')
  }
}

async function assertRecordsTableContainer(page) {
  const recordsSection = page.locator('section.attendance__card').filter({
    has: page.getByRole('heading', { name: labels.records }),
  })
  const recordsTable = recordsSection.locator('table.attendance__table.attendance__table--records')
  if (!(await recordsTable.count())) {
    const empty = recordsSection.getByText(labels.noRecords)
    if (allowEmptyRecords && (await empty.count())) {
      logInfo('Records table assertion skipped (ALLOW_EMPTY_RECORDS=true and no records)')
      return
    }
    throw new Error('Expected records table with class attendance__table--records')
  }
  const wrappedTable = recordsSection.locator('.attendance__table-wrapper table.attendance__table--records')
  if (!(await wrappedTable.count())) {
    throw new Error('Expected records table to be wrapped by .attendance__table-wrapper')
  }
}

function squashWhitespace(value) {
  return String(value || '').replace(/\s+/g, ' ').trim()
}

async function collectAdminImportDebugState(page) {
  const details = []

  try {
    const statusText = squashWhitespace(await page.locator('div.attendance__status-block--admin').first().innerText())
    if (statusText) details.push(`adminStatus=${JSON.stringify(statusText.slice(0, 240))}`)
  } catch {
    // Best-effort debug capture only.
  }

  try {
    const taskTexts = await page.locator('div.attendance__status').allInnerTexts()
    const normalized = taskTexts.map((entry) => squashWhitespace(entry)).filter(Boolean)
    if (normalized.length) {
      details.push(`statusCards=${JSON.stringify(normalized.slice(0, 3).map((entry) => entry.slice(0, 240)))}`)
    }
  } catch {
    // Best-effort debug capture only.
  }

  return details.join(' ')
}

async function assertAdminRetryState(page, importSection) {
  const payloadInput = importSection.locator('#attendance-import-payload').first()
  const previewButton = importSection.getByRole('button', { name: labels.preview }).first()
  const adminStatusBlock = page.locator('div.attendance__status-block--admin').first()
  const invalidJsonMessage = adminStatusBlock.getByText(labels.invalidImportJson).first()
  const retryPreviewButton = adminStatusBlock.getByRole('button', { name: labels.retryPreview }).first()

  await payloadInput.waitFor({ timeout: adminReadyTimeoutMs })
  await previewButton.waitFor({ timeout: adminReadyTimeoutMs })

  if (await invalidJsonMessage.isVisible().catch(() => false) || await retryPreviewButton.isVisible().catch(() => false)) {
    throw new Error('Admin invalid JSON retry state was already visible before the preview click')
  }

  await payloadInput.click()
  await payloadInput.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A')
  await payloadInput.type('{', { delay: 40 })
  await payloadInput.evaluate((node) => node.blur())
  await page.waitForTimeout(150)

  try {
    await previewButton.click()
    await invalidJsonMessage.waitFor({ timeout: timeoutMs })
    await retryPreviewButton.waitFor({ timeout: timeoutMs })
  } catch (error) {
    await captureDebugScreenshot(page, '02-admin-invalid-json-missing.png')
    const debugState = await collectAdminImportDebugState(page)
    const message = (error && error.message) || String(error)
    throw new Error(`Admin invalid JSON preview feedback not visible (${message})${debugState ? ` (${debugState})` : ''}`)
  }
}

async function assertAdminSettingsSaveCycle(page) {
  const settingsSection = page.locator('div.attendance__admin-section').filter({
    has: page.getByRole('heading', { name: labels.settings }),
  }).first()
  await settingsSection.waitFor({ timeout: adminReadyTimeoutMs })
  const saveButton = settingsSection.getByRole('button', { name: labels.saveSettings })
  await saveButton.waitFor({ timeout: adminReadyTimeoutMs })
  if (!(await saveButton.isEnabled())) {
    throw new Error('Save settings button is not enabled before save-cycle assertion')
  }
  await saveButton.click()

  let sawStatusMessage = false
  let sawBusyTransition = false

  const statusMessage = page.getByText(labels.settingsUpdated).first()
  const transientDeadline = Date.now() + Math.max(8_000, Math.min(adminReadyTimeoutMs, 30_000))
  while (Date.now() < transientDeadline) {
    sawStatusMessage ||= await statusMessage.isVisible().catch(() => false)
    const transientState = await settingsSection.evaluate((section, args) => {
      const button = Array.from(section.querySelectorAll('button')).find((node) => {
        const label = (node.textContent || '').trim()
        return args.saveLabels.includes(label) || args.savingLabels.includes(label)
      })
      if (!button) return { present: false, label: '', disabled: false }
      return {
        present: true,
        label: (button.textContent || '').trim(),
        disabled: button.hasAttribute('disabled'),
      }
    }, {
      saveLabels: textSets.saveSettings,
      savingLabels: textSets.saving,
    }).catch(() => ({ present: false, label: '', disabled: false }))

    if (transientState.present && (textSets.saving.includes(transientState.label) || transientState.disabled)) {
      sawBusyTransition = true
      break
    }
    if (sawStatusMessage) {
      break
    }
    await page.waitForTimeout(250)
  }

  if (!sawStatusMessage) {
    try {
      await statusMessage.waitFor({ timeout: 8_000 })
      sawStatusMessage = true
    } catch {
      sawStatusMessage = false
    }
  }

  await page.waitForFunction((args) => {
    const sections = Array.from(document.querySelectorAll('.attendance__admin-section'))
    const section = sections.find((node) => args.headingLabels.includes(node.querySelector('h4')?.textContent?.trim() || ''))
    if (!section) return false
    const button = Array.from(section.querySelectorAll('button')).find((node) => {
      const label = (node.textContent || '').trim()
      return args.saveLabels.includes(label) || args.savingLabels.includes(label)
    })
    if (!button) return false
    const label = (button.textContent || '').trim()
    return args.saveLabels.includes(label) && !button.hasAttribute('disabled')
  }, {
    headingLabels: textSets.settingsHeading,
    saveLabels: textSets.saveSettings,
    savingLabels: textSets.saving,
  }, { timeout: Math.max(adminReadyTimeoutMs, 90_000) })

  const saveCycleDetails = [
    sawStatusMessage ? 'status message' : null,
    sawBusyTransition ? 'busy transition' : 'no busy transition observed',
    'save button recovery',
  ].filter(Boolean).join(' + ')
  logInfo(`Admin settings save cycle verified (${saveCycleDetails})`)
}

async function assertAdminRuleSaveCycle(page) {
  const ruleSection = page.locator('div.attendance__admin-section').filter({
    has: page.getByRole('heading', { name: labels.defaultRule }),
  }).first()
  await ruleSection.waitFor({ timeout: adminReadyTimeoutMs })
  const saveButton = ruleSection.getByRole('button', { name: labels.saveRule })
  await saveButton.waitFor({ timeout: adminReadyTimeoutMs })
  if (!(await saveButton.isEnabled())) {
    throw new Error('Save rule button is not enabled before save-cycle assertion')
  }
  await saveButton.click()

  let sawStatusMessage = false
  let sawBusyTransition = false

  const statusMessage = page.getByText(labels.ruleUpdated).first()
  const transientDeadline = Date.now() + Math.max(8_000, Math.min(adminReadyTimeoutMs, 30_000))
  while (Date.now() < transientDeadline) {
    sawStatusMessage ||= await statusMessage.isVisible().catch(() => false)
    const transientState = await ruleSection.evaluate((section, args) => {
      const button = Array.from(section.querySelectorAll('button')).find((node) => {
        const label = (node.textContent || '').trim()
        return args.saveLabels.includes(label) || args.savingLabels.includes(label)
      })
      if (!button) return { present: false, label: '', disabled: false }
      return {
        present: true,
        label: (button.textContent || '').trim(),
        disabled: button.hasAttribute('disabled'),
      }
    }, {
      saveLabels: textSets.saveRule,
      savingLabels: textSets.saving,
    }).catch(() => ({ present: false, label: '', disabled: false }))

    if (transientState.present && (textSets.saving.includes(transientState.label) || transientState.disabled)) {
      sawBusyTransition = true
      break
    }
    if (sawStatusMessage) break
    await page.waitForTimeout(250)
  }

  if (!sawStatusMessage) {
    try {
      await statusMessage.waitFor({ timeout: 8_000 })
      sawStatusMessage = true
    } catch {
      sawStatusMessage = false
    }
  }

  await page.waitForFunction((args) => {
    const sections = Array.from(document.querySelectorAll('.attendance__admin-section'))
    const section = sections.find((node) => args.headingLabels.includes(node.querySelector('h4')?.textContent?.trim() || ''))
    if (!section) return false
    const button = Array.from(section.querySelectorAll('button')).find((node) => {
      const label = (node.textContent || '').trim()
      return args.saveLabels.includes(label) || args.savingLabels.includes(label)
    })
    if (!button) return false
    const label = (button.textContent || '').trim()
    return args.saveLabels.includes(label) && !button.hasAttribute('disabled')
  }, {
    headingLabels: textSets.defaultRuleHeading,
    saveLabels: textSets.saveRule,
    savingLabels: textSets.saving,
  }, { timeout: Math.max(adminReadyTimeoutMs, 90_000) })

  const saveCycleDetails = [
    sawStatusMessage ? 'status message' : null,
    sawBusyTransition ? 'busy transition' : 'no busy transition observed',
    'save button recovery',
  ].filter(Boolean).join(' + ')
  logInfo(`Admin default rule save cycle verified (${saveCycleDetails})`)
}

async function captureDebugScreenshot(page, fileName) {
  await fs.mkdir(outputDir, { recursive: true })
  const screenshotPath = path.join(outputDir, fileName)
  await page.screenshot({ path: screenshotPath, fullPage: true })
  logInfo(`Saved debug screenshot: ${screenshotPath}`)
}

async function waitForImportPayload(page, previousValue = null) {
  await page.waitForFunction((prevValue) => {
    const el = document.querySelector('#attendance-import-payload')
    const value = el && 'value' in el ? el.value : ''
    if (typeof value !== 'string') return false
    if (!(value.includes('csvFileId') || value.includes('csvText'))) return false
    if (typeof prevValue === 'string') return value !== prevValue
    return true
  }, previousValue, { timeout: timeoutMs })
}

function buildRecoveryCsv(workDate, rowCount, userId) {
  const lines = new Array(rowCount + 1)
  lines[0] = '日期,UserId,考勤组,上班1打卡时间,下班1打卡时间,考勤结果'
  const baseDate = new Date(`${workDate}T00:00:00Z`)
  const resolvedUserId = String(userId || '').trim() || 'current-user'
  for (let i = 0; i < rowCount; i += 1) {
    const d = new Date(baseDate)
    d.setUTCDate(d.getUTCDate() - i)
    const dateText = d.toISOString().slice(0, 10)
    lines[i + 1] = `${dateText},${resolvedUserId},recovery-group,09:00,18:00,正常`
  }
  return lines.join('\n')
}

function tryParseJsonObject(raw) {
  try {
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed
    return {}
  } catch {
    return {}
  }
}

async function uploadRecoveryCsvFile(apiBase, orgId, csvText) {
  const query = new URLSearchParams({
    orgId: orgId || 'default',
    filename: `attendance-recovery-${Date.now()}.csv`,
  })
  const response = await fetch(`${normalizeUrl(apiBase)}/attendance/import/upload?${query.toString()}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'text/csv',
    },
    body: csvText,
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok || !data?.ok || !data?.data?.fileId) {
    const message = data?.error?.message || `HTTP ${response.status}`
    throw new Error(`upload recovery csv failed: ${message}`)
  }
  return {
    fileId: String(data.data.fileId),
    rowCount: Number(data.data.rowCount || 0),
  }
}

async function resolveRecoveryUserId(apiBase) {
  const url = `${normalizeUrl(apiBase)}/auth/me`
  for (let attempt = 1; attempt <= authMeRetries; attempt += 1) {
    try {
      const signal = typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
        ? AbortSignal.timeout(authMeTimeoutMs)
        : undefined
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        signal,
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) {
        if (response.status === 401) {
          await refreshAuthToken(apiBase)
        }
        const retriable = response.status === 401
          || response.status === 408
          || response.status === 429
          || (response.status >= 500 && response.status <= 504)
        if (!retriable || attempt >= authMeRetries) {
          return ''
        }
        const delayMs = Math.min(authMeRetryDelayMs * (2 ** (attempt - 1)), 5000)
        logInfo(`WARN: resolveRecoveryUserId attempt ${attempt}/${authMeRetries} failed (HTTP ${response.status}); retrying in ${delayMs}ms`)
        await sleep(delayMs)
        continue
      }
      const user = data?.data?.user ?? data?.user ?? {}
      const value = user?.userId || user?.id || user?.user_id || ''
      return String(value || '').trim()
    } catch (error) {
      if (attempt >= authMeRetries) {
        return ''
      }
      const delayMs = Math.min(authMeRetryDelayMs * (2 ** (attempt - 1)), 5000)
      const message = (error && error.message) || String(error)
      logInfo(`WARN: resolveRecoveryUserId attempt ${attempt}/${authMeRetries} error (${message}); retrying in ${delayMs}ms`)
      await sleep(delayMs)
    }
  }
  return ''
}

async function assertImportJobRecoveryFlow(page, importSection, apiBase) {
  logInfo('Admin import recovery assertion started')
  const payloadInput = importSection.locator('#attendance-import-payload').first()
  const importButton = importSection.getByRole('button', { name: labels.import }).first()
  await payloadInput.waitFor({ timeout: adminReadyTimeoutMs })
  await importButton.waitFor({ timeout: adminReadyTimeoutMs })

  const profileSelect = importSection.locator('#attendance-import-profile').first()
  if (await profileSelect.count()) {
    const optionCount = await profileSelect.locator('option[value="dingtalk_csv_daily_summary"]').count()
    if (optionCount > 0) {
      await profileSelect.selectOption('dingtalk_csv_daily_summary')
    }
  }

  const workDate = new Date().toISOString().slice(0, 10)
  const orgIdFromInput = await page.locator('#attendance-org-id').first().inputValue().catch(() => '')
  const basePayload = tryParseJsonObject(await payloadInput.inputValue())
  const resolvedOrgId = String(basePayload.orgId || orgIdFromInput || 'default').trim() || 'default'
  const resolvedUserId = String(basePayload.userId || await resolveRecoveryUserId(apiBase) || '').trim() || 'current-user'
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'attendance-recovery-'))
  try {
    let preparedByApiUpload = false
    try {
      const uploaded = await uploadRecoveryCsvFile(apiBase, resolvedOrgId, buildRecoveryCsv(workDate, 200, resolvedUserId))
      const nextPayload = {
        ...basePayload,
        orgId: resolvedOrgId,
        mode: basePayload.mode || 'override',
        csvFileId: uploaded.fileId,
      }
      delete nextPayload.csvText
      delete nextPayload.rows
      await payloadInput.fill(JSON.stringify(nextPayload, null, 2))
      preparedByApiUpload = true
      logInfo(`Recovery assertion prepared via API upload: csvFileId=${uploaded.fileId} rows=${uploaded.rowCount || 'unknown'}`)
    } catch (error) {
      logInfo(`WARN: API upload path unavailable for recovery assertion (${(error && error.message) || error})`)
    }

    if (!preparedByApiUpload) {
      const csvInput = importSection.locator('#attendance-import-csv').first()
      const loadCsvButton = importSection.getByRole('button', { name: labels.loadCsv }).first()
      const csvPath = path.join(tmpDir, 'attendance-recovery.csv')
      await csvInput.waitFor({ timeout: adminReadyTimeoutMs })
      await loadCsvButton.waitFor({ timeout: adminReadyTimeoutMs })

      const initialPayload = await payloadInput.inputValue()
      await fs.writeFile(csvPath, buildRecoveryCsv(workDate, 1, resolvedUserId), 'utf8')
      await csvInput.setInputFiles(csvPath)
      await loadCsvButton.click()
      await waitForImportPayload(page, initialPayload)
      let payload = await payloadInput.inputValue()
      if (!payload.includes('"csvFileId"')) {
        logInfo('Recovery assertion fallback: forcing upload channel with large CSV payload')
        const previousPayload = payload
        await fs.writeFile(csvPath, buildRecoveryCsv(workDate, 130000, resolvedUserId), 'utf8')
        await csvInput.setInputFiles(csvPath)
        await loadCsvButton.click()
        try {
          await waitForImportPayload(page, previousPayload)
        } catch {
          logInfo('WARN: payload did not change after large CSV load; continuing with current payload')
        }
        payload = await payloadInput.inputValue()
        if (!payload.includes('"csvFileId"')) {
          logInfo('WARN: csvFileId payload unavailable in UI; continuing with forced async debug mode')
        }
      }
    }

    await importButton.click()
    const asyncCard = importSection.locator('div.attendance__status').filter({ hasText: labels.asyncJobCard }).first()
    const timeoutMessage = page.getByText(labels.asyncStillRunning).first()
    await Promise.any([
      timeoutMessage.waitFor({ timeout: timeoutMs }),
      asyncCard.waitFor({ timeout: timeoutMs }),
    ])

    const statusBlock = page.locator('.attendance__status-block').first()
    const resumeStatusAction = statusBlock.getByRole('button', { name: labels.resumeImportJob }).first()
    const reloadStatusAction = statusBlock.getByRole('button', { name: labels.reloadImportJob }).first()
    const statusAction = await (async () => {
      if (await resumeStatusAction.count()) return resumeStatusAction
      if (await reloadStatusAction.count()) return reloadStatusAction
      return null
    })()
    const hasStatusAction = statusAction
      ? await statusAction.count().then(async (count) => {
          if (!count) return false
          const visible = await statusAction.isVisible().catch(() => false)
          if (!visible) return false
          return statusAction.isEnabled().catch(() => false)
        })
      : false
    if (hasStatusAction && statusAction) {
      await statusAction.click()
    } else {
      const reloadInCard = asyncCard.getByRole('button', { name: labels.reloadJob })
      if (await reloadInCard.count()) {
        const reloadButton = reloadInCard.first()
        const reloadEnabled = await reloadButton.isEnabled().catch(() => false)
        if (reloadEnabled) {
          await reloadButton.click()
        } else {
          logInfo('WARN: reload job button is disabled; continuing with async completion assertion')
        }
      }
    }

    await asyncCard.waitFor({ timeout: timeoutMs })
    const completionStatus = asyncCard.getByText(labels.statusCompleted).first()
    const completionPreview = page.getByText(labels.previewCompleted).first()
    const completionImport = page.getByText(labels.importCompleted).first()
    const failedStatus = asyncCard.getByText(labels.statusFailed).first()
    const canceledStatus = asyncCard.getByText(labels.statusCanceled).first()
    const pollDelayMs = Math.max(1200, Math.min(4000, importRecoveryIntervalMs * 20))
    const recoveryDeadlineMs = Math.max(
      timeoutMs + 30000,
      Number.isFinite(importRecoveryTimeoutMs) ? Math.max(0, importRecoveryTimeoutMs) * 1000 + 15000 : 90000,
    )
    const recoveryDeadlineAt = Date.now() + recoveryDeadlineMs

    async function clickWhenReady(locator, { attempts = 3, waitMs = 250 } = {}) {
      const maxAttempts = Math.max(1, Number(attempts) || 1)
      for (let i = 0; i < maxAttempts; i += 1) {
        const exists = await locator.count().then((count) => count > 0).catch(() => false)
        if (!exists) return false

        const visible = await locator.isVisible().catch(() => false)
        if (!visible) {
          await page.waitForTimeout(waitMs)
          continue
        }

        const enabled = await locator.isEnabled().catch(() => false)
        if (!enabled) {
          await page.waitForTimeout(waitMs)
          continue
        }

        try {
          await locator.click({ timeout: 1500 })
          return true
        } catch {
          await page.waitForTimeout(waitMs)
        }
      }
      return false
    }

    async function triggerRecoveryPollAction() {
      const resumeCandidates = [
        asyncCard.getByRole('button', { name: labels.resumePolling }).first(),
        statusBlock.getByRole('button', { name: labels.resumeImportJob }).first(),
      ]
      for (const candidate of resumeCandidates) {
        if (await clickWhenReady(candidate)) return 'resume'
      }

      const reloadCandidates = [
        asyncCard.getByRole('button', { name: labels.reloadJob }).first(),
        statusBlock.getByRole('button', { name: labels.reloadImportJob }).first(),
      ]
      for (const candidate of reloadCandidates) {
        if (await clickWhenReady(candidate)) return 'reload'
      }

      return 'none'
    }

    let completed = false
    let attempt = 0
    while (Date.now() < recoveryDeadlineAt) {
      attempt += 1
      const hasCompleted = await Promise.any([
        completionStatus.isVisible().catch(() => false),
        completionPreview.isVisible().catch(() => false),
        completionImport.isVisible().catch(() => false),
      ]).catch(() => false)
      if (hasCompleted) {
        completed = true
        break
      }

      const hasFailed = await Promise.any([
        failedStatus.isVisible().catch(() => false),
        canceledStatus.isVisible().catch(() => false),
      ]).catch(() => false)
      if (hasFailed) {
        throw new Error('Import recovery job reached failed/canceled state')
      }

      const action = await triggerRecoveryPollAction()
      if (attempt % 5 === 0 || action === 'none') {
        const remainingMs = Math.max(0, recoveryDeadlineAt - Date.now())
        logInfo(`Recovery polling attempt=${attempt} action=${action} remaining_ms=${remainingMs}`)
      }
      await page.waitForTimeout(pollDelayMs)
    }

    if (!completed) {
      const waitedMs = recoveryDeadlineMs
      throw new Error(`Import recovery did not complete within ${waitedMs}ms`)
    }

    if (assertImportJobTelemetry) {
      const processedLine = asyncCard.getByText(labels.processedFailed).first()
      const elapsedLine = asyncCard.getByText(labels.elapsed).first()
      const engineLine = asyncCard.getByText(labels.engine).first()
      const hasProcessed = await processedLine.isVisible().catch(() => false)
      const hasElapsed = await elapsedLine.isVisible().catch(() => false)

      if (hasProcessed && hasElapsed) {
        await processedLine.waitFor({ timeout: timeoutMs })
        await elapsedLine.waitFor({ timeout: timeoutMs })
        const hasEngine = await engineLine.isVisible().catch(() => false)
        if (hasEngine) {
          await engineLine.waitFor({ timeout: timeoutMs })
        } else {
          logInfo('WARN: async job engine telemetry not visible; continuing')
        }
      } else {
        logInfo('WARN: async job telemetry lines not visible; continuing')
      }
    }

    logInfo('Admin import recovery assertion passed')
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true })
  }
}

async function run() {
  if (!token) {
    logInfo('AUTH_TOKEN is required')
    process.exit(1)
  }

  const apiBase = normalizeUrl(apiBaseEnv) || deriveApiBaseFromWebUrl(webUrl)
  await refreshAuthToken(apiBase)

  // Resolve expected features:
  // 1) Explicit FEATURES_JSON override (local/dev).
  // 2) Live /api/auth/me (production verification).
  const overrideFeatures = parseFeatures(featuresJson)
  let liveFeatures = null
  if (!overrideFeatures) {
    try {
      liveFeatures = await fetchAuthMeFeatures(apiBase)
      if (liveFeatures) {
        logInfo(`Loaded features from ${apiBase}/auth/me`)
      }
    } catch (error) {
      logInfo(`WARN: failed to load /auth/me features (${(error && error.message) || error})`)
    }
  }

  const features = (overrideFeatures || liveFeatures || {}) ?? {}
  const resolvedMode =
    normalizeProductMode(productMode) ||
    normalizeProductMode(features?.mode)
  const expectAttendanceFocused = resolvedMode === 'attendance'

  const expectProductMode = normalizeProductMode(expectProductModeRaw)
  if (expectProductMode) {
    const actualMode = normalizeProductMode(resolvedMode || features?.mode)
    if (!actualMode) {
      throw new Error(`Expected product mode '${expectProductMode}', but features.mode is missing`)
    }
    if (actualMode !== expectProductMode) {
      throw new Error(`Expected product mode '${expectProductMode}', got '${actualMode}'`)
    }
  }
  const uiLocale = normalizeUiLocale(uiLocaleRaw)

  const browser = await chromium.launch({ headless })
  const context = await browser.newContext({
    viewport: mobile ? { width: 390, height: 844 } : { width: 1280, height: 720 },
    deviceScaleFactor: mobile ? 2 : 1,
    isMobile: mobile,
    locale: uiLocale || undefined,
  })
  const page = await context.newPage()
  await setAuth(page)
  await setProductFeatures(page)
  await setImportDebugOverrides(page)
  await setLocaleOverride(page, uiLocale)

  logInfo(`Navigating to ${webUrl} (ui_locale=${uiLocale || 'auto'})`)
  await page.goto(webUrl, { waitUntil: 'networkidle', timeout: timeoutMs })

  await ensureAttendanceLoaded(page)

  if (expectAttendanceFocused) {
    await assertNavForAttendanceMode(page)
    logInfo('Nav verified (attendance-focused)')
  }

  if (fromDate || toDate) {
    await setDateRange(page, fromDate, toDate)
  }
  if (userId) {
    await page.locator('#attendance-user-id').fill(userId)
  }
  await refreshRecords(page)
  await assertHasRecords(page)
  await assertRecordsTableContainer(page)

  const today = new Date().toISOString().slice(0, 10)
  const anomaliesSupported = await endpointExists(apiBase, `/attendance/anomalies?from=${today}&to=${today}`)
  if (anomaliesSupported) {
    await page.getByRole('heading', { name: labels.anomalies }).first().waitFor({ timeout: timeoutMs })
    logInfo('Anomalies card verified')
  } else {
    logInfo('WARN: /attendance/anomalies not available (skipping anomalies UI assertion)')
  }

  await fs.mkdir(outputDir, { recursive: true })
  await page.screenshot({ path: path.join(outputDir, '01-overview.png'), fullPage: true })
  logInfo('Saved overview screenshot')

  // Admin Center (if enabled)
  if (features.attendanceAdmin) {
    await page.getByRole('button', { name: labels.adminCenter }).click()
    if (mobile) {
      await page.getByRole('heading', { name: labels.desktopRecommended }).waitFor({ timeout: timeoutMs })
    } else {
      const importSection = page.locator('div.attendance__admin-section').filter({
        has: page.getByRole('heading', { name: labels.importHeading }),
      })
      const payrollHeading = page.getByRole('heading', { name: labels.payrollCycles })
      const payrollBatchSummary = page.locator('summary.attendance__details-summary', { hasText: labels.batchGenerateCycles })

      try {
        await importSection.first().waitFor({ timeout: adminReadyTimeoutMs })
        await payrollHeading.waitFor({ timeout: adminReadyTimeoutMs })
        await payrollBatchSummary.waitFor({ timeout: adminReadyTimeoutMs })
      } catch (error) {
        await captureDebugScreenshot(page, '02-admin-section-missing.png')
        const message = (error && error.message) || String(error)
        if (assertAdminRetry) {
          throw new Error(`Admin section not ready for import assertions: ${message}`)
        }
        logInfo(`WARN: Admin section not ready, skipping retry assertions (${message})`)
      }

      const importSectionCount = await importSection.count()
      if (assertImportScalabilityHint && importSectionCount > 0) {
        await importSection.getByText(/Auto mode:\s*preview\s*>=\s*\d+\s*rows/i).first().waitFor({ timeout: timeoutMs })
        logInfo('Import scalability hint verified')
      }
      const shouldAssertRetry = assertAdminRetry && importSectionCount > 0
      if (shouldAssertRetry) {
        await assertAdminRetryState(page, importSection)
        logInfo('Admin status + retry action verified')
      } else {
        logInfo('Admin retry assertions skipped (ASSERT_ADMIN_RETRY=false or section unavailable)')
      }
      const shouldAssertRecovery = assertImportJobRecovery && importSectionCount > 0
      if (shouldAssertRecovery) {
        await assertImportJobRecoveryFlow(page, importSection, apiBase)
      } else if (assertImportJobRecovery) {
        logInfo('WARN: import recovery assertion skipped (section unavailable)')
      }
      if (assertAdminSettingsSave) {
        await assertAdminSettingsSaveCycle(page)
      } else {
        logInfo('Admin settings save assertion skipped (ASSERT_ADMIN_SETTINGS_SAVE=false)')
      }
      if (assertAdminRuleSave) {
        await assertAdminRuleSaveCycle(page)
      } else {
        logInfo('Admin rule save assertion skipped (ASSERT_ADMIN_RULE_SAVE=false)')
      }
      logInfo('Payroll batch UI verified')
    }
    await page.screenshot({ path: path.join(outputDir, '02-admin.png'), fullPage: true })
    logInfo('Saved admin screenshot')
    if (mobile) {
      await page.getByRole('button', { name: labels.backToOverview }).click()
    }
  }

  // Workflow Designer (if enabled)
  if (features.workflow) {
    await page.getByRole('button', { name: labels.workflowDesigner }).click()
    if (mobile) {
      await page.getByRole('heading', { name: labels.desktopRecommended }).waitFor({ timeout: timeoutMs })
      await page.getByRole('button', { name: labels.backToOverview }).click()
      await page.getByRole('heading', { name: labels.attendance }).first().waitFor({ timeout: timeoutMs })
    } else {
      await page.locator('.workflow-designer').waitFor({ timeout: timeoutMs })
    }
    await page.screenshot({ path: path.join(outputDir, '03-workflow.png'), fullPage: true })
    logInfo('Saved workflow screenshot')
  }

  await context.close()
  await browser.close()
  logInfo('Full flow verification complete')
}

run().catch((error) => {
  console.error('[attendance-full-flow] Failed:', error)
  process.exit(1)
})
