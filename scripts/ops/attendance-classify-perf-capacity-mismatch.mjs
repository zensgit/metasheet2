import fs from 'node:fs/promises'

function toPositiveInt(value) {
  const num = Number(value)
  if (!Number.isFinite(num) || num <= 0) return null
  return Math.floor(num)
}

function toBooleanString(value) {
  return String(value || '').trim().toLowerCase()
}

function findLastFailureLine(logText) {
  const lines = String(logText || '')
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]
    if (/^\[attendance-import-perf\] Failed:/.test(line)) {
      return line.trim()
    }
  }
  const tail = lines.slice(-40).join(' ').trim()
  return tail || ''
}

function determineCsvUsage({ rowsValue, hintValue, uploadCsvValue, payloadSourceValue }) {
  if (uploadCsvValue !== 'true') return false
  if (payloadSourceValue === 'csv') return true
  if (payloadSourceValue !== 'auto') return false
  if (rowsValue === null || hintValue === null) return false
  return rowsValue <= hintValue
}

async function main() {
  const perfLogPath = process.env.PERF_LOG
  if (!perfLogPath) {
    console.error('PERF_LOG is required')
    process.exit(2)
  }

  const logText = await fs.readFile(perfLogPath, 'utf8')
  const lastFailureLine = findLastFailureLine(logText)
  if (!/CSV exceeds max rows/i.test(lastFailureLine)) {
    process.exit(1)
  }

  const rowsValue = toPositiveInt(process.env.ROWS)
  const hintValue = toPositiveInt(process.env.CSV_ROWS_LIMIT_HINT)
  const remoteEnvValue = toPositiveInt(process.env.REMOTE_CSV_ROWS_LIMIT)
  const uploadCsvValue = toBooleanString(process.env.UPLOAD_CSV)
  const payloadSourceValue = toBooleanString(process.env.PAYLOAD_SOURCE)
  const wouldUseCsv = determineCsvUsage({
    rowsValue,
    hintValue,
    uploadCsvValue,
    payloadSourceValue,
  })
  if (!wouldUseCsv || rowsValue === null || hintValue === null) {
    process.exit(1)
  }

  const remoteFromFailureMatch = lastFailureLine.match(/CSV exceeds max rows \((\d+)\)/i)
  const remoteFromFailureValue = toPositiveInt(remoteFromFailureMatch?.[1])
  const remoteLimitValue = remoteFromFailureValue ?? remoteEnvValue
  if (remoteLimitValue === null || rowsValue <= remoteLimitValue) {
    process.exit(1)
  }

  const payload = {
    classification: 'capacity_mismatch',
    requestedRows: rowsValue,
    payloadSourceRequested: payloadSourceValue || 'auto',
    uploadCsvRequested: uploadCsvValue === 'true',
    csvRowsLimitHint: hintValue,
    remoteCsvRowsLimit: remoteLimitValue,
    remoteCsvRowsLimitSource: remoteFromFailureValue !== null ? 'failure_line' : 'env',
    failureLine: lastFailureLine,
    suggestedAction: 'Align the high-scale gate with the deployed CSV row cap or raise ATTENDANCE_IMPORT_CSV_MAX_ROWS after capacity validation.',
  }

  const outputJson = JSON.stringify(payload, null, 2)
  const outputFile = process.env.OUTPUT_FILE
  if (outputFile) {
    await fs.writeFile(outputFile, `${outputJson}\n`, 'utf8')
  }
  process.stdout.write(`${outputJson}\n`)
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(2)
})
