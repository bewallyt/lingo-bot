import { createHmac, timingSafeEqual } from 'node:crypto'

const FIVE_MINUTES_SECONDS = 60 * 5

// Slack signs the RAW request body — verify before any JSON.parse, and never
// against a re-serialized body (key order/whitespace changes break the MAC).
export function verifySlackSignature({
  rawBody,
  timestamp,
  signature
}: {
  rawBody: string
  timestamp: string | null
  signature: string | null
}): boolean {
  const signingSecret = process.env.SLACK_SIGNING_SECRET
  if (!signingSecret || !timestamp || !signature) return false

  const requestAge = Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp))
  if (!Number.isFinite(requestAge) || requestAge > FIVE_MINUTES_SECONDS) return false

  const expected = `v0=${createHmac('sha256', signingSecret).update(`v0:${timestamp}:${rawBody}`).digest('hex')}`
  const expectedBuffer = Buffer.from(expected)
  const receivedBuffer = Buffer.from(signature)
  if (expectedBuffer.length !== receivedBuffer.length) return false
  return timingSafeEqual(expectedBuffer, receivedBuffer)
}
