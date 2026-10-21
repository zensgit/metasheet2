import { existsSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import {
  evaluateElearningMediaProbeJson,
  probeElearningMediaBuffer,
} from '../../src/services/elearning-media-probe'

function isoBmffFtypBuffer(extraBytes = 16): Buffer {
  const buf = Buffer.alloc(8 + extraBytes)
  buf.writeUInt32BE(buf.length, 0)
  buf.write('ftyp', 4)
  buf.write('isom', 8)
  return buf
}

const h264Aac = {
  streams: [
    { codec_type: 'video', codec_name: 'h264' },
    { codec_type: 'audio', codec_name: 'aac' },
  ],
  format: { duration: '12.5' },
}

describe('elearning media probe', () => {
  it('accepts H.264 with AAC or silent video and a finite positive duration from ffprobe JSON only', () => {
    expect(evaluateElearningMediaProbeJson(h264Aac)).toEqual({ ok: true, durationMs: 12_500 })
    expect(evaluateElearningMediaProbeJson({
      streams: [{ codec_type: 'video', codec_name: 'h264' }],
      format: { duration: '1' },
    })).toEqual({ ok: true, durationMs: 1000 })
  })

  it('rejects unsupported codecs, missing video, non-finite duration, and malformed probe JSON', () => {
    expect(evaluateElearningMediaProbeJson({
      streams: [
        { codec_type: 'video', codec_name: 'hevc' },
        { codec_type: 'audio', codec_name: 'aac' },
      ],
      format: { duration: '1' },
    })).toEqual({ ok: false, reason: 'unsupported_codec' })
    expect(evaluateElearningMediaProbeJson({
      streams: [
        { codec_type: 'video', codec_name: 'h264' },
        { codec_type: 'audio', codec_name: 'mp3' },
      ],
      format: { duration: '1' },
    })).toEqual({ ok: false, reason: 'unsupported_codec' })
    expect(evaluateElearningMediaProbeJson({
      streams: [{ codec_type: 'audio', codec_name: 'aac' }],
      format: { duration: '1' },
    })).toEqual({ ok: false, reason: 'unsupported_codec' })
    expect(evaluateElearningMediaProbeJson({
      streams: [{ codec_type: 'video', codec_name: 'h264' }],
      format: { duration: 'not-a-number' },
    })).toEqual({ ok: false, reason: 'invalid_duration' })
    expect(evaluateElearningMediaProbeJson({
      streams: [{ codec_type: 'video', codec_name: 'h264' }],
      format: { duration: 'Infinity' },
    })).toEqual({ ok: false, reason: 'invalid_duration' })
    expect(evaluateElearningMediaProbeJson({
      streams: [{ codec_type: 'video', codec_name: 'h264' }],
      format: { duration: '0' },
    })).toEqual({ ok: false, reason: 'invalid_duration' })
    expect(evaluateElearningMediaProbeJson(null)).toEqual({ ok: false, reason: 'probe_failed' })
  })

  it('never uses a client duration field on the probe document', () => {
    expect(evaluateElearningMediaProbeJson({
      streams: [{ codec_type: 'video', codec_name: 'h264' }],
      format: { duration: '2' },
      duration: '9999',
      clientDuration: '9999',
    })).toEqual({ ok: true, durationMs: 2000 })
  })

  it('writes a unique temp file, invokes the injected runner without a user filename, and always removes the dir', async () => {
    const seen: string[] = []
    let capturedPath = ''
    const outcome = await probeElearningMediaBuffer(isoBmffFtypBuffer(), {
      runner: async (filePath) => {
        capturedPath = filePath
        seen.push(filePath)
        expect(filePath.endsWith('upload.mp4')).toBe(true)
        expect(filePath).not.toMatch(/evil|user|client/i)
        expect(existsSync(filePath)).toBe(true)
        return { stdout: JSON.stringify(h264Aac) }
      },
    })
    expect(outcome).toEqual({ ok: true, durationMs: 12_500 })
    expect(seen).toHaveLength(1)
    expect(existsSync(capturedPath)).toBe(false)
  })

  it('maps runner failure to probe_failed and still removes the temp dir', async () => {
    let capturedPath = ''
    const outcome = await probeElearningMediaBuffer(isoBmffFtypBuffer(), {
      runner: async (filePath) => {
        capturedPath = filePath
        throw new Error('ffprobe missing')
      },
    })
    expect(outcome).toEqual({ ok: false, reason: 'probe_failed' })
    expect(existsSync(capturedPath)).toBe(false)
  })
})
