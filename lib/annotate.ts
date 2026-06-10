import Anthropic from '@anthropic-ai/sdk'
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod'
import { z } from 'zod'

// Classification fields first so the model commits to a language decision
// before generating any translation content.
const AnnotationSchema = z.object({
  detected_language: z.enum(['en', 'pt', 'other']),
  language_name: z.string(),
  confidence: z.enum(['high', 'medium', 'low']),
  skip: z.boolean(),
  translations: z.object({
    en: z.string().nullable(),
    pt: z.string().nullable()
  }),
  pronunciation_guide: z.string().nullable(),
  pinyin: z.string().nullable()
})

export type Annotation = z.infer<typeof AnnotationSchema>

const SYSTEM_PROMPT = `You annotate messages in a private Slack channel between two friends. One speaks
English and is learning Brazilian Portuguese and Mandarin; the other speaks
Brazilian Portuguese and English. Classify each message's language and produce
translations per the rules below.

CLASSIFICATION RULES
1. If the message is English: detected_language="en", skip=true, all content
   fields null, language_name="English". Casual/slangy/typo-ridden English is
   still English.
2. If the message is Portuguese: detected_language="pt", skip=false,
   language_name="Portuguese".
   - translations.en: natural English translation.
   - pronunciation_guide: how an American English speaker would sound out the
     ORIGINAL Portuguese, using Brazilian Portuguese (pt-BR) pronunciation.
     Write hyphenated English-readable syllables with CAPS on stressed
     syllables, e.g. "tudo bem" -> "TOO-doo BAYNG". Remember pt-BR specifics:
     final unstressed "de"/"te" sound like "jee"/"chee"; "ão" is a nasal "owng".
   - translations.pt: null. pinyin: null.
3. If the message is ANY other language (Chinese, Spanish, Japanese, French,
   anything that is not English or Portuguese): detected_language="other",
   skip=false. Set language_name to the language's English name (e.g.
   "Chinese", "Spanish").
   - translations.en: natural English translation.
   - translations.pt: natural Brazilian Portuguese (pt-BR) translation.
   - pronunciation_guide: null.
4. PINYIN: contains_chinese_characters is provided as a verified fact. Set
   pinyin ONLY when the message's language is Chinese AND
   contains_chinese_characters is true: tone-marked Hanyu Pinyin of the
   original Chinese text (diacritic tone marks: nǐ hǎo, not ni3 hao3).
   Resolve 多音字 from sentence context (行 xíng/háng, 得 de/dé/děi,
   了 le/liǎo, 还 hái/huán). Accept traditional-character input and still
   produce pinyin. For Japanese or any other language that borrows Han
   characters, pinyin MUST be null.
5. Mixed-language messages: classify by the dominant non-English content. A
   message that is mostly English with one foreign word: treat as "en"/skip
   unless the foreign part is clearly the point of the message. If the message
   contains any Chinese characters, never classify it as "en".
6. confidence: "high" only when the classification is clear-cut. Short or
   ambiguous messages that could plausibly be English (gibberish, romanized
   text, names, "ok", "haha", interjections) get "medium" or "low". The bot
   stays silent below "high" — when in doubt, prefer lower confidence.
7. Ignore Slack artifacts when classifying: <@U123> mentions, <#C123|name>
   channel links, <!here>, <https://...> links, and :emoji_codes:. Preserve
   any such tokens EXACTLY as written inside translations, placed in a
   grammatically sensible position.
8. Any Chinese you output uses simplified characters (zh-Hans).

EXAMPLES
- "running late, sorry!!" -> en, skip=true
- "tudo bem? chego em 10 min" -> pt, en="all good? I'll be there in 10 min",
  pronunciation_guide="TOO-doo BAYNG? SHEH-goo ayng dez mee-NOO-toos"
- "我们去吃饭吧" (contains_chinese_characters=true) -> other,
  language_name="Chinese", en="Let's go eat", pt="Vamos comer",
  pinyin="wǒmen qù chīfàn ba"
- "mañana no puedo" -> other, language_name="Spanish", en="I can't tomorrow",
  pt="Amanhã não posso"
- "ok 行" (contains_chinese_characters=true) -> other, language_name="Chinese",
  en="ok, sure", pt="ok, combinado", pinyin="ok xíng"
- "今日は忙しい" (contains_chinese_characters=true) -> other,
  language_name="Japanese", en="I'm busy today", pt="Estou ocupado hoje",
  pinyin=null
- "me too haha" -> en, skip=true
- "no" -> en, skip=true (valid English; ambiguity resolves to silence)`

const client = new Anthropic()

export async function annotateMessageAsync({
  text,
  hasCjk
}: {
  text: string
  hasCjk: boolean
}): Promise<Annotation | null> {
  const response = await client.messages.parse({
    model: process.env.CLAUDE_MODEL ?? 'claude-haiku-4-5',
    // Long CJK messages need room for pinyin + two translations in one JSON
    // object; 1024 would truncate and null out parsed_output.
    max_tokens: 4096,
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: 'user',
        content: `contains_chinese_characters: ${hasCjk}\nmessage:\n${text}`
      }
    ],
    output_config: { format: zodOutputFormat(AnnotationSchema) }
  })
  return response.parsed_output
}
