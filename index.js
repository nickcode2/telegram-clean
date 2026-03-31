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

    console.log('RAW OUTPUT:', output)

    // 🔥 CRITICAL FIX HERE

    if (typeof output === 'string') return output

    if (Array.isArray(output)) {
      const first = output[0]

      // if it's a file object
      if (first && typeof first.url === 'function') {
        return first.url()
      }

      return first
    }

    // if single object
    if (output && typeof output.url === 'function') {
      return output.url()
    }

    if (output && output.url) {
      return output.url
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