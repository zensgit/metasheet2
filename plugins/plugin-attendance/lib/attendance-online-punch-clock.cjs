const CLIENT_TIMESTAMP_CODE = 'PUNCH_CLIENT_TIMESTAMP_FORBIDDEN'
const CLIENT_TIMESTAMP_MESSAGE = 'The server determines online punch time'
let testInstant = null

function hasClientPunchTimestamp(body) {
  return body !== null && typeof body === 'object'
    && (Object.hasOwn(body, 'occurredAt') || Object.hasOwn(body, 'occurred_at'))
}

function getOnlinePunchServerInstant() {
  return new Date(process.env.NODE_ENV === 'test' && testInstant !== null ? testInstant : Date.now())
}

function setOnlinePunchInstantForTests(value) {
  if (process.env.NODE_ENV !== 'test') throw new Error('ONLINE_PUNCH_TEST_CLOCK_FORBIDDEN')
  if (value === null) {
    testInstant = null
    return
  }
  const instant = new Date(value).getTime()
  if (!Number.isFinite(instant)) throw new Error('ONLINE_PUNCH_TEST_CLOCK_INVALID')
  testInstant = instant
}

module.exports = {
  CLIENT_TIMESTAMP_CODE,
  CLIENT_TIMESTAMP_MESSAGE,
  hasClientPunchTimestamp,
  getOnlinePunchServerInstant,
  setOnlinePunchInstantForTests,
}
