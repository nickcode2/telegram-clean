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
    const scene1Res = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'user', content: `Create ONE 5-second scene with narration + image prompt for: ${theme}` }
      ]
    })

    const scene1 = scene1Res.choices[0].message.content
    await bot.sendMessage(chatId, scene1)

    // SCENE 2
    const scene2Res = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'user', content: `Create another DIFFERENT 5-second scene for: ${theme}` }
      ]
    })

    const scene2 = scene2Res.choices[0].message.content
    await bot.sendMessage(chatId, scene2)

    // IMAGE 1
    await bot.sendMessage(chatId, '🖼 Generating image 1...')
    const img1 = await generateImage(scene1)
    await bot.sendPhoto(chatId, img1)

    // IMAGE 2
    await bot.sendMessage(chatId, '🖼 Generating image 2...')
    const img2 = await generateImage(scene2)
    await bot.sendPhoto(chatId, img2)

    await bot.sendMessage(chatId, '✅ Images done')

  } catch (err) {
    console.error(err)
    bot.sendMessage(chatId, 'Error occurred')
  }
}

async function generateImage(promptText) {
  const start = await fetch('https://api.replicate.com/v1/predictions', {
    method: 'POST',
    headers: {
      Authorization: `Token ${process.env.REPLICATE_API_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      version: "c221b2b8ef527988ecf4b6a6cde2baf9d1d6dbe2f5d5a63d315ff78eaefdd8af",
      input: {
        prompt: promptText,
        aspect_ratio: "16:9"
      }
    })
  })

  const prediction = await start.json()

  if (!prediction.id) {
    console.log('START ERROR:', prediction)
    throw new Error('Replicate start failed')
  }

  let result

  while (true) {
    await new Promise(r => setTimeout(r, 2000))

    const check = await fetch(`https://api.replicate.com/v1/predictions/${prediction.id}`, {
      headers: {
        Authorization: `Token ${process.env.REPLICATE_API_TOKEN}`
      }
    })

    result = await check.json()

    if (result.status === 'succeeded') break
    if (result.status === 'failed') {
      console.log('FAILED:', result)
      throw new Error('Replicate failed')
    }
  }

  if (!result.output) {
    console.log('NO OUTPUT:', result)
    throw new Error('No image output')
  }

  // 🔥 handle BOTH formats
  if (Array.isArray(result.output)) {
    return result.output[0]
  } else {
    return result.output
  }
}