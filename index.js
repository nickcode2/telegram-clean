import TelegramBot from "node-telegram-bot-api"
import fs from "fs"
import fetch from "node-fetch"
import { execSync } from "child_process"
import { google } from "googleapis"
import OpenAI from "openai"

// ─────────────────────────────────────────
// SETUP
// ─────────────────────────────────────────
console.log("Starting bot...")

const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true })
bot.on("polling_error", (err) => console.error("Polling error:", err.message))

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let userState = {}

// Create temp folders
fs.mkdirSync("/tmp/images", { recursive: true })
fs.mkdirSync("/tmp/videos", { recursive: true })
fs.mkdirSync("/tmp/voices", { recursive: true })
fs.mkdirSync("/tmp/final", { recursive: true })

console.log("Bot is running. Waiting for messages...")


// ─────────────────────────────────────────
// GOOGLE DRIVE SETUP
// Reads your service account credentials from Railway
// and uploads files to a shared folder
// ─────────────────────────────────────────
function getDriveClient() {
  const credentials = JSON.parse(process.env.GDRIVE_CREDENTIALS)
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ["https://www.googleapis.com/auth/drive"]
  })
  return google.drive({ version: "v3", auth })
}

async function uploadToDrive(filePath, fileName, mimeType, folderId) {
  const drive = getDriveClient()
  const fileMetadata = {
    name: fileName,
    parents: folderId ? [folderId] : []
  }
  const media = {
    mimeType,
    body: fs.createReadStream(filePath)
  }
  const res = await drive.files.create({
    requestBody: fileMetadata,
    media,
    fields: "id, webViewLink"
  })
  console.log(`Uploaded to Drive: ${fileName} → ${res.data.webViewLink}`)
  return res.data
}

async function createDriveFolder(name) {
  const drive = getDriveClient()
  const res = await drive.files.create({
    requestBody: {
      name,
      mimeType: "application/vnd.google-apps.folder"
    },
    fields: "id"
  })
  return res.data.id
}


// ─────────────────────────────────────────
// STEP 1 — SCRIPT GENERATION WITH OPENAI
// If input is a URL: fetches and reads the article
// If input is text or theme: writes from it directly
// Always produces a clean 10-second script
// ─────────────────────────────────────────
async function generateScript(input) {
  console.log("Generating script with OpenAI...")

  let context = input

  // If it looks like a URL, try to fetch the article text
  if (input.startsWith("http://") || input.startsWith("https://")) {
    try {
      console.log("Fetching article from URL...")
      const res = await fetch(input, {
        headers: { "User-Agent": "Mozilla/5.0" }
      })
      const html = await res.text()

      // Extract readable text from HTML — strip all tags
      const text = html
        .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 4000) // first 4000 chars is enough for GPT

      context = `Article content:\n${text}`
      console.log("Article fetched successfully.")
    } catch (err) {
      console.log("Could not fetch URL, using it as topic:", err.message)
      context = `Topic: ${input}`
    }
  }

  // Ask OpenAI to write the script
  const completion = await openai.chat.completions.create({
    model: "gpt-4o",
    messages: [
      {
        role: "system",
        content: `You are a YouTube Shorts scriptwriter. 
Write a dramatic, engaging 10-second voiceover script.
Rules:
- Maximum 40 words total
- 2 sentences maximum
- Dramatic and engaging tone
- Must end with exactly: Thanks for watching
- No emojis, no hashtags, no questions
- Write ONLY the script, nothing else`
      },
      {
        role: "user",
        content: `Write a 10-second YouTube Shorts script about this:\n\n${context}`
      }
    ],
    max_tokens: 100,
    temperature: 0.7
  })

  const script = completion.choices[0].message.content.trim()
  console.log("Script generated:", script)
  return script
}


// ─────────────────────────────────────────
// STEP 2 — SCENE BREAKDOWN WITH OPENAI
// Splits script into 2 scenes
// Generates proper image prompts and motion prompts
// ─────────────────────────────────────────
async function splitScenes(script) {
  console.log("Splitting into scenes with OpenAI...")

  const completion = await openai.chat.completions.create({
    model: "gpt-4o",
    messages: [
      {
        role: "system",
        content: `You split a script into 2 scenes for a short video.
Return ONLY a valid JSON object. No explanation. No markdown. No backticks.
Format exactly:
{
  "scene1": {
    "script": "first half of script",
    "imagePrompt": "detailed cinematic image description, photorealistic, 4K, no text, no watermark",
    "motionPrompt": "camera movement description"
  },
  "scene2": {
    "script": "second half of script",
    "imagePrompt": "detailed cinematic image description, photorealistic, 4K, no text, no watermark",
    "motionPrompt": "camera movement description"
  }
}`
      },
      {
        role: "user",
        content: `Split this script into 2 scenes:\n\n${script}`
      }
    ],
    max_tokens: 500,
    temperature: 0.7
  })

  const raw = completion.choices[0].message.content.trim()
  const scenes = JSON.parse(raw)

  return [
    {
      script: scenes.scene1.script,
      imagePrompt: scenes.scene1.imagePrompt,
      motion: scenes.scene1.motionPrompt
    },
    {
      script: scenes.scene2.script,
      imagePrompt: scenes.scene2.imagePrompt,
      motion: scenes.scene2.motionPrompt
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
        "Content-Type": "application/json"
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

  if (result.detail && result.detail.includes("Invalid token")) {
    throw new Error("Replicate API key is invalid. Go to Railway → Variables → fix REPLICATE_API_KEY")
  }

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
// Uses Kling 1.6 on Replicate
// Image → 5 second cinematic video
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

  // Poll until done — Kling takes 2 to 5 minutes
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
// Uses ElevenLabs — finds Ellis voice automatically
// ─────────────────────────────────────────
async function getEllisVoiceId() {
  const res = await fetch("https://api.elevenlabs.io/v1/voices", {
    headers: { "xi-api-key": process.env.ELEVENLABS_API_KEY }
  })
  const data = await res.json()
  const ellis = data.voices?.find((v) =>
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
        voice_settings: { stability: 0.5, similarity_boost: 0.75 }
      })
    }
  )

  if (!res.ok) {
    throw new Error(`ElevenLabs failed: ${res.status}. Check ELEVENLABS_API_KEY in Railway.`)
  }

  const buffer = await res.buffer()
  const filePath = `/tmp/voices/voice_${index}.mp3`
  fs.writeFileSync(filePath, buffer)
  console.log(`Voice ${index + 1} saved.`)
  return filePath
}


// ─────────────────────────────────────────
// STEP 6 — BACKGROUND MUSIC
// Downloads your Google Drive music file
// and trims it to exact video duration
// ─────────────────────────────────────────
async function downloadMusic() {
  console.log("Downloading background music from Google Drive...")

  const driveUrl = process.env.MUSIC_DRIVE_URL
  const match =
    driveUrl.match(/\/d\/([a-zA-Z0-9_-]+)/) ||
    driveUrl.match(/id=([a-zA-Z0-9_-]+)/)

  if (!match) {
    throw new Error("MUSIC_DRIVE_URL is not a valid Google Drive link. Check Railway Variables.")
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
function getDuration(filePath) {
  return parseFloat(
    execSync(
      `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${filePath}"`
    )
      .toString()
      .trim()
  )
}

function trimVideoToAudio(videoPath, audioDuration, index) {
  const out = `/tmp/videos/video_trimmed_${index}.mp4`
  execSync(
    `ffmpeg -y -i "${videoPath}" -t ${audioDuration} -c:v libx264 -preset fast -crf 23 "${out}"`
  )
  console.log(`Video ${index + 1} trimmed to ${audioDuration}s`)
  return out
}

function combineSceneVoice(videoPath, voicePath, index) {
  const out = `/tmp/final/scene_${index}.mp4`
  execSync(
    `ffmpeg -y -i "${videoPath}" -i "${voicePath}" -c:v copy -c:a aac -shortest "${out}"`
  )
  return out
}

function assembleFinalVideo(scenePaths, musicPath, totalDuration) {
  // Concat scenes
  const concatFile = `/tmp/concat.txt`
  fs.writeFileSync(concatFile, scenePaths.map((p) => `file '${p}'`).join("\n"))
  const concatenated = `/tmp/final/concatenated.mp4`
  execSync(`ffmpeg -y -f concat -safe 0 -i "${concatFile}" -c copy "${concatenated}"`)

  // Trim music to total duration
  const musicTrimmed = `/tmp/final/music_trimmed.mp3`
  execSync(`ffmpeg -y -i "${musicPath}" -t ${totalDuration} -af "volume=0.15" "${musicTrimmed}"`)

  // Mix voice + music, combine with video
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
// TRIGGER
// ─────────────────────────────────────────
bot.onText(/^do it$/i, (msg) => {
  const chatId = msg.chat.id
  userState[chatId] = { step: "waiting_input" }
  bot.sendMessage(chatId, "Send me a theme, article link, or paste any text about your topic.")
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

  // Create a Google Drive folder for this session
  const folderName = `Video_${new Date().toISOString().slice(0, 16).replace("T", "_")}`
  let driveFolder = null

  try {

    // ── SCRIPT ──
    await bot.sendMessage(chatId, "✍️ Reading your input and writing script...")
    const script = await generateScript(input)
    await bot.sendMessage(chatId, `📄 Script:\n\n${script}`)

    // ── SCENES ──
    await bot.sendMessage(chatId, "🎬 Splitting into 2 scenes...")
    const scenes = await splitScenes(script)
    let sceneText = ""
    scenes.forEach((s, i) => {
      sceneText += `Scene ${i + 1}\n`
      sceneText += `Script: ${s.script}\n`
      sceneText += `Image prompt: ${s.imagePrompt}\n`
      sceneText += `Motion: ${s.motion}\n\n`
    })
    await bot.sendMessage(chatId, sceneText)

    // Create Drive folder now
    try {
      driveFolder = await createDriveFolder(folderName)
      console.log(`Drive folder created: ${folderName} (${driveFolder})`)
    } catch (e) {
      console.log("Drive folder creation failed, continuing without Drive:", e.message)
    }

    // ── IMAGES ──
    await bot.sendMessage(chatId, "🖼 Creating images with Flux 2 Max...")
    const imagePaths = []
    for (let i = 0; i < scenes.length; i++) {
      await bot.sendMessage(chatId, `Generating image ${i + 1} of ${scenes.length}...`)
      const img = await generateImage(scenes[i].imagePrompt, i)
      imagePaths.push(img)
      await bot.sendPhoto(chatId, img, { caption: `Image ${i + 1}` })

      // Save to Drive
      if (driveFolder) {
        await uploadToDrive(img, `image_${i + 1}.jpg`, "image/jpeg", driveFolder).catch(e =>
          console.log("Drive upload failed for image:", e.message)
        )
      }
    }

    // ── VIDEOS ──
    await bot.sendMessage(chatId, "🎥 Creating videos with Kling AI... ⏳ takes a few minutes per clip")
    const videoPaths = []
    for (let i = 0; i < scenes.length; i++) {
      await bot.sendMessage(chatId, `Generating video ${i + 1} of ${scenes.length}... please wait ⏳`)
      const vid = await generateVideo(imagePaths[i], scenes[i].motion, i)
      videoPaths.push(vid)
      await bot.sendVideo(chatId, vid, { caption: `Raw video ${i + 1}` })

      // Save to Drive
      if (driveFolder) {
        await uploadToDrive(vid, `video_raw_${i + 1}.mp4`, "video/mp4", driveFolder).catch(e =>
          console.log("Drive upload failed for video:", e.message)
        )
      }
    }

    // ── VOICE ──
    await bot.sendMessage(chatId, "🎙 Creating voice narration with Ellis...")
    const voiceId = await getEllisVoiceId()
    const voicePaths = []
    for (let i = 0; i < scenes.length; i++) {
      const voice = await generateVoice(scenes[i].script, voiceId, i)
      voicePaths.push(voice)
      await bot.sendAudio(chatId, voice, { caption: `Voice ${i + 1}` })

      // Save to Drive
      if (driveFolder) {
        await uploadToDrive(voice, `voice_${i + 1}.mp3`, "audio/mpeg", driveFolder).catch(e =>
          console.log("Drive upload failed for voice:", e.message)
        )
      }
    }

    // ── TRIM VIDEOS TO MATCH VOICE + COMBINE ──
    await bot.sendMessage(chatId, "✂️ Cutting each video to match voice length...")
    const sceneFinalPaths = []
    let totalDuration = 0

    for (let i = 0; i < scenes.length; i++) {
      const audioDuration = getDuration(voicePaths[i])
      totalDuration += audioDuration
      console.log(`Scene ${i + 1} audio duration: ${audioDuration}s`)
      const trimmedVideo = trimVideoToAudio(videoPaths[i], audioDuration, i)
      const sceneFinal = combineSceneVoice(trimmedVideo, voicePaths[i], i)
      sceneFinalPaths.push(sceneFinal)
    }

    // ── MUSIC ──
    await bot.sendMessage(chatId, "🎵 Adding your background music...")
    const musicPath = await downloadMusic()

    // ── FINAL ASSEMBLY ──
    await bot.sendMessage(chatId, `🎬 Rendering final video (${totalDuration.toFixed(1)}s total)...`)
    const finalVideo = assembleFinalVideo(sceneFinalPaths, musicPath, totalDuration)

    // Save final video to Drive
    let driveLink = ""
    if (driveFolder) {
      try {
        const uploaded = await uploadToDrive(finalVideo, "FINAL_VIDEO.mp4", "video/mp4", driveFolder)
        driveLink = uploaded.webViewLink
      } catch (e) {
        console.log("Drive upload failed for final video:", e.message)
      }
    }

    // ── DELIVERY ──
    await bot.sendVideo(chatId, finalVideo, {
      caption: "🎬 Your final video is ready!"
    })

    if (driveLink) {
      await bot.sendMessage(
        chatId,
        `✅ Video saved to Google Drive:\n${driveLink}\n\nAll files (images, videos, audio) are in the same folder.`
      )
    } else {
      await bot.sendMessage(chatId, "✅ Done! (Drive saving was skipped — check GDRIVE_CREDENTIALS)")
    }

    userState[chatId].step = "done"

  } catch (err) {
    console.error("Pipeline error:", err)
    await bot.sendMessage(
      chatId,
      `❌ Failed: ${err.message}\n\nSend 'do it' to try again.`
    )
    userState[chatId] = {}
  }
})
