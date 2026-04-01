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

    // 🔥 10 scenes (you can change to 20, 50, 120 later)
    const prompts = Array.from({ length: 10 }, (_, i) =>
      `wide cinematic scene ${i + 1}, modern or futuristic environment, people standing or walking slowly, calm atmosphere, realistic lighting`
    )

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

      } catch (err) {
        console.log("IMAGE FAILED:", i, err.message)
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

      } catch (err) {
        console.log("VIDEO FAILED:", i, err.message)
      }
    }

    await bot.sendMessage(chatId, "🎉 Videos done")

    // SAVE OUTPUT (for now logs)
    console.log("IMAGES:", images)
    console.log("VIDEOS:", videos)

    await bot.sendMessage(chatId, "✅ Done (check Railway logs)")

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