'use strict'

const { isDeepStrictEqual } = require('node:util')

/** Only the canonical import's source-consumption path calls this. Ordinary
 * frozen_prior recompute never enters this helper or reads a new policy. */
function createAttendanceCalc14ImportPolicy({HttpError,sourceReader}) {
  async function load(trx,{orgId,userId,workDate,payload}) {
    const candidates=await sourceReader.loadPublishedCandidates(trx,{orgId,userId,workDates:[workDate]})
    if (candidates.length!==1) throw new HttpError(422,'ATTENDANCE_CALC14_SOURCE_HISTORY_INCOMPLETE','ATTENDANCE_CALC14_SOURCE_HISTORY_INCOMPLETE')
    const candidate=candidates[0]
    const sources=candidate.calc14Sources
    const ruleSet=sources.ruleSet
    if (payload.ruleSetId && payload.ruleSetId!==ruleSet?.id) {
      throw new HttpError(409,'ATTENDANCE_CALC14_RULE_SET_SOURCE_MISMATCH','ATTENDANCE_CALC14_RULE_SET_SOURCE_MISMATCH')
    }
    if (payload.engine && !isDeepStrictEqual(payload.engine,ruleSet?.config?.engine ?? null)) {
      throw new HttpError(409,'ATTENDANCE_CALC14_RULE_SET_SOURCE_MISMATCH','ATTENDANCE_CALC14_RULE_SET_SOURCE_MISMATCH')
    }
    // JSON tuple, never delimiter-concatenated: both organization and retained
    // source identity/version participate, including the org-default case.
    const cacheKey=JSON.stringify([orgId,ruleSet?.id ?? null,ruleSet?.__calc14_version ?? sources.rule.__calc14_version,workDate])
    return {candidate,sources,ruleSetId:ruleSet?.id ?? null,config:ruleSet?.config ?? null,cacheKey,
      ruleVersion:ruleSet ? `rule-set:${ruleSet.id}:source-version:${ruleSet.__calc14_version}`
        : `org-default-rule:source-version:${sources.rule.__calc14_version}`}
  }
  return {load}
}

module.exports={createAttendanceCalc14ImportPolicy}
