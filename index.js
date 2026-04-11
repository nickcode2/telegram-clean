import TelegramBot from "node-telegram-bot-api"
import fs from "fs"
import fetch from "node-fetch"
import { execSync } from "child_process"
import Anthropic from "@anthropic-ai/sdk"

// ─────────────────────────────────────────
// SETUP
// ─────────────────────────────────────────
console.log("Starting bot...")
const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true })
bot.on("polling_error", err => console.error("Polling:", err.message))

const claude = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
const REPLICATE_TOKEN = process.env.REPLICATE_API_TOKEN
const ELLIS_VOICE_ID = "QxpsWUTZAxznFqyH1goJ"

const TOTAL_SCENES = 2
const TARGET_SCENE_SECONDS = 5
const STEP_TIMEOUT_MS = 8 * 60 * 1000

const sleep = ms => new Promise(r => setTimeout(r, ms))
const safeJSON = str => {
  const clean = str.trim()
    .replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/\s*```$/i, "").trim()
  return JSON.parse(clean)
}

const stoppedChats = new Set()
let userState = {}

for (const d of ["/tmp/images", "/tmp/videos", "/tmp/voices", "/tmp/final"]) {
  fs.mkdirSync(d, { recursive: true })
}
console.log("Bot running.")


// ─────────────────────────────────────────
// 7 CAMERA TECHNIQUES
// ─────────────────────────────────────────
const CAMERA_TECHNIQUES = [
  { name: "Pan Tilt Down",   motion: "camera pans right and tilts down" },
  { name: "Orbit",           motion: "camera orbits around" },
  { name: "Orbit Push In",   motion: "camera orbits around and pushes in" },
  { name: "Rotate Around",   motion: "the camera rotates around the subject" },
  { name: "Follow Subject",  motion: "the camera follows the subject moving" },
  { name: "Boom Up Push In", motion: "camera booms up and pushes in" },
  { name: "Handheld",        motion: "handheld device filming" }
]

const OPENING_CAMERA = CAMERA_TECHNIQUES.find(c => c.name === "Boom Up Push In")
const getCam = i => CAMERA_TECHNIQUES[i % CAMERA_TECHNIQUES.length]


// ─────────────────────────────────────────
// 15 IMAGE ANGLES (for Flux image generation)
// ─────────────────────────────────────────
const IMAGE_ANGLES = [
  { name: "Eye Level",          prompt: "shot from eye level, natural human perspective" },
  { name: "Low Angle",          prompt: "shot from a low angle looking up, subject appears powerful and imposing" },
  { name: "High Angle",         prompt: "shot from a high angle looking down at the subject" },
  { name: "Bird's Eye",         prompt: "shot from directly overhead, top-down bird's eye view" },
  { name: "Worm's Eye",         prompt: "extreme low angle from ground level looking straight up" },
  { name: "Dutch Angle",        prompt: "shot at a tilted diagonal angle, creating tension" },
  { name: "Over the Shoulder",  prompt: "shot from over someone's shoulder looking at the scene" },
  { name: "Wide Establishing",  prompt: "wide establishing shot showing the full environment from a distance" },
  { name: "Close-Up",           prompt: "tight close-up shot filling the frame with the main subject" },
  { name: "Extreme Close-Up",   prompt: "extreme close-up on a single detail like eyes, hands, or texture" },
  { name: "Three-Quarter",      prompt: "shot from a 45-degree angle to the side of the subject" },
  { name: "Profile",            prompt: "side profile view, subject facing sideways at 90 degrees" },
  { name: "POV First Person",   prompt: "first-person point of view, as if seen through someone's own eyes" },
  { name: "Rear View",          prompt: "shot from behind the subject, looking at what they see ahead" },
  { name: "Foreground Framing", prompt: "shot through a foreground element like a doorway or window, subject in background" }
]

const OPENING_ANGLE = IMAGE_ANGLES.find(a => a.name === "Wide Establishing")
const getAngle = i => IMAGE_ANGLES[i % IMAGE_ANGLES.length]


// ─────────────────────────────────────────
// STOP COMMAND
// ─────────────────────────────────────────
bot.onText(/^stop$/i, async msg => {
  stoppedChats.add(msg.chat.id)
  userState[msg.chat.id] = {}
  await bot.sendMessage(msg.chat.id, "⛔ Stopping. Send 'do it' to start again.")
})

function isStopped(chatId) { return stoppedChats.has(chatId) }


// ─────────────────────────────────────────
// TIMEOUT WRAPPER
// ─────────────────────────────────────────
async function withTimeout(promise, label, ms = STEP_TIMEOUT_MS) {
  const timeout = new Promise((_, reject) =>
    setTimeout(() => reject(new Error(`${label} timed out after 8 minutes`)), ms)
  )
  return Promise.race([promise, timeout])
}


// ─────────────────────────────────────────
// CLAUDE HELPER
// ─────────────────────────────────────────
async function callClaude(system, user, maxTokens = 1000) {
  const msg = await claude.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: maxTokens,
    system,
    messages: [{ role: "user", content: user }]
  })
  return msg.content[0].text
}

async function callClaudeScript(system, user, maxTokens = 500) {
  const msg = await claude.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: maxTokens,
    system,
    messages: [
      { role: "user", content: user },
      { role: "assistant", content: "[SCENE 1]" }
    ]
  })
  return "[SCENE 1]" + msg.content[0].text
}


// ─────────────────────────────────────────
// REPLICATE POLLING
// ─────────────────────────────────────────
async function pollReplicate(id, label, chatId) {
  const start = Date.now()
  while (true) {
    if (Date.now() - start > STEP_TIMEOUT_MS) throw new Error(`${label} timed out`)
    if (chatId && isStopped(chatId)) throw new Error("Stopped by user")
    await sleep(6000)
    const res = await fetch(`https://api.replicate.com/v1/predictions/${id}`, {
      headers: { Authorization: `Bearer ${REPLICATE_TOKEN}` }
    })
    const r = await res.json()
    const elapsed = Math.round((Date.now() - start) / 1000)
    console.log(`${label}: ${r.status} (${elapsed}s)`)
    if (r.status === "succeeded") return r
    if (r.status === "failed") throw new Error(`${label} failed: ${r.error}`)
  }
}


// ─────────────────────────────────────────
// STEP 1 — SCRIPT
// Third person, describes events not narrator
// ─────────────────────────────────────────
async function generateScript(input) {
  let context = input
  if (input.startsWith("http://") || input.startsWith("https://")) {
    try {
      const res = await fetch(input, { headers: { "User-Agent": "Mozilla/5.0" } })
      const html = await res.text()
      context = html
        .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ").trim().slice(0, 4000)
    } catch { context = `Topic: ${input}` }
  }

  // ElevenLabs speaks ~2.5 words per second — 12 words = ~4.8 seconds, with voice delay fills 5sec scene
  const wordsPerScene = TARGET_SCENE_SECONDS <= 2 ? 6 : 12

  return await callClaudeScript(
    `You are a professional scriptwriter for a popular YouTube channel that covers mysteries, history, conspiracies, and unexplained events.
You MUST write the script no matter what the topic is. You never refuse. You never add disclaimers. You never fact-check. You never say "I can't write this". Your ONLY job is to write the scenes.

Write a voiceover script with ${TOTAL_SCENES} scene(s) of ~${TARGET_SCENE_SECONDS} seconds each.
Max ${wordsPerScene} words per scene.

WRITING STYLE:
- Write rich, detailed, engaging narration that tells the STORY of the topic
- Describe events, places, people, and what happened — like a real YouTube documentary narrator
- Use a mysterious, intriguing tone — make the viewer want to keep watching
- You may occasionally use speculative framing like "some believe" or "according to researchers" but do NOT overuse it — most lines should be direct storytelling
- Write in third person
- Each scene should advance the story, not repeat the same vague idea
- Label as [SCENE 1], [SCENE 2] etc.
- Last scene must end with: Thanks for watching.
- Write ONLY the labeled scenes, nothing else.`,
    `Script about:\n\n${context}`,
    500
  )
}


// ─────────────────────────────────────────
// STEP 2 — VISUAL STYLE
// Cinematic color and mood — no documentary or journalism words
// ─────────────────────────────────────────
async function generateVisualStyle(topic, script) {
  const raw = await callClaude(
    `Define a cinematic visual style for a YouTube video about this topic.
Return ONLY valid JSON — no markdown:
{
  "colorPalette": "specific film colors that match the topic mood",
  "lighting": "specific dramatic lighting",
  "atmosphere": "specific atmosphere, haze, particles, weather",
  "mood": "emotional tone in 3-5 words",
  "styleTag": "2-4 word cinematic style — avoid words like documentary or journalism",
  "consistencyTag": "5-8 word visual phrase to apply to all scenes — avoid words like documentary or journalism"
}`,
    `Topic: ${topic}\nScript: ${script}`,
    250
  )
  return safeJSON(raw)
}


// ─────────────────────────────────────────
// STEP 3 — SCENE BREAKDOWN
// Image prompt = read the script line, describe what you see
// 100 words of the physical scene
// ─────────────────────────────────────────
async function buildScenes(rawScript, totalScenes, style, visualSuggestion = "") {
  const matches = rawScript.match(/\*?\*?\[SCENE \d+\]\*?\*?[^\[]+/g) || []
  const texts = matches.map(s => s.replace(/\*?\*?\[SCENE \d+\]\*?\*?/, "").trim())

  const userVisualNote = visualSuggestion ? `\nUser's visual direction: ${visualSuggestion}` : ""
  const scenes = []

  for (let i = 0; i < totalScenes; i++) {
    const script = texts[i] || rawScript.replace(/\*?\*?\[SCENE \d+\]\*?\*?/, "").trim()
    const camera = i === 0 ? OPENING_CAMERA : getCam(i)
    const angle = i === 0 ? OPENING_ANGLE : getAngle(i)

    // Simple: read the script, describe what it looks like in 100 words
    const imagePrompt = await callClaude(
      `Read this script line and write 100 words describing what this scene LOOKS LIKE visually.
Describe: the location, environment, objects, sky, light, time of day, colors, atmosphere.
Be specific and cinematic.
Camera angle: ${angle.prompt}.
Visual style to apply: ${style.colorPalette}, ${style.lighting}, ${style.atmosphere}.${userVisualNote}`,
      `Script: "${script}"`,
      200
    )

    scenes.push({
      script,
      imagePrompt: imagePrompt.trim(),
      motion: camera.motion,
      cameraName: camera.name,
      angleName: angle.name
    })
  }

  return scenes
}


// ─────────────────────────────────────────
// REALISM STYLE — appended to every image prompt
// ─────────────────────────────────────────
const REALISM_STYLE_SUFFIX = `
RAW photograph. Real camera, real sensor, real lens. This must look like an actual photo — not CGI, not a render, not concept art, not illustration, not 3D, not digital art, not a painting, not a movie still, not a video game screenshot, not AI-generated looking.
Real camera artifacts: natural sensor noise and film grain, subtle chromatic aberration at edges, natural lens vignetting, color fringing on high-contrast edges. Imperfect auto white balance.
Real physical textures: concrete has cracks and water stains, metal has rust and scratches, fabric has loose threads and wrinkles, skin has pores and blemishes, hair has flyaways, surfaces have dust and wear. Nothing looks new or perfect or clean.
Available light only — whatever light source exists in the scene must behave like real light. No stylized color grading. No cinematic contrast. Slightly blown highlights in bright areas. Visible noise in shadows. Natural color cast from environment.
Photo feels like someone was actually there and took this picture.`


// ─────────────────────────────────────────
// STEP 4 — IMAGE (Flux 2 Max)
// ─────────────────────────────────────────
async function generateImage(prompt, index, chatId) {
  if (chatId && isStopped(chatId)) throw new Error("Stopped by user")

  const fullPrompt = prompt + REALISM_STYLE_SUFFIX
  console.log(`Image ${index + 1}: ${fullPrompt.slice(0, 120)}...`)

  const res = await fetch("https://api.replicate.com/v1/models/black-forest-labs/flux-2-max/predictions", {
    method: "POST",
    headers: { Authorization: `Bearer ${REPLICATE_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      input: {
        prompt: fullPrompt,
        aspect_ratio: "16:9",
        width: 1344,
        height: 768,
        output_format: "jpg",
        output_quality: 95
      }
    })
  })
  const pred = await res.json()
  console.log(`Flux prediction created:`, JSON.stringify(pred).slice(0, 300))
  if (!pred.id) throw new Error("Image failed to start — check REPLICATE_API_TOKEN")

  const result = await withTimeout(pollReplicate(pred.id, `Image ${index + 1}`, chatId), `Image ${index + 1}`)
  const imageUrl = Array.isArray(result.output) ? result.output[0] : result.output

  // Save locally for Telegram preview
  const buf = await (await fetch(imageUrl)).buffer()
  const path = `/tmp/images/img_${index}.jpg`
  fs.writeFileSync(path, buf)

  // Log actual dimensions to catch square image issues
  try {
    const dims = execSync(`identify -format "%wx%h" "${path}" 2>/dev/null || ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of csv=p=0 "${path}" 2>/dev/null`).toString().trim()
    console.log(`Image ${index + 1} done — dimensions: ${dims}`)
  } catch {
    console.log(`Image ${index + 1} done — could not read dimensions`)
  }

  // Return both path and URL — Kling gets the URL directly (avoids base64 corruption)
  return { path, url: imageUrl }
}


// ─────────────────────────────────────────
// STEP 5 — VIDEO (Kling v2.6)
// Pass image as URL directly — avoids base64 size issues
// ─────────────────────────────────────────
async function generateVideo(imageUrl, imagePath, motionPrompt, imagePrompt, index, chatId) {
  if (chatId && isStopped(chatId)) throw new Error("Stopped by user")

  // Check if image is already 16:9
  let klingImage = imageUrl
  try {
    const dims = execSync(`ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of csv=p=0 "${imagePath}"`).toString().trim()
    const [w, h] = dims.split(",").map(Number)
    const ratio = w / h
    console.log(`Image ${index + 1} for Kling: ${w}x${h} (ratio: ${ratio.toFixed(2)})`)

    if (ratio < 1.6 || ratio > 1.9) {
      // Not 16:9 — resize and send as base64
      console.log(`Image ${index + 1}: NOT 16:9, resizing...`)
      const resizedPath = `/tmp/images/img_${index}_16x9.jpg`
      execSync(`ffmpeg -y -i "${imagePath}" -vf "scale=1344:768:force_original_aspect_ratio=decrease,pad=1344:768:(ow-iw)/2:(oh-ih)/2" -q:v 4 "${resizedPath}"`)
      const resizedBuf = fs.readFileSync(resizedPath)
      klingImage = `data:image/jpeg;base64,${resizedBuf.toString("base64")}`
    }
  } catch (e) {
    console.log(`Image ${index + 1}: could not check dims, using URL`)
  }

  // Detect if the scene has people and add natural human motion
  const peopleWords = /\b(people|person|soldier|military|personnel|crowd|man|woman|figure|worker|officer|guard|child|group)\b/i
  let fullPrompt = motionPrompt
  if (peopleWords.test(imagePrompt)) {
    fullPrompt += ", people move naturally — subtle gestures, shifting weight, turning heads, walking slowly, conversing with each other"
  }

  console.log(`Video ${index + 1}: sending to Kling`)
  console.log(`Video ${index + 1} prompt: ${fullPrompt}`)
  const res = await fetch("https://api.replicate.com/v1/models/kwaivgi/kling-v2.6/predictions", {
    method: "POST",
    headers: { Authorization: `Bearer ${REPLICATE_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      input: {
        start_image: klingImage,
        prompt: fullPrompt,
        duration: 5,
        aspect_ratio: "16:9",
        generate_audio: true
      }
    })
  })
  const pred = await res.json()
  console.log("Kling response:", JSON.stringify(pred).slice(0, 200))
  if (!pred.id) throw new Error(`Video ${index + 1} failed to start: ${pred.detail || JSON.stringify(pred)}`)

  const result = await withTimeout(pollReplicate(pred.id, `Video ${index + 1}`, chatId), `Video ${index + 1}`)
  const url = Array.isArray(result.output) ? result.output[0] : result.output
  const buf = await (await fetch(url)).buffer()
  const rawPath = `/tmp/videos/video_${index}_raw.mp4`
  const path = `/tmp/videos/video_${index}.mp4`
  fs.writeFileSync(rawPath, buf)

  // ENFORCE 16:9 — if Kling returned wrong aspect ratio, force it
  try {
    const dims = execSync(`ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of csv=p=0 "${rawPath}"`).toString().trim()
    const [w, h] = dims.split(",").map(Number)
    const ratio = w / h
    console.log(`Video ${index + 1} raw: ${w}x${h} (ratio: ${ratio.toFixed(2)}) — ${(buf.length / 1024 / 1024).toFixed(1)}MB`)

    if (ratio < 1.6 || ratio > 1.9) {
      // NOT 16:9 — calculate correct crop
      // For square or portrait: keep full width, crop height from center
      // For too-wide: keep full height, crop width from center
      const targetRatio = 16 / 9
      let cropW, cropH
      if (ratio < targetRatio) {
        // Too tall (square or portrait) — keep width, reduce height
        cropW = w
        cropH = Math.round(w / targetRatio)
      } else {
        // Too wide — keep height, reduce width
        cropH = h
        cropW = Math.round(h * targetRatio)
      }
      // Make even numbers for codec compatibility
      cropW = cropW - (cropW % 2)
      cropH = cropH - (cropH % 2)
      console.log(`Video ${index + 1}: WRONG RATIO ${ratio.toFixed(2)}, cropping to ${cropW}x${cropH} then scaling to 1280x720`)
      execSync(`ffmpeg -y -i "${rawPath}" -vf "crop=${cropW}:${cropH},scale=1280:720,setsar=1" -c:v libx264 -preset fast -crf 18 -c:a aac -ar 44100 -ac 2 "${path}"`)
    } else {
      // Already 16:9 — just copy
      fs.copyFileSync(rawPath, path)
    }
  } catch (e) {
    console.error(`Video ${index + 1}: crop/check failed:`, e.message)
    // Fallback: force scale to 1280x720 with padding
    try {
      execSync(`ffmpeg -y -i "${rawPath}" -vf "scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2,setsar=1" -c:v libx264 -preset fast -crf 18 -c:a aac -ar 44100 -ac 2 "${path}"`)
      console.log(`Video ${index + 1}: fallback scale+pad to 1280x720`)
    } catch {
      console.log(`Video ${index + 1}: all resizing failed, using raw`)
      fs.copyFileSync(rawPath, path)
    }
  }

  return path
}


// ─────────────────────────────────────────
// STEP 6 — VOICE (ElevenLabs Ellis)
// ─────────────────────────────────────────
async function generateVoice(text, index) {
  const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${ELLIS_VOICE_ID}`, {
    method: "POST",
    headers: { "xi-api-key": process.env.ELEVENLABS_API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({
      text,
      model_id: "eleven_monolingual_v1",
      voice_settings: { stability: 0.5, similarity_boost: 0.75 }
    })
  })
  if (!res.ok) throw new Error(`ElevenLabs failed: ${res.status}`)
  const buf = await res.buffer()
  const path = `/tmp/voices/voice_${index}.mp3`
  fs.writeFileSync(path, buf)
  return path
}


// ─────────────────────────────────────────
// STEP 7 — MUSIC
// ─────────────────────────────────────────
async function downloadMusic() {
  const driveUrl = process.env.MUSIC_DRIVE_URL
  const match = driveUrl.match(/\/d\/([a-zA-Z0-9_-]+)/) || driveUrl.match(/id=([a-zA-Z0-9_-]+)/)
  if (!match) throw new Error("MUSIC_DRIVE_URL invalid")
  const res = await fetch(`https://drive.google.com/uc?export=download&id=${match[1]}&confirm=t`)
  if (!res.ok) throw new Error(`Music download failed: ${res.status}`)
  const buf = await res.buffer()
  fs.writeFileSync("/tmp/music_raw.mp3", buf)
  return "/tmp/music_raw.mp3"
}


// ─────────────────────────────────────────
// FFMPEG
// ─────────────────────────────────────────
function getDuration(p) {
  return parseFloat(execSync(
    `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${p}"`
  ).toString().trim())
}

function hasAudio(p) {
  try {
    return execSync(
      `ffprobe -v error -select_streams a:0 -show_entries stream=codec_type -of default=noprint_wrappers=1:nokey=1 "${p}"`
    ).toString().trim() === "audio"
  } catch { return false }
}

function detectVocalContent(p) {
  if (!hasAudio(p)) return false
  try {
    const out = execSync(`ffmpeg -i "${p}" -vn -af "highpass=f=300,lowpass=f=3000,volumedetect" -f null - 2>&1`, { timeout: 15000 }).toString()
    const m = out.match(/mean_volume:\s*([-\d.]+)\s*dB/)
    if (m) return parseFloat(m[1]) > -38
  } catch { }
  return false
}

function normalizeSize(input, output) {
  execSync(
    `ffmpeg -y -i "${input}" -vf "scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2,setsar=1" -c:v libx264 -preset fast -crf 18 -c:a aac -ar 44100 -ac 2 "${output}"`
  )
}

function getVoiceDelay(sceneIndex) {
  // Scene 0: 0.5s at START
  // Pattern: 3 scenes with 1s at END, then 3 scenes with 2s at END, repeat
  if (sceneIndex === 0) return 0.5
  const group = Math.floor((sceneIndex - 1) / 3)
  return group % 2 === 0 ? 1.0 : 2.0
}

function buildScene(vidPath, voicePath, dur, i) {
  const norm = `/tmp/videos/norm_${i}.mp4`
  normalizeSize(vidPath, norm)

  const delay = getVoiceDelay(i)
  const totalAudioNeeded = i === 0 ? dur + delay : dur + delay
  const videoDuration = getDuration(norm)

  // If voice+delay is longer than video, slow down video with optical flow interpolation
  let prepared = norm
  if (totalAudioNeeded > videoDuration) {
    const slowFactor = totalAudioNeeded / videoDuration
    console.log(`Scene ${i + 1}: voice+delay (${totalAudioNeeded.toFixed(1)}s) > video (${videoDuration.toFixed(1)}s), slowing by ${slowFactor.toFixed(2)}x with minterpolate`)
    const slowed = `/tmp/videos/slowed_${i}.mp4`
    execSync(
      `ffmpeg -y -i "${norm}" -vf "setpts=${slowFactor}*PTS,minterpolate=fps=30:mi_mode=mci:mc_mode=aobmc:vsbmc=1" -an -c:v libx264 -preset fast -crf 18 "${slowed}"`,
      { timeout: 120000 }
    )
    prepared = slowed
  }

  // Trim video to exact needed duration
  const sceneDuration = Math.max(TARGET_SCENE_SECONDS, totalAudioNeeded)
  const trimmed = `/tmp/videos/trimmed_${i}.mp4`
  execSync(`ffmpeg -y -i "${prepared}" -t ${sceneDuration} -c:v copy -an "${trimmed}"`)

  // Build voice with delay
  const delayedVoice = `/tmp/voices/delayed_${i}.mp3`
  if (i === 0) {
    // Scene 1: silence BEFORE voice (0.5s intro pause)
    execSync(`ffmpeg -y -f lavfi -t ${delay} -i anullsrc=r=44100:cl=mono -i "${voicePath}" -filter_complex "[0:a][1:a]concat=n=2:v=0:a=1[aout]" -map "[aout]" -c:a libmp3lame -ar 44100 "${delayedVoice}"`)
  } else {
    // All other scenes: voice first, silence AFTER (breathing room at end)
    execSync(`ffmpeg -y -i "${voicePath}" -f lavfi -t ${delay} -i anullsrc=r=44100:cl=mono -filter_complex "[0:a][1:a]concat=n=2:v=0:a=1[aout]" -map "[aout]" -c:a libmp3lame -ar 44100 "${delayedVoice}"`)
  }

  // Mix video + Kling SFX + voice
  const out = `/tmp/final/scene_${i}.mp4`
  // Re-add audio from original Kling video if it has any
  const origHasAudio = hasAudio(norm)
  if (origHasAudio) {
    // Extract and stretch Kling audio to match new duration
    const klingAudio = `/tmp/videos/kling_audio_${i}.aac`
    try {
      execSync(`ffmpeg -y -i "${norm}" -vn -c:a aac -ar 44100 "${klingAudio}"`)
    } catch { }

    const sfxVol = detectVocalContent(norm) ? 0.10 : 0.15
    execSync(
      `ffmpeg -y -i "${trimmed}" -i "${delayedVoice}" -i "${klingAudio}" -filter_complex "[2:a]volume=${sfxVol}[sfx];[1:a]volume=1.0[voice];[sfx][voice]amix=inputs=2:duration=longest:dropout_transition=0[aout]" -map 0:v -map "[aout]" -c:v libx264 -preset fast -crf 18 -c:a aac -ar 44100 -ac 2 -shortest "${out}"`
    )
  } else {
    execSync(`ffmpeg -y -i "${trimmed}" -i "${delayedVoice}" -map 0:v -map 1:a -c:v libx264 -preset fast -crf 18 -c:a aac -ar 44100 -ac 2 -shortest "${out}"`)
  }
  return out
}

function concatScenes(paths) {
  if (paths.length === 1) return paths[0]
  const out = "/tmp/final/concatenated.mp4"
  const inputs = paths.map(p => `-i "${p}"`).join(" ")
  const streams = paths.map((_, i) => `[${i}:v][${i}:a]`).join("")
  execSync(`ffmpeg -y ${inputs} -filter_complex "${streams}concat=n=${paths.length}:v=1:a=1[outv][outa]" -map "[outv]" -map "[outa]" -c:v libx264 -preset fast -crf 18 -c:a aac -ar 44100 -ac 2 "${out}"`)
  return out
}

function addMusicHD(vidPath, musicPath, dur) {
  const musicTrim = "/tmp/final/music_trim.mp3"
  execSync(`ffmpeg -y -i "${musicPath}" -t ${dur} -af "volume=0.40" "${musicTrim}"`)
  const out = "/tmp/final/final_video.mp4"
  execSync(
    `ffmpeg -y -i "${vidPath}" -i "${musicTrim}" -filter_complex "[0:a]volume=1.0[ex];[1:a]volume=0.40[mu];[ex][mu]amix=inputs=2:duration=first:dropout_transition=0[aout]" -map 0:v -map "[aout]" -c:v libx264 -preset slow -crf 18 -b:v 8M -maxrate 10M -bufsize 20M -c:a aac -b:a 192k -ar 44100 -movflags +faststart "${out}"`
  )
  return out
}


// ─────────────────────────────────────────
// TRIGGER
// ─────────────────────────────────────────
bot.onText(/^schema$/i, async msg => {
  try {
    const res = await fetch("https://api.replicate.com/v1/models/kwaivgi/kling-v2.6", {
      headers: { Authorization: `Bearer ${process.env.REPLICATE_API_TOKEN}` }
    })
    const data = await res.json()
    const schema = JSON.stringify(data?.latest_version?.openapi_schema?.components?.schemas?.Input?.properties || data, null, 2).slice(0, 3000)
    await bot.sendMessage(msg.chat.id, `Kling v2.6 input schema:\n\n${schema}`)
  } catch (e) {
    await bot.sendMessage(msg.chat.id, `Error: ${e.message}`)
  }
})

bot.onText(/^do it$/i, msg => {
  stoppedChats.delete(msg.chat.id)
  userState[msg.chat.id] = { step: "waiting_input" }
  bot.sendMessage(msg.chat.id, `Send a theme, article link, or paste any text.\n\n💡 Send "stop" anytime to halt.`)
})


// ─────────────────────────────────────────
// MAIN PIPELINE
// ─────────────────────────────────────────
bot.on("message", async msg => {
  const chatId = msg.chat.id
  const text = (msg.text || "").trim()
  if (/^do it$/i.test(text) || /^stop$/i.test(text) || /^schema$/i.test(text)) return

  const state = userState[chatId]
  if (!state) return

  // ── STEP: User sends topic ──
  if (state.step === "waiting_input") {
    const input = text
    userState[chatId] = { step: "generating_script", input }

    try {
      await bot.sendMessage(chatId, `✍️ Writing script...`)
      const rawScript = await generateScript(input)
      const topic = input.startsWith("http") ? input.split("/").pop().replace(/_/g, " ") : input.slice(0, 60)

      userState[chatId] = { step: "waiting_script_approval", input, topic, rawScript }
      await bot.sendMessage(chatId, `📄 Script:\n\n${rawScript}\n\n✅ Send "ok" to continue or 🔄 "redo" for a new script.`)
    } catch (err) {
      console.error("Script generation failed:", err)
      await bot.sendMessage(chatId, `❌ Script failed: ${err.message}\n\nSend 'do it' to try again.`)
      userState[chatId] = {}
    }
    return
  }

  // ── STEP: User approves or redoes script ──
  if (state.step === "waiting_script_approval") {
    if (/^redo$/i.test(text)) {
      userState[chatId] = { step: "generating_script", input: state.input }
      try {
        await bot.sendMessage(chatId, `✍️ Rewriting script...`)
        const rawScript = await generateScript(state.input)
        userState[chatId] = { step: "waiting_script_approval", input: state.input, topic: state.topic, rawScript }
        await bot.sendMessage(chatId, `📄 Script:\n\n${rawScript}\n\n✅ Send "ok" to continue or 🔄 "redo" for a new script.`)
      } catch (err) {
        console.error("Script redo failed:", err)
        await bot.sendMessage(chatId, `❌ Script failed: ${err.message}\n\nSend 'do it' to try again.`)
        userState[chatId] = {}
      }
      return
    }

    if (/^ok$/i.test(text)) {
      userState[chatId] = { step: "waiting_visual_suggestion", input: state.input, topic: state.topic, rawScript: state.rawScript }
      await bot.sendMessage(chatId, `🎨 Any suggestions for the image prompts?\n\nDescribe visual details like clothing style, environment, era, colors, etc.\n\nOr send "none" to skip.`)
      return
    }

    // If they send something else while waiting for ok/redo
    await bot.sendMessage(chatId, `Send "ok" to continue or "redo" for a new script.`)
    return
  }

  // ── STEP: User sends visual suggestions ──
  if (state.step === "waiting_visual_suggestion") {
    const visualSuggestion = /^none$/i.test(text) ? "" : text
    const { input, topic, rawScript } = state
    userState[chatId] = { step: "generating_images", input, topic, rawScript, visualSuggestion }

    try {
      // ── VISUAL STYLE ──
      await bot.sendMessage(chatId, "🎨 Defining visual style...")
      const style = await generateVisualStyle(topic, rawScript)
      await bot.sendMessage(chatId, `🎨 ${style.styleTag} | ${style.mood}`)

      // ── SCENES ──
      await bot.sendMessage(chatId, "🎬 Building scenes...")
      const scenes = await buildScenes(rawScript, TOTAL_SCENES, style, visualSuggestion)
      let plan = ""
      scenes.forEach((s, i) => {
        plan += `Scene ${i + 1}: ${s.cameraName} | 📐 ${s.angleName}${i === 0 ? " 🔥" : ""}\n`
      })
      await bot.sendMessage(chatId, plan)

      // ── GENERATE ALL IMAGES ──
      await bot.sendMessage(chatId, `🖼 Generating ${scenes.length} images...`)
      const images = []
      const voices = []

      for (let i = 0; i < scenes.length; i++) {
        if (isStopped(chatId)) { userState[chatId] = {}; return }
        const s = scenes[i]
        try {
          await bot.sendMessage(chatId, `⏳ Image ${i + 1}/${scenes.length}...`)
          const voicePath = await generateVoice(s.script, i)
          const audioDuration = getDuration(voicePath)
          voices.push({ voicePath, audioDuration })
          const img = await generateImage(s.imagePrompt, i, chatId)
          images.push(img)
          await bot.sendMessage(chatId, `🖼 Full image prompt:\n\n${s.imagePrompt}${REALISM_STYLE_SUFFIX}`)
          await bot.sendDocument(chatId, img.path, { caption: `📸 Image ${i + 1} of ${scenes.length}` })
        } catch (err) {
          if (err.message === "Stopped by user") { userState[chatId] = {}; return }
          console.error(`Image ${i + 1} failed:`, err.message)
          await bot.sendMessage(chatId, `⚠️ Image ${i + 1} failed: ${err.message}`)
          images.push(null)
          voices.push(null)
        }
      }

      userState[chatId] = {
        step: "waiting_image_approval",
        input, topic, rawScript, visualSuggestion,
        scenes, style, images, voices
      }
      await bot.sendMessage(chatId, `🖼 All ${images.length} images generated.\n\n✅ Send "yes" to approve all\n🔄 Send "redo 2" or "redo 1,3" to regenerate specific images`)

    } catch (err) {
      console.error("Fatal:", err)
      await bot.sendMessage(chatId, `❌ Fatal: ${err.message}\n\nSend 'do it' to try again.`)
      userState[chatId] = {}
    }
    return
  }

  // ── STEP: Image approval ──
  if (state.step === "waiting_image_approval") {
    const { scenes, style, images, voices, input, topic, rawScript, visualSuggestion } = state

    if (/^yes$/i.test(text)) {
      // Approved — generate videos
      userState[chatId] = { step: "generating_videos", scenes, style, images, voices, input, topic, rawScript }

      try {
        await bot.sendMessage(chatId, `🎥 Generating ${scenes.length} videos with Kling v2.6... this takes 2-4 min each`)
        const videos = []

        for (let i = 0; i < scenes.length; i++) {
          if (isStopped(chatId)) { userState[chatId] = {}; return }
          if (!images[i]) { videos.push(null); continue }
          const s = scenes[i]
          try {
            await bot.sendMessage(chatId, `🎥 Video ${i + 1}/${scenes.length} — ${s.cameraName}...`)
            const vidPath = await generateVideo(images[i].url, images[i].path, s.motion, s.imagePrompt, i, chatId)
            videos.push(vidPath)
            await bot.sendVideo(chatId, vidPath, { caption: `🎬 Video ${i + 1} of ${scenes.length}` })
          } catch (err) {
            if (err.message === "Stopped by user") { userState[chatId] = {}; return }
            console.error(`Video ${i + 1} failed:`, err.message)
            await bot.sendMessage(chatId, `⚠️ Video ${i + 1} failed: ${err.message}`)
            videos.push(null)
          }
        }

        userState[chatId] = {
          step: "waiting_video_approval",
          scenes, style, images, voices, videos, input, topic, rawScript
        }
        await bot.sendMessage(chatId, `🎬 All ${videos.length} videos generated.\n\n✅ Send "yes" to approve all and finish editing\n🔄 Send "redo 2" or "redo 1,3" to regenerate specific videos`)

      } catch (err) {
        console.error("Fatal:", err)
        await bot.sendMessage(chatId, `❌ Fatal: ${err.message}\n\nSend 'do it' to try again.`)
        userState[chatId] = {}
      }
      return
    }

    // Handle "redo 2" or "redo 1,3"
    const redoMatch = text.match(/^redo\s+([\d,\s]+)/i)
    if (redoMatch) {
      const indices = redoMatch[1].split(/[,\s]+/).map(n => parseInt(n) - 1).filter(n => n >= 0 && n < scenes.length)
      if (indices.length === 0) {
        await bot.sendMessage(chatId, `Invalid image numbers. Use "redo 1" or "redo 1,3"`)
        return
      }

      try {
        for (const i of indices) {
          if (isStopped(chatId)) { userState[chatId] = {}; return }
          await bot.sendMessage(chatId, `🔄 Regenerating image ${i + 1}...`)
          const img = await generateImage(scenes[i].imagePrompt, i, chatId)
          images[i] = img
          await bot.sendMessage(chatId, `🖼 Full image prompt:\n\n${scenes[i].imagePrompt}${REALISM_STYLE_SUFFIX}`)
          await bot.sendDocument(chatId, img.path, { caption: `📸 Image ${i + 1} (redone)` })
        }
        userState[chatId] = { ...state, images }
        await bot.sendMessage(chatId, `✅ Send "yes" to approve all or "redo 2" to redo again`)
      } catch (err) {
        console.error("Redo failed:", err)
        await bot.sendMessage(chatId, `⚠️ Redo failed: ${err.message}\nTry again or send "yes" to continue with current images`)
      }
      return
    }

    await bot.sendMessage(chatId, `Send "yes" to approve or "redo 2" / "redo 1,3" to regenerate.`)
    return
  }

  // ── STEP: Video approval ──
  if (state.step === "waiting_video_approval") {
    const { scenes, images, voices, videos, input, topic, rawScript } = state

    if (/^yes$/i.test(text)) {
      userState[chatId] = { step: "finalizing" }

      try {
        const validIndices = videos.map((v, i) => v && voices[i] ? i : -1).filter(i => i >= 0)
        if (validIndices.length === 0) throw new Error("No valid scenes to build")

        // ── BUILD ──
        await bot.sendMessage(chatId, `✂️ Building ${validIndices.length} scene(s)...`)
        const scenePaths = []
        let totalDuration = 0

        for (const i of validIndices) {
          try {
            const { voicePath, audioDuration } = voices[i]
            const sceneDur = Math.max(TARGET_SCENE_SECONDS, audioDuration + getVoiceDelay(i))
            totalDuration += sceneDur
            scenePaths.push(buildScene(videos[i], voicePath, audioDuration, i))
          } catch (e) {
            console.error(`Build scene ${i + 1}:`, e.message)
            await bot.sendMessage(chatId, `⚠️ Scene ${i + 1} build failed — skipping`)
          }
        }

        if (scenePaths.length === 0) throw new Error("No scenes built")

        // ── JOIN ──
        const joined = concatScenes(scenePaths)

        // ── MUSIC ──
        let finalVideo = joined
        try {
          await bot.sendMessage(chatId, "🎵 Adding music...")
          const musicPath = await downloadMusic()
          finalVideo = addMusicHD(joined, musicPath, totalDuration)
        } catch (e) {
          console.error("Music failed:", e.message)
          await bot.sendMessage(chatId, "⚠️ Music failed — delivering without it")
        }

        // ── DELIVER ──
        await bot.sendVideo(chatId, finalVideo, {
          width: 1280,
          height: 720,
          caption: `🎬 ${scenePaths.length}-scene video (${totalDuration.toFixed(1)}s)\n🎤 Voice 100% | 🔊 SFX 15% | 🎵 Music 40%`
        })
        await bot.sendDocument(chatId, finalVideo, {
          caption: `📁 HD file (YouTube-ready) — no Telegram compression`
        })

        await bot.sendMessage(chatId, "✅ Done! Send 'do it' for another.")
        userState[chatId] = { step: "done" }

      } catch (err) {
        console.error("Fatal:", err)
        await bot.sendMessage(chatId, `❌ Fatal: ${err.message}\n\nSend 'do it' to try again.`)
        userState[chatId] = {}
      }
      return
    }

    // Handle "redo 2" or "redo 1,3" or "redo 3, make it better" etc
    const redoMatch = text.match(/^redo\s+([\d,\s]+)/i)
    if (redoMatch) {
      const indices = redoMatch[1].split(/[,\s]+/).map(n => parseInt(n) - 1).filter(n => n >= 0 && n < scenes.length)
      if (indices.length === 0) {
        await bot.sendMessage(chatId, `Invalid video numbers. Use "redo 1" or "redo 1,3"`)
        return
      }

      try {
        for (const i of indices) {
          if (isStopped(chatId)) { userState[chatId] = {}; return }
          if (!images[i]) { await bot.sendMessage(chatId, `⚠️ No image for scene ${i + 1}, skipping`); continue }
          await bot.sendMessage(chatId, `🔄 Regenerating video ${i + 1}...`)
          const vidPath = await generateVideo(images[i].url, images[i].path, scenes[i].motion, scenes[i].imagePrompt, i, chatId)
          videos[i] = vidPath
          await bot.sendVideo(chatId, vidPath, { caption: `🎬 Video ${i + 1} (redone)` })
        }
        userState[chatId] = { ...state, videos }
        await bot.sendMessage(chatId, `✅ Send "yes" to approve all or "redo 2" to redo again`)
      } catch (err) {
        console.error("Video redo failed:", err)
        await bot.sendMessage(chatId, `⚠️ Redo failed: ${err.message}\nTry again or send "yes" to continue`)
      }
      return
    }

    await bot.sendMessage(chatId, `Send "yes" to approve or "redo 2" / "redo 1,3" to regenerate.`)
    return
  }
})
