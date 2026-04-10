import TelegramBot from "node-telegram-bot-api"
import fs from "fs"
import fetch from "node-fetch"
import { execSync } from "child_process"
import OpenAI from "openai"

// ─────────────────────────────────────────
// SETUP
// ─────────────────────────────────────────
console.log("Starting bot...")

const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true })
bot.on("polling_error", (err) => console.error("Polling error:", err.message))

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
const REPLICATE_TOKEN = process.env.REPLICATE_API_TOKEN
const ELLIS_VOICE_ID = "QxpsWUTZAxznFqyH1goJ"

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let userState = {}

fs.mkdirSync("/tmp/images", { recursive: true })
fs.mkdirSync("/tmp/videos", { recursive: true })
fs.mkdirSync("/tmp/voices", { recursive: true })
fs.mkdirSync("/tmp/final", { recursive: true })

console.log("Bot is running.")


// ─────────────────────────────────────────
// 20 CAMERA TECHNIQUES
// Each has an image composition style and a video motion style
// They rotate automatically per scene index
// ─────────────────────────────────────────
const CAMERA_TECHNIQUES = [
  {
    name: "Handheld",
    imageStyle: "handheld camera shot, slight tilt, documentary feel, raw and real",
    motionStyle: "handheld shaky camera, organic realistic movement, documentary style"
  },
  {
    name: "Drone Aerial",
    imageStyle: "aerial drone shot from high above, bird's eye view, sweeping landscape",
    motionStyle: "slow drone pullback reveal, camera rises up showing full scene from above"
  },
  {
    name: "Slow Motion",
    imageStyle: "cinematic slow motion freeze frame, dramatic motion blur on edges",
    motionStyle: "ultra slow motion, 240fps look, every detail revealed in slow dramatic push in"
  },
  {
    name: "Dolly Zoom",
    imageStyle: "vertigo dolly zoom perspective, background stretching effect, unsettling depth",
    motionStyle: "dolly zoom effect, subject stays same size while background dramatically changes"
  },
  {
    name: "POV First Person",
    imageStyle: "first person POV shot, as if viewer is walking through the scene, immersive",
    motionStyle: "first person POV camera movement, walking forward into the scene"
  },
  {
    name: "Security Camera",
    imageStyle: "security camera angle, wide static shot, surveillance footage look, slightly grainy",
    motionStyle: "static security camera, no movement, slight grain, surveillance style"
  },
  {
    name: "News Broadcast",
    imageStyle: "news broadcast camera style, professional journalism angle, slightly zoomed",
    motionStyle: "news camera slow zoom in, professional broadcast movement"
  },
  {
    name: "Time Lapse",
    imageStyle: "time lapse photography style, motion blur on moving elements, static background",
    motionStyle: "time lapse movement, fast flowing environment with static camera"
  },
  {
    name: "Crane Shot",
    imageStyle: "crane shot perspective, camera slowly rising from ground level upward",
    motionStyle: "crane camera slowly rising from low to high, revealing the full scene"
  },
  {
    name: "Tracking Shot",
    imageStyle: "tracking shot, camera moves alongside subject, motion blur on background",
    motionStyle: "tracking shot, camera follows subject movement from the side"
  },
  {
    name: "Extreme Close Up",
    imageStyle: "extreme macro close up, small details fill the entire frame, shallow depth of field",
    motionStyle: "extreme close up slow zoom in, revealing tiny details dramatically"
  },
  {
    name: "Dutch Angle",
    imageStyle: "dutch angle tilt shot, camera rotated 20 degrees, unsettling dramatic framing",
    motionStyle: "dutch angle tilt, camera slowly rotates to reveal the scene at an angle"
  },
  {
    name: "Shoulder Mount",
    imageStyle: "shoulder mounted camera style, slight bounce and sway, journalistic feel",
    motionStyle: "shoulder mount camera, realistic bounce movement as if walking with camera"
  },
  {
    name: "360 Orbit",
    imageStyle: "360 orbit perspective, camera circling the subject, dynamic angle",
    motionStyle: "slow 360 degree orbit around the main subject, circular camera movement"
  },
  {
    name: "Rack Focus",
    imageStyle: "rack focus shot, foreground sharp while background beautifully blurred, bokeh",
    motionStyle: "pull focus from background to foreground, dramatic blur transition"
  },
  {
    name: "Top Down",
    imageStyle: "overhead top down shot, looking straight down at the scene from above",
    motionStyle: "overhead top down camera, slowly pulling back to reveal more of the scene"
  },
  {
    name: "Low Angle",
    imageStyle: "low angle ground level shot, looking dramatically upward, powerful perspective",
    motionStyle: "low angle camera tilting up slowly, dramatic upward reveal"
  },
  {
    name: "Whip Pan",
    imageStyle: "whip pan transition style, motion blur across the frame, dynamic energy",
    motionStyle: "fast whip pan movement, camera sweeps quickly across the scene"
  },
  {
    name: "Underwater",
    imageStyle: "underwater camera shot, light rays filtering through water, dreamy distortion",
    motionStyle: "underwater camera slowly rising toward the surface, light rays above"
  },
  {
    name: "Steadicam",
    imageStyle: "steadicam glide shot, perfectly smooth movement, cinematic float",
    motionStyle: "steadicam smooth glide forward, perfectly stable cinematic movement"
  }
]

function getCameraTechnique(sceneIndex) {
  return CAMERA_TECHNIQUES[sceneIndex % CAMERA_TECHNIQUES.length]
}


// ─────────────────────────────────────────
// PEOPLE PATTERN: 3 with, 1 without, 3 with, 2 without — repeat
// Cycle: [T, T, T, F, T, T, T, F, F] = 9 per cycle
// ─────────────────────────────────────────
const PEOPLE_CYCLE = [true, true, true, false, true, true, true, false, false]

function shouldHavePeople(sceneIndex) {
  return PEOPLE_CYCLE[sceneIndex % PEOPLE_CYCLE.length]
}


// ─────────────────────────────────────────
// REPLICATE POLLING
// ─────────────────────────────────────────
async function pollReplicate(predictionId, label) {
  const maxWait = 10 * 60 * 1000
  const start = Date.now()

  while (true) {
    if (Date.now() - start > maxWait) throw new Error(`${label} timed out after 10 minutes`)
    await sleep(6000)
    const res = await fetch(
      `https://api.replicate.com/v1/predictions/${predictionId}`,
      { headers: { Authorization: `Bearer ${REPLICATE_TOKEN}` } }
    )
    const result = await res.json()
    console.log(`${label} status: ${result.status}`)
    if (result.status === "succeeded") return result
    if (result.status === "failed") throw new Error(`${label} failed: ${result.error}`)
  }
}


// ─────────────────────────────────────────
// STEP 1 — SCRIPT GENERATION
// YouTube hook structure:
// - Opens with the most dramatic statement possible
// - Creates urgency and curiosity immediately
// - Ends with Thanks for watching
// ─────────────────────────────────────────
async function generateScript(input) {
  console.log("Generating script...")
  let context = input

  if (input.startsWith("http://") || input.startsWith("https://")) {
    try {
      const res = await fetch(input, { headers: { "User-Agent": "Mozilla/5.0" } })
      const html = await res.text()
      const text = html
        .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 4000)
      context = `Article content:\n${text}`
      console.log("Article fetched.")
    } catch (err) {
      context = `Topic: ${input}`
    }
  }

  const completion = await openai.chat.completions.create({
    model: "gpt-4o",
    messages: [
      {
        role: "system",
        content: `You are an expert YouTube scriptwriter who specializes in viral short-form content.

Your job is to write a 10-second voiceover script that hooks viewers in the first second.

YouTube hook science:
- Start with the most shocking or unexpected fact
- Use power words: secret, hidden, never seen, shocking, untold, discovered
- Create a knowledge gap — make the viewer feel they NEED to know more
- Short punchy sentences hit harder than long ones
- The first 3 words must be magnetic

Rules:
- Maximum 35 words
- 2 sentences only
- Must feel urgent and dramatic
- Must end with exactly: Thanks for watching
- No emojis, no hashtags
- Write ONLY the script, nothing else`
      },
      {
        role: "user",
        content: `Write a 10-second YouTube hook script about:\n\n${context}`
      }
    ],
    max_tokens: 120,
    temperature: 0.8
  })

  const script = completion.choices[0].message.content.trim()
  console.log("Script:", script)
  return script
}


// ─────────────────────────────────────────
// STEP 2 — SCENE BREAKDOWN
// Scene 1 = most dramatic hook visual
// Scene 2 = continuation / revelation
// Each gets camera technique + people decision baked in
// ─────────────────────────────────────────
async function splitScenes(script, totalScenes) {
  console.log("Splitting into scenes...")

  // Pre-assign camera technique and people for each scene
  const sceneSetup = Array.from({ length: totalScenes }, (_, i) => ({
    index: i,
    camera: getCameraTechnique(i),
    hasPeople: shouldHavePeople(i)
  }))

  const setupDescription = sceneSetup.map((s, i) =>
    `Scene ${i + 1}: camera=${s.camera.name}, people=${s.hasPeople ? "YES include 1-3 people relevant to the scene" : "NO people at all"}`
  ).join("\n")

  const completion = await openai.chat.completions.create({
    model: "gpt-4o",
    messages: [
      {
        role: "system",
        content: `You split a YouTube script into scenes for a short video.
Each scene needs a photorealistic image prompt and a video motion prompt.

Image prompt rules:
- Always photorealistic, real photography, no CGI, no illustration, no 3D
- Apply the assigned camera technique style to the composition
- If people are assigned: include 1-3 people that make sense for the scene
- If no people: pure environment, landscape, objects, no human presence
- High detail, cinematic, dramatic lighting
- No text, no watermarks, no logos

Motion prompt rules:
- Describe exactly how the camera moves during the video clip
- Use the assigned camera technique name and style
- Be specific: speed, direction, what is revealed

Return ONLY valid JSON. No markdown. No backticks.
Format:
{
  "scenes": [
    {
      "script": "the script text for this scene",
      "imagePrompt": "detailed photorealistic image prompt with camera style and people decision applied",
      "motionPrompt": "specific camera motion for Kling video generation"
    }
  ]
}`
      },
      {
        role: "user",
        content: `Split this script into ${totalScenes} scenes:\n\n"${script}"\n\nScene assignments:\n${setupDescription}`
      }
    ],
    max_tokens: 800,
    temperature: 0.7
  })

  const raw = completion.choices[0].message.content.trim()
  const data = JSON.parse(raw)

  return data.scenes.map((s, i) => ({
    script: s.script,
    imagePrompt: s.imagePrompt,
    motion: s.motionPrompt,
    camera: sceneSetup[i].camera.name,
    hasPeople: sceneSetup[i].hasPeople
  }))
}


// ─────────────────────────────────────────
// STEP 3 — IMAGE GENERATION
// Flux 2 Max — photorealistic only
// ─────────────────────────────────────────
async function generateImage(prompt, index) {
  console.log(`Starting image ${index + 1}...`)

  // Enforce photorealistic style in the prompt
  const fullPrompt = `${prompt}, photorealistic photography, real photo, shot on camera, ultra detailed, no CGI, no illustration, no 3D render, no painting`

  const res = await fetch(
    "https://api.replicate.com/v1/models/black-forest-labs/flux-2-max/predictions",
    {
      method: "POST",
      headers: { Authorization: `Bearer ${REPLICATE_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        input: {
          prompt: fullPrompt,
          width: 1280,
          height: 720,
          output_format: "jpg",
          output_quality: 95
        }
      })
    }
  )

  const prediction = await res.json()
  if (!prediction.id) throw new Error(`Image ${index + 1} could not start. Check REPLICATE_API_TOKEN.`)

  const result = await pollReplicate(prediction.id, `Image ${index + 1}`)
  const imageUrl = Array.isArray(result.output) ? result.output[0] : result.output
  const imgRes = await fetch(imageUrl)
  const buffer = await imgRes.buffer()
  const filePath = `/tmp/images/img_${index}.jpg`
  fs.writeFileSync(filePath, buffer)
  console.log(`Image ${index + 1} done.`)
  return filePath
}


// ─────────────────────────────────────────
// STEP 4 — VIDEO GENERATION
// Kling v2.6 — keeps its ambient sound effects
// Do NOT strip audio — we mix it in at 20% later
// ─────────────────────────────────────────
async function generateVideo(imagePath, motionPrompt, index) {
  console.log(`Starting video ${index + 1}...`)

  const imageBuffer = fs.readFileSync(imagePath)
  const base64Image = `data:image/jpeg;base64,${imageBuffer.toString("base64")}`

  const res = await fetch(
    "https://api.replicate.com/v1/models/kwaivgi/kling-v2.6/predictions",
    {
      method: "POST",
      headers: { Authorization: `Bearer ${REPLICATE_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        input: { image: base64Image, prompt: motionPrompt, duration: 5, aspect_ratio: "16:9" }
      })
    }
  )

  const prediction = await res.json()
  if (!prediction.id) throw new Error(`Video ${index + 1} could not start. Check REPLICATE_API_TOKEN.`)

  const result = await pollReplicate(prediction.id, `Video ${index + 1}`)
  const videoUrl = Array.isArray(result.output) ? result.output[0] : result.output
  const vidRes = await fetch(videoUrl)
  const buffer = await vidRes.buffer()
  const filePath = `/tmp/videos/video_${index}.mp4`
  fs.writeFileSync(filePath, buffer)
  console.log(`Video ${index + 1} done. Size: ${(buffer.length / 1024 / 1024).toFixed(1)}MB`)
  return filePath
}


// ─────────────────────────────────────────
// STEP 5 — VOICE GENERATION
// ElevenLabs Ellis voice
// ─────────────────────────────────────────
async function generateVoice(text, index) {
  console.log(`Generating voice ${index + 1}...`)

  const res = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${ELLIS_VOICE_ID}`,
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
    const errText = await res.text()
    throw new Error(`ElevenLabs failed (${res.status}): ${errText}`)
  }

  const buffer = await res.buffer()
  const filePath = `/tmp/voices/voice_${index}.mp3`
  fs.writeFileSync(filePath, buffer)
  console.log(`Voice ${index + 1} done.`)
  return filePath
}


// ─────────────────────────────────────────
// STEP 6 — BACKGROUND MUSIC
// ─────────────────────────────────────────
async function downloadMusic() {
  console.log("Downloading music...")
  const driveUrl = process.env.MUSIC_DRIVE_URL
  const match =
    driveUrl.match(/\/d\/([a-zA-Z0-9_-]+)/) ||
    driveUrl.match(/id=([a-zA-Z0-9_-]+)/)

  if (!match) throw new Error("MUSIC_DRIVE_URL is not a valid Google Drive link.")

  const fileId = match[1]
  const url = `https://drive.google.com/uc?export=download&id=${fileId}&confirm=t`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Music download failed: HTTP ${res.status}`)

  const buffer = await res.buffer()
  const rawPath = `/tmp/music_raw.mp3`
  fs.writeFileSync(rawPath, buffer)
  console.log(`Music downloaded. Size: ${(buffer.length / 1024 / 1024).toFixed(1)}MB`)
  return rawPath
}


// ─────────────────────────────────────────
// FFMPEG HELPERS
// ─────────────────────────────────────────
function getDuration(filePath) {
  return parseFloat(
    execSync(
      `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${filePath}"`
    ).toString().trim()
  )
}

function hasAudioStream(filePath) {
  try {
    const result = execSync(
      `ffprobe -v error -select_streams a:0 -show_entries stream=codec_type -of default=noprint_wrappers=1:nokey=1 "${filePath}"`
    ).toString().trim()
    return result === "audio"
  } catch {
    return false
  }
}

// Trim video to match voice duration exactly
function trimVideo(videoPath, duration, index) {
  const out = `/tmp/videos/video_trimmed_${index}.mp4`
  execSync(
    `ffmpeg -y -i "${videoPath}" -t ${duration} -c:v libx264 -preset fast -crf 18 -c:a aac -ar 44100 "${out}"`
  )
  return out
}

// Build one scene:
// Voice = 100%, Kling sound effects = 20%
// If Kling has no audio, just use voice alone
function buildScene(videoPath, voicePath, index) {
  const out = `/tmp/final/scene_${index}.mp4`
  const videoHasAudio = hasAudioStream(videoPath)

  if (videoHasAudio) {
    console.log(`Scene ${index + 1}: mixing voice (100%) + Kling SFX (20%)`)
    execSync(
      `ffmpeg -y -i "${videoPath}" -i "${voicePath}" ` +
      `-filter_complex "[0:a]volume=0.20[sfx];[1:a]volume=1.0[voice];[sfx][voice]amix=inputs=2:duration=longest:dropout_transition=0[aout]" ` +
      `-map 0:v -map "[aout]" ` +
      `-c:v libx264 -preset fast -crf 18 -c:a aac -ar 44100 -ac 2 ` +
      `-shortest "${out}"`
    )
  } else {
    console.log(`Scene ${index + 1}: Kling has no audio — using voice only`)
    execSync(
      `ffmpeg -y -i "${videoPath}" -i "${voicePath}" ` +
      `-map 0:v -map 1:a ` +
      `-c:v libx264 -preset fast -crf 18 -c:a aac -ar 44100 -ac 2 ` +
      `-shortest "${out}"`
    )
  }

  console.log(`Scene ${index + 1} built.`)
  return out
}

// Concatenate all scenes using filter_complex
// This is reliable for both video and audio
function concatScenes(scenePaths) {
  const out = `/tmp/final/concatenated.mp4`
  const n = scenePaths.length
  const inputs = scenePaths.map(p => `-i "${p}"`).join(" ")
  const streams = scenePaths.map((_, i) => `[${i}:v][${i}:a]`).join("")
  const filter = `${streams}concat=n=${n}:v=1:a=1[outv][outa]`

  execSync(
    `ffmpeg -y ${inputs} ` +
    `-filter_complex "${filter}" ` +
    `-map "[outv]" -map "[outa]" ` +
    `-c:v libx264 -preset fast -crf 18 -c:a aac -ar 44100 -ac 2 "${out}"`
  )
  console.log("All scenes concatenated.")
  return out
}

// Add background music underneath everything
// Music = 40%, existing audio (voice + SFX) stays as is
function addMusic(videoPath, musicPath, totalDuration) {
  const out = `/tmp/final/final_video.mp4`

  // Trim music to video length
  const musicTrimmed = `/tmp/final/music_trimmed.mp3`
  execSync(`ffmpeg -y -i "${musicPath}" -t ${totalDuration} -af "volume=0.40" "${musicTrimmed}"`)

  // Mix existing audio (voice + SFX already at their levels) with music at 40%
  execSync(
    `ffmpeg -y -i "${videoPath}" -i "${musicTrimmed}" ` +
    `-filter_complex "[0:a]volume=1.0[existing];[1:a]volume=0.40[music];[existing][music]amix=inputs=2:duration=first:dropout_transition=0[aout]" ` +
    `-map 0:v -map "[aout]" ` +
    `-c:v libx264 -preset slow -crf 18 -b:v 8M -maxrate 10M -bufsize 20M ` +
    `-c:a aac -b:a 192k -ar 44100 -ac 2 ` +
    `-movflags +faststart "${out}"`
  )

  const size = fs.statSync(out).size
  console.log(`Final video ready. Size: ${(size / 1024 / 1024).toFixed(1)}MB`)
  return out
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

  const TOTAL_SCENES = 2 // 2 scenes = ~10 seconds for testing

  try {

    // ── SCRIPT ──
    await bot.sendMessage(chatId, "✍️ Writing YouTube hook script...")
    const script = await generateScript(input)
    await bot.sendMessage(chatId, `📄 Script:\n\n${script}`)

    // ── SCENES ──
    await bot.sendMessage(chatId, "🎬 Building scenes with camera techniques...")
    const scenes = await splitScenes(script, TOTAL_SCENES)

    let sceneText = ""
    scenes.forEach((s, i) => {
      sceneText += `Scene ${i + 1} — 📷 ${s.camera} — 👥 ${s.hasPeople ? "People: YES" : "People: NO"}\n`
      sceneText += `Script: ${s.script}\n`
      sceneText += `Image: ${s.imagePrompt}\n`
      sceneText += `Motion: ${s.motion}\n\n`
    })
    await bot.sendMessage(chatId, sceneText)

    // ── IMAGES ──
    await bot.sendMessage(chatId, "🖼 Generating images with Flux 2 Max... (~1-2 min each)")
    const imagePaths = []
    for (let i = 0; i < scenes.length; i++) {
      await bot.sendMessage(chatId, `⏳ Image ${i + 1} — ${scenes[i].camera} technique...`)
      const img = await generateImage(scenes[i].imagePrompt, i)
      imagePaths.push(img)
      await bot.sendMessage(chatId, `✅ Image ${i + 1} done`)
    }

    // ── VIDEOS ──
    await bot.sendMessage(chatId, "🎥 Generating videos with Kling v2.6... (~3-5 min each) ⏳")
    const videoPaths = []
    for (let i = 0; i < scenes.length; i++) {
      await bot.sendMessage(chatId, `⏳ Video ${i + 1} generating... please wait`)
      const vid = await generateVideo(imagePaths[i], scenes[i].motion, i)
      videoPaths.push(vid)
      await bot.sendMessage(chatId, `✅ Video ${i + 1} done`)
    }

    // ── VOICE ──
    await bot.sendMessage(chatId, "🎙 Generating voice with Ellis...")
    const voicePaths = []
    for (let i = 0; i < scenes.length; i++) {
      const voice = await generateVoice(scenes[i].script, i)
      voicePaths.push(voice)
      await bot.sendMessage(chatId, `✅ Voice ${i + 1} done`)
    }

    // ── TRIM + BUILD SCENES ──
    await bot.sendMessage(chatId, "✂️ Mixing audio layers and cutting to length...")
    const scenePaths = []
    let totalDuration = 0

    for (let i = 0; i < scenes.length; i++) {
      const audioDuration = getDuration(voicePaths[i])
      totalDuration += audioDuration
      console.log(`Scene ${i + 1}: voice is ${audioDuration.toFixed(2)}s`)

      // Trim video to match voice length
      const trimmed = trimVideo(videoPaths[i], audioDuration, i)

      // Mix voice (100%) + Kling SFX (20%)
      const scene = buildScene(trimmed, voicePaths[i], i)
      scenePaths.push(scene)

      await bot.sendMessage(chatId, `✅ Scene ${i + 1} — ${audioDuration.toFixed(1)}s — Voice + SFX mixed`)
    }

    // ── CONCAT ──
    await bot.sendMessage(chatId, "🔗 Joining all scenes...")
    const concatenated = concatScenes(scenePaths)

    // ── MUSIC ──
    await bot.sendMessage(chatId, "🎵 Adding background music at 40%...")
    const musicPath = await downloadMusic()

    // ── FINAL HD RENDER ──
    await bot.sendMessage(chatId, `🎬 Rendering final HD video (${totalDuration.toFixed(1)}s)...`)
    const finalVideo = addMusic(concatenated, musicPath, totalDuration)

    // ── DELIVER ──
    await bot.sendVideo(chatId, finalVideo, {
      caption: `🎬 Final video ready!\n\nAudio mix:\n🎤 Voice: 100%\n🔊 Scene SFX: 20%\n🎵 Music: 40%`
    })

    await bot.sendMessage(chatId, "✅ Done! Send 'do it' to create another video.")

    userState[chatId].step = "done"

  } catch (err) {
    console.error("Pipeline error:", err)
    await bot.sendMessage(chatId, `❌ Error: ${err.message}\n\nSend 'do it' to try again.`)
    userState[chatId] = {}
  }
})
