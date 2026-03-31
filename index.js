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
        {
          role: 'user',
          content: 'Create a short megaproject documentary theme. Return only title.'
        }
      ]
    })

    const theme = themeRes.choices[0].message.content.trim()
    await bot.sendMessage(chatId, `THEME:\n${theme}`)

    const prompt1 = await getImagePrompt(theme)
    await bot.sendMessage(chatId, `Prompt 1:\n${prompt1}`)

    const prompt2 = await getImagePrompt(theme)
    await bot.sendMessage(chatId, `Prompt 2:\n${prompt2}`)

    await bot.sendMessage(chatId, '🖼 Generating image 1...')
    const img1 = await generateImage(prompt1)
    await bot.sendMessage(chatId, `DEBUG URL:\n${img1}`)
    await sendImageFromUrl(chatId, img1)

    await bot.sendMessage(chatId, '🖼 Generating image 2...')
    const img2 = await generateImage(prompt2)
    await bot.sendMessage(chatId, `DEBUG URL:\n${img2}`)
    await sendImageFromUrl(chatId, img2)

    await bot.sendMessage(chatId, '✅ Images done')

    // video part comes after image sending is fully stable
    // if you want, next I give you the full version with Kling video added on top of this working base

  } catch (err) {
    console.error('MAIN ERROR:', err)
    await bot.sendMessage(chatId, `❌ ERROR:\n${err.message || String(err)}`)
  }
}

async function getImagePrompt(theme) {
  const res = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      {
        role: 'user',
        content: `Create ONE ultra realistic cinematic image prompt about: ${theme}. Only return the image prompt.`
      }
    ]
  })

  return res.choices[0].message.content.trim()
}

async function generateImage(promptText) {
  try {
    const output = await replicate.run(
      'black-forest-labs/flux-2-pro',
      {
        input: {
          prompt: promptText,
          aspect_ratio: '16:9'
        }
      }
    )

    console.log('RAW OUTPUT:', output)

    let imageUrl = null

    if (typeof output === 'string') {
      imageUrl = output
    } else if (Array.isArray(output)) {
      const first = output[0]

      if (typeof first === 'string') {
        imageUrl = first
      } else if (first && typeof first.url === 'function') {
        imageUrl = first.url().toString()
      } else if (first && typeof first.url === 'string') {
        imageUrl = first.url
      }
    } else if (output && typeof output.url === 'function') {
      imageUrl = output.url().toString()
    } else if (output && typeof output.url === 'string') {
      imageUrl = output.url
    }

    if (!imageUrl || typeof imageUrl !== 'string') {
      throw new Error('No valid image URL extracted')
    }

    return imageUrl
  } catch (err) {
    console.error('IMAGE ERROR:', err)
    throw err
  }
}

async function sendImageFromUrl(chatId, imageUrl) {
  try {
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
  } catch (err) {
    console.error('SEND IMAGE ERROR:', err)
    throw err
  }
}

const PORT = process.env.PORT || 3000
app.listen(PORT, () => {
  console.log('Server running')
})