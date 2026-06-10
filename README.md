# Lingo Bot — Slack translation bot

Annotates messages in a Slack channel between two friends (English speaker learning
Portuguese/Mandarin + Brazilian Portuguese speaker):

| Message language | Bot reply (threaded under the message) |
| --- | --- |
| English | *(silent)* |
| Portuguese | 🇺🇸 English translation + 🔊 pronunciation guide ("TOO-doo BAYNG") |
| Anything else | 🇺🇸 English + 🇧🇷 Portuguese translations |
| ...with Chinese characters | **wǒmen qù chīfàn ba** tone-marked pinyin on top |

One Claude Haiku call per message does detection + everything. ~$10–18/month at
300 messages/day; hosting is $0 (Vercel Hobby).

## Architecture

```
Slack message event
  └─> POST /api/slack/events (Vercel function)
        1. verify v0 signature over the RAW body
        2. ack 200 immediately (Slack's 3-second deadline)
        3. waitUntil(): filter -> preprocess -> one Claude call -> threaded Block Kit reply
```

- **Loop guard**: anything with `bot_id`/`bot_profile` or a disallowed subtype is dropped
  before the LLM ever runs — the bot never translates its own replies, edits, or deletes.
- **Silence bias**: ambiguous short messages ("no", "mama") get `confidence != high`
  and the bot stays quiet. A missed translation is cheap; a wrong one is annoying.
- **Failure signal**: if the LLM or the Slack post fails (after one retry), the bot adds a
  ⚠️ reaction to the original message instead of replying with an error or failing silently.
- **Privacy**: logs contain decision metadata only (language, confidence, latency) — never
  message text. Anthropic's API does not train on inputs.

## Setup (~30 min)

1. **Create the Slack app**: [api.slack.com/apps](https://api.slack.com/apps) → *Create New App*
   → *From a manifest* → pick your workspace → paste `slack-app-manifest.yaml`
   (leave the placeholder `request_url` for now — Slack lets you save it unverified).
2. **Install the app** to the workspace (*Install App* in the sidebar). Copy the
   **Bot User OAuth Token** (`xoxb-...`). Also copy the **Signing Secret** from
   *Basic Information*.
3. **Deploy to Vercel**:
   ```sh
   pnpm install
   npx vercel link   # create a new Vercel project (Hobby is fine — personal use)
   npx vercel env add SLACK_SIGNING_SECRET
   npx vercel env add SLACK_BOT_TOKEN
   npx vercel env add ANTHROPIC_API_KEY
   npx vercel deploy --prod
   ```
4. **Wire the events URL**: app settings → *Event Subscriptions* → set Request URL to
   `https://<your-app>.vercel.app/api/slack/events`. Slack sends a `url_verification`
   challenge; the handler echoes it and you get a green check.
   (If you later change scopes or events, you must **reinstall the app**.)
5. **Create a private channel**, invite your friend and `@lingo`.
6. **Smoke test**, in order:
   - `hello there` → silence
   - `tudo bem?` → threaded reply with English + pronunciation
   - `我们去吃饭吧` → threaded reply with pinyin + English + Portuguese
   - `mañana no puedo` → Spanish label + English + Portuguese
   - edit a message → silence (edits are ignored in v1)
   - confirm the bot's own reply did not trigger another reply

## Config

| Env var | Default | Notes |
| --- | --- | --- |
| `SLACK_SIGNING_SECRET` | — | Basic Information → Signing Secret |
| `SLACK_BOT_TOKEN` | — | `xoxb-...` from Install App |
| `ANTHROPIC_API_KEY` | — | platform.claude.com |
| `CLAUDE_MODEL` | `claude-haiku-4-5` | Set `claude-sonnet-4-6` (3x cost) if pinyin/translation quality ever disappoints |

## Known v1 trade-offs

- **Edits/deletes ignored** — an edited message keeps its original annotation; deleting a
  message orphans the bot's threaded reply. Fixing this needs a sourceTs→replyTs store;
  not worth it for two users.
- **Dedupe is in-memory** — Slack retries are already rare because the handler acks
  instantly; a cold-start race can at worst produce one duplicate threaded reply. Add
  Upstash Redis only if you actually observe duplicates.
- **Typed pinyin ("ni hao ma") is not auto-detected** — too many Portuguese words are
  valid pinyin syllables (de, da, me, tu, dou, sei, lei), and a false positive means
  annotating your friend's Portuguese as Mandarin. A `py:` prefix trigger is the clean
  v2: detect the prefix, ask the model for `simplified_chinese` + pinyin + translations.
  The conversion itself is reliable (it's what phone IMEs do).
