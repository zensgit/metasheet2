#!/usr/bin/env node

import fs from 'fs'
import path from 'path'
import { chromium } from '@playwright/test'

const DEFAULT_WEB_BASE = 'http://127.0.0.1:8081'
const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_OUTPUT_DIR = 'output/playwright/dingtalk-login-e2e-smoke'

function parseArgs(argv) {
  let webBase = process.env.WEB_BASE || DEFAULT_WEB_BASE
  let timeoutMs = Number(process.env.TIMEOUT_MS || DEFAULT_TIMEOUT_MS)
  let outputDir = process.env.OUTPUT_DIR || DEFAULT_OUTPUT_DIR
  let headless = process.env.HEADLESS !== 'false'
  let help = false

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if ((arg === '--web-base' || arg === '--base-url') && argv[i + 1]) {
      webBase = argv[i + 1]
      i += 1
    } else if (arg === '--timeout' && argv[i + 1]) {
      timeoutMs = Number(argv[i + 1]) || DEFAULT_TIMEOUT_MS
      i += 1
    } else if (arg === '--output-dir' && argv[i + 1]) {
      outputDir = argv[i + 1]
      i += 1
    } else if (arg === '--headed') {
      headless = false
    } else if (arg === '--headless') {
      headless = true
    } else if (arg === '--help' || arg === '-h') {
      help = true
    }
  }

  return {
    webBase: String(webBase || DEFAULT_WEB_BASE).trim().replace(/\/+$/, ''),
    timeoutMs,
    outputDir: String(outputDir || DEFAULT_OUTPUT_DIR).trim(),
    headless,
    help,
  }
}

function printHelp() {
  console.log(`Usage: node scripts/dingtalk-login-e2e-smoke.mjs [options]

Browser smoke for DingTalk login.

Options:
  --web-base <url>     Web base URL (default: ${DEFAULT_WEB_BASE})
  --timeout <ms>       Timeout per major step (default: ${DEFAULT_TIMEOUT_MS})
  --output-dir <dir>   Output directory (default: ${DEFAULT_OUTPUT_DIR})
  --headed             Run headed browser
  --headless           Run headless browser
  --help, -h           Show this help

Scenarios:
  1. Login page shows the DingTalk button when launch is reachable
  2. Clicking the DingTalk button redirects to the DingTalk auth URL
  3. Login page hides the DingTalk button when launch is forced to 503
  4. Callback page shows the missing-code error
  5. Callback page shows the invalid-state error
  6. Simulated successful callback stores the token and redirects away from the callback route

Artifacts:
  - summary.json
  - *.png screenshots under output/playwright/
`)
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true })
}

const report = {
  ok: true,
  webBase: '',
  timeoutMs: 0,
  headless: true,
  checks: [],
  screenshots: {},
}

function record(name, ok, details = {}) {
  report.checks.push({ name, ok, ...details })
  if (!ok) report.ok = false
}

async function screenshot(page, outputDir, name) {
  const filePath = path.join(outputDir, `${name}.png`)
  await page.screenshot({ path: filePath, fullPage: true })
  report.screenshots[name] = filePath
  return filePath
}

async function gotoLogin(page, webBase, timeoutMs) {
  await page.goto(`${webBase}/login`, {
    waitUntil: 'networkidle',
    timeout: timeoutMs,
  })
  await page.getByRole('heading', { name: '登录' }).waitFor({ timeout: timeoutMs })
}

async function verifyVisibleLaunchAndRedirect(browser, opts) {
  const context = await browser.newContext()
  await context.route('https://login.dingtalk.com/**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'text/html; charset=utf-8',
      body: '<!doctype html><html><body><h1>Mock DingTalk Auth</h1></body></html>',
    })
  })

  const page = await context.newPage()
  try {
    await gotoLogin(page, opts.webBase, opts.timeoutMs)

    const dingTalkButton = page.getByRole('button', { name: '钉钉登录' })
    await dingTalkButton.waitFor({ state: 'visible', timeout: opts.timeoutMs })
    record('login.button.visible', true)
    await screenshot(page, opts.outputDir, '01-login-visible')

    await Promise.all([
      page.waitForURL((url) => url.hostname === 'login.dingtalk.com', { timeout: opts.timeoutMs }),
      dingTalkButton.click(),
    ])

    record('login.redirect.external', page.url().includes('login.dingtalk.com/oauth2/auth'), {
      url: page.url(),
    })
    await screenshot(page, opts.outputDir, '02-dingtalk-redirect')
  } finally {
    await context.close()
  }
}

async function verifyHiddenWhenLaunchUnavailable(browser, opts) {
  const context = await browser.newContext()
  await context.route('**/api/auth/dingtalk/launch', async (route) => {
    await route.fulfill({
      status: 503,
      contentType: 'application/json; charset=utf-8',
      body: JSON.stringify({
        success: false,
        error: 'DingTalk login is not configured on this server',
      }),
    })
  })

  const page = await context.newPage()
  try {
    await gotoLogin(page, opts.webBase, opts.timeoutMs)
    await page.waitForTimeout(500)

    const dingTalkButtons = await page.getByRole('button', { name: '钉钉登录' }).count()
    const hidden = dingTalkButtons === 0
    record('login.button.hidden.on-503', hidden, { buttonCount: dingTalkButtons })
    await screenshot(page, opts.outputDir, '03-login-hidden-when-launch-unavailable')
  } finally {
    await context.close()
  }
}

async function verifyMissingCodeError(browser, opts) {
  const context = await browser.newContext()
  const page = await context.newPage()
  try {
    await page.goto(`${opts.webBase}/auth/dingtalk/callback`, {
      waitUntil: 'networkidle',
      timeout: opts.timeoutMs,
    })

    const errorText = page.locator('.dingtalk-callback__error-text')
    await errorText.waitFor({ timeout: opts.timeoutMs })
    const text = (await errorText.textContent())?.trim() || ''
    record('callback.error.missing-code', text.includes('缺少授权码参数'), { text })
    await screenshot(page, opts.outputDir, '04-callback-missing-code')

    await page.getByRole('button', { name: '返回登录' }).click()
    await page.waitForURL((url) => url.pathname === '/login', { timeout: opts.timeoutMs })
    record('callback.error.return-login', true, { url: page.url() })
  } finally {
    await context.close()
  }
}

async function verifyInvalidStateError(browser, opts) {
  const context = await browser.newContext()
  const page = await context.newPage()
  try {
    await page.goto(`${opts.webBase}/auth/dingtalk/callback?code=dummy-code&state=invalid-state`, {
      waitUntil: 'networkidle',
      timeout: opts.timeoutMs,
    })

    const errorText = page.locator('.dingtalk-callback__error-text')
    await errorText.waitFor({ timeout: opts.timeoutMs })
    const text = (await errorText.textContent())?.trim() || ''
    const ok = text.includes('Invalid or unknown state parameter')
      || text.includes('State parameter has expired')
      || text.includes('钉钉登录失败')
    record('callback.error.invalid-state', ok, { text })
    await screenshot(page, opts.outputDir, '05-callback-invalid-state')
  } finally {
    await context.close()
  }
}

async function verifySimulatedSuccess(browser, opts) {
  const context = await browser.newContext()
  await context.route('**/api/auth/dingtalk/callback', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json; charset=utf-8',
      body: JSON.stringify({
        success: true,
        data: {
          token: 'jwt-dingtalk-smoke-token',
          user: {
            id: 'smoke-user-1',
            email: 'smoke@example.com',
            name: 'Smoke User',
            role: 'admin',
          },
          features: {
            attendance: true,
            workflow: true,
            attendanceAdmin: true,
            attendanceImport: true,
            mode: 'attendance',
          },
        },
      }),
    })
  })

  const page = await context.newPage()
  try {
    await page.goto(`${opts.webBase}/auth/dingtalk/callback?code=mock-code&state=mock-state`, {
      waitUntil: 'domcontentloaded',
      timeout: opts.timeoutMs,
    })

    await page.waitForURL((url) => url.pathname !== '/auth/dingtalk/callback', {
      timeout: opts.timeoutMs,
    })

    const token = await page.evaluate(() => localStorage.getItem('auth_token'))
    const redirected = new URL(page.url()).pathname !== '/auth/dingtalk/callback'
    record('callback.success.simulated', redirected && token === 'jwt-dingtalk-smoke-token', {
      url: page.url(),
      tokenStored: token === 'jwt-dingtalk-smoke-token',
    })
    await screenshot(page, opts.outputDir, '06-callback-success-simulated')
  } finally {
    await context.close()
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2))
  if (opts.help) {
    printHelp()
    process.exit(0)
  }

  ensureDir(opts.outputDir)
  report.webBase = opts.webBase
  report.timeoutMs = opts.timeoutMs
  report.headless = opts.headless

  const browser = await chromium.launch({ headless: opts.headless })
  try {
    await verifyVisibleLaunchAndRedirect(browser, opts)
    await verifyHiddenWhenLaunchUnavailable(browser, opts)
    await verifyMissingCodeError(browser, opts)
    await verifyInvalidStateError(browser, opts)
    await verifySimulatedSuccess(browser, opts)
  } finally {
    await browser.close()
  }

  const summaryPath = path.join(opts.outputDir, 'summary.json')
  fs.writeFileSync(summaryPath, `${JSON.stringify(report, null, 2)}\n`)
  console.log(JSON.stringify(report, null, 2))
  process.exit(report.ok ? 0 : 1)
}

main().catch((error) => {
  report.ok = false
  report.error = error instanceof Error ? error.message : String(error)
  ensureDir(DEFAULT_OUTPUT_DIR)
  const summaryPath = path.join(DEFAULT_OUTPUT_DIR, 'summary.json')
  fs.writeFileSync(summaryPath, `${JSON.stringify(report, null, 2)}\n`)
  console.error(report.error)
  process.exit(1)
})
