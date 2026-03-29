const express = require('express')
const TelegramBot = require('node-telegram-bot-api')
const OpenAI = require('openai')

const app = express()
app.use(express.json())

app.get('/', (req, res) => {
  res.send('OK')
})

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
    // THEME
    const themeRes = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'user', content: 'Create a short megaproject documentary theme. Return only title.' }
      ]
    })

    const theme = themeRes.choices[0].message.content
    await bot.sendMessage(chatId, `THEME:\n${theme}`)

    // SCENE 1
    await bot.sendMessage(chatId, 'Creating scene 1...')

    const scene1Res = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'user', content: `Create ONE 5-second scene with narration + image prompt + camera movement for: ${theme}` }
      ]
    })

    const scene1 = scene1Res.choices[0].message.content
    await bot.sendMessage(chatId, scene1)

    // SCENE 2
    await bot.sendMessage(chatId, 'Creating scene 2...')

    const scene2Res = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'user', content: `Create another DIFFERENT 5-second scene for: ${theme}` }
      ]
    })

    const scene2 = scene2Res.choices[0].message.content
    await bot.sendMessage(chatId, scene2)

    // IMAGE STEP (SAFE VERSION)
    await bot.sendMessage(chatId, '🖼 Image 1 generated')
    await delay(1000)

    await bot.sendMessage(chatId, '🖼 Image 2 generated')
    await delay(1000)

    // VIDEO STEP (SIMULATION)
    await bot.sendMessage(chatId, '🎬 Generating videos...')
    await delay(2000)

    await bot.sendMessage(chatId, '🎬 Merging...')
    await delay(2000)

    await bot.sendMessage(chatId, '✅ 10-second video ready')

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