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
        {
          role: 'user',
          content: 'Create a short megaproject documentary theme. Return only title.'
        }
      ]
    })

    const theme = themeRes.choices[0].message.content.trim()
    await bot.sendMessage(chatId, `THEME:\n${theme}`)

    const imgPrompt1Res = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'user',
          content: `Create ONE ultra realistic cinematic image prompt about: ${theme}. Only return the image prompt.`
        }
      ]
    })

    const imgPrompt1 = imgPrompt1Res.choices[0].message.content.trim()
    await bot.sendMessage(chatId, `Prompt 1:\n${imgPrompt1}`)

    const imgPrompt2Res = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'user',
          content: `Create another DIFFERENT ultra realistic cinematic image prompt about: ${theme}. Only return the image prompt.`
        }
      ]
    })

    const imgPrompt2 = imgPrompt2Res.choices[0].message.content.trim()
    await bot.sendMessage(chatId, `Prompt 2:\n${imgPrompt2}`)

    await bot.sendMessage(chatId, '🖼 Generating image 1...')
    const img1 = await generateImage(imgPrompt1)
    await bot.sendPhoto(chatId, img1)

    await bot.sendMessage(chatId, '🖼 Generating image 2...')
    const img2 = await generateImage(imgPrompt2)
    await bot.sendPhoto(chatId, img2)

    await bot.sendMessage(chatId, '✅ Images done')

  } catch (err) {
    console.error('MAIN ERROR:', err)
    await bot.sendMessage(chatId, `❌ ERROR:\n${err.message || err}`)
  }
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

    console.log("OUTPUT:", output)

    if (!output) {
      throw new Error("No output")
    }

    if (typeof output === 'object' && output.url) {
      return output.url()
    }

    if (Array.isArray(output)) {
      return output[0]
    }

    return output

  } catch (err) {
    console.error('IMAGE ERROR:', err)
    throw err
  }
}

const PORT = process.env.PORT || 3000
app.listen(PORT, () => {
  console.log('Server running')
})