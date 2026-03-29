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
    bot.sendMessage(chatId, 'Starting 10s pipeline...')
    runTest(chatId)
    return
  }

  bot.sendMessage(chatId, 'Send do it')
})

async function runTest(chatId) {
  try {
    // STEP 1: THEME
    const themeRes = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'user', content: 'Create a short theme about megaprojects' }
      ]
    })

    const theme = themeRes.choices[0].message.content
    await bot.sendMessage(chatId, `THEME:\n${theme}`)

    // STEP 2: SCENE 1
    await bot.sendMessage(chatId, 'Creating scene 1...')

    const scene1Res = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'user',
          content: `Create ONE scene for a 5-second video based on: ${theme}. Include narration + image prompt + video movement`
        }
      ]
    })

    const scene1 = scene1Res.choices[0].message.content
    await bot.sendMessage(chatId, scene1)

    // STEP 3: SCENE 2
    await bot.sendMessage(chatId, 'Creating scene 2...')

    const scene2Res = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'user',
          content: `Create another DIFFERENT scene for a 5-second video based on: ${theme}. Include narration + image prompt + video movement`
        }
      ]
    })

    const scene2 = scene2Res.choices[0].message.content
    await bot.sendMessage(chatId, scene2)

    // STEP 4: IMAGES
    await bot.sendMessage(chatId, 'Generating image 1...')
    await delay(1000)
    await bot.sendPhoto(chatId, 'https://via.placeholder.com/512?text=Scene+1')

    await bot.sendMessage(chatId, 'Generating image 2...')
    await delay(1000)
    await bot.sendPhoto(chatId, 'https://via.placeholder.com/512?text=Scene+2')

    // STEP 5: VIDEO SIM
    await bot.sendMessage(chatId, 'Generating videos...')
    await delay(2000)

    await bot.sendMessage(chatId, 'Merging...')
    await delay(2000)

    await bot.sendMessage(chatId, '🎬 10s video ready (simulation)')

  } catch (err) {
    console.error('ERROR:', err)
    bot.sendMessage(chatId, 'Error occurred')
  }
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

const PORT = process.env.PORT || 3000

app.listen(PORT, '0.0.0.0', () => {
  console.log('running')
})