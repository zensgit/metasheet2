'use strict'

const FEATURE_DISABLED_CODE = 'FEATURE_DISABLED'
const FEATURE_DISABLED_MESSAGE = 'Feature is disabled'

function sendFeatureDisabled(res) {
  res.status(404).json({
    ok: false,
    error: {
      code: FEATURE_DISABLED_CODE,
      message: FEATURE_DISABLED_MESSAGE,
    },
  })
}

module.exports = {
  FEATURE_DISABLED_CODE,
  FEATURE_DISABLED_MESSAGE,
  sendFeatureDisabled,
}
