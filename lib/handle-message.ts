import { annotateMessageAsync, type Annotation } from './annotate.js'
import { hasChineseCharacters, prepareText, type SlackMessageEvent } from './filters.js'
import { addWarningReactionAsync, buildAnnotationMessage, postThreadReplyAsync } from './slack.js'

// Structured decision log — metadata only, never message bodies (Vercel
// retains function logs).
function logDecision(payload: Record<string, unknown>): void {
  console.log(JSON.stringify({ source: 'lingo', ...payload }))
}

async function annotateWithRetryAsync({ text, hasCjk }: { text: string; hasCjk: boolean }): Promise<Annotation | null> {
  try {
    return await annotateMessageAsync({ text, hasCjk })
  } catch {
    await new Promise(resolve => setTimeout(resolve, 1500))
    return annotateMessageAsync({ text, hasCjk })
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
  const startedAt = Date.now()
  const base = { eventId, channel: event.channel, ts: event.ts, retryNum, textLength: event.text?.length ?? 0 }

  const text = prepareText(event.text ?? '')
  if (!text) {
    logDecision({ ...base, outcome: 'short-circuit', reason: 'no-translatable-residue' })
    return
  }
  const hasCjk = hasChineseCharacters(text)

  let annotation: Annotation | null = null
  let failure: string | null = null
  try {
    annotation = await annotateWithRetryAsync({ text, hasCjk })
    if (!annotation) failure = 'unparseable-llm-output'
  } catch (error) {
    failure = error instanceof Error ? error.message : 'llm-error'
  }

  if (!failure && annotation) {
    if (annotation.skip || annotation.detected_language === 'en') {
      logDecision({ ...base, outcome: 'silent', detectedLanguage: annotation.detected_language, confidence: annotation.confidence, hasCjk, llmMs: Date.now() - startedAt })
      return
    }
    if (annotation.confidence !== 'high') {
      logDecision({ ...base, outcome: 'silent-low-confidence', detectedLanguage: annotation.detected_language, languageName: annotation.language_name, confidence: annotation.confidence, hasCjk, llmMs: Date.now() - startedAt })
      return
    }
    // Code-side guard: never show Mandarin readings for Japanese/other
    // Han-borrowing languages, and never without actual Chinese characters.
    if (annotation.pinyin && (!hasCjk || annotation.language_name !== 'Chinese')) {
      annotation = { ...annotation, pinyin: null }
    }
    // Schema-valid but content-empty counts as a failure, not a silent skip
    if (!annotation.translations.en) failure = 'missing-en-translation'
  }

  if (failure || !annotation) {
    logDecision({ ...base, outcome: 'failure', reason: failure, llmMs: Date.now() - startedAt })
    await addWarningReactionAsync({ channel: event.channel, timestamp: event.ts })
    return
  }

  const { text: fallbackText, blocks } = buildAnnotationMessage(annotation)
  try {
    await postThreadReplyAsync({
      channel: event.channel,
      // Replies inside a thread go to the same thread; never a reply's own ts
      threadTs: event.thread_ts ?? event.ts,
      text: fallbackText,
      blocks
    })
    logDecision({ ...base, outcome: 'annotated', detectedLanguage: annotation.detected_language, languageName: annotation.language_name, hasPinyin: Boolean(annotation.pinyin), hasCjk, totalMs: Date.now() - startedAt })
  } catch (error) {
    logDecision({ ...base, outcome: 'post-failed', reason: error instanceof Error ? error.message : 'unknown' })
    await addWarningReactionAsync({ channel: event.channel, timestamp: event.ts })
  }
}
