import TelegramBot from "node-telegram-bot-api"
import fs from "fs"
import path from "path"
import axios from "axios"
import { execSync } from "child_process"

const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true })

const TMP = "/tmp"

// ===== SETUP =====

function ensureDirs() {
  const dirs = ["images", "videos", "audio", "music"]
  dirs.forEach(d => {
    const full = path.join(TMP, d)
    if (!fs.existsSync(full)) fs.mkdirSync(full, { recursive: true })
  })
}

function cleanTmp() {
  fs.rmSync(TMP, { recursive: true, force: true })
}

async function downloadFile(url, filepath) {
  const res = await axios({ url, responseType: "stream" })
  const writer = fs.createWriteStream(filepath)
  res.data.pipe(writer)

  return new Promise((resolve, reject) => {
    writer.on("finish", resolve)
    writer.on("error", reject)
  })
}

// ===== SCRIPT (REAL FLOW) =====

function generateScript(input) {
  return [
    `Scientists are exploring ${input} and uncovering hidden details.`,
    `These discoveries may completely change our understanding. Thanks for watching`
  ]
}

// ===== SCENES (BASED ON SCRIPT) =====

function splitScenes(scriptArray) {
  return scriptArray.map((sceneText, i) => ({
    script: sceneText,
    imagePrompt: `realistic cinematic scene of ${sceneText}, dramatic lighting`,
    motionPrompt: i === 0 ? "slow zoom in" : "slow pan right"
  }))
}

// ===== IMAGE =====

async function generateImage(i) {
  const file = `${TMP}/images/img_${i}.jpg`
  await downloadFile("https://picsum.photos/1280/720", file)
  return file
}

// ===== VIDEO =====

function generateVideo(i, imgPath) {
  const output = `${TMP}/videos/video_${i}.mp4`

  execSync(`
    ffmpeg -y -loop 1 -i ${imgPath} -t 5 \
    -vf "scale=1280:720,format=yuv420p" \
    -pix_fmt yuv420p ${output}
  `)

  return output
}

// ===== AUDIO =====

function generateVoice(i) {
  const output = `${TMP}/audio/voice_${i}.mp3`

  execSync(`
    ffmpeg -y -f lavfi -i "sine=frequency=1000:duration=5" ${output}
  `)

  return output
}

function generateMusic() {
  const output = `${TMP}/music/music.mp3`

  execSync(`
    ffmpeg -y -f lavfi -i "sine=frequency=200:duration=10" ${output}
  `)

  return output
}

// ===== MERGE =====

function mergeVideos(videoFiles) {
  const listFile = `${TMP}/videos/list.txt`

  fs.writeFileSync(
    listFile,
    videoFiles.map(v => `file '${v}'`).join("\n")
  )

  const output = `${TMP}/merged.mp4`

  execSync(`
    ffmpeg -y -f concat -safe 0 -i ${listFile} -c copy ${output}
  `)

  return output
}

function finalMerge(video, voices, music) {
  const output = `${TMP}/final.mp4`

  execSync(`
    ffmpeg -y -i ${video} -i ${voices[0]} -i ${voices[1]} -i ${music} \
    -filter_complex "[1:a][2:a]concat=n=2:v=0:a=1[a];[3:a]volume=0.2[m];[a][m]amix=inputs=2" \
    -c:v copy -c:a aac -shortest ${output}
  `)

  return output
}

// ===== TELEGRAM FLOW =====

let userState = {}

bot.onText(/do it/, async (msg) => {
  const chatId = msg.chat.id
  userState[chatId] = "waiting"
  await bot.sendMessage(chatId, "Send theme, link, or text")
})

bot.on("message", async (msg) => {
  const chatId = msg.chat.id

  if (userState[chatId] !== "waiting") return
  userState[chatId] = null

  const input = msg.text

  try {
    ensureDirs()

    // 1. SCRIPT
    await bot.sendMessage(chatId, "Creating script")

    const scriptArray = generateScript(input)
    const fullScript = scriptArray.join(" ")

    await bot.sendMessage(chatId, fullScript)

    // 2. SCENES
    const scenes = splitScenes(scriptArray)

    let breakdown = ""

    scenes.forEach((scene, i) => {
      breakdown += `Scene ${i + 1}\n`
      breakdown += `Script: ${scene.script}\n`
      breakdown += `Image prompt: ${scene.imagePrompt}\n`
      breakdown += `Video motion prompt: ${scene.motionPrompt}\n\n`
    })

    await bot.sendMessage(chatId, breakdown)

    // 3. IMAGES
    await bot.sendMessage(chatId, "Creating images")

    let images = []
    for (let i = 0; i < scenes.length; i++) {
      const img = await generateImage(i)
      images.push(img)
      await bot.sendPhoto(chatId, img)
    }

    // 4. VIDEOS
    await bot.sendMessage(chatId, "Creating videos")

    let videos = []
    for (let i = 0; i < images.length; i++) {
      const vid = generateVideo(i, images[i])
      videos.push(vid)
      await bot.sendVideo(chatId, vid)
    }

    // 5. VOICE
    await bot.sendMessage(chatId, "Creating voice")

    let voices = []
    for (let i = 0; i < scenes.length; i++) {
      const voice = generateVoice(i)
      voices.push(voice)
      await bot.sendAudio(chatId, voice)
    }

    // 6. MUSIC
    await bot.sendMessage(chatId, "Creating background music")

    const music = generateMusic()
    await bot.sendAudio(chatId, music)

    // 7. FINAL
    await bot.sendMessage(chatId, "Rendering final video")

    const merged = mergeVideos(videos)
    const finalVideo = finalMerge(merged, voices, music)

    await bot.sendVideo(chatId, finalVideo)

    cleanTmp()

  } catch (err) {
    console.log(err)
    await bot.sendMessage(chatId, "FAILED ❌")
  }
})