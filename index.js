const express = require('express')
const TelegramBot = require('node-telegram-bot-api')
const OpenAI = require('openai')

const app = express()
app.use(express.json())

app.get('/', (req, res) => {
  res.send('OK')
})

if (!process.env.BOT_TOKEN) {
  console.error('BOT_TOKEN missing')
  process.exit(1)
}

if (!process.env.OPENAI_API_KEY) {
  console.error('OPENAI_API_KEY missing')
  process.exit(1)
}

const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true })

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
})

const userStates = {}

bot.on('message', async (msg) => {
  const chatId = msg.chat.id
  const text = msg.text

  if (!text) return

  console.log('MSG:', text)

  // STEP 1
  if (text === 'do it') {
    bot.sendMessage(chatId, 'Generating full system...')
    runSystem(chatId)
    return
  }

  bot.sendMessage(chatId, 'Send do it')
})

async function runSystem(chatId) {
  try {
    // 🔥 STEP 1: GENERATE THEME
    const themeRes = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'user',
          content: `
Generate ONE unique YouTube documentary theme.

Style:
Massive engineering, megaprojects, hidden infrastructure, underground systems, military tech.

Return ONLY:
THEME: <short title>
`
        }
      ]
    })

    const theme = themeRes.choices[0].message.content

    await bot.sendMessage(chatId, theme)

    // 🔥 STEP 2: GENERATE FULL SCRIPT (50 scenes)
    const scriptRes = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'user',
          content: `
Create a full 50-scene YouTube documentary.

Use this theme:
${theme}

RULES:
- 50 scenes total
- scenes 1–20: fast, ~22 words
- scenes 21–50: slower, ~32 words

FOR EACH SCENE INCLUDE:

Scene number

Narration

Image Prompt 1 (different camera angle)

Image Prompt 2 (different camera angle)

Video Prompt (camera movement, no repetition)

STYLE:
- massive scale
- realistic
- engineering focused
- no fantasy
- always include people for scale

CAMERA ANGLES ROTATE:
top down aerial
low ground
side wide
diagonal high
inside perspective
vertical shaft
elevated platform
extreme wide

RETURN CLEAN TEXT
`
        }
      ]
    })

    const script = scriptRes.choices[0].message.content

    // 🔥 SEND IN CHUNKS (Telegram limit)
    const chunks = script.match(/[\s\S]{1,3500}/g)

    for (const chunk of chunks) {
      await bot.sendMessage(chatId, chunk)
    }

    await bot.sendMessage(chatId, 'DONE ✅')

  } catch (err) {
    console.error(err)
    bot.sendMessage(chatId, 'Error running system')
  }
}

const PORT = process.env.PORT || 3000

app.listen(PORT, '0.0.0.0', () => {
  console.log('running')
})