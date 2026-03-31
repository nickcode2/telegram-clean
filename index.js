const express = require('express')
const TelegramBot = require('node-telegram-bot-api')
const OpenAI = require('openai')
const Replicate = require('replicate')

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
        { role: 'user', content: 'Create a short megaproject documentary theme. Return only title.' }
      ]
    })

    const theme = themeRes.choices[0].message.content.trim()
    await bot.sendMessage(chatId, `THEME:\n${theme}`)

    const imgPrompt1 = await generatePrompt(theme)
    const imgPrompt2 = await generatePrompt(theme)

    await bot.sendMessage(chatId, `Prompt 1:\n${imgPrompt1}`)
    await bot.sendMessage(chatId, `Prompt 2:\n${imgPrompt2}`)

    await bot.sendMessage(chatId, '🖼 Generating image 1...')
    const img1 = await generateImage(imgPrompt1)

    await bot.sendMessage(chatId, `DEBUG URL:\n${img1}`)
    await bot.sendPhoto(chatId, img1)

    await bot.sendMessage(chatId, '🖼 Generating image 2...')
    const img2 = await generateImage(imgPrompt2)

    await bot.sendMessage(chatId, `DEBUG URL:\n${img2}`)
    await bot.sendPhoto(chatId, img2)

    await bot.sendMessage(chatId, '✅ Images done')

  } catch (err) {
    console.error('MAIN ERROR:', err)
    await bot.sendMessage(chatId, `❌ ERROR:\n${err.message}`)
  }
}

async function generatePrompt(theme) {
  const res = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      { role: 'user', content: `Create ONE ultra realistic cinematic image prompt about: ${theme}. Only return the image prompt.` }
    ]
  })

  return res.choices[0].message.content.trim()
}

async function generateImage(promptText) {
  try {
    const output = await replicate.run(
      "black-forest-labs/flux-2-pro",
      {
        input: {
          prompt: promptText,
          aspect_ratio: "16:9"
        }
      }
    )

    console.log('RAW OUTPUT:', JSON.stringify(output, null, 2))

    // 🔥 HANDLE ALL CASES

    // case 1: string
    if (typeof output === 'string') {
      return output
    }

    // case 2: array
    if (Array.isArray(output)) {
      return output[0]
    }

    // case 3: object with url
    if (output.url) {
      return output.url
    }

    // case 4: object with output array
    if (output.output && Array.isArray(output.output)) {
      return output.output[0]
    }

    // case 5: object with images
    if (output.images && Array.isArray(output.images)) {
      return output.images[0]
    }

    // case 6: object with data
    if (output.data && Array.isArray(output.data)) {
      return output.data[0].url
    }

    throw new Error('Replicate returned unknown format')

  } catch (err) {
    console.error('IMAGE ERROR:', err)
    throw err
  }
}

const PORT = process.env.PORT || 3000
app.listen(PORT, () => {
  console.log('Server running')
})