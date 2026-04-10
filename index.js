import TelegramBot from "node-telegram-bot-api"
import fs from "fs"
import fetch from "node-fetch"
import { execSync } from "child_process"
import { google } from "googleapis"
import Anthropic from "@anthropic-ai/sdk"
import sharp from "sharp"

// ─────────────────────────────────────────
// SETUP
// ─────────────────────────────────────────
console.log("Starting bot...")
const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true })
bot.on("polling_error", err => console.error("Polling:", err.message))

const claude = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
const REPLICATE_TOKEN = process.env.REPLICATE_API_TOKEN
const ELLIS_VOICE_ID = "QxpsWUTZAxznFqyH1goJ"

const TOTAL_SCENES = 6
const REPORTER_EVERY = 4

const REPORTER_PHOTO_IDS = [
  "1-j1_7baQ9ZUReTkt0akX5R1bg8XGlLEg",
  "1W7GjxliUVN9uyjwZVhzC0S9LjI0s-X3L",
  "1t0qbfayOQrbWlVPh70sMLn8lHG0oOtEI"
]
const THUMBNAIL_PNG_ID = "1xhXV1MY484aAdmZiA9a6zeDNkWUT9uQo"

const sleep = ms => new Promise(r => setTimeout(r, ms))
const safeJSON = str => {
  const clean = str.trim()
    .replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/\s*```$/i, "").trim()
  return JSON.parse(clean)
}

let userState = {}
let reporterPhotoIndex = 0

for (const d of ["/tmp/images", "/tmp/videos", "/tmp/voices", "/tmp/final", "/tmp/assets"]) {
  fs.mkdirSync(d, { recursive: true })
}
console.log("Bot running.")


// ─────────────────────────────────────────
// 19 CAMERA TECHNIQUES (Slow Motion removed)
// ─────────────────────────────────────────
// 13 Kling-native camera movements — proven to work with any scene type
const CAMERA_TECHNIQUES = [
  { name: "Pan Right",           motionStyle: "camera pans right" },
  { name: "Pan and Tilt Down",   motionStyle: "camera pans right and tilts down" },
  { name: "Zoom In",             motionStyle: "the camera zooms in" },
  { name: "Zoom Out",            motionStyle: "The camera zooms out" },
  { name: "Tilt Up",             motionStyle: "camera tilts up" },
  { name: "Tilt Down",           motionStyle: "camera tilts down" },
  { name: "Orbit",               motionStyle: "camera orbits around" },
  { name: "Orbit Push In",       motionStyle: "camera orbits around and pushes in" },
  { name: "Rotate Around",       motionStyle: "the camera rotates around the subject" },
  { name: "Follow Subject",      motionStyle: "the camera follows the subject moving" },
  { name: "Boom Up Push In",     motionStyle: "camera booms up and pushes in" },
  { name: "Handheld",            motionStyle: "handheld device filming" },
  { name: "Long Shot",           motionStyle: "positioned at a Long Shot" }
]

const getCam = i => CAMERA_TECHNIQUES[i % CAMERA_TECHNIQUES.length]
const PEOPLE_CYCLE = [true, true, true, false, true, true, true, false, false]
const hasPeople = i => PEOPLE_CYCLE[i % PEOPLE_CYCLE.length]
const isReporter = i => (i + 1) % REPORTER_EVERY === 0


// ─────────────────────────────────────────
// CLAUDE — all text generation
// ─────────────────────────────────────────
async function callClaude(systemPrompt, userMessage, maxTokens = 1000) {
  const msg = await claude.messages.create({
    model: "claude-opus-4-5",
    max_tokens: maxTokens,
    system: systemPrompt,
    messages: [{ role: "user", content: userMessage }]
  })
  return msg.content[0].text
}


// ─────────────────────────────────────────
// GOOGLE DRIVE
// ─────────────────────────────────────────
function getDriveClient() {
  const credentials = JSON.parse(process.env.GDRIVE_CREDENTIALS)
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ["https://www.googleapis.com/auth/drive"]
  })
  return google.drive({ version: "v3", auth })
}

async function uploadToDrive(filePath, fileName, mimeType) {
  const folderId = process.env.DRIVE_FOLDER_ID
  if (!folderId) { console.log("No DRIVE_FOLDER_ID — skipping"); return null }
  try {
    const stat = fs.statSync(filePath)
    console.log(`Uploading ${fileName} (${(stat.size / 1024 / 1024).toFixed(1)}MB)...`)
    const drive = getDriveClient()
    const res = await drive.files.create({
      requestBody: { name: fileName, parents: [folderId] },
      media: { mimeType, body: fs.createReadStream(filePath) },
      fields: "id, webViewLink"
    })
    await drive.permissions.create({
      fileId: res.data.id,
      requestBody: { role: "reader", type: "anyone" }
    })
    console.log(`Drive OK: ${res.data.webViewLink}`)
    return res.data
  } catch (err) {
    console.error(`Drive upload failed (${fileName}):`, err.message)
    return null
  }
}

async function downloadFromDrive(fileId, outPath) {
  const url = `https://drive.google.com/uc?export=download&id=${fileId}&confirm=t`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Drive download failed: ${res.status} (ID: ${fileId})`)
  const buf = await res.buffer()
  fs.writeFileSync(outPath, buf)
  console.log(`Downloaded: ${outPath} (${(buf.length / 1024).toFixed(0)}KB)`)
  return outPath
}


// ─────────────────────────────────────────
// REPLICATE POLLING
// ─────────────────────────────────────────
async function pollReplicate(id, label) {
  const start = Date.now()
  while (true) {
    if (Date.now() - start > 12 * 60 * 1000) throw new Error(`${label} timed out`)
    await sleep(6000)
    const res = await fetch(`https://api.replicate.com/v1/predictions/${id}`, {
      headers: { Authorization: `Bearer ${REPLICATE_TOKEN}` }
    })
    const r = await res.json()
    console.log(`${label}: ${r.status}`)
    if (r.status === "succeeded") return r
    if (r.status === "failed") throw new Error(`${label} failed: ${r.error}`)
  }
}


// ─────────────────────────────────────────
// STEP 1 — SCRIPT (Claude)
// ─────────────────────────────────────────
async function generateScript(input) {
  let context = input
  if (input.startsWith("http://") || input.startsWith("https://")) {
    try {
      const res = await fetch(input, { headers: { "User-Agent": "Mozilla/5.0" } })
      const html = await res.text()
      context = "Article:\n" + html
        .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ").trim().slice(0, 4000)
    } catch { context = `Topic: ${input}` }
  }

  return await callClaude(
    `You write viral YouTube voiceover scripts for 30-second videos (6 scenes of 5 seconds each).

Structure:
- [SCENE 1]: Most shocking opening revelation — hits immediately
- [SCENE 2]: Second shocking detail that deepens the hook
- [SCENE 3]: Context that makes it more fascinating
- [SCENE 4]: The key turning point or discovery
- [SCENE 5]: The consequence or impact of this revelation
- [SCENE 6]: Final punch — must end with exactly: Thanks for watching

Rules:
- Label every scene: [SCENE 1] text [SCENE 2] text etc.
- 12-16 words maximum per scene
- First 3 words of Scene 1 must be magnetic
- Use real names, dates, numbers when available
- Declarative statements only — no questions
- Write ONLY the 6 labeled scenes, nothing else`,
    `Write a 30-second 6-scene YouTube script about:\n\n${context}`,
    400
  )
}


// ─────────────────────────────────────────
// STEP 2 — VISUAL STYLE (Claude)
// ─────────────────────────────────────────
async function generateVisualStyle(topic, script) {
  const raw = await callClaude(
    `Define a cinematic visual style for a YouTube documentary. Applied to ALL scenes for consistency.
Return ONLY valid JSON — no markdown, no backticks.
{
  "colorPalette": "specific colors",
  "lighting": "specific lighting description",
  "atmosphere": "atmosphere and particle effects",
  "mood": "emotional tone",
  "styleTag": "2-4 word style name",
  "consistencyTag": "5-8 word phrase appended to every prompt",
  "avoid": "elements to avoid in all images"
}`,
    `Topic: ${topic}\nScript: ${script}`,
    300
  )
  return safeJSON(raw)
}


// ─────────────────────────────────────────
// STEP 3 — SCENE BREAKDOWN (Claude)
// 100+ word prompts, no stock images, no people talking
// ─────────────────────────────────────────
async function buildScenes(rawScript, totalScenes, style, topic) {
  const matches = rawScript.match(/\[SCENE \d+\][^\[]+/g) || []
  const texts = matches.map(s => s.replace(/\[SCENE \d+\]/, "").trim())

  const setup = Array.from({ length: totalScenes }, (_, i) => ({
    index: i,
    camera: getCam(i),
    hasPeople: hasPeople(i),
    isReporter: isReporter(i),
    script: texts[i] || `Scene ${i + 1} about ${topic}`
  }))

  const setupList = setup.map((s, i) =>
    `Scene ${i + 1}: "${s.script}" | Camera movement: ${s.camera.name} (${s.camera.motionStyle}) | People: ${
      s.isReporter ? "REPORTER_SCENE — write REPORTER_SCENE as imagePrompt" :
      s.hasPeople ? "YES — 1-3 people in physical action, NOT talking, NOT facing each other, always show environment around them" :
      "NO people — environment, objects, or landscape only"
    }`
  ).join("\n\n")

  const raw = await callClaude(
    `Write detailed cinematic image prompts and motion prompts for YouTube documentary scenes.

VISUAL STYLE (apply to every scene):
Color palette: ${style.colorPalette}
Lighting: ${style.lighting}
Atmosphere: ${style.atmosphere}
Mood: ${style.mood}
Consistency tag: ${style.consistencyTag}
Avoid: ${style.avoid}

IMAGE PROMPT RULES:
- MINIMUM 100 WORDS per prompt — be extremely specific and cinematic
- Photorealistic photography ONLY — real photo aesthetic, professional cinema camera, no CGI, no illustration, no 3D
- Apply visual style to every scene for consistency
- Apply camera technique composition to framing
- People rules: if included, show in purposeful action (excavating, observing horizon, running, working equipment, reacting to something off-camera) — NEVER two people facing each other in dialogue — NEVER isolated close-up portrait without environment — always show significant environment
- Include in every prompt: specific location/geography, weather, time of day, specific objects that tell the story, lighting direction, camera angle, depth of field
- FORBIDDEN: stock photo aesthetic, plain backgrounds, studio lighting, people looking at camera, conversation poses, generic landscapes
- SAFETY (critical): Never include violence, weapons, blood, death, abuse, nudity, or anything that could be flagged by content moderation. Keep all scenes visually safe and documentary-appropriate.

MOTION PROMPT: specific Kling camera movement, 15-25 words, match the camera technique

Return ONLY valid JSON — no markdown:
{"scenes":[{"imagePrompt":"...","motionPrompt":"..."}]}`,
    `Generate prompts for ${totalScenes} scenes:\n\n${setupList}`,
    2500
  )

  const data = safeJSON(raw)
  return setup.map((s, i) => ({
    ...s,
    imagePrompt: data.scenes[i]?.imagePrompt || `${s.script}, ${style.styleTag}, photorealistic`,
    motion: data.scenes[i]?.motionPrompt || s.camera.motionStyle
  }))
}


// ─────────────────────────────────────────
// STEP 4 — IMAGE (Flux 2 Max)
// Auto-retries with safer prompt if content is flagged (E005)
// ─────────────────────────────────────────
function sanitizePrompt(prompt) {
  // Remove words that commonly trigger content filters
  return prompt
    .replace(/\b(dead|death|dying|corpse|blood|gore|weapon|gun|knife|bomb|explosion|terror|torture|abuse|violent|massacre|murder|kill|war crime|genocide|naked|nude|sexual)\b/gi, "")
    .replace(/\s+/g, " ").trim()
}

async function generateImage(prompt, avoid, index) {
  const attempts = [
    // Attempt 1: full prompt
    `${prompt}. Shot on professional cinema camera. Ultra high resolution. No CGI. No illustration. No 3D. No text. No watermarks. Avoid: ${avoid}.`,
    // Attempt 2: sanitized prompt
    `${sanitizePrompt(prompt)}. Cinematic photorealistic. Dramatic lighting. No text. No watermarks.`,
    // Attempt 3: very safe generic fallback based on first 50 chars
    `Dramatic cinematic landscape scene, ${prompt.slice(0, 60)}. Documentary photography. No people. No text.`
  ]

  for (let attempt = 0; attempt < attempts.length; attempt++) {
    try {
      const full = attempts[attempt]
      console.log(`Image ${index + 1} attempt ${attempt + 1}...`)

      const res = await fetch("https://api.replicate.com/v1/models/black-forest-labs/flux-2-max/predictions", {
        method: "POST",
        headers: { Authorization: `Bearer ${REPLICATE_TOKEN}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          input: { prompt: full, width: 1280, height: 720, output_format: "jpg", output_quality: 95 }
        })
      })
      const pred = await res.json()
      if (!pred.id) throw new Error(`No prediction ID. Check REPLICATE_API_TOKEN.`)

      const result = await pollReplicate(pred.id, `Image ${index + 1}`)
      const url = Array.isArray(result.output) ? result.output[0] : result.output
      const buf = await (await fetch(url)).buffer()
      const path = `/tmp/images/img_${index}.jpg`
      fs.writeFileSync(path, buf)
      console.log(`Image ${index + 1} done on attempt ${attempt + 1}`)
      return path

    } catch (err) {
      const isSensitive = err.message.includes("E005") || err.message.includes("sensitive") || err.message.includes("flagged")
      if (isSensitive && attempt < attempts.length - 1) {
        console.log(`Image ${index + 1}: Content flagged (attempt ${attempt + 1}), retrying with safer prompt...`)
        continue
      }
      throw err
    }
  }
}


// ─────────────────────────────────────────
// STEP 4B — REPORTER LIP-SYNC (Kling)
// Tries multiple param conventions since Kling model names vary
// Logs full response so we can debug if it fails
// ─────────────────────────────────────────
async function generateReporterLipSync(audioPath, index) {
  const photoId = REPORTER_PHOTO_IDS[reporterPhotoIndex % REPORTER_PHOTO_IDS.length]
  const photoPath = `/tmp/assets/reporter_${reporterPhotoIndex}.jpg`
  await downloadFromDrive(photoId, photoPath)
  reporterPhotoIndex++

  const imageBuffer = fs.readFileSync(photoPath)
  const audioBuffer = fs.readFileSync(audioPath)
  const imageBase64 = `data:image/jpeg;base64,${imageBuffer.toString("base64")}`
  const audioBase64 = `data:audio/mpeg;base64,${audioBuffer.toString("base64")}`

  console.log(`Starting reporter lip-sync (scene ${index + 1})...`)

  // Try multiple param name conventions — Kling models differ across deployments
  const paramSets = [
    { face_image: imageBase64, audio: audioBase64, mode: "std", aspect_ratio: "16:9" },
    { image: imageBase64, audio: audioBase64, mode: "std", aspect_ratio: "16:9" },
    { face_image: imageBase64, driven_audio: audioBase64, aspect_ratio: "16:9" },
    { image: imageBase64, audio_input: audioBase64, aspect_ratio: "16:9" }
  ]

  for (let p = 0; p < paramSets.length; p++) {
    const res = await fetch("https://api.replicate.com/v1/models/kwaivgi/kling-lip-sync/predictions", {
      method: "POST",
      headers: { Authorization: `Bearer ${REPLICATE_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ input: paramSets[p] })
    })

    const pred = await res.json()
    console.log(`Lip-sync param set ${p + 1}:`, JSON.stringify(pred).slice(0, 300))

    if (!pred.id) {
      if (p < paramSets.length - 1) {
        console.log(`Param set ${p + 1} rejected, trying next...`)
        continue
      }
      throw new Error(`Lip-sync failed all param sets. Last error: ${pred.detail || JSON.stringify(pred).slice(0, 200)}`)
    }

    try {
      const result = await pollReplicate(pred.id, `Lip-sync ${index + 1}`)
      const url = Array.isArray(result.output) ? result.output[0] : result.output
      const buf = await (await fetch(url)).buffer()
      const path = `/tmp/videos/reporter_${index}.mp4`
      fs.writeFileSync(path, buf)
      console.log(`Lip-sync done (params ${p + 1}): ${(buf.length / 1024 / 1024).toFixed(1)}MB`)
      return { path, isLipSync: true }
    } catch (pollErr) {
      if (p < paramSets.length - 1) {
        console.log(`Param set ${p + 1} failed during poll: ${pollErr.message}, trying next...`)
        continue
      }
      throw pollErr
    }
  }
}


// ─────────────────────────────────────────
// STEP 5 — VIDEO (Kling v2.6) — normal scenes
// ─────────────────────────────────────────
async function generateVideo(imgPath, motionPrompt, index) {
  const buf64 = `data:image/jpeg;base64,${fs.readFileSync(imgPath).toString("base64")}`

  const res = await fetch("https://api.replicate.com/v1/models/kwaivgi/kling-v2.6/predictions", {
    method: "POST",
    headers: { Authorization: `Bearer ${REPLICATE_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      input: { image: buf64, prompt: motionPrompt, duration: 5, aspect_ratio: "16:9" }
    })
  })
  const pred = await res.json()
  if (!pred.id) throw new Error(`Video ${index + 1} failed to start.`)

  const result = await pollReplicate(pred.id, `Video ${index + 1}`)
  const url = Array.isArray(result.output) ? result.output[0] : result.output
  const buf = await (await fetch(url)).buffer()
  const path = `/tmp/videos/video_${index}.mp4`
  fs.writeFileSync(path, buf)
  return { path, isLipSync: false }
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
  if (!match) throw new Error("MUSIC_DRIVE_URL invalid.")
  const res = await fetch(`https://drive.google.com/uc?export=download&id=${match[1]}&confirm=t`)
  if (!res.ok) throw new Error(`Music download failed: ${res.status}`)
  const buf = await res.buffer()
  fs.writeFileSync("/tmp/music_raw.mp3", buf)
  return "/tmp/music_raw.mp3"
}


// ─────────────────────────────────────────
// FFMPEG — all videos forced to 1280x720
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

// Force every video to exactly 1280x720 — prevents aspect ratio issues
function normalizeSize(input, output) {
  execSync(
    `ffmpeg -y -i "${input}" ` +
    `-vf "scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2,setsar=1" ` +
    `-c:v libx264 -preset fast -crf 18 -c:a aac -ar 44100 -ac 2 "${output}"`
  )
  return output
}

// Regular scene: normalize + trim + mix voice(100%) + SFX(20%)
function buildRegularScene(vidPath, voicePath, dur, i) {
  const norm = `/tmp/videos/norm_${i}.mp4`
  normalizeSize(vidPath, norm)

  const trimmed = `/tmp/videos/trimmed_${i}.mp4`
  execSync(`ffmpeg -y -i "${norm}" -t ${dur} -c:v copy -c:a copy "${trimmed}"`)

  const out = `/tmp/final/scene_${i}.mp4`
  if (hasAudio(trimmed)) {
    execSync(
      `ffmpeg -y -i "${trimmed}" -i "${voicePath}" ` +
      `-filter_complex "[0:a]volume=0.20[sfx];[1:a]volume=1.0[voice];[sfx][voice]amix=inputs=2:duration=longest:dropout_transition=0[aout]" ` +
      `-map 0:v -map "[aout]" -c:v libx264 -preset fast -crf 18 -c:a aac -ar 44100 -ac 2 -shortest "${out}"`
    )
  } else {
    execSync(
      `ffmpeg -y -i "${trimmed}" -i "${voicePath}" ` +
      `-map 0:v -map 1:a -c:v libx264 -preset fast -crf 18 -c:a aac -ar 44100 -ac 2 -shortest "${out}"`
    )
  }
  return out
}

// Reporter (lip-sync) scene: normalize + trim — audio already synced, don't add voice again
function buildReporterScene(lipSyncPath, dur, i) {
  const norm = `/tmp/videos/reporter_norm_${i}.mp4`
  normalizeSize(lipSyncPath, norm)
  const out = `/tmp/final/scene_${i}.mp4`
  execSync(`ffmpeg -y -i "${norm}" -t ${dur} -c:v libx264 -preset fast -crf 18 -c:a aac -ar 44100 -ac 2 "${out}"`)
  return out
}

// Concatenate all scenes
function concatScenes(paths) {
  const out = "/tmp/final/concatenated.mp4"
  const n = paths.length
  const inputs = paths.map(p => `-i "${p}"`).join(" ")
  const streams = paths.map((_, i) => `[${i}:v][${i}:a]`).join("")
  execSync(
    `ffmpeg -y ${inputs} ` +
    `-filter_complex "${streams}concat=n=${n}:v=1:a=1[outv][outa]" ` +
    `-map "[outv]" -map "[outa]" -c:v libx264 -preset fast -crf 18 -c:a aac -ar 44100 -ac 2 "${out}"`
  )
  return out
}

// Add music at 40% + HD export for YouTube
function addMusicHD(vidPath, musicPath, dur) {
  const musicTrim = "/tmp/final/music_trim.mp3"
  execSync(`ffmpeg -y -i "${musicPath}" -t ${dur} -af "volume=0.40" "${musicTrim}"`)
  const out = "/tmp/final/final_video.mp4"
  execSync(
    `ffmpeg -y -i "${vidPath}" -i "${musicTrim}" ` +
    `-filter_complex "[0:a]volume=1.0[ex];[1:a]volume=0.40[mu];[ex][mu]amix=inputs=2:duration=first:dropout_transition=0[aout]" ` +
    `-map 0:v -map "[aout]" ` +
    `-c:v libx264 -preset slow -crf 18 -b:v 8M -maxrate 10M -bufsize 20M ` +
    `-c:a aac -b:a 192k -ar 44100 -movflags +faststart "${out}"`
  )
  return out
}


// ─────────────────────────────────────────
// THUMBNAIL (Sharp + SVG)
// Matches your example: person large + centered high, purple box with strokes
// ─────────────────────────────────────────
async function generateThumbnail(topic, script) {
  // 1. Dramatic background from Flux
  const bgRes = await fetch("https://api.replicate.com/v1/models/black-forest-labs/flux-2-max/predictions", {
    method: "POST",
    headers: { Authorization: `Bearer ${REPLICATE_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      input: {
        prompt: `Dramatic cinematic wide shot about ${topic}, atmospheric photorealistic, 4K, epic scale, no people, no text, no watermark, golden hour dramatic lighting, detailed environment`,
        width: 1280, height: 720, output_format: "jpg", output_quality: 95
      }
    })
  })
  const bgPred = await bgRes.json()
  if (!bgPred.id) throw new Error("Thumbnail BG failed")
  const bgResult = await pollReplicate(bgPred.id, "Thumbnail BG")
  const bgUrl = Array.isArray(bgResult.output) ? bgResult.output[0] : bgResult.output
  const bgBuf = await (await fetch(bgUrl)).buffer()
  const bgPath = "/tmp/assets/thumb_bg.jpg"
  fs.writeFileSync(bgPath, bgBuf)

  // 2. Impact phrase (Claude — max 4 words)
  const phrase = (await callClaude(
    "Write a YouTube thumbnail impact phrase. MAXIMUM 4 WORDS. ALL CAPS. Shocking, curiosity-triggering. Return ONLY the phrase — no quotes, no punctuation at end.",
    `Topic: ${topic}\nScript: ${script}`,
    15
  )).trim().toUpperCase()
  console.log(`Thumbnail phrase: "${phrase}"`)

  // 3. Download your PNG cutout
  const personPath = "/tmp/assets/thumb_person.png"
  await downloadFromDrive(THUMBNAIL_PNG_ID, personPath)

  const W = 1280, H = 720

  // Person: 85% height, head near top (starts at 4% from top), centered
  const personH = Math.round(H * 0.85)
  const personBuf = await sharp(personPath)
    .resize({ height: personH, fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .toBuffer()
  const pMeta = await sharp(personBuf).metadata()
  const personW = pMeta.width || 530
  const personX = Math.round((W - personW) / 2)
  const personY = Math.round(H * 0.04)  // head near top edge

  // Purple box: 78% width, centered, at 69% from top
  const boxW = Math.round(W * 0.78)
  const boxH = 98
  const boxX = Math.round((W - boxW) / 2)
  const boxY = Math.round(H * 0.69)

  // Dynamic font size based on phrase length
  const fontSize = Math.max(34, Math.min(58, Math.round(58 * (9 / Math.max(phrase.length, 9)))))

  // SVG matching your example design:
  // - Outer dark stroke (border effect around box)
  // - Main bright purple fill
  // - Darker right cap
  // - Decorative accent line below
  // - Bold dark text
  const svg = `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
    <rect x="${boxX - 6}" y="${boxY - 6}" width="${boxW + 12}" height="${boxH + 12}" rx="9" ry="9" fill="#3A0066"/>
    <rect x="${boxX}" y="${boxY}" width="${boxW}" height="${boxH}" rx="6" ry="6" fill="#8800EE"/>
    <rect x="${boxX + boxW - 28}" y="${boxY}" width="28" height="${boxH}" rx="6" ry="6" fill="#5500AA"/>
    <rect x="${boxX}" y="${boxY + boxH + 7}" width="${Math.round(boxW * 0.38)}" height="7" rx="3" ry="3" fill="#5500AA"/>
    <text
      x="${boxX + (boxW - 28) / 2}"
      y="${boxY + Math.round(boxH / 2) + Math.round(fontSize * 0.38)}"
      font-family="Arial Black, Impact, Arial, sans-serif"
      font-size="${fontSize}"
      font-weight="900"
      fill="#0A0A3A"
      text-anchor="middle">${phrase}</text>
  </svg>`

  const thumbPath = "/tmp/assets/thumbnail.jpg"
  await sharp(bgPath)
    .resize(W, H)
    .composite([
      { input: personBuf, left: Math.max(0, personX), top: Math.max(0, personY), blend: "over" },
      { input: Buffer.from(svg), left: 0, top: 0, blend: "over" }
    ])
    .jpeg({ quality: 95 })
    .toFile(thumbPath)

  console.log("Thumbnail done.")
  return thumbPath
}


// ─────────────────────────────────────────
// TRIGGER
// ─────────────────────────────────────────
bot.onText(/^do it$/i, msg => {
  userState[msg.chat.id] = { step: "waiting_input" }
  bot.sendMessage(msg.chat.id, "Send me a theme, article link, or paste any text about your topic.")
})


// ─────────────────────────────────────────
// MAIN PIPELINE
// ─────────────────────────────────────────
bot.on("message", async msg => {
  const chatId = msg.chat.id
  if (!userState[chatId] || userState[chatId].step !== "waiting_input") return
  if (/^do it$/i.test(msg.text)) return

  const input = msg.text
  userState[chatId].step = "processing"
  reporterPhotoIndex = 0

  try {

    // ── SCRIPT ──
    await bot.sendMessage(chatId, "✍️ Claude is writing the script...")
    const rawScript = await generateScript(input)
    const topic = input.length > 100 ? input.slice(0, 80) + "..." : input
    await bot.sendMessage(chatId, `📄 Script:\n\n${rawScript}`)

    // ── VISUAL STYLE ──
    await bot.sendMessage(chatId, "🎨 Claude is defining visual style...")
    const style = await generateVisualStyle(topic, rawScript)
    await bot.sendMessage(chatId, `🎨 ${style.styleTag}\n🖌 ${style.colorPalette}\n🎭 ${style.mood}`)

    // ── SCENE PLAN ──
    await bot.sendMessage(chatId, "🎬 Claude is writing 100-word image prompts...")
    const scenes = await buildScenes(rawScript, TOTAL_SCENES, style, topic)
    let plan = ""
    scenes.forEach((s, i) => {
      plan += `Scene ${i + 1}: ${s.camera.name}${s.isReporter ? " 🎙REPORTER" : ""} ${s.hasPeople ? "👥" : "🏔"}\n`
    })
    await bot.sendMessage(chatId, plan)

    // ── GENERATE ALL SCENES ──
    const sceneResults = []  // { videoPath, voicePath, isLipSync, audioDuration }

    for (let i = 0; i < scenes.length; i++) {
      const s = scenes[i]

      // Always generate voice first
      const voicePath = await generateVoice(s.script, i)
      const audioDuration = getDuration(voicePath)

      if (s.isReporter) {
        await bot.sendMessage(chatId, `⏳ Scene ${i + 1}/${scenes.length}: Reporter lip-sync...`)
        try {
          const { path: vidPath } = await generateReporterLipSync(voicePath, i)
          sceneResults.push({ videoPath: vidPath, voicePath, isLipSync: true, audioDuration })
          await bot.sendMessage(chatId, `✅ Scene ${i + 1}: Reporter lip-sync done`)
        } catch (e) {
          console.error("Lip-sync failed:", e.message)
          await bot.sendMessage(chatId, `⚠️ Scene ${i + 1}: Lip-sync failed — using regular video`)
          // Fallback to regular video
          const fbImg = await generateImage(
            `Close-up man talking to camera, modern journalist, ${topic} environment background, photorealistic, ${style.styleTag}`,
            style.avoid, i
          )
          const { path: fbVid } = await generateVideo(fbImg, "gentle handheld camera, slight realistic movement, slow zoom in", i)
          sceneResults.push({ videoPath: fbVid, voicePath, isLipSync: false, audioDuration })
          await bot.sendMessage(chatId, `✅ Scene ${i + 1}: Fallback video done`)
        }
      } else {
        await bot.sendMessage(chatId, `⏳ Scene ${i + 1}/${scenes.length}: Image + video...`)
        const img = await generateImage(s.imagePrompt, style.avoid, i)
        const { path: vid } = await generateVideo(img, s.motion, i)
        sceneResults.push({ videoPath: vid, voicePath, isLipSync: false, audioDuration })
        await bot.sendMessage(chatId, `✅ Scene ${i + 1}: Done`)
      }
    }

    // ── BUILD ALL SCENES ──
    await bot.sendMessage(chatId, "✂️ Cutting and mixing audio...")
    const scenePaths = []
    let totalDuration = 0

    for (let i = 0; i < sceneResults.length; i++) {
      const { videoPath, voicePath, isLipSync, audioDuration } = sceneResults[i]
      totalDuration += audioDuration

      let scenePath
      if (isLipSync) {
        // Lip-sync video already has synced audio — just normalize + trim
        scenePath = buildReporterScene(videoPath, audioDuration, i)
      } else {
        // Normal: normalize + trim + mix voice + SFX
        scenePath = buildRegularScene(videoPath, voicePath, audioDuration, i)
      }
      scenePaths.push(scenePath)
      await bot.sendMessage(chatId, `✅ Scene ${i + 1}: ${audioDuration.toFixed(1)}s ready`)
    }

    // ── CONCAT + MUSIC ──
    await bot.sendMessage(chatId, "🔗 Joining all scenes...")
    const concatenated = concatScenes(scenePaths)

    await bot.sendMessage(chatId, "🎵 Adding background music at 40%...")
    const musicPath = await downloadMusic()
    const finalVideo = addMusicHD(concatenated, musicPath, totalDuration)

    // ── THUMBNAIL ──
    await bot.sendMessage(chatId, "🖼 Generating thumbnail...")
    let thumbPath = null
    try {
      thumbPath = await generateThumbnail(topic, rawScript)
    } catch (e) {
      console.error("Thumbnail error:", e.message)
      await bot.sendMessage(chatId, `⚠️ Thumbnail error: ${e.message}`)
    }

    // ── DRIVE SAVE ──
    const dateStr = new Date().toISOString().slice(0, 16).replace("T", "_")
    await bot.sendMessage(chatId, "☁️ Saving to Google Drive...")
    const videoUpload = await uploadToDrive(finalVideo, `VIDEO_${dateStr}.mp4`, "video/mp4")
    let thumbUpload = null
    if (thumbPath && fs.existsSync(thumbPath)) {
      thumbUpload = await uploadToDrive(thumbPath, `THUMBNAIL_${dateStr}.jpg`, "image/jpeg")
    }

    // ── DELIVER VIDEO ──
    await bot.sendVideo(chatId, finalVideo, {
      width: 1280,
      height: 720,
      caption: `🎬 30-second video ready!\n🎤 Voice 100% | 🔊 SFX 20% | 🎵 Music 40%`
    })

    // ── DELIVER THUMBNAIL ──
    if (thumbPath && fs.existsSync(thumbPath)) {
      await bot.sendPhoto(chatId, thumbPath, {
        caption: "🖼 Thumbnail — ready for YouTube upload"
      })
    }

    // ── DRIVE LINKS ──
    let driveMsg = ""
    if (videoUpload?.webViewLink) driveMsg += `📹 Video: ${videoUpload.webViewLink}\n`
    if (thumbUpload?.webViewLink) driveMsg += `🖼 Thumbnail: ${thumbUpload.webViewLink}`
    if (driveMsg) {
      await bot.sendMessage(chatId, `✅ Saved to Google Drive:\n${driveMsg}`)
    } else {
      await bot.sendMessage(chatId, "⚠️ Drive save failed — check DRIVE_FOLDER_ID and GDRIVE_CREDENTIALS in Railway")
    }

    await bot.sendMessage(chatId, "✅ All done! Send 'do it' to create another.")
    userState[chatId].step = "done"

  } catch (err) {
    console.error("Pipeline error:", err)
    await bot.sendMessage(chatId, `❌ Error: ${err.message}\n\nSend 'do it' to try again.`)
    userState[chatId] = {}
  }
})
