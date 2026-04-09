import TelegramBot from "node-telegram-bot-api"
import fs from "fs"
import fetch from "node-fetch"
import { execSync } from "child_process"

// ─────────────────────────────────────────
// BOT SETUP
// ─────────────────────────────────────────
console.log("Starting bot...")
const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true })
bot.on("polling_error", (err) => console.error("Polling error:", err.message))
console.log("Bot is running.")

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let userState = {}

// Make sure temp folders exist
fs.mkdirSync("/tmp/images", { recursive: true })
fs.mkdirSync("/tmp/videos", { recursive: true })
fs.mkdirSync("/tmp/voices", { recursive: true })
fs.mkdirSync("/tmp/final", { recursive: true })


// ─────────────────────────────────────────
// STEP 1 — SCRIPT
// Generates a tight 10-second script from input
// ─────────────────────────────────────────
function generateScript(input) {
  return (
    `${input} has revealed something extraordinary. ` +
    `Hidden details beneath the surface are now coming to light. ` +
    `These discoveries may completely change our understanding. ` +
    `Thanks for watching`
  )
}


// ─────────────────────────────────────────
// STEP 2 — SCENE BREAKDOWN
// Splits script into 2 scenes of roughly 5 seconds each
// Each scene gets its own image prompt and motion prompt
// ─────────────────────────────────────────
function splitScenes(script, input) {
  const words = script.split(" ")
  const half = Math.ceil(words.length / 2)
  const scene1Script = words.slice(0, half).join(" ")
  const scene2Script = words.slice(half).join(" ")

  return [
    {
      script: scene1Script,
      imagePrompt: `Cinematic photorealistic scene about ${input}, dramatic lighting, 4K, wide shot, no text`,
      motion: `Slow cinematic zoom in, dramatic reveal of ${input}`
    },
    {
      script: scene2Script,
      imagePrompt: `Stunning close-up discovery scene related to ${input}, atmospheric, photorealistic, 4K, no text`,
      motion: `Slow cinematic pan right, mysterious atmosphere`
    }
  ]
}


// ─────────────────────────────────────────
// STEP 3 — IMAGE GENERATION
// Uses Flux 2 Max on Replicate
// ─────────────────────────────────────────
async function generateImage(prompt, index) {
  console.log(`Generating image ${index + 1}...`)

  const startRes = await fetch(
    "https://api.replicate.com/v1/models/black-forest-labs/flux-2-max/predictions",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.REPLICATE_API_KEY}`,
        "Content-Type": "application/json",
        Prefer: "wait=60"
      },
      body: JSON.stringify({
        input: {
          prompt,
          width: 1280,
          height: 720,
          output_format: "jpg",
          output_quality: 90
        }
      })
    }
  )

  let result = await startRes.json()

  // Poll until done
  while (result.status !== "succeeded" && result.status !== "failed") {
    await sleep(4000)
    const pollRes = await fetch(
      `https://api.replicate.com/v1/predictions/${result.id}`,
      { headers: { Authorization: `Bearer ${process.env.REPLICATE_API_KEY}` } }
    )
    result = await pollRes.json()
    console.log(`Image ${index + 1} status: ${result.status}`)
  }

  if (result.status === "failed") {
    throw new Error(`Image ${index + 1} failed: ${result.error}`)
  }

  const imageUrl = Array.isArray(result.output) ? result.output[0] : result.output
  const imgRes = await fetch(imageUrl)
  const buffer = await imgRes.buffer()
  const filePath = `/tmp/images/img_${index}.jpg`
  fs.writeFileSync(filePath, buffer)
  console.log(`Image ${index + 1} saved.`)
  return filePath
}


// ─────────────────────────────────────────
// STEP 4 — VIDEO GENERATION
// Uses Kling 1.6 on Replicate (image → 5 sec video)
// ─────────────────────────────────────────
async function generateVideo(imagePath, motionPrompt, index) {
  console.log(`Generating video ${index + 1}...`)

  const imageBuffer = fs.readFileSync(imagePath)
  const base64Image = `data:image/jpeg;base64,${imageBuffer.toString("base64")}`

  const startRes = await fetch(
    "https://api.replicate.com/v1/models/klingai/kling-1.6-standard/predictions",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.REPLICATE_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        input: {
          image: base64Image,
          prompt: motionPrompt,
          duration: 5,
          aspect_ratio: "16:9",
          cfg_scale: 0.5
        }
      })
    }
  )

  let result = await startRes.json()

  // Poll until done — Kling takes 2 to 5 minutes per clip
  while (result.status !== "succeeded" && result.status !== "failed") {
    await sleep(8000)
    const pollRes = await fetch(
      `https://api.replicate.com/v1/predictions/${result.id}`,
      { headers: { Authorization: `Bearer ${process.env.REPLICATE_API_KEY}` } }
    )
    result = await pollRes.json()
    console.log(`Video ${index + 1} status: ${result.status}`)
  }

  if (result.status === "failed") {
    throw new Error(`Video ${index + 1} failed: ${result.error}`)
  }

  const videoUrl = Array.isArray(result.output) ? result.output[0] : result.output
  const vidRes = await fetch(videoUrl)
  const buffer = await vidRes.buffer()
  const filePath = `/tmp/videos/video_${index}.mp4`
  fs.writeFileSync(filePath, buffer)
  console.log(`Video ${index + 1} saved.`)
  return filePath
}


// ─────────────────────────────────────────
// STEP 5 — VOICE GENERATION
// Uses ElevenLabs — finds Ellis voice automatically by name
// ─────────────────────────────────────────
async function getEllisVoiceId() {
  const res = await fetch("https://api.elevenlabs.io/v1/voices", {
    headers: { "xi-api-key": process.env.ELEVENLABS_API_KEY }
  })
  const data = await res.json()
  const ellis = data.voices.find((v) =>
    v.name.toLowerCase().includes("ellis")
  )
  if (!ellis) {
    throw new Error("Ellis voice not found. Check your ELEVENLABS_API_KEY in Railway.")
  }
  console.log(`Found Ellis voice: ${ellis.voice_id}`)
  return ellis.voice_id
}

async function generateVoice(text, voiceId, index) {
  console.log(`Generating voice ${index + 1}...`)

  const res = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`,
    {
      method: "POST",
      headers: {
        "xi-api-key": process.env.ELEVENLABS_API_KEY,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        text,
        model_id: "eleven_monolingual_v1",
        voice_settings: {
          stability: 0.5,
          similarity_boost: 0.75
        }
      })
    }
  )

  const buffer = await res.buffer()
  const filePath = `/tmp/voices/voice_${index}.mp3`
  fs.writeFileSync(filePath, buffer)
  console.log(`Voice ${index + 1} saved.`)
  return filePath
}


// ─────────────────────────────────────────
// STEP 6 — BACKGROUND MUSIC
// Downloads your Google Drive file and trims it to exact duration
// ─────────────────────────────────────────
async function downloadMusic() {
  console.log("Downloading background music from Google Drive...")

  const driveUrl = process.env.MUSIC_DRIVE_URL
  const match =
    driveUrl.match(/\/d\/([a-zA-Z0-9_-]+)/) ||
    driveUrl.match(/id=([a-zA-Z0-9_-]+)/)

  if (!match) {
    throw new Error("Cannot read MUSIC_DRIVE_URL. Make sure it is a valid Google Drive share link.")
  }

  const fileId = match[1]
  const downloadUrl = `https://drive.google.com/uc?export=download&id=${fileId}&confirm=t`

  const res = await fetch(downloadUrl)
  if (!res.ok) throw new Error(`Music download failed: HTTP ${res.status}`)

  const buffer = await res.buffer()
  const rawPath = `/tmp/music_raw.mp3`
  fs.writeFileSync(rawPath, buffer)
  console.log("Music downloaded.")
  return rawPath
}


// ─────────────────────────────────────────
// FFMPEG HELPERS
// ─────────────────────────────────────────

// Get exact duration of any audio or video file
function getDuration(filePath) {
  const result = execSync(
    `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${filePath}"`
  )
    .toString()
    .trim()
  return parseFloat(result)
}

// Trim video to exactly match the audio duration
function trimVideoToAudio(videoPath, audioDuration, index) {
  const outputPath = `/tmp/videos/video_trimmed_${index}.mp4`
  execSync(
    `ffmpeg -y -i "${videoPath}" -t ${audioDuration} -c:v libx264 -preset fast -crf 23 "${outputPath}"`
  )
  console.log(`Video ${index + 1} trimmed to ${audioDuration}s`)
  return outputPath
}

// Combine one video + one voice track into a single scene file
function combineSceneVoice(videoPath, voicePath, index) {
  const outputPath = `/tmp/final/scene_${index}.mp4`
  execSync(
    `ffmpeg -y -i "${videoPath}" -i "${voicePath}" -c:v copy -c:a aac -shortest "${outputPath}"`
  )
  console.log(`Scene ${index + 1} combined.`)
  return outputPath
}

// Concatenate all scene files then mix in background music underneath
function assembleFinalVideo(scenePaths, musicPath, totalDuration) {
  // Write the list of scenes for ffmpeg concat
  const concatFile = `/tmp/concat.txt`
  fs.writeFileSync(concatFile, scenePaths.map((p) => `file '${p}'`).join("\n"))

  // Join all scenes into one video
  const concatenated = `/tmp/final/concatenated.mp4`
  execSync(
    `ffmpeg -y -f concat -safe 0 -i "${concatFile}" -c copy "${concatenated}"`
  )

  // Trim music to exact total duration and lower the volume
  const musicTrimmed = `/tmp/final/music_trimmed.mp3`
  execSync(
    `ffmpeg -y -i "${musicPath}" -t ${totalDuration} -af "volume=0.15" "${musicTrimmed}"`
  )

  // Mix the scene audio (voice) with background music
  // Voice stays at full volume, music at 15%
  const finalPath = `/tmp/final/final_video.mp4`
  execSync(
    `ffmpeg -y -i "${concatenated}" -i "${musicTrimmed}" ` +
    `-filter_complex "[0:a]volume=1.0[voice];[1:a]volume=0.15[music];[voice][music]amix=inputs=2:duration=shortest[aout]" ` +
    `-map 0:v -map "[aout]" -c:v copy -c:a aac "${finalPath}"`
  )

  console.log("Final video assembled.")
  return finalPath
}


// ─────────────────────────────────────────
// TRIGGER — User sends "do it"
// ─────────────────────────────────────────
bot.onText(/^do it$/i, (msg) => {
  const chatId = msg.chat.id
  userState[chatId] = { step: "waiting_input" }
  bot.sendMessage(chatId, "Send theme, link, or text")
})


// ─────────────────────────────────────────
// MAIN PIPELINE
// ─────────────────────────────────────────
bot.on("message", async (msg) => {
  const chatId = msg.chat.id
  if (!userState[chatId] || userState[chatId].step !== "waiting_input") return
  if (/^do it$/i.test(msg.text)) return

  const input = msg.text
  userState[chatId].step = "processing"

  try {

    // ── 1. SCRIPT ──
    await bot.sendMessage(chatId, "✍️ Creating script...")
    const script = generateScript(input)
    await bot.sendMessage(chatId, `📄 Script:\n\n${script}`)

    // ── 2. SCENES ──
    await bot.sendMessage(chatId, "🎬 Splitting into 2 scenes...")
    const scenes = splitScenes(script, input)
    let sceneText = ""
    scenes.forEach((s, i) => {
      sceneText += `Scene ${i + 1}\n`
      sceneText += `Script: ${s.script}\n`
      sceneText += `Image prompt: ${s.imagePrompt}\n`
      sceneText += `Video motion prompt: ${s.motion}\n\n`
    })
    await bot.sendMessage(chatId, sceneText)

    // ── 3. IMAGES ──
    await bot.sendMessage(chatId, "🖼 Creating images...")
    const imagePaths = []
    for (let i = 0; i < scenes.length; i++) {
      await bot.sendMessage(chatId, `Generating image ${i + 1} of ${scenes.length}...`)
      const img = await generateImage(scenes[i].imagePrompt, i)
      imagePaths.push(img)
      await bot.sendPhoto(chatId, img, { caption: `Image ${i + 1}` })
    }

    // ── 4. VIDEOS ──
    await bot.sendMessage(chatId, "🎥 Creating videos... this takes a few minutes per clip ⏳")
    const videoPaths = []
    for (let i = 0; i < scenes.length; i++) {
      await bot.sendMessage(chatId, `Generating video ${i + 1} of ${scenes.length}... please wait ⏳`)
      const vid = await generateVideo(imagePaths[i], scenes[i].motion, i)
      videoPaths.push(vid)
      await bot.sendVideo(chatId, vid, { caption: `Raw video ${i + 1}` })
    }

    // ── 5. VOICE ──
    await bot.sendMessage(chatId, "🎙 Creating voice narration...")
    const voiceId = await getEllisVoiceId()
    const voicePaths = []
    for (let i = 0; i < scenes.length; i++) {
      await bot.sendMessage(chatId, `Generating voice ${i + 1} of ${scenes.length}...`)
      const voice = await generateVoice(scenes[i].script, voiceId, i)
      voicePaths.push(voice)
      await bot.sendAudio(chatId, voice, { caption: `Voice ${i + 1}` })
    }

    // ── 6. TRIM VIDEOS TO MATCH VOICE EXACTLY ──
    await bot.sendMessage(chatId, "✂️ Cutting videos to match voice length...")
    const sceneFinalPaths = []
    let totalDuration = 0

    for (let i = 0; i < scenes.length; i++) {
      const audioDuration = getDuration(voicePaths[i])
      totalDuration += audioDuration
      const trimmedVideo = trimVideoToAudio(videoPaths[i], audioDuration, i)
      const sceneFinal = combineSceneVoice(trimmedVideo, voicePaths[i], i)
      sceneFinalPaths.push(sceneFinal)
    }

    // ── 7. MUSIC ──
    await bot.sendMessage(chatId, "🎵 Getting background music...")
    const musicPath = await downloadMusic()

    // ── 8. FINAL ASSEMBLY ──
    await bot.sendMessage(chatId, `🎬 Rendering final video (total: ${totalDuration.toFixed(1)}s)...`)
    const finalVideo = assembleFinalVideo(sceneFinalPaths, musicPath, totalDuration)

    // ── 9. SEND FINAL VIDEO ──
    await bot.sendMessage(chatId, "✅ Done! Here is your final video:")
    await bot.sendVideo(chatId, finalVideo, {
      caption: "🎬 Auto-generated video"
    })

    userState[chatId].step = "done"

  } catch (err) {
    console.error("Pipeline error:", err)
    await bot.sendMessage(chatId, `❌ Failed: ${err.message}\n\nSend 'do it' to try again.`)
    userState[chatId] = {}
  }
})
