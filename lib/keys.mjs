/* Raw stdin parser for the Jarvis TUI.
 *
 * readline cannot express what we need: bracketed paste (a pasted block must
 * arrive as ONE message, not as a burst of Enters) and SGR mouse events
 * (wheel = scroll, drag = select, right click = copy). So the TUI reads raw
 * stdin chunks and this module turns them into a flat event list.
 *
 * Pure function, no I/O: every escape sequence below is unit tested.
 */

const PASTE_START = '\x1b[200~'
const PASTE_END = '\x1b[201~'

const CTRL = {
  '\x03': 'c', '\x0c': 'l', '\x01': 'a', '\x05': 'e', '\x15': 'u', '\x17': 'w',
  '\x16': 'v', '\x18': 'x',
}

const CSI = {
  A: 'up', B: 'down', C: 'right', D: 'left',
  H: 'home', F: 'end',
}

const TILDE = {
  1: 'home', 7: 'home', 4: 'end', 8: 'end',
  2: 'insert', 3: 'delete', 5: 'pgup', 6: 'pgdn', Z: 'backtab',
}

export const MOUSE_ON = '\x1b[?1000h\x1b[?1006h'
export const MOUSE_OFF = '\x1b[?1000l\x1b[?1006l'
export const PASTE_ON = '\x1b[?2004h'
export const PASTE_OFF = '\x1b[?2004l'

/** decode an SGR mouse report: ESC [ < Cb ; Cx ; Cy M|m */
export function parseMouse(cb, cx, cy, final) {
  const x = cx
  const y = cy
  if (cb & 64) {
    return cb === 64 ? { type: 'mouse', button: 'wheelup', x, y }
      : { type: 'mouse', button: 'wheeldown', x, y }
  }
  const base = cb & 3
  const motion = (cb & 32) !== 0
  const released = final === 'm' || base === 3
  const name = base === 0 ? 'left' : base === 1 ? 'middle' : base === 2 ? 'right' : 'none'
  if (released) return { type: 'mouse', button: 'release', last: name, x, y }
  if (motion) return { type: 'mouse', button: 'motion', last: name, x, y }
  return { type: 'mouse', button: name, x, y }
}

/** one raw chunk -> ordered events */
export function parseInput(chunk) {
  const events = []
  let text = ''
  const flushText = () => {
    if (text) { events.push({ type: 'text', value: text }); text = '' }
  }
  let i = 0
  while (i < chunk.length) {
    // ---- bracketed paste: swallow everything up to the end marker
    if (chunk.startsWith(PASTE_START, i)) {
      flushText()
      const end = chunk.indexOf(PASTE_END, i + PASTE_START.length)
      const body = end === -1 ? chunk.slice(i + PASTE_START.length) : chunk.slice(i + PASTE_START.length, end)
      events.push({ type: 'paste', value: body })
      i = end === -1 ? chunk.length : end + PASTE_END.length
      continue
    }

    // ---- SGR mouse
    if (chunk.startsWith('\x1b[<', i)) {
      const m = chunk.slice(i).match(/^\x1b\[<(\d+);(\d+);(\d+)([Mm])/)
      if (m) {
        flushText()
        events.push(parseMouse(Number(m[1]), Number(m[2]), Number(m[3]), m[4]))
        i += m[0].length
        continue
      }
    }

    // ---- CSI sequences
    if (chunk[i] === '\x1b' && chunk[i + 1] === '[') {
      const m = chunk.slice(i).match(/^\x1b\[([0-9;?]*)([A-Za-z~])/)
      if (m) {
        flushText()
        const param = m[1]
        const fin = m[2]
        if (fin === '~') {
          const first = Number(String(param).split(';')[0])
          const name = TILDE[first]
          if (name && name !== 'backtab') events.push({ type: name })
        } else if (CSI[fin]) {
          events.push({ type: CSI[fin] })
        }
        i += m[0].length
        continue
      }
      // lone ESC[ — treat the ESC as esc
      flushText()
      events.push({ type: 'esc' })
      i += 1
      continue
    }

    const ch = chunk[i]

    // ---- escapes that are not CSI
    if (ch === '\x1b') {
      const next = chunk[i + 1]
      if (next === undefined || next !== '[') {
        flushText()
        // ESC O A/B/C/D as well (application cursor keys)
        if (next === 'O' && CSI[chunk[i + 2]]) {
          events.push({ type: CSI[chunk[i + 2]] })
          i += 3
          continue
        }
        events.push({ type: 'esc' })
        i += 1
        continue
      }
    }

    // ---- control characters
    if (ch === '\r' || ch === '\n') { flushText(); events.push({ type: 'enter' }); i += 1; continue }
    if (ch === '\t') { flushText(); events.push({ type: 'tab' }); i += 1; continue }
    if (ch === '\x7f' || ch === '\x08') { flushText(); events.push({ type: 'backspace' }); i += 1; continue }
    if (CTRL[ch]) { flushText(); events.push({ type: 'ctrl', key: CTRL[ch] }); i += 1; continue }
    if (ch < ' ') { i += 1; continue }   // unknown control: ignore

    text += ch
    i += 1
  }
  flushText()
  return events
}

export default { parseInput, parseMouse, MOUSE_ON, MOUSE_OFF, PASTE_ON, PASTE_OFF }
