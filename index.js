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

// ── VIDEO CONFIG ──
// 2 scenes × ~2 seconds = ~4-6 second test video
// Change TOTAL_SCENES to 6 and TARGET_SCENE_SECONDS to 5 for 30-second video
const TOTAL_SCENES = 2
const TARGET_SCENE_SECONDS = 2   // script written for this many seconds per scene
const REPORTER_EVERY = 4         // every 4th scene = reporter (won't fire at 2 scenes)

// Reporter reference photo — placed INTO the background via flux-fill-pro
const REPORTER_REF_ID = "1Rb47BC7eWiQndjmZKkHKrvIaIjpViBZC"

// 3 reporter lip-sync photos (rotate)
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
let reporterPositionIndex = 0
let cachedReporterRef = null

for (const d of ["/tmp/images", "/tmp/videos", "/tmp/voices", "/tmp/final", "/tmp/assets"]) {
  fs.mkdirSync(d, { recursive: true })
}
console.log("Bot running.")


// ─────────────────────────────────────────
// 13 KLING-NATIVE CAMERA MOVEMENTS
// ─────────────────────────────────────────
const CAMERA_TECHNIQUES = [
  { name: "Pan Right",        motionStyle: "camera pans right" },
  { name: "Pan Tilt Down",    motionStyle: "camera pans right and tilts down" },
  { name: "Zoom In",          motionStyle: "the camera zooms in" },
  { name: "Zoom Out",         motionStyle: "The camera zooms out" },
  { name: "Tilt Up",          motionStyle: "camera tilts up" },
  { name: "Tilt Down",        motionStyle: "camera tilts down" },
  { name: "Orbit",            motionStyle: "camera orbits around" },
  { name: "Orbit Push In",    motionStyle: "camera orbits around and pushes in" },
  { name: "Rotate Around",    motionStyle: "the camera rotates around the subject" },
  { name: "Follow Subject",   motionStyle: "the camera follows the subject moving" },
  { name: "Boom Up Push In",  motionStyle: "camera booms up and pushes in" },
  { name: "Handheld",         motionStyle: "handheld device filming" },
  { name: "Long Shot",        motionStyle: "positioned at a Long Shot" }
]

const getCam = i => CAMERA_TECHNIQUES[i % CAMERA_TECHNIQUES.length]
const PEOPLE_CYCLE = [true, true, true, false, true, true, true, false, false]
const hasPeople = i => PEOPLE_CYCLE[i % PEOPLE_CYCLE.length]
const isReporter = i => (i + 1) % REPORTER_EVERY === 0


// ─────────────────────────────────────────
// CLAUDE HELPER
// ─────────────────────────────────────────
async function callClaude(system, user, maxTokens = 1000) {
  const msg = await claude.messages.create({
    model: "claude-opus-4-5",
    max_tokens: maxTokens,
    system,
    messages: [{ role: "user", content: user }]
  })
  return msg.content[0].text
}


// ─────────────────────────────────────────
// GOOGLE DRIVE
// ─────────────────────────────────────────
function getDriveClient() {
  const creds = JSON.parse(process.env.GDRIVE_CREDENTIALS)
  const auth = new google.auth.GoogleAuth({ credentials: creds, scopes: ["https://www.googleapis.com/auth/drive"] })
  return google.drive({ version: "v3", auth })
}

async function uploadToDrive(filePath, fileName, mimeType) {
  const folderId = process.env.DRIVE_FOLDER_ID
  if (!folderId) { console.log("No DRIVE_FOLDER_ID — skipping"); return null }
  try {
    const drive = getDriveClient()
    const res = await drive.files.create({
      requestBody: { name: fileName, parents: [folderId] },
      media: { mimeType, body: fs.createReadStream(filePath) },
      fields: "id, webViewLink"
    })
    await drive.permissions.create({ fileId: res.data.id, requestBody: { role: "reader", type: "anyone" } })
    console.log(`Drive OK: ${fileName}`)
    return res.data
  } catch (err) { console.error(`Drive upload failed (${fileName}):`, err.message); return null }
}

async function downloadFromDrive(fileId, outPath) {
  const res = await fetch(`https://drive.google.com/uc?export=download&id=${fileId}&confirm=t`)
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
// Short punchy scenes matching TARGET_SCENE_SECONDS
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

  const wordsPerScene = TARGET_SCENE_SECONDS === 2 ? 8 : 15

  return await callClaude(
    `You write viral YouTube voiceover scripts split into ${TOTAL_SCENES} scenes.
Each scene is spoken in exactly ${TARGET_SCENE_SECONDS} seconds — maximum ${wordsPerScene} words per scene.

Structure for ${TOTAL_SCENES} scenes:
- [SCENE 1]: Most shocking opening statement. Maximum ${wordsPerScene} words.
${TOTAL_SCENES > 1 ? `- [SCENE 2]: Second shocking detail. Maximum ${wordsPerScene} words. End with: Thanks for watching` : ""}
${TOTAL_SCENES > 2 ? `- [SCENE 3]: Key context. Maximum ${wordsPerScene} words.` : ""}
${TOTAL_SCENES > 3 ? `- [SCENE 4]: The revelation. Maximum ${wordsPerScene} words.` : ""}
${TOTAL_SCENES > 4 ? `- [SCENE 5]: The impact. Maximum ${wordsPerScene} words.` : ""}
${TOTAL_SCENES > 5 ? `- [SCENE 6]: Final punch. End with: Thanks for watching` : ""}

Rules:
- Label every scene: [SCENE 1] text [SCENE 2] text etc.
- Last scene MUST end with: Thanks for watching
- Declarative statements only — no questions
- Write ONLY the labeled scenes, nothing else`,
    `Write a ${TOTAL_SCENES}-scene script about:\n\n${context}`,
    300
  )
}


// ─────────────────────────────────────────
// STEP 2 — VISUAL STYLE + REPORTER OUTFIT (Claude)
// Style must absorb the emotional tone of the theme
// ─────────────────────────────────────────
async function generateVisualStyle(topic, script) {
  const raw = await callClaude(
    `You define a precise cinematic visual style for a YouTube documentary video.
The style must ABSORB the emotional DNA of the topic — the color, mood, texture, and feeling should be inseparable from the subject matter.

For example:
- UFO/conspiracy → cold blue-green night tones, paranoid surveillance feeling, grainy
- Ancient Egypt → golden amber dust, mythic scale, sun-baked stone
- Ocean/underwater → deep aqua teal, diffused light, pressure and mystery
- War/military → desaturated olive green, high contrast, tension and urgency
- Space → deep black void, singular light source, awe and isolation

Return ONLY valid JSON — no markdown, no backticks:
{
  "colorPalette": "specific colors that match the topic's emotional DNA",
  "lighting": "specific lighting that fits the theme",
  "atmosphere": "specific atmosphere — particles, haze, weather",
  "mood": "emotional tone in 3-5 words",
  "styleTag": "2-4 word cinematic style name",
  "consistencyTag": "6-10 word phrase that locks the visual tone across all scenes",
  "avoid": "visual elements that would break the tone",
  "reporterOutfit": "specific modern 2026 clothing appropriate for this topic's environment — journalist who belongs there"
}`,
    `Topic: ${topic}\nScript: ${script}`,
    350
  )
  return safeJSON(raw)
}


// ─────────────────────────────────────────
// STEP 3 — SCENE BREAKDOWN (Claude)
// Prompts follow the vibe/mood of the theme
// Written like a cinematographer obsessed with this specific subject
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
    `Scene ${i + 1}: "${s.script}"
Camera: ${s.camera.motionStyle}
People: ${
  s.isReporter ? "REPORTER_SCENE" :
  s.hasPeople ? "YES — 1-3 people in physical action that matches the theme. NEVER talking to each other. NEVER facing each other. Always in purposeful motion or discovery. Show environment around them." :
  "NO people — pure environment, objects, phenomena"
}`
  ).join("\n\n")

  const raw = await callClaude(
    `You write cinematic image prompts for YouTube documentary video scenes.
You write like a cinematographer who is deeply obsessed with this specific topic — every detail in the prompt should feel like it belongs to this world.

VISUAL STYLE — apply to every scene without exception:
Color palette: ${style.colorPalette}
Lighting: ${style.lighting}
Atmosphere: ${style.atmosphere}
Mood: ${style.mood}
Style: ${style.styleTag}
Consistency tag: ${style.consistencyTag}
Avoid in all scenes: ${style.avoid}

IMAGE PROMPT RULES:
1. Write minimum 100 words per prompt — detailed, specific, immersive
2. The prompt should FEEL like the topic — if it's about UFOs, it should feel eerie and paranoid. If it's ancient history, it should feel mythic and dusty. The writing itself should have the vibe.
3. Photorealistic photography — real photo aesthetic, no CGI, no illustration, no 3D render
4. Include: exact location type, specific time of day, specific atmospheric conditions, specific objects that tell the story, lighting source and direction, what's happening in the scene
5. People rules: physical action only — excavating, running, pointing at horizon, operating equipment — NEVER two people facing each other talking — NEVER isolated portrait
6. NEVER include violence, weapons, blood, gore, nudity — keep documentay-safe
7. Reporter scenes: write exactly REPORTER_SCENE as the imagePrompt

MOTION PROMPT: match exactly the camera technique listed, be specific about what moves

Return ONLY valid JSON:
{"scenes":[{"imagePrompt":"100+ words OR REPORTER_SCENE","motionPrompt":"exact camera motion matching the technique"}]}`,
    `Build ${totalScenes} scene prompts for topic: ${topic}\n\n${setupList}`,
    2500
  )

  const data = safeJSON(raw)
  return setup.map((s, i) => ({
    ...s,
    imagePrompt: data.scenes[i]?.imagePrompt || `${s.script}, ${style.styleTag}, photorealistic, dramatic, ${style.consistencyTag}`,
    motion: data.scenes[i]?.motionPrompt || s.camera.motionStyle
  }))
}


// ─────────────────────────────────────────
// STEP 4 — IMAGE (Flux 2 Max)
// Prompt goes in clean — no extra text added that competes
// Auto-retries on content flags (E005)
// ─────────────────────────────────────────
function sanitizePrompt(p) {
  return p.replace(/\b(dead|death|dying|corpse|blood|gore|weapon|gun|knife|bomb|explosion|terror|torture|abuse|violent|massacre|murder|kill|naked|nude|sexual|attack)\b/gi, "")
    .replace(/\s+/g, " ").trim()
}

async function generateImage(prompt, index) {
  // Clean prompt — no competing suffix text, let the prompt speak for itself
  const attempts = [
    prompt,
    sanitizePrompt(prompt),
    `Dramatic cinematic documentary scene, ${sanitizePrompt(prompt).slice(0, 100)}, photorealistic, no text, no watermarks`
  ]

  for (let attempt = 0; attempt < attempts.length; attempt++) {
    try {
      console.log(`Image ${index + 1} attempt ${attempt + 1}...`)
      const res = await fetch("https://api.replicate.com/v1/models/black-forest-labs/flux-2-max/predictions", {
        method: "POST",
        headers: { Authorization: `Bearer ${REPLICATE_TOKEN}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          input: { prompt: attempts[attempt], width: 1280, height: 720, output_format: "jpg", output_quality: 95 }
        })
      })
      const pred = await res.json()
      if (!pred.id) throw new Error(`No prediction ID — check REPLICATE_API_TOKEN`)

      const result = await pollReplicate(pred.id, `Image ${index + 1}`)
      const url = Array.isArray(result.output) ? result.output[0] : result.output
      const buf = await (await fetch(url)).buffer()
      const path = `/tmp/images/img_${index}.jpg`
      fs.writeFileSync(path, buf)
      console.log(`Image ${index + 1} done (attempt ${attempt + 1})`)
      return path

    } catch (err) {
      const isFlagged = err.message.includes("E005") || err.message.includes("sensitive") || err.message.includes("flagged")
      if (isFlagged && attempt < attempts.length - 1) {
        console.log(`Image ${index + 1}: flagged, retrying safer (attempt ${attempt + 2})`)
        continue
      }
      throw err
    }
  }
}


// ─────────────────────────────────────────
// STEP 4B — REPORTER SCENE PIPELINE
//
// 1. Generate clean background (no person)
// 2. Download reporter reference photo
// 3. Use flux-fill-pro to PAINT reporter INTO the background
//    with outfit adapted to the environment
// 4. Feed merged image + voice into Kling lip-sync
// 5. Kling animates background + reporter talking simultaneously
// ─────────────────────────────────────────

async function getReporterRef() {
  if (cachedReporterRef && fs.existsSync(cachedReporterRef)) return cachedReporterRef
  cachedReporterRef = "/tmp/assets/reporter_ref.jpg"
  await downloadFromDrive(REPORTER_REF_ID, cachedReporterRef)
  return cachedReporterRef
}

// Create foreground mask — white area where reporter will be painted in
// Alternates left/right side
function createReporterMask(W, H, isLeft) {
  const maskW = Math.round(W * 0.38)   // reporter takes 38% of width
  const maskH = Math.round(H * 0.80)   // reporter height = 80% of frame
  const maskX = isLeft ? 0 : W - maskW
  const maskY = H - maskH               // anchored to bottom

  // White = fill here, Black = keep original
  const svgMask = `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
    <rect x="0" y="0" width="${W}" height="${H}" fill="black"/>
    <rect x="${maskX}" y="${maskY}" width="${maskW}" height="${maskH}" fill="white"/>
  </svg>`

  return Buffer.from(svgMask)
}

// Use flux-fill-pro to inpaint the reporter into the background scene
async function mergeReporterIntoBackground(bgPath, outfit, style, topic, index) {
  const W = 1280, H = 720
  const isLeft = reporterPositionIndex % 2 === 0
  reporterPositionIndex++

  // Create the mask
  const maskBuf = createReporterMask(W, H, isLeft)
  const maskPath = `/tmp/assets/mask_${index}.png`

  // Convert SVG mask to PNG
  await sharp(maskBuf)
    .resize(W, H)
    .png()
    .toFile(maskPath)

  // Read background and mask as base64
  const bgBase64 = `data:image/jpeg;base64,${fs.readFileSync(bgPath).toString("base64")}`
  const maskBase64 = `data:image/png;base64,${fs.readFileSync(maskPath).toString("base64")}`

  // Inpainting prompt — reporter in scene with correct outfit
  const sideDesc = isLeft ? "left side of frame" : "right side of frame"
  const inpaintPrompt = `A modern journalist reporter man standing in ${sideDesc}, close to camera showing from waist up, hands visible and gesturing naturally while talking, wearing ${outfit}, background shows ${topic} environment behind him, ${style.consistencyTag}, photorealistic, natural integration with scene lighting, ${style.lighting}, facing camera directly`

  console.log(`Flux fill-pro inpainting reporter into scene ${index + 1} (${isLeft ? "left" : "right"})...`)

  const res = await fetch("https://api.replicate.com/v1/models/black-forest-labs/flux-fill-pro/predictions", {
    method: "POST",
    headers: { Authorization: `Bearer ${REPLICATE_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      input: {
        image: bgBase64,
        mask: maskBase64,
        prompt: inpaintPrompt,
        guidance: 30,
        steps: 28,
        output_format: "jpg",
        output_quality: 95
      }
    })
  })

  const pred = await res.json()
  if (!pred.id) {
    console.error("Flux fill-pro response:", JSON.stringify(pred).slice(0, 300))
    throw new Error(`Flux fill-pro failed to start: ${pred.detail || "unknown"}`)
  }

  const result = await pollReplicate(pred.id, `Reporter inpaint ${index + 1}`)
  const url = Array.isArray(result.output) ? result.output[0] : result.output
  const buf = await (await fetch(url)).buffer()
  const mergedPath = `/tmp/images/reporter_merged_${index}.jpg`
  fs.writeFileSync(mergedPath, buf)
  console.log(`Reporter merged into scene ${index + 1}: ${(buf.length / 1024).toFixed(0)}KB`)
  return mergedPath
}

// Kling lip-sync: merged image + voice audio → animated talking video
// Background also animates (Kling handles this)
async function runLipSync(mergedImagePath, audioPath, index) {
  const imageBase64 = `data:image/jpeg;base64,${fs.readFileSync(mergedImagePath).toString("base64")}`
  const audioBase64 = `data:audio/mpeg;base64,${fs.readFileSync(audioPath).toString("base64")}`

  console.log(`Running Kling lip-sync scene ${index + 1}...`)

  // Try multiple param conventions
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
    console.log(`Lip-sync param ${p + 1}:`, JSON.stringify(pred).slice(0, 200))

    if (!pred.id) {
      if (p < paramSets.length - 1) { console.log(`Param ${p + 1} rejected, trying next...`); continue }
      throw new Error(`Lip-sync failed all params: ${pred.detail || JSON.stringify(pred).slice(0, 100)}`)
    }

    try {
      const result = await pollReplicate(pred.id, `Lip-sync ${index + 1}`)
      const url = Array.isArray(result.output) ? result.output[0] : result.output
      const buf = await (await fetch(url)).buffer()
      const path = `/tmp/videos/lipsync_${index}.mp4`
      fs.writeFileSync(path, buf)
      console.log(`Lip-sync done (params ${p + 1}): ${(buf.length / 1024 / 1024).toFixed(1)}MB`)
      return path
    } catch (pollErr) {
      if (p < paramSets.length - 1) { console.log(`Param ${p + 1} poll failed, trying next...`); continue }
      throw pollErr
    }
  }
}

// Full reporter scene pipeline
async function generateReporterScene(voicePath, outfit, style, topic, index) {
  // 1. Generate background scene (no person, with space for reporter)
  const bgPrompt = `${style.consistencyTag}, cinematic wide establishing shot about ${topic}, ${style.atmosphere}, ${style.lighting}, dramatic environment showing the world of this story, no people visible, clear foreground area, photorealistic, no text, no watermarks, ${style.colorPalette}`
  const bgPath = await generateImage(bgPrompt, index)

  // 2. Paint reporter INTO the background using flux-fill-pro inpainting
  const mergedPath = await mergeReporterIntoBackground(bgPath, outfit, style, topic, index)

  // 3. Kling lip-sync: reporter talks, background moves naturally
  const lipSyncPath = await runLipSync(mergedPath, voicePath, index)

  return { path: lipSyncPath, isLipSync: true }
}


// ─────────────────────────────────────────
// STEP 5 — VIDEO (Kling v2.6) — normal scenes
// ─────────────────────────────────────────
async function generateVideo(imgPath, motionPrompt, index) {
  const b64 = `data:image/jpeg;base64,${fs.readFileSync(imgPath).toString("base64")}`
  const res = await fetch("https://api.replicate.com/v1/models/kwaivgi/kling-v2.6/predictions", {
    method: "POST",
    headers: { Authorization: `Bearer ${REPLICATE_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ input: { image: b64, prompt: motionPrompt, duration: 5, aspect_ratio: "16:9" } })
  })
  const pred = await res.json()
  if (!pred.id) throw new Error(`Video ${index + 1} failed to start`)
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
  if (!match) throw new Error("MUSIC_DRIVE_URL invalid")
  const res = await fetch(`https://drive.google.com/uc?export=download&id=${match[1]}&confirm=t`)
  if (!res.ok) throw new Error(`Music download failed: ${res.status}`)
  const buf = await res.buffer()
  fs.writeFileSync("/tmp/music_raw.mp3", buf)
  return "/tmp/music_raw.mp3"
}


// ─────────────────────────────────────────
// FFMPEG HELPERS
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

// Detect audible voices in Kling SFX — drops to 10% if found
function detectVocalContent(videoPath) {
  if (!hasAudio(videoPath)) return false
  try {
    const out = execSync(
      `ffmpeg -i "${videoPath}" -vn -af "highpass=f=300,lowpass=f=3000,volumedetect" -f null - 2>&1`,
      { timeout: 15000 }
    ).toString()
    const match = out.match(/mean_volume:\s*([-\d.]+)\s*dB/)
    if (match) {
      const db = parseFloat(match[1])
      console.log(`SFX vocal scan: ${db}dB`)
      return db > -38
    }
  } catch (e) { console.log("Vocal scan skipped:", e.message) }
  return false
}

// Force 1280x720 on every video — no aspect ratio issues
function normalizeSize(input, output) {
  execSync(
    `ffmpeg -y -i "${input}" ` +
    `-vf "scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2,setsar=1" ` +
    `-c:v libx264 -preset fast -crf 18 -c:a aac -ar 44100 -ac 2 "${output}"`
  )
  return output
}

// Regular scene: normalize + trim to voice duration + mix voice(100%) + SFX(15% or 10%)
function buildRegularScene(vidPath, voicePath, dur, i) {
  const norm = `/tmp/videos/norm_${i}.mp4`
  normalizeSize(vidPath, norm)
  const trimmed = `/tmp/videos/trimmed_${i}.mp4`
  execSync(`ffmpeg -y -i "${norm}" -t ${dur} -c:v copy -c:a copy "${trimmed}"`)
  const out = `/tmp/final/scene_${i}.mp4`

  if (hasAudio(trimmed)) {
    const hasVocal = detectVocalContent(trimmed)
    const sfxVol = hasVocal ? 0.10 : 0.15
    console.log(`Scene ${i + 1} SFX: ${sfxVol * 100}% (vocal: ${hasVocal})`)
    execSync(
      `ffmpeg -y -i "${trimmed}" -i "${voicePath}" ` +
      `-filter_complex "[0:a]volume=${sfxVol}[sfx];[1:a]volume=1.0[voice];[sfx][voice]amix=inputs=2:duration=longest:dropout_transition=0[aout]" ` +
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

// Reporter (lip-sync): normalize + trim — audio already baked in
function buildReporterScene(lipSyncPath, dur, i) {
  const norm = `/tmp/videos/reporter_norm_${i}.mp4`
  normalizeSize(lipSyncPath, norm)
  const out = `/tmp/final/scene_${i}.mp4`
  execSync(`ffmpeg -y -i "${norm}" -t ${dur} -c:v libx264 -preset fast -crf 18 -c:a aac -ar 44100 -ac 2 "${out}"`)
  return out
}

// Concatenate all scenes using filter_complex
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

// Add music at 40% — HD export for YouTube
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
// THUMBNAIL
// ─────────────────────────────────────────
async function generateThumbnail(topic, script) {
  const bgRes = await fetch("https://api.replicate.com/v1/models/black-forest-labs/flux-2-max/predictions", {
    method: "POST",
    headers: { Authorization: `Bearer ${REPLICATE_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      input: {
        prompt: `Dramatic cinematic wide shot about ${topic}, atmospheric photorealistic, 4K, epic scale, no people, no text, no watermark, golden hour dramatic lighting, breathtaking environment`,
        width: 1280, height: 720, output_format: "jpg", output_quality: 95
      }
    })
  })
  const bgPred = await bgRes.json()
  if (!bgPred.id) throw new Error("Thumbnail BG failed to start")
  const bgResult = await pollReplicate(bgPred.id, "Thumbnail BG")
  const bgUrl = Array.isArray(bgResult.output) ? bgResult.output[0] : bgResult.output
  fs.writeFileSync("/tmp/assets/thumb_bg.jpg", await (await fetch(bgUrl)).buffer())

  const phrase = (await callClaude(
    "Write a YouTube thumbnail impact phrase. MAXIMUM 4 WORDS. ALL CAPS. Shocking and curiosity-triggering. Return ONLY the phrase — no quotes, no punctuation at end.",
    `Topic: ${topic}\nScript: ${script}`, 15
  )).trim().toUpperCase()

  await downloadFromDrive(THUMBNAIL_PNG_ID, "/tmp/assets/thumb_person.png")

  const W = 1280, H = 720
  const personH = Math.round(H * 0.85)
  const personBuf = await sharp("/tmp/assets/thumb_person.png")
    .resize({ height: personH, fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .toBuffer()
  const pMeta = await sharp(personBuf).metadata()
  const personW = pMeta.width || 530
  const personX = Math.round((W - personW) / 2)
  const personY = Math.round(H * 0.04)

  const boxW = Math.round(W * 0.78), boxH = 98
  const boxX = Math.round((W - boxW) / 2)
  const boxY = Math.round(H * 0.69)
  const fontSize = Math.max(34, Math.min(58, Math.round(58 * (9 / Math.max(phrase.length, 9)))))

  const svg = `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
    <rect x="${boxX - 6}" y="${boxY - 6}" width="${boxW + 12}" height="${boxH + 12}" rx="9" ry="9" fill="#3A0066"/>
    <rect x="${boxX}" y="${boxY}" width="${boxW}" height="${boxH}" rx="6" ry="6" fill="#8800EE"/>
    <rect x="${boxX + boxW - 28}" y="${boxY}" width="28" height="${boxH}" rx="6" ry="6" fill="#5500AA"/>
    <rect x="${boxX}" y="${boxY + boxH + 7}" width="${Math.round(boxW * 0.38)}" height="7" rx="3" ry="3" fill="#5500AA"/>
    <text x="${boxX + (boxW - 28) / 2}" y="${boxY + Math.round(boxH / 2) + Math.round(fontSize * 0.38)}"
      font-family="Arial Black, Impact, Arial, sans-serif" font-size="${fontSize}" font-weight="900"
      fill="#0A0A3A" text-anchor="middle">${phrase}</text>
  </svg>`

  const thumbPath = "/tmp/assets/thumbnail.jpg"
  await sharp("/tmp/assets/thumb_bg.jpg")
    .resize(W, H)
    .composite([
      { input: personBuf, left: Math.max(0, personX), top: Math.max(0, personY), blend: "over" },
      { input: Buffer.from(svg), left: 0, top: 0, blend: "over" }
    ])
    .jpeg({ quality: 95 })
    .toFile(thumbPath)

  return thumbPath
}


// ─────────────────────────────────────────
// TRIGGER
// ─────────────────────────────────────────
bot.onText(/^do it$/i, msg => {
  userState[msg.chat.id] = { step: "waiting_input" }
  bot.sendMessage(msg.chat.id, "Send me a theme, article link, or paste any text.")
})


// ─────────────────────────────────────────
// MAIN PIPELINE
// NEVER STOPS — every scene and every step is wrapped
// Failures are skipped with a warning, pipeline continues
// ─────────────────────────────────────────
bot.on("message", async msg => {
  const chatId = msg.chat.id
  if (!userState[chatId] || userState[chatId].step !== "waiting_input") return
  if (/^do it$/i.test(msg.text)) return

  const input = msg.text
  userState[chatId].step = "processing"
  reporterPhotoIndex = 0
  reporterPositionIndex = 0
  cachedReporterRef = null

  try {

    // ── SCRIPT ──
    await bot.sendMessage(chatId, `✍️ Writing ${TOTAL_SCENES}-scene script (${TARGET_SCENE_SECONDS}s per scene)...`)
    const rawScript = await generateScript(input)
    const topic = input.length > 100 ? input.slice(0, 80) + "..." : input
    await bot.sendMessage(chatId, `📄 Script:\n\n${rawScript}`)

    // ── VISUAL STYLE ──
    await bot.sendMessage(chatId, "🎨 Defining visual style...")
    const style = await generateVisualStyle(topic, rawScript)
    const outfit = style.reporterOutfit || "modern casual shirt, dark pants, 2026 journalist"
    await bot.sendMessage(chatId, `🎨 ${style.styleTag} | ${style.mood}\n🖌 ${style.colorPalette}\n👔 Reporter: ${outfit}`)

    // ── SCENE PLAN ──
    await bot.sendMessage(chatId, "🎬 Building scene plan...")
    const scenes = await buildScenes(rawScript, TOTAL_SCENES, style, topic)
    let plan = ""
    scenes.forEach((s, i) => {
      plan += `Scene ${i + 1}: ${s.camera.name}${s.isReporter ? " 🎙REPORTER" : ""} ${s.hasPeople ? "👥" : "🏔"}\n`
    })
    await bot.sendMessage(chatId, plan)

    // ── GENERATE ALL SCENES — NEVER STOP ON FAILURE ──
    const sceneResults = []

    for (let i = 0; i < scenes.length; i++) {
      const s = scenes[i]
      let sceneData = null

      try {
        const voicePath = await generateVoice(s.script, i)
        const audioDuration = getDuration(voicePath)

        if (s.isReporter) {
          await bot.sendMessage(chatId, `⏳ Scene ${i + 1}/${scenes.length}: Reporter (background → inpaint → lip-sync)...`)
          const result = await generateReporterScene(voicePath, outfit, style, topic, i)
          sceneData = { videoPath: result.path, voicePath, isLipSync: true, audioDuration }
          await bot.sendMessage(chatId, `✅ Scene ${i + 1}: Reporter done`)
        } else {
          await bot.sendMessage(chatId, `⏳ Scene ${i + 1}/${scenes.length}: Generating...`)
          const img = await generateImage(s.imagePrompt, i)
          const result = await generateVideo(img, s.motion, i)
          sceneData = { videoPath: result.path, voicePath, isLipSync: false, audioDuration }
          await bot.sendMessage(chatId, `✅ Scene ${i + 1}: Done`)
        }

      } catch (sceneErr) {
        console.error(`Scene ${i + 1} failed:`, sceneErr.message)
        await bot.sendMessage(chatId, `⚠️ Scene ${i + 1} error: ${sceneErr.message}\n→ Continuing...`)
      }

      sceneResults.push(sceneData)
    }

    // ── BUILD VALID SCENES ──
    const validScenes = sceneResults.filter(s => s !== null)
    if (validScenes.length === 0) throw new Error("All scenes failed — cannot build video")

    await bot.sendMessage(chatId, `✂️ Building ${validScenes.length} scenes...`)
    const scenePaths = []
    let totalDuration = 0

    for (let i = 0; i < validScenes.length; i++) {
      try {
        const { videoPath, voicePath, isLipSync, audioDuration } = validScenes[i]
        totalDuration += audioDuration
        const scenePath = isLipSync
          ? buildReporterScene(videoPath, audioDuration, i)
          : buildRegularScene(videoPath, voicePath, audioDuration, i)
        scenePaths.push(scenePath)
        await bot.sendMessage(chatId, `✅ Scene ${i + 1}: ${audioDuration.toFixed(1)}s mixed`)
      } catch (buildErr) {
        console.error(`Scene ${i + 1} build failed:`, buildErr.message)
        await bot.sendMessage(chatId, `⚠️ Scene ${i + 1} build failed — skipping`)
      }
    }

    if (scenePaths.length === 0) throw new Error("No scenes could be built")

    // ── CONCAT ──
    await bot.sendMessage(chatId, `🔗 Joining ${scenePaths.length} scenes...`)
    const concatenated = concatScenes(scenePaths)

    // ── MUSIC ──
    let finalVideo = concatenated
    try {
      await bot.sendMessage(chatId, "🎵 Adding background music...")
      const musicPath = await downloadMusic()
      finalVideo = addMusicHD(concatenated, musicPath, totalDuration)
    } catch (musicErr) {
      console.error("Music failed:", musicErr.message)
      await bot.sendMessage(chatId, `⚠️ Music failed — delivering without it`)
    }

    // ── THUMBNAIL ──
    let thumbPath = null
    try {
      await bot.sendMessage(chatId, "🖼 Generating thumbnail...")
      thumbPath = await generateThumbnail(topic, rawScript)
    } catch (thumbErr) {
      console.error("Thumbnail failed:", thumbErr.message)
      await bot.sendMessage(chatId, `⚠️ Thumbnail failed: ${thumbErr.message}`)
    }

    // ── DRIVE SAVE ──
    const dateStr = new Date().toISOString().slice(0, 16).replace("T", "_")
    let driveMsg = ""
    try {
      await bot.sendMessage(chatId, "☁️ Saving to Google Drive...")
      const videoUpload = await uploadToDrive(finalVideo, `VIDEO_${dateStr}.mp4`, "video/mp4")
      if (videoUpload?.webViewLink) driveMsg += `📹 Video: ${videoUpload.webViewLink}\n`
      if (thumbPath && fs.existsSync(thumbPath)) {
        const thumbUpload = await uploadToDrive(thumbPath, `THUMB_${dateStr}.jpg`, "image/jpeg")
        if (thumbUpload?.webViewLink) driveMsg += `🖼 Thumb: ${thumbUpload.webViewLink}`
      }
    } catch (driveErr) {
      console.error("Drive failed:", driveErr.message)
    }

    // ── DELIVER ──
    await bot.sendVideo(chatId, finalVideo, {
      width: 1280, height: 720,
      caption: `🎬 ${scenePaths.length}-scene video (${totalDuration.toFixed(1)}s)\n🎤 Voice 100% | 🔊 SFX 15% | 🎵 Music 40%`
    })

    if (thumbPath && fs.existsSync(thumbPath)) {
      await bot.sendPhoto(chatId, thumbPath, { caption: "🖼 Thumbnail ready for YouTube" })
    }

    if (driveMsg) {
      await bot.sendMessage(chatId, `✅ Saved to Google Drive:\n${driveMsg}`)
    } else {
      await bot.sendMessage(chatId, "⚠️ Drive save failed — check DRIVE_FOLDER_ID in Railway")
    }

    await bot.sendMessage(chatId, "✅ Done! Send 'do it' for another.")
    userState[chatId].step = "done"

  } catch (err) {
    console.error("Fatal pipeline error:", err)
    await bot.sendMessage(chatId, `❌ Fatal: ${err.message}\n\nSend 'do it' to try again.`)
    userState[chatId] = {}
  }
})
