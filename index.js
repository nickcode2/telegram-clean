import TelegramBot from "node-telegram-bot-api"
import Replicate from "replicate"
import express from "express"
import axios from "axios"
import fs from "fs"
import { execSync } from "child_process"

const bot = new TelegramBot(process.env.BOT_TOKEN, {
  polling: { interval: 3000, autoStart: true },
})

const replicate = new Replicate({
  auth: process.env.REPLICATE_API_TOKEN,
})

// store user states
const userState = {}

bot.on("message", async (msg) => {
  const chatId = msg.chat.id
  const text = msg.text

  // STEP 1 → trigger
  if (text === "do it") {
    userState[chatId] = { step: "waiting_theme" }
    await bot.sendMessage(chatId, "🧠 Send theme / link / text")
    return
  }

  // STEP 2 → receive theme
  if (userState[chatId]?.step === "waiting_theme") {
    userState[chatId] = {
      step: "processing",
      theme: text,
    }

    const theme = text

    try {
      await bot.sendMessage(chatId, "🚀 Generating from theme...")

      // =========================
      // PROMPTS BASED ON USER INPUT
      // =========================

      const prompts = [
        `${theme}, wide cinematic environment, people present, realistic, no violence`,
        `${theme}, detailed scene with workers or humans, realistic lighting, no conflict`,
      ]

      let images = []

      // =========================
      // IMAGES
      // =========================

      for (let i = 0; i < prompts.length; i++) {
        try {
          await bot.sendMessage(chatId, `🖼 Image ${i + 1}`)

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
          console.log("IMAGE FAIL:", err.message)
          images.push(null)
        }
      }

      await bot.sendMessage(chatId, "✅ Images done")

      // =========================
      // VIDEOS
      // =========================

      let clips = []

      for (let i = 0; i < images.length; i++) {
        try {
          if (!images[i]) throw new Error("No image")

          await bot.sendMessage(chatId, `🎬 Video ${i + 1}`)

          const output = await replicate.run(
            "kwaivgi/kling-v2.6",
            {
              input: {
                prompt: `cinematic camera movement, ${theme}, realistic, people present`,
                start_image: images[i],
              },
            }
          )

          const videoUrl = Array.isArray(output) ? output[0] : output

          const videoPath = `video${i}.mp4`
          const response = await axios.get(videoUrl, { responseType: "stream" })

          await new Promise((resolve, reject) => {
            const writer = fs.createWriteStream(videoPath)
            response.data.pipe(writer)
            writer.on("finish", resolve)
            writer.on("error", reject)
          })

          clips.push(videoPath)

        } catch (err) {
          console.log("VIDEO FAIL:", err.message)
        }
      }

      if (clips.length === 0) {
        await bot.sendMessage(chatId, "❌ All videos failed")
        return
      }

      // =========================
      // MERGE
      // =========================

      const listFile = "list.txt"
      const content = clips.map(c => `file '${c}'`).join("\n")
      fs.writeFileSync(listFile, content)

      execSync(`ffmpeg -y -f concat -safe 0 -i ${listFile} -c copy merged.mp4`)

      await bot.sendVideo(chatId, "merged.mp4")

      await bot.sendMessage(chatId, "🎉 DONE")

      userState[chatId] = null

    } catch (err) {
      console.log(err)
      await bot.sendMessage(chatId, "❌ Failed")
      userState[chatId] = null
    }
  }
})

// SERVER
const app = express()
const PORT = process.env.PORT || 3000

app.get("/", (req, res) => res.send("OK"))
app.listen(PORT)