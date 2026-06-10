import { waitUntil } from '@vercel/functions'
import { getSkipReason, type SlackMessageEvent } from '../../lib/filters.js'
import { handleMentionAsync, handleMessageAsync } from '../../lib/handle-message.js'
import { verifySlackSignature } from '../../lib/verify-slack.js'

type SlackEnvelope = {
  type: string
  challenge?: string
  event_id?: string
  event?: SlackMessageEvent
}

// Best-effort dedupe for Slack's at-least-once retries. Survives only within
// a warm instance, which is fine at 2-user scale: ack-first below means
// retries are rare, and a retry after an instance died SHOULD be processed
// (the original never did the work). Worst case is one duplicate reply.
const seenEventIds = new Set<string>()
const SEEN_CAP = 1000

function alreadySeen(eventId: string): boolean {
  if (seenEventIds.has(eventId)) return true
  seenEventIds.add(eventId)
  if (seenEventIds.size > SEEN_CAP) {
    const oldest = seenEventIds.values().next().value
    if (oldest) seenEventIds.delete(oldest)
  }
  return false
}

export async function POST(request: Request): Promise<Response> {
  // Raw body first — the signature is computed over the exact bytes
  const rawBody = await request.text()
  const isValid = verifySlackSignature({
    rawBody,
    timestamp: request.headers.get('x-slack-request-timestamp'),
    signature: request.headers.get('x-slack-signature')
  })
  if (!isValid) return new Response('invalid signature', { status: 401 })

  const envelope = JSON.parse(rawBody) as SlackEnvelope

  if (envelope.type === 'url_verification') {
    return Response.json({ challenge: envelope.challenge })
  }
  if (envelope.type !== 'event_callback' || !envelope.event || !envelope.event_id) {
    return new Response('', { status: 200 })
  }

  if (alreadySeen(envelope.event_id)) return new Response('', { status: 200 })

  // Explicit "@lingo" -> translate the previous/parent message on demand
  if (envelope.event.type === 'app_mention') {
    waitUntil(handleMentionAsync({ event: envelope.event, eventId: envelope.event_id }))
    return new Response('', { status: 200 })
  }

  const skipReason = getSkipReason(envelope.event)
  if (skipReason) {
    if (skipReason !== 'bot-authored') {
      console.log(JSON.stringify({ source: 'lingo', outcome: 'filtered', reason: skipReason, eventId: envelope.event_id }))
    }
    return new Response('', { status: 200 })
  }

  // Ack within Slack's 3s deadline; translate + post after the response
  waitUntil(
    handleMessageAsync({
      event: envelope.event,
      eventId: envelope.event_id,
      retryNum: request.headers.get('x-slack-retry-num')
    })
  )
  return new Response('', { status: 200 })
}
