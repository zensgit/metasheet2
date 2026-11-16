import { describe, expect, it } from 'vitest'
import {
  FORBID_CONTROL,
  FORBID_WHITESPACE,
  productionProviderNotificationRegistry,
  type ProviderTransportDescriptor,
} from '../../src/notifications/provider-notification-registry'
import { normalizeAddress } from '../../src/notifications/witness'

const [dingtalk] = productionProviderNotificationRegistry()

// Shapes of the providers planned next, used only to check that the descriptor shape is enough.
const wecom: Pick<ProviderTransportDescriptor, 'forbiddenInAddress' | 'maxAddressLength'> = {
  forbiddenInAddress: ['|', '@all', FORBID_WHITESPACE, FORBID_CONTROL],
  maxAddressLength: 64,
}
const feishu: Pick<ProviderTransportDescriptor, 'forbiddenInAddress' | 'maxAddressLength'> = {
  forbiddenInAddress: [FORBID_WHITESPACE, FORBID_CONTROL],
  maxAddressLength: 64,
}

const bad = { ok: false, code: 'address_unusable' } as const

describe('address normalization (DingTalk)', () => {
  it('removes surrounding whitespace and keeps the rest, case included', () => {
    expect(normalizeAddress(dingtalk, '  Abc123 ')).toEqual({ ok: true, address: 'Abc123' })
    expect(normalizeAddress(dingtalk, '\tuser-1\n')).toEqual({ ok: true, address: 'user-1' })
  })

  it('treats a missing or blank value as missing', () => {
    for (const raw of [undefined, null, '', '   ', 5, {}]) {
      expect(normalizeAddress(dingtalk, raw), String(raw)).toEqual({ ok: false, code: 'address_missing' })
    }
  })

  it('refuses a value that could name several recipients', () => {
    for (const raw of ['a,b', ',', 'a, b', 'a b', 'a b', 'a　b']) {
      expect(normalizeAddress(dingtalk, raw), JSON.stringify(raw)).toEqual(bad)
    }
  })

  it('refuses control characters anywhere', () => {
    for (const raw of ['a\u0000b', 'a\u0007b', 'a\u007fb', 'a\u0085b']) {
      expect(normalizeAddress(dingtalk, raw), JSON.stringify(raw)).toEqual(bad)
    }
  })

  it('accepts the longest allowed value and refuses one longer', () => {
    expect(normalizeAddress(dingtalk, 'x'.repeat(128))).toEqual({ ok: true, address: 'x'.repeat(128) })
    expect(normalizeAddress(dingtalk, 'x'.repeat(129))).toEqual(bad)
  })
})

describe('address normalization (descriptor shapes of other providers)', () => {
  it('refuses the separator, the broadcast keyword and whitespace for WeCom', () => {
    for (const raw of ['a|b', '@all', 'x@ally', 'a b']) {
      expect(normalizeAddress(wecom, raw), raw).toEqual(bad)
    }
    expect(normalizeAddress(wecom, 'zhangsan')).toEqual({ ok: true, address: 'zhangsan' })
  })

  it('allows a comma where the descriptor does not forbid it, and refuses whitespace for Feishu', () => {
    expect(normalizeAddress(feishu, 'ou_abc,def')).toEqual({ ok: true, address: 'ou_abc,def' })
    expect(normalizeAddress(feishu, 'ou abc')).toEqual(bad)
  })

  it('applies the length limit of the descriptor', () => {
    expect(normalizeAddress({ forbiddenInAddress: [], maxAddressLength: 3 }, 'abcd')).toEqual(bad)
    expect(normalizeAddress({ forbiddenInAddress: [], maxAddressLength: 3 }, 'abc')).toEqual({ ok: true, address: 'abc' })
  })
})
