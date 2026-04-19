export interface DingTalkGroupDestination {
  id: string
  name: string
  webhookUrl: string
  secret?: string
  enabled: boolean
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
