import type { Annotation } from './annotate.js'

const SLACK_API_BASE = 'https://slack.com/api'

type SlackApiBody = { ok: boolean; error?: string } & Record<string, unknown>

async function slackApiAsync({ method, payload }: { method: string; payload: Record<string, unknown> }): Promise<SlackApiBody> {
  const response = await fetch(`${SLACK_API_BASE}/${method}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}`,
      'content-type': 'application/json; charset=utf-8'
    },
    body: JSON.stringify(payload)
  })
  const body = (await response.json()) as SlackApiBody
  if (!body.ok) throw new Error(`slack ${method} failed: ${body.error ?? 'unknown'}`)
  return body
}

async function slackGetAsync({ method, params }: { method: string; params: Record<string, string> }): Promise<SlackApiBody> {
  const query = new URLSearchParams(params).toString()
  const response = await fetch(`${SLACK_API_BASE}/${method}?${query}`, {
    headers: { authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}` }
  })
  const body = (await response.json()) as SlackApiBody
  if (!body.ok) throw new Error(`slack ${method} failed: ${body.error ?? 'unknown'}`)
  return body
}

let botUserIdPromise: Promise<string> | null = null

// Own bot user id (cached per instance) — used to tell "@lingo ..." messages
// apart from ordinary ones so the message and mention paths don't both reply.
export function getBotUserIdAsync(): Promise<string> {
  botUserIdPromise ??= slackApiAsync({ method: 'auth.test', payload: {} }).then(body => body.user_id as string)
  return botUserIdPromise
}

type FetchedMessage = { text?: string; ts: string; thread_ts?: string; bot_id?: string; user?: string }

export async function fetchThreadRootAsync({ channel, threadTs }: { channel: string; threadTs: string }): Promise<FetchedMessage | null> {
  const body = await slackGetAsync({
    method: 'conversations.replies',
    params: { channel, ts: threadTs, limit: '1', inclusive: 'true' }
  })
  const messages = (body.messages as FetchedMessage[] | undefined) ?? []
  return messages[0] ?? null
}

// Most recent human message strictly before `ts` that has translatable text
export async function fetchMessageBeforeAsync({ channel, ts }: { channel: string; ts: string }): Promise<FetchedMessage | null> {
  const body = await slackGetAsync({
    method: 'conversations.history',
    params: { channel, latest: ts, inclusive: 'false', limit: '10' }
  })
  const messages = (body.messages as FetchedMessage[] | undefined) ?? []
  return messages.find(message => !message.bot_id && message.user && typeof message.text === 'string' && message.text.trim() !== '') ?? null
}

// Mentions/broadcasts preserved verbatim by the model would re-ping people
// when posted inside the bot's reply — render them as plain text instead.
function defangSlackTokens(text: string): string {
  return text
    .replace(/<!(here|channel|everyone)(\|[^>]*)?>/g, '@$1')
    .replace(/<@([A-Z0-9]+)(\|([^>]+))?>/g, (_match, id: string, _g, label?: string) => `@${label ?? id}`)
    .replace(/<#[A-Z0-9]+\|([^>]+)>/g, '#$1')
    .replace(/<(https?:\/\/[^|>]+)(\|[^>]*)?>/g, '$1')
}

function contextBlock(text: string): Record<string, unknown> {
  return { type: 'context', elements: [{ type: 'mrkdwn', text }] }
}

export function buildAnnotationMessage(annotation: Annotation): { text: string; blocks: Record<string, unknown>[] } {
  const en = annotation.translations.en ? defangSlackTokens(annotation.translations.en) : null
  const pt = annotation.translations.pt ? defangSlackTokens(annotation.translations.pt) : null

  const blocks: Record<string, unknown>[] = []
  if (annotation.detected_language === 'other') {
    // Chinese original: pinyin headline; other languages: small label
    if (annotation.pinyin) {
      blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `*${annotation.pinyin}*` } })
    } else if (annotation.language_name) {
      blocks.push(contextBlock(`_${annotation.language_name}_`))
    }
  }
  if (en) blocks.push(contextBlock(`:flag-us: ${en}`))
  if (pt) blocks.push(contextBlock(`:flag-br: ${pt}`))
  if (annotation.translations.zh) {
    // zh is a translation (pt or forced-en source) — pinyin rides alongside it
    const zhPinyin = annotation.pinyin ? ` (${annotation.pinyin})` : ''
    blocks.push(contextBlock(`:cn: ${annotation.translations.zh}${zhPinyin}`))
  }
  if (annotation.pronunciation_guide) {
    blocks.push(contextBlock(`:speaking_head_in_silhouette: ${annotation.pronunciation_guide}`))
  }

  // Top-level text is the notification/accessibility fallback
  return { text: en ?? pt ?? annotation.pinyin ?? '(translation)', blocks }
}

export async function postThreadReplyAsync({
  channel,
  threadTs,
  text,
  blocks
}: {
  channel: string
  threadTs: string
  text: string
  blocks: Record<string, unknown>[]
}): Promise<void> {
  await slackApiAsync({
    method: 'chat.postMessage',
    payload: { channel, thread_ts: threadTs, text, blocks, reply_broadcast: false }
  })
}

export async function addWarningReactionAsync({ channel, timestamp }: { channel: string; timestamp: string }): Promise<void> {
  try {
    await slackApiAsync({ method: 'reactions.add', payload: { channel, timestamp, name: 'warning' } })
  } catch {
    // Last-resort signal failed too — nothing further to do
  }
}
