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

bot.on('message', async (msg) => {
  const chatId = msg.chat.id
  const text = msg.text

  if (!text) return

  if (text === 'do it') {
    bot.sendMessage(chatId, 'Creating real 10s pipeline...')
    runTest(chatId)
    return
  }

  bot.sendMessage(chatId, 'Send do it')
})

async function runTest(chatId) {
  try {
    // 🔥 STEP 1: THEME
    const themeRes = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'user',
          content: 'Create a short theme about massive engineering or megaprojects'
        }
      ]
    })

    const theme = themeRes.choices[0].message.content
    await bot.sendMessage(chatId, `THEME:\n${theme}`)

    // 🔥 STEP 2: SCENE PROMPTS
    const sceneRes = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'user',
          content: `
Create 2 scenes for a 10-second video.

Theme: ${theme}

Each scene:
- short narration
- 1 image prompt (realistic, massive scale)
- 1 video movement

Return clean.
`
        }
      ]
    })

    const scenes = sceneRes.choices[0].message.content
    await bot.sendMessage(chatId, scenes)

    // 🔥 STEP 3: SIMULATE IMAGE GENERATION
    await bot.sendMessage(chatId, 'Generating image 1...')
    await delay(1500)

    const image1 = 'https://via.placeholder.com/512?text=Scene+1'
    await bot.sendPhoto(chatId, image1)

    await bot.sendMessage(chatId, 'Generating image 2...')
    await delay(1500)

    const image2 = 'https://via.placeholder.com/512?text=Scene+2'
    await bot.sendPhoto(chatId, image2)

    // 🔥 STEP 4: SIMULATE VIDEO GENERATION
    await bot.sendMessage(chatId, 'Generating 5s video 1...')
    await delay(2000)

    await bot.sendMessage(chatId, 'Generating 5s video 2...')
    await delay(2000)

    // 🔥 STEP 5: FINAL OUTPUT
    await bot.sendMessage(chatId, 'Merging clips...')
    await delay(2000)

    await bot.sendMessage(chatId, '🎬 Final 10-second video ready (simulation)')

  } catch (err) {
    console.error(err)
    bot.sendMessage(chatId, 'Error in pipeline')
  }
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

const PORT = process.env.PORT || 3000

app.listen(PORT, '0.0.0.0', () => {
  console.log('running')
})