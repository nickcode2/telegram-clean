import TelegramBot from "node-telegram-bot-api"
import Replicate from "replicate"
import express from "express"

const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true })

const replicate = new Replicate({
  auth: process.env.REPLICATE_API_TOKEN,
})

bot.on("message", async (msg) => {
  const chatId = msg.chat.id
  const text = msg.text

  if (text !== "do it") return

  try {
    await bot.sendMessage(chatId, "🚀 Starting pipeline...")

    const prompts = [
      "wide shot of a modern city under construction at sunset, engineers standing still observing the skyline, realistic lighting, calm atmosphere",
      "aerial view of a futuristic city with clean architecture, people walking slowly, neutral expressions, peaceful environment",
    ]

    let images = []

    // IMAGE LOOP
    for (let i = 0; i < prompts.length; i++) {
      try {
        await bot.sendMessage(chatId, `🖼 Generating image ${i + 1}...`)

        const output = await replicate.run(
          "black-forest-labs/flux-2-max",
          {
            input: {
              prompt: prompts[i],
              aspect_ratio: "16:9",
            },
          }
        )

        const imageUrl = Array.isArray(output) ? output[0] : output

        images.push(imageUrl)

        await bot.sendPhoto(chatId, imageUrl)
      } catch (err) {
        console.log("IMAGE FAILED:", i, err.message)
        await bot.sendMessage(chatId, `⚠️ Image ${i + 1} failed`)
      }
    }

    await bot.sendMessage(chatId, "✅ Images done")

    let videos = []

    // VIDEO LOOP
    for (let i = 0; i < images.length; i++) {
      try {
        await bot.sendMessage(chatId, `🎬 Generating video ${i + 1}...`)

        const output = await replicate.run(
          "kwaivgi/kling-v2.6",
          {
            input: {
              prompt: "slow cinematic camera movement, people standing or walking slowly, calm environment",
              start_image: images[i],
            },
          }
        )

        const videoUrl = Array.isArray(output) ? output[0] : output

        videos.push(videoUrl)

        await bot.sendVideo(chatId, videoUrl)
      } catch (err) {
        console.log("VIDEO FAILED:", i, err.message)
        await bot.sendMessage(chatId, `⚠️ Video ${i + 1} failed`)
      }
    }

    await bot.sendMessage(chatId, "🎉 Videos done")

  } catch (err) {
    console.log("MAIN ERROR:", err.message)
    await bot.sendMessage(chatId, "❌ Pipeline failed")
  }
})

// SERVER
const app = express()
const PORT = process.env.PORT || 3000

app.get("/", (req, res) => {
  res.send("Bot is running")
})

app.listen(PORT, () => {
  console.log("Server running")
})