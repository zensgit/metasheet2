export interface DingTalkGroupDestination {
  id: string
  name: string
  webhookUrl: string
  secret?: string
  hasSecret?: boolean
  enabled: boolean
  scope: 'private' | 'sheet' | 'org'
  sheetId?: string
  orgId?: string
  createdBy: string
  createdAt: string
  updatedAt?: string
  lastTestedAt?: string
  lastTestStatus?: 'success' | 'failed'
  lastTestError?: string
}

export interface DingTalkGroupDestinationCreateInput {
  name: string
  webhookUrl: string
  secret?: string
  enabled?: boolean
  scope?: 'private' | 'sheet' | 'org'
  sheetId?: string
  orgId?: string
}

export interface DingTalkGroupDestinationUpdateInput {
  name?: string
  webhookUrl?: string
  secret?: string
  enabled?: boolean
}

export interface DingTalkGroupTestSendInput {
  subject?: string
  content?: string
}

export interface DingTalkGroupDelivery {
  id: string
  destinationId: string
  sourceType: 'manual_test' | 'automation'
  subject: string
  content: string
  success: boolean
  httpStatus?: number
  responseBody?: string
  errorMessage?: string
  automationRuleId?: string
  recordId?: string
  initiatedBy?: string
  createdAt: string
  deliveredAt?: string
}
