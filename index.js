import TelegramBot from "node-telegram-bot-api"
import Replicate from "replicate"
import express from "express"
import axios from "axios"
import fs from "fs"
import { execSync } from "child_process"

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

    // =========================
    // SCRIPT (TEST)
    // =========================

    const script = [
      "Massive futuristic cities are being built faster than ever.",
      "But behind the scenes, thousands of workers coordinate every detail.",
    ]

    // =========================
    // GENERATE AUDIO (ElevenLabs)
    // =========================

    let audioFiles = []

    for (let i = 0; i < script.length; i++) {
      await bot.sendMessage(chatId, `🎤 Generating audio ${i + 1}...`)

      const response = await axios.post(
        `https://api.elevenlabs.io/v1/text-to-speech/${process.env.VOICE_ID}`,
        {
          text: script[i],
          model_id: "eleven_multilingual_v2",
        },
        {
          headers: {
            "xi-api-key": process.env.ELEVENLABS_API_KEY,
            "Content-Type": "application/json",
          },
          responseType: "arraybuffer",
        }
      )

      const filePath = `audio${i}.mp3`
      fs.writeFileSync(filePath, response.data)
      audioFiles.push(filePath)
    }

    await bot.sendMessage(chatId, "✅ Audio done")

    // =========================
    // GET AUDIO DURATION
    // =========================

    let durations = []

    for (let i = 0; i < audioFiles.length; i++) {
      const output = execSync(
        `ffprobe -i ${audioFiles[i]} -show_entries format=duration -v quiet -of csv="p=0"`
      )
      const duration = parseFloat(output.toString().trim())
      durations.push(duration)
    }

    // =========================
    // IMAGE PROMPTS
    // =========================

    const prompts = [
      "wide futuristic city under construction, workers visible, realistic lighting",
      "engineers coordinating large scale project, people present, cinematic realism",
    ]

    let images = []

    for (let i = 0; i < prompts.length; i++) {
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
    }

    // =========================
    // VIDEO + CUT TO AUDIO LENGTH
    // =========================

    let finalClips = []

    for (let i = 0; i < images.length; i++) {
      await bot.sendMessage(chatId, `🎬 Video ${i + 1}`)

      const output = await replicate.run(
        "kwaivgi/kling-v2.6",
        {
          input: {
            prompt: "slow cinematic movement, people working, realistic",
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

      const trimmed = `clip${i}.mp4`

      execSync(
        `ffmpeg -i ${videoPath} -t ${durations[i]} -c copy ${trimmed}`
      )

      finalClips.push(trimmed)
    }

    await bot.sendMessage(chatId, "✅ Clips matched to audio")

  } catch (err) {
    console.log(err)
    await bot.sendMessage(chatId, "❌ Failed")
  }
})

// SERVER
const app = express()
const PORT = process.env.PORT || 3000

app.get("/", (req, res) => res.send("OK"))
app.listen(PORT)