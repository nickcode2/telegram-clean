const express = require('express')
const TelegramBot = require('node-telegram-bot-api')
const OpenAI = require('openai')
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
    const themeRes = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'user', content: 'Create a short megaproject documentary theme. Return only title.' }
      ]
    })

    const theme = themeRes.choices[0].message.content
    await bot.sendMessage(chatId, `THEME:\n${theme}`)

    const prompt1 = await getImagePrompt(theme)
    await bot.sendMessage(chatId, `Prompt 1:\n${prompt1}`)

    const prompt2 = await getImagePrompt(theme)
    await bot.sendMessage(chatId, `Prompt 2:\n${prompt2}`)

    // IMAGE 1
    await bot.sendMessage(chatId, '🖼 Generating image 1...')
    const img1 = await generateImage(prompt1)
    await bot.sendPhoto(chatId, img1)

    // VIDEO 1
    await bot.sendMessage(chatId, '🎬 Generating video 1...')
    const vid1 = await generateKlingVideo(img1)
    await bot.sendVideo(chatId, vid1)

    // IMAGE 2
    await bot.sendMessage(chatId, '🖼 Generating image 2...')
    const img2 = await generateImage(prompt2)
    await bot.sendPhoto(chatId, img2)

    // VIDEO 2
    await bot.sendMessage(chatId, '🎬 Generating video 2...')
    const vid2 = await generateKlingVideo(img2)
    await bot.sendVideo(chatId, vid2)

    await bot.sendMessage(chatId, '✅ 10s pipeline done')

  } catch (err) {
    console.error('MAIN ERROR:', err)
    bot.sendMessage(chatId, 'Error occurred')
  }
}

async function getImagePrompt(theme) {
  const res = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      { role: 'user', content: `Create ONE ultra realistic cinematic image prompt about: ${theme}. Only return the image prompt.` }
    ]
  })

  return res.choices[0].message.content
}

async function generateImage(promptText) {
  const start = await axios.post(
    'https://api.replicate.com/v1/predictions',
    {
      version: "black-forest-labs/flux-2-max",
      input: {
        prompt: promptText,
        aspect_ratio: "16:9"
      }
    },
    {
      headers: {
        Authorization: `Token ${process.env.REPLICATE_API_TOKEN}`,
        'Content-Type': 'application/json'
      }
    }
  )

  let prediction = start.data

  while (prediction.status !== 'succeeded') {
    await new Promise(r => setTimeout(r, 2000))

    const check = await axios.get(
      `https://api.replicate.com/v1/predictions/${prediction.id}`,
      {
        headers: {
          Authorization: `Token ${process.env.REPLICATE_API_TOKEN}`
        }
      }
    )

    prediction = check.data

    if (prediction.status === 'failed') {
      throw new Error('Image failed')
    }
  }

  return prediction.output[0]
}

async function generateKlingVideo(imageUrl) {
  const start = await axios.post(
    'https://api.replicate.com/v1/predictions',
    {
      version: "kwaivgi/kling-v1",
      input: {
        image: imageUrl,
        prompt: "cinematic motion, realistic movement, camera slowly pushes forward",
        duration: 5
      }
    },
    {
      headers: {
        Authorization: `Token ${process.env.REPLICATE_API_TOKEN}`,
        'Content-Type': 'application/json'
      }
    }
  )

  let prediction = start.data

  while (prediction.status !== 'succeeded') {
    await new Promise(r => setTimeout(r, 3000))

    const check = await axios.get(
      `https://api.replicate.com/v1/predictions/${prediction.id}`,
      {
        headers: {
          Authorization: `Token ${process.env.REPLICATE_API_TOKEN}`
        }
      }
    )

    prediction = check.data

    if (prediction.status === 'failed') {
      throw new Error('Video failed')
    }
  }

  return prediction.output[0]
}

const PORT = process.env.PORT || 3000
app.listen(PORT, () => {
  console.log('Server running')
})