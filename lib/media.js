'use strict'
/* Media route resolution — pure, so it can be unit tested. */

const path = require('path')

const AUDIO_MIME = {
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.flac': 'audio/flac',
  '.ogg': 'audio/ogg',
}

/**
 * Turn an app:// request pathname of the form /media/<encoded absolute path>
 * into a resolved target. Never touches the disk.
 * @returns {{ok: true, abs: string, mime: string} | {ok: false, status: number, error: string}}
 */
function resolveMediaTarget(urlPath) {
  if (typeof urlPath !== 'string' || !urlPath.startsWith('/media/')) {
    return { ok: false, status: 400, error: 'not a media path' }
  }
  let abs
  try {
    abs = decodeURIComponent(urlPath.slice('/media/'.length))
  } catch {
    return { ok: false, status: 400, error: 'bad encoding' }
  }
  abs = abs.replace(/\0/g, '')
  if (!abs || !path.isAbsolute(abs)) return { ok: false, status: 400, error: 'path must be absolute' }
  const mime = AUDIO_MIME[path.extname(abs).toLowerCase()]
  if (!mime) return { ok: false, status: 415, error: 'unsupported type' }
  return { ok: true, abs, mime }
}

module.exports = { resolveMediaTarget, AUDIO_MIME }
