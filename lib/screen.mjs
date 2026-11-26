/* Screen model for the Jarvis TUI: the bits of the viewport that are pure
 * arithmetic, so they can be tested without a terminal.
 *
 *  - scrolling through the transcript (state.scroll = rows scrolled up)
 *  - turning a drag selection into text
 *  - turning a pasted block into ONE line of input
 */

const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g

export const stripAnsi = (s) => String(s == null ? '' : s).replace(ANSI, '')

/** how far up the transcript we are allowed to be */
export function maxScroll(totalRows, bodyRows) {
  return Math.max(0, totalRows - bodyRows)
}

export function clampScroll(scroll, totalRows, bodyRows) {
  const v = Math.floor(Number(scroll) || 0)
  return Math.max(0, Math.min(maxScroll(totalRows, bodyRows), v))
}

/** the slice of rows on screen for a given scroll offset */
export function windowRows(rows, bodyRows, scroll) {
  const total = rows.length
  const s = clampScroll(scroll, total, bodyRows)
  const end = total - s
  const start = Math.max(0, end - bodyRows)
  return { rows: rows.slice(start, end), scroll: s, hidden: start }
}

/** order two drag points into a top-left / bottom-right selection */
export function normalizeSelection(a, b) {
  if (!a || !b) return null
  const before = (a.y < b.y) || (a.y === b.y && a.x <= b.x)
  const [p, q] = before ? [a, b] : [b, a]
  return { r1: p.y, c1: p.x, r2: q.y, c2: q.x }
}

/**
 * Text under a selection. `rows` are plain (ANSI stripped) screen rows.
 * Coordinates are 1-based mouse columns/rows, exactly as the terminal sends them.
 */
export function selectionText(rows, sel) {
  if (!sel || !rows.length) return ''
  const n = normalizeSelection({ x: sel.c1, y: sel.r1 }, { x: sel.c2, y: sel.r2 })
  if (!n) return ''
  const out = []
  for (let r = n.r1; r <= n.r2; r++) {
    const row = rows[r - 1]
    if (row == null) continue
    const from = r === n.r1 ? Math.max(0, n.c1 - 1) : 0
    const to = r === n.r2 ? Math.max(0, n.c2) : row.length
    out.push(row.slice(from, to).replace(/\s+$/, ''))
  }
  // a single-line selection keeps its own spacing; multi-line drops the padding
  const text = out.join('\n')
  return n.r1 === n.r2 ? text : text.split('\n').map((l) => l.replace(/\s+$/, '')).join('\n')
}

/**
 * A pasted block becomes ONE continuous message: newlines and runs of spaces
 * collapse to a single space, so pressing Enter once sends the whole thing.
 */
export function pasteLine(text) {
  return String(text == null ? '' : text)
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .join(' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

/** visible text with the cursor drawn as a block (used when the terminal blinks) */
export function withCursor(line, pos) {
  const p = Math.max(0, Math.min(line.length, pos))
  return line.slice(0, p) + '\u258f' + line.slice(p)
}

/** Character class used when double-clicking a word on screen. */
const WORD_CHAR = /[\w@./\\:-]/

/** 1-based inclusive column range of the word at col, or null in blank space. */
export function wordBounds(line, col) {
  const text = String(line == null ? '' : line)
  if (!text.trim()) return null
  let a = Math.max(0, Math.min(col - 1, text.length - 1))
  if (!WORD_CHAR.test(text[a])) {
    let k = a
    while (k < text.length && !WORD_CHAR.test(text[k])) k++
    if (k >= text.length) {
      k = a
      while (k > 0 && !WORD_CHAR.test(text[k])) k--
    }
    a = k
  }
  if (!WORD_CHAR.test(text[a])) return null
  let b = a
  while (a > 0 && WORD_CHAR.test(text[a - 1])) a--
  while (b < text.length - 1 && WORD_CHAR.test(text[b + 1])) b++
  return { c1: a + 1, c2: b + 1, word: text.slice(a, b + 1) }
}

/** 1-based inclusive range of the visible line, trailing spaces trimmed. */
export function lineBounds(line) {
  const text = String(line == null ? '' : line)
  const end = Math.max(1, text.replace(/\s+$/, '').length)
  return { c1: 1, c2: end }
}

export default { stripAnsi, maxScroll, clampScroll, windowRows, normalizeSelection, selectionText, pasteLine, withCursor, wordBounds, lineBounds }
