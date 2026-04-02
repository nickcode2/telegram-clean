import TelegramBot from "node-telegram-bot-api"
import Replicate from "replicate"
import express from "express"
import axios from "axios"
import fs from "fs"
import { execSync } from "child_process"
import path from "path"
import { google } from "googleapis"

// =========================
// TELEGRAM
// =========================
const bot = new TelegramBot(process.env.BOT_TOKEN, {
  polling: { interval: 3000, autoStart: true },
})

// =========================
// REPLICATE
// =========================
const replicate = new Replicate({
  auth: process.env.REPLICATE_API_TOKEN,
})

// =========================
// GOOGLE DRIVE SETUP
// =========================
const auth = new google.auth.GoogleAuth({
  credentials: JSON.parse(process.env.GDRIVE_CREDENTIALS),
  scopes: ["https://www.googleapis.com/auth/drive"],
})

const drive = google.drive({ version: "v3", auth })

async function createFolder(name, parentId = null) {
  const res = await drive.files.create({
    requestBody: {
      name,
      mimeType: "application/vnd.google-apps.folder",
      parents: parentId ? [parentId] : [],
    },
  })
  return res.data.id
}

async function uploadFile(filePath, folderId) {
  await drive.files.create({
    requestBody: {
      name: path.basename(filePath),
      parents: [folderId],
    },
    media: {
      mimeType: "application/octet-stream",
      body: fs.createReadStream(filePath),
    },
  })
}

// =========================
// STATE
// =========================
const userState = {}

bot.on("message", async (msg) => {
  const chatId = msg.chat.id
  const text = msg.text

  if (text === "do it") {
    userState[chatId] = { step: "waiting_theme" }
    await bot.sendMessage(chatId, "🧠 Send theme / link / text")
    return
  }

  if (userState[chatId]?.step === "waiting_theme") {
    userState[chatId] = { step: "processing" }

    try {
      await bot.sendMessage(chatId, "🚀 Starting...")

      // =========================
      // THEME NAME (MAX 4 WORDS)
      // =========================
      const theme = text.split(" ").slice(0, 4).join("_")

      // =========================
      // GOOGLE DRIVE FOLDERS
      // =========================
      const mainFolder = await createFolder(theme)
      const imagesFolder = await createFolder("images", mainFolder)
      const videosFolder = await createFolder("videos", mainFolder)
      const audioFolder = await createFolder("audio_script", mainFolder)

      // =========================
      // PROMPTS
      // =========================
      const prompts = [
        `${text}, cinematic, realistic, people present`,
        `${text}, detailed environment, workers, realistic lighting`,
      ]

      let images = []
      let clips = []

      // =========================
      // IMAGES
      // =========================
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

        const imgPath = `image${i}.jpg`
        const res = await axios.get(imageUrl, { responseType: "stream" })

        await new Promise((resolve, reject) => {
          const writer = fs.createWriteStream(imgPath)
          res.data.pipe(writer)
          writer.on("finish", resolve)
          writer.on("error", reject)
        })

        images.push(imgPath)

        // SEND TO TELEGRAM (FIXED)
        await bot.sendPhoto(chatId, imgPath)

        // UPLOAD TO DRIVE
        await uploadFile(imgPath, imagesFolder)
      }

      // =========================
      // VIDEOS
      // =========================
      for (let i = 0; i < images.length; i++) {
        await bot.sendMessage(chatId, `🎬 Video ${i + 1}`)

        const output = await replicate.run(
          "kwaivgi/kling-v2.6",
          {
            input: {
              prompt: `cinematic motion, ${text}, realistic`,
              start_image: images[i],
            },
          }
        )

        const videoUrl = Array.isArray(output) ? output[0] : output

        const videoPath = `video${i}.mp4`
        const res = await axios.get(videoUrl, { responseType: "stream" })

        await new Promise((resolve, reject) => {
          const writer = fs.createWriteStream(videoPath)
          res.data.pipe(writer)
          writer.on("finish", resolve)
          writer.on("error", reject)
        })

        clips.push(videoPath)

        // SEND TO TELEGRAM (FIXED)
        await bot.sendVideo(chatId, videoPath)

        // UPLOAD TO DRIVE
        await uploadFile(videoPath, videosFolder)
      }

      // =========================
      // MERGE
      // =========================
      const list = clips.map(c => `file '${c}'`).join("\n")
      fs.writeFileSync("list.txt", list)

      execSync(`ffmpeg -y -f concat -safe 0 -i list.txt -c copy final.mp4`)

      await bot.sendVideo(chatId, "final.mp4")

      await uploadFile("final.mp4", videosFolder)

      await bot.sendMessage(chatId, "🎉 DONE")

    } catch (err) {
      console.log(err)
      await bot.sendMessage(chatId, "❌ Failed")
    }
  }
})

// =========================
// SERVER
// =========================
const app = express()
const PORT = process.env.PORT || 3000

app.get("/", (req, res) => res.send("OK"))
app.listen(PORT)