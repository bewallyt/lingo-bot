export type SlackMessageEvent = {
  type: string
  subtype?: string
  user?: string
  bot_id?: string
  bot_profile?: unknown
  text?: string
  ts: string
  thread_ts?: string
  channel: string
  channel_type?: string
}

// file_share keeps captioned photos translatable; thread_broadcast is a normal
// human reply that was also sent to the channel. Everything else (bot_message,
// message_changed, message_deleted, joins, ...) is skipped.
const ALLOWED_SUBTYPES = new Set<string | undefined>([undefined, 'file_share', 'thread_broadcast'])

const ALLOWED_CHANNEL_TYPES = new Set(['group', 'mpim', 'im', 'channel'])

export type SkipReason =
  | 'not-a-message'
  | 'bot-authored'
  | 'subtype-not-allowed'
  | 'no-user'
  | 'channel-type'
  | 'no-text'

export function getSkipReason(event: SlackMessageEvent | undefined): SkipReason | null {
  if (!event || event.type !== 'message') return 'not-a-message'
  // #1 loop guard: the bot's own threaded replies come back as message events
  if (event.bot_id || event.bot_profile) return 'bot-authored'
  if (!ALLOWED_SUBTYPES.has(event.subtype)) return 'subtype-not-allowed'
  if (!event.user) return 'no-user'
  if (!event.channel_type || !ALLOWED_CHANNEL_TYPES.has(event.channel_type)) return 'channel-type'
  if (typeof event.text !== 'string' || event.text.trim() === '') return 'no-text'
  return null
}

const MAX_INPUT_CHARS = 2000

// Returns the text to classify/translate, or null when there is nothing
// translatable (emoji-only, URL-only, mention-only, code-only, numbers...).
export function prepareText(raw: string): string | null {
  let text = raw
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`\n]*`/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .trim()

  if (text.length > MAX_INPUT_CHARS) text = `${text.slice(0, MAX_INPUT_CHARS)} (truncated)`

  const residue = text
    .replace(/<[^<>]*>/g, ' ') // <@U..>, <#C..|..>, <!here>, <http..|..>
    .replace(/:[a-z0-9_+'-]+:/gi, ' ') // :emoji_codes:
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[\s\d\p{P}\p{S}]+/gu, '') // whitespace, digits, punctuation, symbols (emoji)

  if (residue === '') return null
  return text
}

export function hasChineseCharacters(text: string): boolean {
  return /\p{Script=Han}/u.test(text)
}
