import { annotateMessageAsync, type Annotation } from './annotate.js'
import { hasChineseCharacters, prepareText, type SlackMessageEvent } from './filters.js'
import {
  addWarningReactionAsync,
  buildAnnotationMessage,
  fetchMessageBeforeAsync,
  fetchThreadRootAsync,
  getBotUserIdAsync,
  postThreadReplyAsync
} from './slack.js'

// Structured decision log — metadata only, never message bodies (Vercel
// retains function logs).
function logDecision(payload: Record<string, unknown>): void {
  console.log(JSON.stringify({ source: 'lingo', ...payload }))
}

async function annotateWithRetryAsync({
  text,
  hasCjk,
  force
}: {
  text: string
  hasCjk: boolean
  force: boolean
}): Promise<Annotation | null> {
  try {
    return await annotateMessageAsync({ text, hasCjk, force })
  } catch {
    await new Promise(resolve => setTimeout(resolve, 1500))
    return annotateMessageAsync({ text, hasCjk, force })
  }
}

async function annotateAndReplyAsync({
  channel,
  rawText,
  sourceTs,
  replyThreadTs,
  force,
  logBase
}: {
  channel: string
  rawText: string
  sourceTs: string
  replyThreadTs: string
  force: boolean
  logBase: Record<string, unknown>
}): Promise<void> {
  const startedAt = Date.now()
  const base = { ...logBase, channel, ts: sourceTs, force, textLength: rawText.length }

  const text = prepareText(rawText)
  if (!text) {
    logDecision({ ...base, outcome: 'short-circuit', reason: 'no-translatable-residue' })
    return
  }
  const hasCjk = hasChineseCharacters(text)

  let annotation: Annotation | null = null
  let failure: string | null = null
  try {
    annotation = await annotateWithRetryAsync({ text, hasCjk, force })
    if (!annotation) failure = 'unparseable-llm-output'
  } catch (error) {
    failure = error instanceof Error ? error.message : 'llm-error'
  }

  if (!failure && annotation) {
    // Explicit @lingo requests bypass the silence rules
    if (!force) {
      if (annotation.skip || annotation.detected_language === 'en') {
        logDecision({ ...base, outcome: 'silent', detectedLanguage: annotation.detected_language, confidence: annotation.confidence, hasCjk, llmMs: Date.now() - startedAt })
        return
      }
      if (annotation.confidence !== 'high') {
        logDecision({ ...base, outcome: 'silent-low-confidence', detectedLanguage: annotation.detected_language, languageName: annotation.language_name, confidence: annotation.confidence, hasCjk, llmMs: Date.now() - startedAt })
        return
      }
    }
    // Code-side guard: pinyin belongs to either a Chinese original message or
    // a zh translation — never to Japanese/other Han-borrowing languages.
    const pinyinIsForOriginal = hasCjk && annotation.language_name === 'Chinese'
    const pinyinIsForZhTranslation = Boolean(annotation.translations.zh)
    if (annotation.pinyin && !pinyinIsForOriginal && !pinyinIsForZhTranslation) {
      annotation = { ...annotation, pinyin: null }
    }
    // Schema-valid but content-empty counts as a failure, not a silent skip
    if (!annotation.translations.en && !annotation.translations.pt) failure = 'missing-translations'
  }

  if (failure || !annotation) {
    logDecision({ ...base, outcome: 'failure', reason: failure, llmMs: Date.now() - startedAt })
    await addWarningReactionAsync({ channel, timestamp: sourceTs })
    return
  }

  const { text: fallbackText, blocks } = buildAnnotationMessage(annotation)
  try {
    await postThreadReplyAsync({ channel, threadTs: replyThreadTs, text: fallbackText, blocks })
    logDecision({ ...base, outcome: 'annotated', detectedLanguage: annotation.detected_language, languageName: annotation.language_name, hasPinyin: Boolean(annotation.pinyin), hasCjk, totalMs: Date.now() - startedAt })
  } catch (error) {
    logDecision({ ...base, outcome: 'post-failed', reason: error instanceof Error ? error.message : 'unknown' })
    await addWarningReactionAsync({ channel, timestamp: sourceTs })
  }
}

export async function handleMessageAsync({
  event,
  eventId,
  retryNum
}: {
  event: SlackMessageEvent
  eventId: string
  retryNum: string | null
}): Promise<void> {
  // "@lingo ..." messages are handled by the app_mention event — bail here
  // so the same message doesn't get two replies.
  const botUserId = await getBotUserIdAsync().catch(() => null)
  if (botUserId && (event.text ?? '').includes(`<@${botUserId}>`)) {
    logDecision({ eventId, channel: event.channel, ts: event.ts, trigger: 'message', outcome: 'deferred-to-mention' })
    return
  }

  await annotateAndReplyAsync({
    channel: event.channel,
    rawText: event.text ?? '',
    sourceTs: event.ts,
    // Replies inside a thread go to the same thread; never a reply's own ts
    replyThreadTs: event.thread_ts ?? event.ts,
    force: false,
    logBase: { eventId, retryNum, trigger: 'message' }
  })
}

// "@lingo" trigger:
// - "@lingo <some text>" -> translate that inline text (forced, even English)
// - bare "@lingo" in a thread -> translate the thread's root message
// - bare "@lingo" at top level -> translate the most recent message above it
export async function handleMentionAsync({
  event,
  eventId
}: {
  event: SlackMessageEvent
  eventId: string
}): Promise<void> {
  const inlineText = (event.text ?? '').replace(/<@[A-Z0-9]+(\|[^>]*)?>/g, ' ').trim()
  if (prepareText(inlineText)) {
    await annotateAndReplyAsync({
      channel: event.channel,
      rawText: inlineText,
      sourceTs: event.ts,
      replyThreadTs: event.thread_ts ?? event.ts,
      force: true,
      logBase: { eventId, trigger: 'mention-inline' }
    })
    return
  }

  const target =
    event.thread_ts && event.thread_ts !== event.ts
      ? await fetchThreadRootAsync({ channel: event.channel, threadTs: event.thread_ts }).catch(() => null)
      : await fetchMessageBeforeAsync({ channel: event.channel, ts: event.ts }).catch(() => null)

  if (!target || !target.text || target.bot_id) {
    logDecision({ eventId, channel: event.channel, ts: event.ts, trigger: 'mention', outcome: 'no-target' })
    await addWarningReactionAsync({ channel: event.channel, timestamp: event.ts })
    return
  }

  await annotateAndReplyAsync({
    channel: event.channel,
    rawText: target.text,
    sourceTs: target.ts,
    replyThreadTs: target.thread_ts ?? target.ts,
    force: true,
    logBase: { eventId, trigger: 'mention' }
  })
}
