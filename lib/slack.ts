import type { Annotation } from './annotate.js'

const SLACK_API_BASE = 'https://slack.com/api'

async function slackApiAsync({ method, payload }: { method: string; payload: Record<string, unknown> }): Promise<void> {
  const response = await fetch(`${SLACK_API_BASE}/${method}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}`,
      'content-type': 'application/json; charset=utf-8'
    },
    body: JSON.stringify(payload)
  })
  const body = (await response.json()) as { ok: boolean; error?: string }
  if (!body.ok) throw new Error(`slack ${method} failed: ${body.error ?? 'unknown'}`)
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
  if (annotation.pinyin) {
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `*${annotation.pinyin}*` } })
  } else if (annotation.detected_language === 'other' && annotation.language_name) {
    blocks.push(contextBlock(`_${annotation.language_name}_`))
  }
  if (en) blocks.push(contextBlock(`:flag-gb: ${en}`))
  if (pt) blocks.push(contextBlock(`:flag-br: ${pt}`))
  if (annotation.pronunciation_guide) {
    blocks.push(contextBlock(`:speaking_head_in_silhouette: ${annotation.pronunciation_guide}`))
  }

  // Top-level text is the notification/accessibility fallback
  return { text: en ?? annotation.pinyin ?? '(translation)', blocks }
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
