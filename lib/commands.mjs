/* Slash-command parsing for the Jarvis prompt line. */

export const KNOWN = [
  'help', 'music', 'dashboard', 'hardware', 'settings',
  'attach', 'voice', 'clear', 'clr', 'new', 'back',
  'open', 'run', 'read', 'reminders', 'notes',
]

/* Slash forms of the instant commands: /open notepad → open notepad */
const ALIAS_AS_ASK = new Set(['open', 'run', 'read'])

const KNOWN_SET = new Set(KNOWN)

/**
 * "/clr"      → { type: 'command', name: 'clr', arg: '', known: true }
 * "hi there"  → { type: 'ask', text: 'hi there' }
 * ""          → { type: 'empty' }
 */
export function parseCommand(text) {
  const raw = typeof text === 'string' ? text.trim() : ''
  if (!raw) return { type: 'empty' }
  if (raw[0] !== '/') return { type: 'ask', text: raw }
  const parts = raw.slice(1).split(/\s+/)
  const name = (parts.shift() || '').toLowerCase()
  const arg = parts.join(' ').trim()
  if (!name) return { type: 'empty' }
  if (ALIAS_AS_ASK.has(name) && arg) return { type: 'ask', text: `${name} ${arg}` }
  return { type: 'command', name, arg, known: KNOWN_SET.has(name) }
}
