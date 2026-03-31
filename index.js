const express = require('express')
const TelegramBot = require('node-telegram-bot-api')
const OpenAI = require('openai')
const Replicate = require('replicate')
const axios = require('axios')

const app = express()
app.use(express.json())

app.get('/', (req, res) => {
  res.send('OK')
})

const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true })

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
})

const replicate = new Replicate({
  auth: process.env.REPLICATE_API_TOKEN
})

bot.on('message', async (msg) => {
  const chatId = msg.chat.id
  const text = msg.text

  if (!text) return

  if (text.trim().toLowerCase() === 'do it') {
    await bot.sendMessage(chatId, 'Starting 10s pipeline...')
    runTest(chatId)
    return
  }

  await bot.sendMessage(chatId, 'Send do it')
})

async function runTest(chatId) {
  try {
    const themeRes = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'user', content: 'Create a short megaproject theme. Only title.' }
      ]
    })

    const theme = themeRes.choices[0].message.content.trim()
    await bot.sendMessage(chatId, `THEME:\n${theme}`)

    const prompt1 = await getImagePrompt(theme)
    const prompt2 = await getImagePrompt(theme)

    await bot.sendMessage(chatId, `Prompt 1:\n${prompt1}`)
    await bot.sendMessage(chatId, `Prompt 2:\n${prompt2}`)

    // IMAGE 1
    await bot.sendMessage(chatId, '🖼 Generating image 1...')
    const img1 = await generateImage(prompt1)
    await sendImage(chatId, img1)

    // IMAGE 2
    await bot.sendMessage(chatId, '🖼 Generating image 2...')
    const img2 = await generateImage(prompt2)
    await sendImage(chatId, img2)

    await bot.sendMessage(chatId, '🎬 Generating video 1...')
    const video1 = await generateVideo(img1, prompt1)
    await bot.sendVideo(chatId, video1)

    await bot.sendMessage(chatId, '🎬 Generating video 2...')
    const video2 = await generateVideo(img2, prompt2)
    await bot.sendVideo(chatId, video2)

    await bot.sendMessage(chatId, '✅ DONE')

  } catch (err) {
    console.error(err)
    await bot.sendMessage(chatId, '❌ ERROR')
  }
}

async function getImagePrompt(theme) {
  const res = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      { role: 'user', content: `Create cinematic image prompt about ${theme}` }
    ]
  })

  return res.choices[0].message.content.trim()
}

async function generateImage(promptText) {
  const output = await replicate.run(
    'black-forest-labs/flux-2-pro',
    {
      input: {
        prompt: promptText,
        aspect_ratio: '16:9'
      }
    }
  )

  return Array.isArray(output) ? output[0] : output
}

async function generateVideo(imageUrl, promptText) {
  const output = await replicate.run(
    'kwaivgi/kling-v2.6',
    {
      input: {
        prompt: promptText,
        start_image: imageUrl
      }
    }
  )

  return Array.isArray(output) ? output[0] : output
}

async function sendImage(chatId, imageUrl) {
  const response = await axios.get(imageUrl, {
    responseType: 'arraybuffer'
  })

  const buffer = Buffer.from(response.data)

  await bot.sendPhoto(
    chatId,
    buffer,
    {},
    {
      filename: 'image.webp',
      contentType: 'image/webp'
    }
  )
}

const PORT = process.env.PORT || 3000
app.listen(PORT, () => {
  console.log('Server running')
})