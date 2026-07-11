/**
 * Inline image magic-byte sniffing — no new dependency (H2 photo-evidence-hardening
 * design-lock, 2026-07-10, P3-1).
 *
 * Defect this closes: a `files` row's `meta.contentType` is client-asserted (multer
 * trusts whatever the multipart `Content-Type` part header claims), so a forged
 * `image/png` declaration on a non-image body previously sailed through attendance's
 * G2 outdoor-punch photo-evidence check (`image/*` string match against the
 * self-reported value). This sniffs the first bytes of the uploaded buffer against a
 * handful of well-known image signatures and returns the *detected* content-type —
 * independent of whatever the client claimed.
 *
 * This module does NOT reject anything — `POST /api/files/upload` is a general-purpose
 * file-upload route (attachments, exports, etc. all flow through it), and changing it
 * to refuse non-image uploads would change its existing semantics for every caller.
 * The sniff result is advisory: callers (here, the attendance G2 gate) decide what a
 * miss means for their own domain.
 */

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47]
const JPEG_SIGNATURE = [0xff, 0xd8, 0xff]
const GIF_SIGNATURE = [0x47, 0x49, 0x46, 0x38] // "GIF8" (covers GIF87a + GIF89a)
const BMP_SIGNATURE = [0x42, 0x4d] // "BM"
const RIFF_SIGNATURE = [0x52, 0x49, 0x46, 0x46] // "RIFF"
const WEBP_SIGNATURE = [0x57, 0x45, 0x42, 0x50] // "WEBP" (bytes 8-11 of a RIFF container)

function matchesAt(buffer: Buffer, offset: number, signature: number[]): boolean {
  if (buffer.length < offset + signature.length) return false
  for (let i = 0; i < signature.length; i++) {
    if (buffer[offset + i] !== signature[i]) return false
  }
  return true
}

/**
 * Returns the detected image content-type for `buffer`'s leading bytes, or
 * `undefined` when no known image signature matches (including when the buffer is
 * too short to hold any signature — never throws, never indexes out of bounds).
 */
export function sniffImageContentType(buffer: Buffer | undefined | null): string | undefined {
  if (!buffer || buffer.length === 0) return undefined
  if (matchesAt(buffer, 0, PNG_SIGNATURE)) return 'image/png'
  if (matchesAt(buffer, 0, JPEG_SIGNATURE)) return 'image/jpeg'
  if (matchesAt(buffer, 0, GIF_SIGNATURE)) return 'image/gif'
  if (matchesAt(buffer, 0, BMP_SIGNATURE)) return 'image/bmp'
  // WEBP is a RIFF container: bytes 0-3 "RIFF", bytes 4-7 file size (ignored), bytes 8-11 "WEBP".
  if (matchesAt(buffer, 0, RIFF_SIGNATURE) && matchesAt(buffer, 8, WEBP_SIGNATURE)) return 'image/webp'
  return undefined
}
