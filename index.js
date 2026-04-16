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

const TARGET_VIDEO_MINUTES = 10
const TARGET_SCENE_SECONDS = 5
const SCENES_PER_CHUNK = 12 // 12 scenes × 5s = 60s = 1 minute
const WORDS_PER_SCENE = 12
const STEP_TIMEOUT_MS = 8 * 60 * 1000

const sleep = ms => new Promise(r => setTimeout(r, ms))
const safeJSON = str => {
  const clean = str.trim()
    .replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/\s*```$/i, "").trim()
  return JSON.parse(clean)
}

async function sendLongMessage(chatId, text) {
  const MAX = 4000
  if (text.length <= MAX) {
    await bot.sendMessage(chatId, text)
    return
  }
  const parts = []
  let remaining = text
  while (remaining.length > 0) {
    if (remaining.length <= MAX) {
      parts.push(remaining)
      break
    }
    let cut = remaining.lastIndexOf("\n", MAX)
    if (cut < MAX / 2) cut = remaining.lastIndexOf(" ", MAX)
    if (cut < MAX / 2) cut = MAX
    parts.push(remaining.slice(0, cut))
    remaining = remaining.slice(cut).trim()
  }
  for (const part of parts) {
    await bot.sendMessage(chatId, part)
  }
}

const stoppedChats = new Set()
let _userState = {}

// ─────────────────────────────────────────
// STATE PERSISTENCE — survives restarts
// ─────────────────────────────────────────
const STATE_FILE = "/tmp/bot_state.json"
let saveTimeout = null

function saveState() {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify({ userState: _userState, stoppedChats: [...stoppedChats] }))
  } catch (e) {
    console.log("State save failed:", e.message)
  }
}

function debouncedSave() {
  if (saveTimeout) clearTimeout(saveTimeout)
  saveTimeout = setTimeout(saveState, 1000)
}

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const data = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"))
      _userState = data.userState || {}
      if (data.stoppedChats) data.stoppedChats.forEach(id => stoppedChats.add(id))
      console.log(`State restored: ${Object.keys(_userState).length} active chats`)
    }
  } catch (e) {
    console.log("State load failed:", e.message)
  }
}

// Auto-save proxy — saves state whenever userState is modified
const userState = new Proxy(_userState, {
  set(target, prop, value) {
    target[prop] = value
    debouncedSave()
    return true
  },
  deleteProperty(target, prop) {
    delete target[prop]
    debouncedSave()
    return true
  }
})

loadState()

for (const d of ["/tmp/images", "/tmp/videos", "/tmp/voices", "/tmp/final", "/tmp/chunks"]) {
  fs.mkdirSync(d, { recursive: true })
}
console.log("Bot running.")


// ─────────────────────────────────────────
// 7 CAMERA TECHNIQUES (for Kling video motion)
// ─────────────────────────────────────────
const CAMERA_TECHNIQUES = [
  { name: "Slow Pan Right",     motion: "camera slowly pans right with smooth controlled motion" },
  { name: "Orbit",              motion: "camera slowly orbits around the subject" },
  { name: "Orbit Push In",      motion: "camera slowly orbits while gently pushing in closer" },
  { name: "Gentle Rotate",      motion: "camera gently rotates around the subject revealing the scene" },
  { name: "Follow Subject",     motion: "camera smoothly follows the subject as they move" },
  { name: "Boom Up",            motion: "camera smoothly rises upward revealing more of the scene" },
  { name: "Handheld Drift",     motion: "subtle handheld camera drift with gentle natural movement" },
  { name: "Parallax Push",      motion: "camera pushes slowly forward, foreground and background separate with depth" },
  { name: "Crane Up",           motion: "camera slowly cranes upward from low showing the full scene" },
  { name: "Tracking Left",      motion: "camera tracks smoothly to the left alongside the scene" },
  { name: "Dolly In",           motion: "camera slowly dollies forward toward the subject" },
  { name: "Low Angle Rise",     motion: "camera from low angle slowly rises upward with power" },
  { name: "Slow Pan Left",      motion: "camera slowly pans left with controlled steady motion" },
  { name: "Push In Close",      motion: "camera steadily pushes in from medium to close-up on the subject" }
]

const OPENING_CAMERA = CAMERA_TECHNIQUES.find(c => c.name === "Boom Up")
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
// WOMAN PRESENTER
// ─────────────────────────────────────────
const PRESENTER_FACE_ID = "1oxbm7wh3MogxXI1j2rHF6fI9GQHht5Kq"
const PRESENTER_VOICE_ID = "X1amM3LR8OIq8LP92VpO" // Lauren - calm, clear, friendly

async function downloadPresenterFace() {
  const path = `/tmp/images/presenter_face.png`
  if (fs.existsSync(path)) return path
  const res = await fetch(`https://drive.google.com/uc?export=download&id=${PRESENTER_FACE_ID}&confirm=t`)
  if (!res.ok) throw new Error(`Presenter face download failed: ${res.status}`)
  const buf = await res.buffer()
  fs.writeFileSync(path, buf)
  return path
}

// Presenter location/studio pattern tracker
// Pattern: 3 location, 1 studio, 3 location, 1 studio...
let presenterAppearanceCount = 0
function resetPresenterState() {
  presenterAppearanceCount = 0
  presenterOutfit = ""
}
function getPresenterSceneType() {
  // Check what the CURRENT scene type is without advancing
  return presenterAppearanceCount % 4 === 3 ? "studio" : "location"
}
function isCurrentStudio() {
  return presenterAppearanceCount % 4 === 3
}
function advancePresenterCounter() {
  presenterAppearanceCount++
}

// First outfit is locked for all location scenes
let presenterOutfit = ""

async function generatePresenterImage(script, topic, isStudio, chatId) {
  const facePath = await downloadPresenterFace()
  const faceUrl = await uploadToReplicate(facePath, "image/png")

  // Common description of the presenter — must match reference face
  const presenterDesc = "Portrait of a beautiful confident woman around 25 years old with dark hair, green eyes, full lips, glowing skin. No microphone. Neutral composed expression. Both hands hanging naturally down at her sides. Cropped at the waist showing only upper body and head"

  let locationPrompt
  if (isStudio) {
    locationPrompt = `${presenterDesc}. She is in a modern broadcast studio wearing a fitted navy blazer and white blouse. Behind her a large screen shows imagery about: ${topic}. Studio lighting.`
  } else {
    if (!presenterOutfit) {
      presenterOutfit = await callClaude(
        `Based on this topic and location, describe in 10 words what clothing this woman would REALISTICALLY wear if she were actually AT this location. She must look like she belongs there, not like a TV reporter. Be specific. Write ONLY the clothing.`,
        `Topic: ${topic}\nScene: ${script}`,
        50
      )
      presenterOutfit = presenterOutfit.trim()
    }
    locationPrompt = `${presenterDesc}. She is physically standing at the real location described in: "${script}". She wears ${presenterOutfit}. She is naturally part of the scene, not green-screened. The environment wraps around her realistically. Dramatic natural lighting matching the location.`
  }

  const fullPrompt = locationPrompt + REALISM_STYLE_SUFFIX
  console.log(`Presenter image: ${fullPrompt.slice(0, 120)}...`)

  const res = await fetch("https://api.replicate.com/v1/models/black-forest-labs/flux-2-max/predictions", {
    method: "POST",
    headers: { Authorization: `Bearer ${REPLICATE_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      input: {
        prompt: fullPrompt,
        image_prompt: faceUrl,
        image_prompt_strength: 0.45,
        aspect_ratio: "16:9",
        width: 1344,
        height: 768,
        output_format: "jpg",
        output_quality: 95
      }
    })
  })
  const pred = await res.json()
  if (!pred.id) throw new Error(`Presenter image failed: ${pred.detail || JSON.stringify(pred)}`)

  try {
    const result = await withTimeout(pollReplicate(pred.id, "Presenter image", chatId), "Presenter image")
    const imageUrl = Array.isArray(result.output) ? result.output[0] : result.output
    const buf = await (await fetch(imageUrl)).buffer()
    const imgPath = `/tmp/images/presenter_${Date.now()}.jpg`
    fs.writeFileSync(imgPath, buf)
    return imgPath
  } catch (err) {
    if (/sensitive|flagged|E005|safety/i.test(err.message)) {
      console.log("Presenter image flagged, retrying with safe prompt...")
      // Retry with a generic safe prompt
      const safePrompt = `${presenterDesc}. She stands outdoors in a neutral professional setting. Clear sky, natural daylight.` + REALISM_STYLE_SUFFIX
      const res2 = await fetch("https://api.replicate.com/v1/models/black-forest-labs/flux-2-max/predictions", {
        method: "POST",
        headers: { Authorization: `Bearer ${REPLICATE_TOKEN}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          input: { prompt: safePrompt, image_prompt: faceUrl, image_prompt_strength: 0.45, aspect_ratio: "16:9", width: 1344, height: 768, output_format: "jpg", output_quality: 95 }
        })
      })
      const pred2 = await res2.json()
      if (!pred2.id) throw new Error(`Presenter retry failed: ${pred2.detail || JSON.stringify(pred2)}`)
      const result2 = await withTimeout(pollReplicate(pred2.id, "Presenter retry", chatId), "Presenter retry")
      const url2 = Array.isArray(result2.output) ? result2.output[0] : result2.output
      const buf2 = await (await fetch(url2)).buffer()
      const imgPath2 = `/tmp/images/presenter_${Date.now()}.jpg`
      fs.writeFileSync(imgPath2, buf2)
      return imgPath2
    }
    throw err
  }
}

async function generatePresenterVoice(text, index) {
  const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${PRESENTER_VOICE_ID}`, {
    method: "POST",
    headers: { "xi-api-key": process.env.ELEVENLABS_API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({
      text,
      model_id: "eleven_multilingual_v2",
      voice_settings: { stability: 0.5, similarity_boost: 0.75 }
    })
  })
  if (!res.ok) throw new Error(`ElevenLabs presenter failed: ${res.status}`)
  const buf = await res.buffer()
  const path = `/tmp/voices/presenter_voice_${index}.mp3`
  fs.writeFileSync(path, buf)
  return path
}


// ─────────────────────────────────────────
// KLING LIP SYNC
// ─────────────────────────────────────────
async function uploadToReplicate(filePath, contentType) {
  const fileData = fs.readFileSync(filePath)
  const filename = filePath.split("/").pop()
  const boundary = "----ReplicateUpload" + Date.now()

  let body = `--${boundary}\r\n`
  body += `Content-Disposition: form-data; name="content"; filename="${filename}"\r\n`
  body += `Content-Type: ${contentType}\r\n\r\n`

  const bodyStart = Buffer.from(body, "utf-8")
  const bodyEnd = Buffer.from(`\r\n--${boundary}--\r\n`, "utf-8")
  const fullBody = Buffer.concat([bodyStart, fileData, bodyEnd])

  const res = await fetch("https://api.replicate.com/v1/files", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${REPLICATE_TOKEN}`,
      "Content-Type": `multipart/form-data; boundary=${boundary}`
    },
    body: fullBody
  })
  const data = await res.json()
  if (!data.urls?.get) throw new Error(`File upload failed: ${JSON.stringify(data).slice(0, 200)}`)
  console.log(`Uploaded ${filename} → ${data.urls.get}`)
  return data.urls.get
}

async function generateLipSync(faceImagePath, voicePath, index, chatId) {
  if (chatId && isStopped(chatId)) throw new Error("Stopped by user")

  // Upload both files to Replicate's file hosting
  console.log(`LipSync ${index + 1}: uploading image and audio to Replicate...`)
  const imageUrl = await uploadToReplicate(faceImagePath, "image/png")
  const audioUrl = await uploadToReplicate(voicePath, "audio/mpeg")

  console.log(`LipSync ${index + 1}: sending to OmniHuman`)
  const res = await fetch("https://api.replicate.com/v1/models/bytedance/omni-human-1.5/predictions", {
    method: "POST",
    headers: { Authorization: `Bearer ${REPLICATE_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      input: {
        image: imageUrl,
        audio: audioUrl,
        prompt: "Professional reporter speaking directly into camera with steady eye contact. Neutral composed expression, serious and focused like a news reporter. Both hands down at her sides at all times. Subtle natural head movements only. No hand gestures. No smiling. Calm professional delivery."
      }
    })
  })
  const pred = await res.json()
  console.log("OmniHuman response:", JSON.stringify(pred).slice(0, 300))
  if (!pred.id) throw new Error(`LipSync failed to start: ${pred.detail || JSON.stringify(pred)}`)

  const result = await withTimeout(pollReplicate(pred.id, `LipSync ${index + 1}`, chatId), `LipSync ${index + 1}`)
  const url = Array.isArray(result.output) ? result.output[0] : result.output
  const buf = await (await fetch(url)).buffer()
  const rawPath = `/tmp/videos/lipsync_${index}_raw.mp4`
  fs.writeFileSync(rawPath, buf)

  // Trim to exact audio length and normalize to 1280x720 — no zoom, no effects
  const audioDuration = getDuration(voicePath)
  console.log(`LipSync ${index + 1}: audio is ${audioDuration.toFixed(1)}s, trimming video to match`)

  const path = `/tmp/videos/lipsync_${index}.mp4`
  execSync(
    `ffmpeg -y -i "${rawPath}" -t ${audioDuration} -vf "scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2,setsar=1" -c:v libx264 -preset fast -crf 18 -c:a aac -ar 44100 -ac 2 "${path}"`
  )

  console.log(`LipSync ${index + 1}: done (${audioDuration.toFixed(1)}s)`)
  return path
}





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
// CLAUDE HELPERS
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

async function callClaudeNoRefuse(system, user, maxTokens = 4000) {
  const msg = await claude.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: maxTokens,
    system,
    messages: [
      { role: "user", content: user },
      { role: "assistant", content: "Here" }
    ]
  })
  return "Here" + msg.content[0].text
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
// STEP 1 — FULL 10-MINUTE SCRIPT
// Plain paragraphs, no scene labels
// ─────────────────────────────────────────
async function generateFullScript(input) {
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

  const targetWords = 1550
  const minWords = 1500
  const maxWords = 1650

  // PASS 1: Generate detailed outline with story beats
  console.log("Script pass 1: generating outline...")
  const outline = await callClaude(
    `You are a professional YouTube scriptwriter. Create a detailed OUTLINE for a 10-minute narration video.

Structure the outline as:
HOOK (first 20 seconds — THIS IS THE MOST IMPORTANT PART):
- Open with ONE of these proven YouTube hook techniques:
  1. SHOCKING STATEMENT: A bold, surprising claim that demands explanation ("The largest structure ever built was completed in just 16 months.")
  2. INFORMATION GAP: Tell WHAT happened but withhold HOW or WHY ("In 1943, a secret was buried under the Virginia countryside that would change the world forever.")
  3. IMPOSSIBLE QUESTION: Ask something that seems unanswerable ("What if the most powerful building on Earth was designed to be invisible?")
  4. SENSORY OPENING: Drop the viewer into a vivid scene ("The ground shakes. Dust rises. Thousands of workers pour concrete at a pace never seen before.")
  5. COUNTDOWN/STAKES: Create urgency ("They had 16 months. If they failed, the war could be lost.")
- The hook must create TENSION and promise a PAYOFF

CONTEXT (minutes 1-2): [set the scene, introduce the topic]
DEEP DIVE (minutes 3-5): [main story, revelations, key facts — HIGH INTENSITY]
TWIST (minutes 6-8): [unexpected angle, deeper mystery, emotional turn]
CLIMAX (minutes 8-9): [highest stakes, most dramatic revelation]
CLOSE (final minute): [emotional payoff, reflection, end with "Thanks for watching"]

For each section, list 3-5 specific story beats (events, facts, moments to describe).
Write the outline ONLY, no narration yet.`,
    `Topic:\n\n${context}`,
    1500
  )
  console.log("Outline done, starting pass 2...")

  // PASS 2: Write full narration from outline
  let raw = await callClaude(
    `You are a professional scriptwriter. Write the FULL narration based on this outline.

CRITICAL: Write EXACTLY ${targetWords} words (between ${minWords} and ${maxWords}). Count carefully.

WRITING STYLE:
- THE FIRST 3 SENTENCES ARE THE MOST IMPORTANT — extremely dramatic, intriguing, visually striking. HOOK the viewer instantly.
- Fully original wording — never repeat phrases or ideas
- HIGH INTENSITY first half — fast-paced, gripping, constant revelations
- DEEP IMMERSIVE second half — slower, more detailed, emotionally resonant
- ESCALATION throughout — each paragraph raises the stakes
- Strong emotional payoff at the end
- Write in flowing paragraphs — NO scene labels, bullet points, or headers
- Third person — describe events, places, people
- Occasionally use speculative framing like "some believe" but mostly direct storytelling
- End with the exact words: Thanks for watching.
- Write ONLY the narration text — no titles, no notes, no preamble like "Here is the script"`,
    `OUTLINE:\n\n${outline}\n\nTOPIC:\n\n${context}`,
    8000
  )

  raw = raw.trim()

  // If script is too short, ask Claude to expand it
  let words = countWords(raw)
  if (words < minWords) {
    console.log(`Script too short: ${words} words, need ${minWords}. Expanding...`)
    const expansion = await callClaudeNoRefuse(
      `You are continuing a YouTube narration script. The current script is ${words} words but needs to be at least ${minWords} words.
Write additional narration paragraphs that continue the story seamlessly. Add more details, events, and mystery. Write at least ${minWords - words + 100} more words but no more than ${maxWords - words} words.
Do NOT repeat what was already written. Do NOT add scene labels or headers. End with: Thanks for watching.
Write ONLY the additional narration text.`,
      `Current script so far:\n\n${raw.replace(/Thanks for watching\.?\s*$/i, "")}`,
      3000
    )
    raw = raw.replace(/Thanks for watching\.?\s*$/i, "").trim() + "\n\n" + expansion.trim()
    if (!raw.match(/Thanks for watching\.?\s*$/i)) {
      raw += "\n\nThanks for watching."
    }
  }

  // Clean up: remove any preamble Claude adds before the actual narration
  raw = raw.replace(/^Here[\s\S]*?:\s*\n/i, "").trim()
  raw = raw.replace(/^(Here's|Here is|Below is|The following)[\s\S]*?:\s*\n/i, "").trim()

  // If script is too long, trim to maxWords at a sentence boundary
  words = countWords(raw)
  if (words > maxWords) {
    console.log(`Script too long: ${words} words, trimming to ~${maxWords}...`)
    const sentences = raw.match(/[^.!?]*[.!?]+[\s]*/g) || [raw]
    let trimmed = ""
    for (const sentence of sentences) {
      if (countWords(trimmed + sentence) > maxWords && trimmed) break
      trimmed += sentence
    }
    if (!trimmed.match(/Thanks for watching\.?\s*$/i)) {
      trimmed = trimmed.trim() + " Thanks for watching."
    }
    raw = trimmed.trim()
  }

  return raw
}

function countWords(text) {
  return text.split(/\s+/).filter(w => w.length > 0).length
}


// ─────────────────────────────────────────
// STEP 2 — VISUAL STYLE (once for whole video)
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
    `Topic: ${topic}\nScript: ${script.slice(0, 1000)}`,
    250
  )
  return safeJSON(raw)
}


const THUMBNAIL_STYLE_SUFFIX = `
Photorealistic photograph, super high definition, ultra sharp detail. High contrast with vibrant saturated colors that pop and catch the eye. Bold dramatic lighting. Every detail is crisp and clear even at small sizes. Image demands attention and makes people want to click.
Everything in the image must be physically possible and make sense in the real world. No fantasy elements, no impossible physics, no duplicated objects, no magical effects. The drama comes from the real moment, not from adding impossible elements. No text, no words, no titles, no labels anywhere in the image.`


// ─────────────────────────────────────────
// STEP 3 — THUMBNAIL
// ─────────────────────────────────────────
async function generateThumbnail(topic, script, style, chatId) {
  const thumbPrompt = await callClaude(
    `You must read the ENTIRE script below and pick the SINGLE most dramatic, shocking, or visually striking moment from the whole story. Then write a 30-word image prompt that captures THAT specific moment as a YouTube thumbnail.

YOUTUBE THUMBNAIL PSYCHOLOGY:
- ONE clear subject taking up 40-60% of the frame — not cluttered
- HIGH CONTRAST between subject and background — subject must pop
- If there's a person, show EMOTIONAL EXPRESSION (shock, awe, fear, determination)
- VISUAL MYSTERY — something partially hidden, revealed, or about to happen
- DRAMATIC SCALE — show something massive, imposing, or overwhelming
- Everything must be PHYSICALLY POSSIBLE — no fantasy, no impossible physics, no duplicated objects
- Bold dramatic lighting with strong shadows
- The image must make someone STOP scrolling and CLICK
- AVOID words that trigger AI safety filters: no gore, blood, death, weapons being fired, corpses, nudity, graphic violence, explosions. Describe scenes in a documentary tone.

Write ONLY the 30-word prompt, nothing else.`,
    `Topic: ${topic}\n\nFULL SCRIPT:\n${script}`,
    150
  )

  return await generateImage(thumbPrompt.trim() + " " + THUMBNAIL_STYLE_SUFFIX.trim(), 999, chatId)
}


// ─────────────────────────────────────────
// SPLIT TEXT INTO SENTENCES
// ─────────────────────────────────────────
function splitIntoSentences(text) {
  // Split on sentence-ending punctuation followed by space or end
  const raw = text.match(/[^.!?]*[.!?]+[\s]*/g) || [text]
  return raw.map(s => s.trim()).filter(s => s.length > 0)
}


// ─────────────────────────────────────────
// SPLIT SCRIPT INTO CHUNKS
// Each chunk = ~1 minute of narration (~150 words)
// Groups complete sentences, never breaks mid-sentence
// ─────────────────────────────────────────
function splitScriptIntoChunks(script) {
  const sentences = splitIntoSentences(script)
  const wordsPerChunk = SCENES_PER_CHUNK * WORDS_PER_SCENE // ~144 words per chunk
  const chunks = []
  let current = ""

  for (const sentence of sentences) {
    const combined = current ? current + " " + sentence : sentence
    if (countWords(combined) > wordsPerChunk && current) {
      chunks.push(current.trim())
      current = sentence
    } else {
      current = combined
    }
  }
  if (current.trim()) chunks.push(current.trim())

  // If last chunk is too short (< 50 words), merge with previous
  if (chunks.length > 1 && countWords(chunks[chunks.length - 1]) < 50) {
    const last = chunks.pop()
    chunks[chunks.length - 1] += " " + last
  }

  return chunks
}


// ─────────────────────────────────────────
// SPLIT CHUNK INTO SCENES — Claude does the splitting
// Each scene = complete thought, 8-12 words (~5 seconds of speech)
// ─────────────────────────────────────────
async function splitChunkIntoScenes(chunkText) {
  const raw = await callClaude(
    `Split this narration text into individual scenes for a video. Each scene will be spoken aloud (~4-6 seconds) and followed by a pause.

RULES:
- Each scene MUST be a COMPLETE thought that makes sense on its own
- Each scene MUST be between 11 and 14 words. This is CRITICAL for video timing. NEVER go below 10 words. NEVER go above 15 words.
- If a sentence is too short (under 11 words), combine it with the next sentence
- If a sentence is too long (over 15 words), rephrase it into two scenes of 11-14 words each
- NEVER cut a sentence in half — every scene must end at a period, question mark, or exclamation mark
- You may slightly rephrase to hit the 11-14 word target while keeping the meaning
- For each scene, assign a PACING tag based on the emotional intensity:
  "fast" = intense revelation, action (0.5s pause after)
  "normal" = standard narration (1s pause after)
  "slow" = emotional, reflective moment (1.5s pause after)
  "dramatic" = major revelation or cliffhanger (2.5s pause after)

Return ONLY a JSON array of objects: [{"text": "scene text here eleven to fourteen words long.", "pacing": "normal"}, ...]
Return ONLY the JSON array, no other text`,
    chunkText,
    2000
  )
  try {
    const parsed = safeJSON(raw)
    // Handle both formats: array of objects or array of strings
    if (parsed.length > 0 && typeof parsed[0] === "string") {
      return parsed.map(t => ({ text: t, pacing: "normal" }))
    }
    return parsed
  } catch {
    console.log("Claude scene split failed, falling back to sentence split")
    const sentences = splitIntoSentences(chunkText)
    return sentences.length > 0 ? sentences.map(t => ({ text: t, pacing: "normal" })) : [{ text: chunkText, pacing: "normal" }]
  }
}


// ─────────────────────────────────────────
// SCENE BREAKDOWN — build image prompts
// ─────────────────────────────────────────
async function buildScenePrompts(sceneTexts, style, visualSuggestion, globalSceneIndex, topic, scriptSummary) {
  const userVisualNote = visualSuggestion ? ` ${visualSuggestion}.` : ""
  const scenes = []
  const previousPrompts = []

  for (let i = 0; i < sceneTexts.length; i++) {
    const absIndex = globalSceneIndex + i
    const script = sceneTexts[i]
    const camera = absIndex === 0 ? OPENING_CAMERA : getCam(absIndex)
    const angle = absIndex === 0 ? OPENING_ANGLE : getAngle(absIndex)

    const prevContext = previousPrompts.length > 0
      ? `\nPREVIOUS SCENES (DO NOT REPEAT similar compositions):\n${previousPrompts.map((p, j) => `- Scene ${j + 1}: ${p}`).join("\n")}`
      : ""

    const systemPrompt = `You are creating an image prompt for a YouTube video about: "${topic}"

VIDEO CONTEXT (read this to understand what the video is about):
${scriptSummary}

Write a SHORT image prompt (20-30 words max) for this specific scene.
Be LITERAL and SIMPLE — describe only what is physically in the frame. No poetry, no metaphors.
The image MUST make sense in the context of the overall video topic above.
Format: "[angle]. [who/what is in the scene] [what they are doing] [where]. [time of day]."${prevContext}

MUST INCLUDE:
- Ultra realistic
- Massive scale when appropriate
- People actively performing a visible action (not standing still)
- Clear weather conditions
- Dramatic lighting
- Visible tension or danger when the script implies it
- No fantasy elements — everything must be physically possible

RULES:
- Start with the camera angle: "${angle.prompt}"
- Each scene MUST show a DIFFERENT subject, location, or moment than previous scenes
- Keep it under 30 words
- AVOID words that trigger AI safety filters: no gore, blood, death, weapons being fired, corpses, nudity, graphic violence. Describe scenes in a documentary tone.
- NEVER include any text, words, subtitles, captions, or labels in the image. The image must be purely visual with zero text.
- Style: ${style.mood}.${userVisualNote}
- Write ONLY the prompt, nothing else`

    const imagePrompt = await callClaude(systemPrompt, `Scene script line: "${script}"`, 100)
    const trimmedPrompt = imagePrompt.trim().replace(/^["']|["']$/g, "")

    previousPrompts.push(trimmedPrompt.slice(0, 60))

    scenes.push({
      script,
      imagePrompt: trimmedPrompt,
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
Photorealistic photograph with natural imperfections: slight sensor noise, subtle focus variation, real-world micro-details. Materials and surfaces look physically real — touched, used, existing in the real world. Overall image feels like a candid moment captured by someone who was actually there. No text, no words, no subtitles, no captions, no labels, no watermarks anywhere in the image.`


// ─────────────────────────────────────────
// IMAGE GENERATION (Flux 2 Max)
// ─────────────────────────────────────────
async function generateImage(prompt, index, chatId, retryCount = 0) {
  if (chatId && isStopped(chatId)) throw new Error("Stopped by user")

  const fullPrompt = prompt + REALISM_STYLE_SUFFIX
  console.log(`Image ${index + 1} (attempt ${retryCount + 1}): ${fullPrompt.slice(0, 120)}...`)

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
  console.log(`Flux prediction created:`, JSON.stringify(pred).slice(0, 500))
  if (!pred.id) throw new Error(`Image failed to start: ${pred.detail || pred.error?.message || JSON.stringify(pred).slice(0, 200)}`)

  try {
    const result = await withTimeout(pollReplicate(pred.id, `Image ${index + 1}`, chatId), `Image ${index + 1}`)
    const imageUrl = Array.isArray(result.output) ? result.output[0] : result.output

    const buf = await (await fetch(imageUrl)).buffer()
    const path = `/tmp/images/img_${index}.jpg`
    fs.writeFileSync(path, buf)

    try {
      const dims = execSync(`ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of csv=p=0 "${path}"`).toString().trim()
      console.log(`Image ${index + 1} done — dimensions: ${dims}`)
    } catch {
      console.log(`Image ${index + 1} done`)
    }

    return { path, url: imageUrl }
  } catch (err) {
    // If flagged as sensitive, retry with sanitized prompt
    if (err.message && /sensitive|flagged|E005|safety/i.test(err.message) && retryCount < 3) {
      console.log(`Image ${index + 1} flagged as sensitive (attempt ${retryCount + 1}), sanitizing...`)
      let sanitized
      if (retryCount === 0) {
        // First retry: just remove triggering words
        sanitized = await callClaude(
          `This image prompt was flagged by an AI safety filter. Rewrite it removing ALL potentially sensitive words: no violence, weapons, military, combat, blood, death, destruction, fire, explosion, crash, attack, war, burning, corpse, nude. Describe the same scene peacefully. Keep under 30 words. Write ONLY the new prompt.`,
          `Flagged: ${prompt}`,
          100
        )
      } else if (retryCount === 1) {
        // Second retry: make it very generic and safe
        sanitized = await callClaude(
          `Write a completely SAFE 20-word image prompt about this general topic. No people, no conflict, no sensitive content. Just a beautiful landscape or architectural scene. Write ONLY the prompt.`,
          `Topic context: ${prompt.slice(0, 50)}`,
          100
        )
      } else {
        // Third retry: ultra-safe fallback
        sanitized = "Beautiful dramatic landscape, golden hour lighting, sweeping vista, cinematic composition, ultra realistic photograph"
      }
      const cleanPrompt = typeof sanitized === "string" ? sanitized.trim() : sanitized
      return generateImage(cleanPrompt, index, chatId, retryCount + 1)
    }
    throw err
  }
}


// ─────────────────────────────────────────
// VIDEO GENERATION (Kling v2.6)
// ─────────────────────────────────────────
async function generateVideo(imageUrl, imagePath, motionPrompt, imagePrompt, index, chatId, retryCount = 0) {
  if (chatId && isStopped(chatId)) throw new Error("Stopped by user")

  // Always use base64 from local file to avoid URL expiry issues
  let klingImage
  try {
    const dims = execSync(`ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of csv=p=0 "${imagePath}"`).toString().trim()
    const [w, h] = dims.split(",").map(Number)
    const ratio = w / h
    if (ratio < 1.6 || ratio > 1.9) {
      const resizedPath = `/tmp/images/img_${index}_16x9.jpg`
      execSync(`ffmpeg -y -i "${imagePath}" -vf "scale=1344:768:force_original_aspect_ratio=decrease,pad=1344:768:(ow-iw)/2:(oh-ih)/2" -q:v 4 "${resizedPath}"`)
      klingImage = `data:image/jpeg;base64,${fs.readFileSync(resizedPath).toString("base64")}`
    } else {
      klingImage = `data:image/jpeg;base64,${fs.readFileSync(imagePath).toString("base64")}`
    }
  } catch {
    klingImage = `data:image/jpeg;base64,${fs.readFileSync(imagePath).toString("base64")}`
  }

  const peopleWords = /\b(people|person|soldier|military|personnel|crowd|man|woman|figure|worker|officer|guard|child|group)\b/i
  // Build a rich, dynamic motion prompt
  let fullPrompt = `${motionPrompt}, premium documentary cinematography, dynamic and lively scene with visible motion throughout`
  if (peopleWords.test(imagePrompt)) {
    fullPrompt += ", people actively moving — walking, turning, reaching, working, clothes and hair moving with wind, visible body motion"
  }
  // Add environmental motion based on scene content
  if (/desert|sand|dust/i.test(imagePrompt)) fullPrompt += ", dust particles swirl through the air, sand blows across the ground"
  if (/water|ocean|river|rain/i.test(imagePrompt)) fullPrompt += ", water flows and splashes, waves move with energy"
  if (/sky|cloud/i.test(imagePrompt)) fullPrompt += ", clouds move across the sky, light shifts"
  if (/fire|flame|smoke/i.test(imagePrompt)) fullPrompt += ", flames dance and crackle, thick smoke billows upward"
  if (/tree|forest|vegetation/i.test(imagePrompt)) fullPrompt += ", trees and branches sway in wind, leaves flutter"
  if (/city|building|street/i.test(imagePrompt)) fullPrompt += ", traffic moves, flags wave, life in the streets"
  if (/space|planet|mars/i.test(imagePrompt)) fullPrompt += ", atmospheric particles drift, terrain slowly shifts"

  console.log(`Video ${index + 1}: sending to Kling`)
  const res = await fetch("https://api.replicate.com/v1/models/kwaivgi/kling-v2.6/predictions", {
    method: "POST",
    headers: { Authorization: `Bearer ${REPLICATE_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      input: { start_image: klingImage, prompt: fullPrompt, negative_prompt: "blurry, distorted, low quality, watermark, text overlay, logo, glitch, artifacts, subtitles, captions, words, letters, labels, human voice, speech, dialogue, talking, narration", duration: 5, aspect_ratio: "16:9", generate_audio: true }
    })
  })
  const pred = await res.json()
  if (!pred.id) throw new Error(`Video ${index + 1} failed to start: ${pred.detail || JSON.stringify(pred)}`)

  const result = await withTimeout(pollReplicate(pred.id, `Video ${index + 1}`, chatId), `Video ${index + 1}`)
  const url = Array.isArray(result.output) ? result.output[0] : result.output
  const buf = await (await fetch(url)).buffer()
  const rawPath = `/tmp/videos/video_${index}_raw.mp4`
  const path = `/tmp/videos/video_${index}.mp4`
  fs.writeFileSync(rawPath, buf)

  // ENFORCE 16:9
  try {
    const dims = execSync(`ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of csv=p=0 "${rawPath}"`).toString().trim()
    const [w, h] = dims.split(",").map(Number)
    const ratio = w / h
    if (ratio < 1.6 || ratio > 1.9) {
      const targetRatio = 16 / 9
      let cropW, cropH
      if (ratio < targetRatio) { cropW = w; cropH = Math.round(w / targetRatio) }
      else { cropH = h; cropW = Math.round(h * targetRatio) }
      cropW -= cropW % 2; cropH -= cropH % 2
      execSync(`ffmpeg -y -i "${rawPath}" -vf "crop=${cropW}:${cropH},scale=1280:720,setsar=1" -c:v libx264 -preset fast -crf 18 -c:a aac -ar 44100 -ac 2 "${path}"`)
    } else {
      fs.copyFileSync(rawPath, path)
    }
  } catch {
    try {
      execSync(`ffmpeg -y -i "${rawPath}" -vf "scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2,setsar=1" -c:v libx264 -preset fast -crf 18 -c:a aac -ar 44100 -ac 2 "${path}"`)
    } catch { fs.copyFileSync(rawPath, path) }
  }

  return path
}


// ─────────────────────────────────────────
// VOICE GENERATION (ElevenLabs)
// ─────────────────────────────────────────
async function generateVoice(text, index) {
  const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${ELLIS_VOICE_ID}`, {
    method: "POST",
    headers: { "xi-api-key": process.env.ELEVENLABS_API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({
      text,
      model_id: "eleven_multilingual_v2",
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
// MUSIC — 3 options from Google Drive
// ─────────────────────────────────────────
const MUSIC_OPTIONS = [
  { name: "Hopeful", id: "1Cw_QOTNCuImtn3miP4IQWUkhRsFhyCEU" },
  { name: "Suspense", id: "1wU0OEEXca-ctc0EYWNeS6IL3pLO7p_jC" },
  { name: "Space", id: "1CY8Fi1Mdz1RXO4QvwHrQDXa4UxS0dg4r" }
]

async function downloadMusicByChoice(choice) {
  const music = MUSIC_OPTIONS[choice - 1]
  if (!music) throw new Error(`Invalid music choice: ${choice}`)
  const path = `/tmp/music_${music.name.toLowerCase()}.mp3`
  if (fs.existsSync(path)) return path
  const res = await fetch(`https://drive.google.com/uc?export=download&id=${music.id}&confirm=t`)
  if (!res.ok) throw new Error(`Music download failed: ${res.status}`)
  const buf = await res.buffer()
  fs.writeFileSync(path, buf)
  return path
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

function detectVocalContent(p) {
  if (!hasAudio(p)) return false
  try {
    const out = execSync(`ffmpeg -i "${p}" -vn -af "highpass=f=300,lowpass=f=3000,volumedetect" -f null - 2>&1`, { timeout: 15000 }).toString()
    const m = out.match(/mean_volume:\s*([-\d.]+)\s*dB/)
    if (m) return parseFloat(m[1]) > -38
  } catch {}
  return false
}

function normalizeSize(input, output) {
  execSync(
    `ffmpeg -y -i "${input}" -vf "scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2,setsar=1" -c:v libx264 -preset fast -crf 18 -c:a aac -ar 44100 -ac 2 "${output}"`
  )
}

function getVoiceDelay(sceneIndex, pacing = "normal") {
  return 0.5 // Always 0.5s delay at start of every scene
}

// Lip sync scenes: every 5 scenes starting at scene 3 (index 2, 7, 12, 17...)
function isLipSyncScene(globalSceneIndex) {
  if (globalSceneIndex < 2) return false
  return (globalSceneIndex - 2) % 5 === 0
}

// Build a lip sync scene — use actual lip sync video, 0.5s delay at start
function buildLipSyncScene(vidPath, voicePath, dur, i, sfxVideoPath = null) {
  const norm = `/tmp/videos/norm_${i}.mp4`
  normalizeSize(vidPath, norm)

  // Total duration = 0.5s delay + audio duration
  const totalDur = dur + 0.5

  // Trim video to total duration — keep the actual lip sync animation
  const trimmed = `/tmp/videos/trimmed_${i}.mp4`
  execSync(`ffmpeg -y -i "${norm}" -t ${totalDur} -an -c:v libx264 -preset fast -crf 18 "${trimmed}"`)

  // Add 0.5s silence before voice
  const delayedVoice = `/tmp/voices/presenter_delayed_${i}.mp3`
  execSync(`ffmpeg -y -f lavfi -t 0.5 -i anullsrc=r=44100:cl=mono -i "${voicePath}" -filter_complex "[0:a][1:a]concat=n=2:v=0:a=1[aout]" -map "[aout]" -c:a libmp3lame -ar 44100 "${delayedVoice}"`)

  const out = `/tmp/final/scene_${i}.mp4`

  // Try to mix with SFX from Kling video — filter out voices
  if (sfxVideoPath && fs.existsSync(sfxVideoPath)) {
    const sfxAudio = `/tmp/videos/lipsync_sfx_${i}.aac`
    try {
      execSync(`ffmpeg -y -i "${sfxVideoPath}" -vn -c:a aac -ar 44100 "${sfxAudio}"`)
      if (fs.existsSync(sfxAudio)) {
        execSync(
          `ffmpeg -y -i "${trimmed}" -i "${delayedVoice}" -i "${sfxAudio}" -filter_complex "[2:a]lowpass=f=250,highpass=f=50,volume=0.12,afade=t=in:st=0:d=0.5,afade=t=out:st=${Math.max(0, totalDur - 1)}:d=1[sfx];[1:a]volume=1.0[voice];[sfx][voice]amix=inputs=2:duration=longest:dropout_transition=0[aout]" -map 0:v -map "[aout]" -c:v libx264 -preset fast -crf 18 -c:a aac -ar 44100 -ac 2 -shortest "${out}"`
        )
        return out
      }
    } catch (e) {
      console.log(`SFX mix failed (non-critical): ${e.message}`)
    }
  }

  // Fallback: voice only with delay
  execSync(`ffmpeg -y -i "${trimmed}" -i "${delayedVoice}" -map 0:v -map 1:a -c:v libx264 -preset fast -crf 18 -c:a aac -ar 44100 -ac 2 -shortest "${out}"`)
  return out
}

function buildScene(vidPath, voicePath, dur, i, pacing = "normal") {
  const norm = `/tmp/videos/norm_${i}.mp4`
  normalizeSize(vidPath, norm)

  const delay = getVoiceDelay(i, pacing)
  const totalAudioNeeded = dur + delay
  const videoDuration = getDuration(norm)

  let prepared = norm
  if (totalAudioNeeded > videoDuration) {
    const slowFactor = totalAudioNeeded / videoDuration
    console.log(`Scene ${i + 1}: slowing by ${slowFactor.toFixed(2)}x with minterpolate`)
    const slowed = `/tmp/videos/slowed_${i}.mp4`
    execSync(
      `ffmpeg -y -i "${norm}" -vf "setpts=${slowFactor}*PTS,minterpolate=fps=30:mi_mode=mci:mc_mode=aobmc:vsbmc=1" -an -c:v libx264 -preset fast -crf 18 "${slowed}"`,
      { timeout: 120000 }
    )
    prepared = slowed
  }

  const sceneDuration = Math.max(TARGET_SCENE_SECONDS, totalAudioNeeded)
  const trimmed = `/tmp/videos/trimmed_${i}.mp4`
  execSync(`ffmpeg -y -i "${prepared}" -t ${sceneDuration} -c:v copy -an "${trimmed}"`)

  const delayedVoice = `/tmp/voices/delayed_${i}.mp3`
  // Always put 0.5s silence BEFORE the voice
  execSync(`ffmpeg -y -f lavfi -t ${delay} -i anullsrc=r=44100:cl=mono -i "${voicePath}" -filter_complex "[0:a][1:a]concat=n=2:v=0:a=1[aout]" -map "[aout]" -c:a libmp3lame -ar 44100 "${delayedVoice}"`)

  const out = `/tmp/final/scene_${i}.mp4`
  if (hasAudio(norm)) {
    const klingAudio = `/tmp/videos/kling_audio_${i}.aac`
    try { execSync(`ffmpeg -y -i "${norm}" -vn -c:a aac -ar 44100 "${klingAudio}"`) } catch {}
    // Filter out vocal frequencies (300-3000Hz) to keep only environment SFX, then set volume
    const sfxVol = 0.12
    execSync(
      `ffmpeg -y -i "${trimmed}" -i "${delayedVoice}" -i "${klingAudio}" -filter_complex "[2:a]lowpass=f=250,highpass=f=50,volume=${sfxVol},afade=t=in:st=0:d=1,afade=t=out:st=3:d=2[sfx];[1:a]volume=1.0[voice];[sfx][voice]amix=inputs=2:duration=longest:dropout_transition=0[aout]" -map 0:v -map "[aout]" -c:v libx264 -preset fast -crf 18 -c:a aac -ar 44100 -ac 2 -shortest "${out}"`
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

function concatChunks(paths) {
  if (paths.length === 1) return paths[0]
  const out = "/tmp/final/full_video_no_music.mp4"
  const listFile = "/tmp/final/chunk_list.txt"
  fs.writeFileSync(listFile, paths.map(p => `file '${p}'`).join("\n"))
  execSync(`ffmpeg -y -f concat -safe 0 -i "${listFile}" -c copy "${out}"`)
  return out
}

function addMusicHD(vidPath, musicPath, dur) {
  const musicTrim = "/tmp/final/music_trim.mp3"
  // Trim music to video duration with fade out in last 5 seconds
  const fadeStart = Math.max(0, dur - 5)
  execSync(`ffmpeg -y -i "${musicPath}" -t ${dur} -af "volume=0.35,afade=t=out:st=${fadeStart}:d=5" "${musicTrim}"`)
  const out = "/tmp/final/final_video.mp4"
  // Simple ducking: music at 35% volume, voice at 100%, amix blends them
  // The music fade-out handles the ending, voice naturally dominates during speech
  execSync(
    `ffmpeg -y -i "${vidPath}" -i "${musicTrim}" -filter_complex "[0:a]volume=1.0[voice];[1:a]volume=1.0[music];[voice][music]amix=inputs=2:duration=first:dropout_transition=2:weights=1 0.4[aout]" -map 0:v -map "[aout]" -c:v libx264 -preset slow -crf 18 -b:v 8M -maxrate 10M -bufsize 20M -c:a aac -b:a 192k -ar 44100 -movflags +faststart "${out}"`
  )
  return out
}


// ─────────────────────────────────────────
// PROCESS ONE CHUNK (images → approval → videos → approval → build)
// Returns a promise that resolves when chunk is fully approved
// ─────────────────────────────────────────
async function processChunk(chatId, chunkIndex, totalChunks, sceneObjs, style, visualSuggestion, globalSceneIndex, topic, rawScript) {
  if (isStopped(chatId)) throw new Error("Stopped by user")

  // sceneObjs = [{text, pacing}, ...]
  const sceneTexts = sceneObjs.map(s => typeof s === "string" ? s : s.text)
  const pacingTags = sceneObjs.map(s => typeof s === "string" ? "normal" : (s.pacing || "normal"))

  await bot.sendMessage(chatId, `📦 Chunk ${chunkIndex + 1}/${totalChunks} — ${sceneTexts.length} scenes`)

  // Build scene prompts with full context
  await bot.sendMessage(chatId, "🎬 Building scene prompts...")
  const scriptSummary = rawScript.slice(0, 800)
  const scenes = await buildScenePrompts(sceneTexts, style, visualSuggestion, globalSceneIndex, topic, scriptSummary)

  // Attach pacing to each scene
  scenes.forEach((s, i) => { s.pacing = pacingTags[i] })

  // Generate images + lip sync videos
  await bot.sendMessage(chatId, `🖼 Generating images...`)
  const images = []
  const voices = []
  const lipSyncFlags = []
  const lipSyncVideos = {} // pre-generated lip sync videos

  for (let i = 0; i < scenes.length; i++) {
    if (isStopped(chatId)) throw new Error("Stopped by user")
    const s = scenes[i]
    const absIdx = globalSceneIndex + i
    const isLipSync = isLipSyncScene(absIdx)
    lipSyncFlags.push(isLipSync)

    try {
      // Show the script text for this scene
      await bot.sendMessage(chatId, `📝 Scene ${i + 1} script:\n"${s.script}"`)

      if (isLipSync) {
        // PRESENTER SCENE — generate image first, ask approval, then lip sync
        const isStudio = isCurrentStudio()
        const sceneType = isStudio ? "studio" : "location"
        await bot.sendMessage(chatId, `🎤 Scene ${i + 1} — presenter (${sceneType}), generating image...`)

        // Generate presenter voice (Lauren)
        const voicePath = await generatePresenterVoice(s.script, absIdx)
        const audioDuration = getDuration(voicePath)
        voices.push({ voicePath, audioDuration })

        // Generate presenter image (Flux with face reference)
        const presenterImgPath = await generatePresenterImage(s.script, topic, isStudio, chatId)
        await bot.sendDocument(chatId, presenterImgPath, { caption: `📸 Presenter image (${sceneType})` })

        // Save state and ask for approval before generating lip sync
        images.push(null)
        userState[chatId] = {
          step: "waiting_presenter_image_approval",
          scenes, images, voices, lipSyncFlags, lipSyncVideos, globalSceneIndex, chunkIndex, totalChunks, style, visualSuggestion,
          presenterImgPath, presenterSceneIndex: i, presenterAbsIdx: absIdx, presenterIsStudio: isStudio,
          topic, rawScript, remainingSceneStart: i + 1
        }
        await bot.sendMessage(chatId, `✅ Send "yes" to approve presenter image\n🔄 Send "redo" or "redo, suggestion here" to regenerate`)
        return // Break out — will resume after user approves
      } else {
        // NORMAL SCENE — Ellis voice, Flux image
        const voicePath = await generateVoice(s.script, absIdx)
        const audioDuration = getDuration(voicePath)
        voices.push({ voicePath, audioDuration })

        const img = await generateImage(s.imagePrompt, absIdx, chatId)
        images.push(img)
        await bot.sendMessage(chatId, `🖼 Full image prompt:\n\n${s.imagePrompt}${REALISM_STYLE_SUFFIX}`)
        await bot.sendDocument(chatId, img.path, { caption: `📸 Image ${i + 1} of ${scenes.length}` })
      }
    } catch (err) {
      if (err.message === "Stopped by user") throw err
      console.error(`Scene ${i + 1} failed:`, err.message)
      await bot.sendMessage(chatId, `⚠️ Scene ${i + 1} failed: ${err.message}`)
      images.push(null)
      voices.push(null)
    }
  }

  // Wait for image approval
  userState[chatId] = { step: "waiting_chunk_image_approval", scenes, images, voices, lipSyncFlags, lipSyncVideos, globalSceneIndex, chunkIndex, totalChunks, style, visualSuggestion }
  await bot.sendMessage(chatId, `🖼 All images for chunk ${chunkIndex + 1} generated.\n\n✅ Send "yes" to approve\n🔄 Send "redo 2" or "redo 1,3" to regenerate`)
}


// ─────────────────────────────────────────
// TRIGGER
// ─────────────────────────────────────────
bot.onText(/^do it$/i, msg => {
  stoppedChats.delete(msg.chat.id)
  resetPresenterState()
  userState[msg.chat.id] = { step: "waiting_input" }
  bot.sendMessage(msg.chat.id, `Send a theme, article link, or paste any text.\n\n💡 Send "stop" anytime to halt.`)
})


// ─────────────────────────────────────────
// TEST ALL — diagnostic test of every pipeline step
// ─────────────────────────────────────────
bot.onText(/^test all$/i, async msg => {
  const chatId = msg.chat.id
  stoppedChats.delete(chatId)
  resetPresenterState()
  userState[chatId] = { step: "testing" }

  const results = []
  const pass = (name) => { results.push(`✅ ${name}`); return true }
  const fail = (name, err) => { results.push(`❌ ${name}: ${err}`); return false }

  await bot.sendMessage(chatId, `🧪 Starting full pipeline test...\nThis will test every step without generating a full video.\n\n⏱ Estimated time: 10-15 minutes`)

  const testTopic = "The mystery of the Bermuda Triangle"
  const testScript = "Ships vanish without a trace in these waters. For decades, the Bermuda Triangle has claimed hundreds of vessels and aircraft. Scientists and conspiracy theorists alike have searched for answers in this deadly stretch of ocean."
  const testScene = "Ships vanish without a trace in these deadly waters."

  // 1. CLAUDE — Script outline
  try {
    await bot.sendMessage(chatId, `🧪 1/14 Testing Claude script outline...`)
    const outline = await callClaude("Write a 3-sentence outline for a YouTube video about this topic.", testTopic, 200)
    await bot.sendMessage(chatId, `📝 Outline: ${outline.slice(0, 200)}`)
    pass("Claude script outline")
  } catch (e) { fail("Claude script outline", e.message) }

  if (isStopped(chatId)) { await bot.sendMessage(chatId, "⛔ Test stopped."); return }

  // 2. FLUX — Scene image
  let sceneImgPath = null, sceneImgUrl = null
  try {
    await bot.sendMessage(chatId, `🧪 2/14 Testing Flux scene image...`)
    const img = await generateImage("Wide establishing shot. A cargo ship in rough ocean waters during a storm. Dark clouds, massive waves. Dramatic lighting.", 0, chatId)
    sceneImgPath = img.path
    sceneImgUrl = img.url
    await bot.sendDocument(chatId, img.path, { caption: "📸 Test scene image" })
    pass("Flux scene image")
  } catch (e) { fail("Flux scene image", e.message) }

  if (isStopped(chatId)) { await bot.sendMessage(chatId, "⛔ Test stopped."); return }

  // 3. FLUX — Thumbnail
  try {
    await bot.sendMessage(chatId, `🧪 3/14 Testing Flux thumbnail...`)
    const thumb = await generateImage("A massive ship sinking in dark stormy ocean, dramatic golden light breaking through clouds, high contrast, ultra sharp. No text.", 999, chatId)
    await bot.sendDocument(chatId, thumb.path, { caption: "📸 Test thumbnail" })
    pass("Flux thumbnail")
  } catch (e) { fail("Flux thumbnail", e.message) }

  if (isStopped(chatId)) { await bot.sendMessage(chatId, "⛔ Test stopped."); return }

  // 4. FLUX — Presenter image (location)
  let presenterImgPath = null
  try {
    await bot.sendMessage(chatId, `🧪 4/14 Testing Flux presenter image (location)...`)
    presenterImgPath = await generatePresenterImage(testScene, testTopic, false, chatId)
    await bot.sendDocument(chatId, presenterImgPath, { caption: "📸 Test presenter (location)" })
    pass("Flux presenter image (location)")
  } catch (e) { fail("Flux presenter image (location)", e.message) }

  if (isStopped(chatId)) { await bot.sendMessage(chatId, "⛔ Test stopped."); return }

  // 5. FLUX — Presenter image (studio)
  try {
    await bot.sendMessage(chatId, `🧪 5/14 Testing Flux presenter image (studio)...`)
    const studioImg = await generatePresenterImage(testScene, testTopic, true, chatId)
    await bot.sendDocument(chatId, studioImg, { caption: "📸 Test presenter (studio)" })
    pass("Flux presenter image (studio)")
  } catch (e) { fail("Flux presenter image (studio)", e.message) }

  if (isStopped(chatId)) { await bot.sendMessage(chatId, "⛔ Test stopped."); return }

  // 6. ELEVENLABS — Narrator voice (Ellis)
  let narratorVoicePath = null
  try {
    await bot.sendMessage(chatId, `🧪 6/14 Testing ElevenLabs narrator voice...`)
    narratorVoicePath = await generateVoice(testScene, 0)
    const dur = getDuration(narratorVoicePath)
    await bot.sendMessage(chatId, `🎤 Narrator voice: ${dur.toFixed(1)}s`)
    pass("ElevenLabs narrator (Ellis)")
  } catch (e) { fail("ElevenLabs narrator (Ellis)", e.message) }

  if (isStopped(chatId)) { await bot.sendMessage(chatId, "⛔ Test stopped."); return }

  // 7. ELEVENLABS — Presenter voice (Lauren)
  let presenterVoicePath = null
  try {
    await bot.sendMessage(chatId, `🧪 7/14 Testing ElevenLabs presenter voice...`)
    presenterVoicePath = await generatePresenterVoice(testScene, 0)
    const dur = getDuration(presenterVoicePath)
    await bot.sendMessage(chatId, `🎤 Presenter voice: ${dur.toFixed(1)}s`)
    pass("ElevenLabs presenter (Lauren)")
  } catch (e) { fail("ElevenLabs presenter (Lauren)", e.message) }

  if (isStopped(chatId)) { await bot.sendMessage(chatId, "⛔ Test stopped."); return }

  // 8. KLING — Scene video
  let sceneVideoPath = null
  try {
    if (sceneImgPath) {
      await bot.sendMessage(chatId, `🧪 8/14 Testing Kling scene video...`)
      sceneVideoPath = await generateVideo(sceneImgUrl, sceneImgPath, "camera slowly orbits around the subject", "ship ocean storm waves", 0, chatId)
      await bot.sendVideo(chatId, sceneVideoPath, { caption: "🎬 Test scene video" })
      pass("Kling scene video")
    } else { fail("Kling scene video", "No scene image to use") }
  } catch (e) { fail("Kling scene video", e.message) }

  if (isStopped(chatId)) { await bot.sendMessage(chatId, "⛔ Test stopped."); return }

  // 9. OMNIHUMAN — Lip sync
  let lipSyncPath = null
  try {
    if (presenterImgPath && presenterVoicePath) {
      await bot.sendMessage(chatId, `🧪 9/14 Testing OmniHuman lip sync...`)
      lipSyncPath = await generateLipSync(presenterImgPath, presenterVoicePath, 0, chatId)
      await bot.sendVideo(chatId, lipSyncPath, { caption: "🎤 Test lip sync" })
      pass("OmniHuman lip sync")
    } else { fail("OmniHuman lip sync", "No presenter image or voice") }
  } catch (e) { fail("OmniHuman lip sync", e.message) }

  if (isStopped(chatId)) { await bot.sendMessage(chatId, "⛔ Test stopped."); return }

  // 10. FFMPEG — Build normal scene
  let builtScenePath = null
  try {
    if (sceneVideoPath && narratorVoicePath) {
      await bot.sendMessage(chatId, `🧪 10/14 Testing FFmpeg normal scene build...`)
      const dur = getDuration(narratorVoicePath)
      builtScenePath = buildScene(sceneVideoPath, narratorVoicePath, dur, 0, "normal")
      await bot.sendVideo(chatId, builtScenePath, { caption: "🎬 Test built scene (voice + SFX + delay)" })
      pass("FFmpeg normal scene build")
    } else { fail("FFmpeg normal scene build", "No video or voice") }
  } catch (e) { fail("FFmpeg normal scene build", e.message) }

  if (isStopped(chatId)) { await bot.sendMessage(chatId, "⛔ Test stopped."); return }

  // 11. FFMPEG — Build presenter scene
  let builtPresenterPath = null
  try {
    if (lipSyncPath && presenterVoicePath) {
      await bot.sendMessage(chatId, `🧪 11/14 Testing FFmpeg presenter scene build...`)
      const dur = getDuration(presenterVoicePath)
      builtPresenterPath = buildLipSyncScene(lipSyncPath, presenterVoicePath, dur, 1, null)
      await bot.sendVideo(chatId, builtPresenterPath, { caption: "🎬 Test built presenter scene (zoom + voice)" })
      pass("FFmpeg presenter scene build")
    } else { fail("FFmpeg presenter scene build", "No lip sync or voice") }
  } catch (e) { fail("FFmpeg presenter scene build", e.message) }

  if (isStopped(chatId)) { await bot.sendMessage(chatId, "⛔ Test stopped."); return }

  // 12. FFMPEG — Concat scenes
  let concatPath = null
  try {
    if (builtScenePath && builtPresenterPath) {
      await bot.sendMessage(chatId, `🧪 12/14 Testing FFmpeg concat...`)
      concatPath = concatScenes([builtScenePath, builtPresenterPath])
      await bot.sendVideo(chatId, concatPath, { caption: "🎬 Test concat (2 scenes)" })
      pass("FFmpeg concat")
    } else { fail("FFmpeg concat", "No built scenes") }
  } catch (e) { fail("FFmpeg concat", e.message) }

  if (isStopped(chatId)) { await bot.sendMessage(chatId, "⛔ Test stopped."); return }

  // 13. MUSIC — Download
  let musicPath = null
  try {
    await bot.sendMessage(chatId, `🧪 13/14 Testing music download (Hopeful)...`)
    musicPath = await downloadMusicByChoice(1)
    pass("Music download")
  } catch (e) { fail("Music download", e.message) }

  if (isStopped(chatId)) { await bot.sendMessage(chatId, "⛔ Test stopped."); return }

  // 14. FFMPEG — Music mix
  try {
    if (concatPath && musicPath) {
      await bot.sendMessage(chatId, `🧪 14/14 Testing FFmpeg music mix + ducking + fade...`)
      const totalDur = getDuration(concatPath)
      const finalPath = addMusicHD(concatPath, musicPath, totalDur)
      await bot.sendVideo(chatId, finalPath, { caption: "🎬 Test final (music + ducking + fade)" })
      await bot.sendDocument(chatId, finalPath, { caption: "📁 Test final HD file" })
      pass("FFmpeg music mix")
    } else { fail("FFmpeg music mix", "No concat or music") }
  } catch (e) { fail("FFmpeg music mix", e.message) }

  // RESULTS
  const passed = results.filter(r => r.startsWith("✅")).length
  const failed = results.filter(r => r.startsWith("❌")).length
  await bot.sendMessage(chatId, `\n🧪 TEST COMPLETE\n\n${results.join("\n")}\n\n✅ Passed: ${passed}/14\n❌ Failed: ${failed}/14\n\nSend "do it" to start a real video.`)
  userState[chatId] = {}
})


// ─────────────────────────────────────────
// MAIN MESSAGE HANDLER
// ─────────────────────────────────────────
bot.on("message", async msg => {
  const chatId = msg.chat.id
  const text = (msg.text || "").trim()
  if (/^do it$/i.test(text) || /^stop$/i.test(text) || /^test all$/i.test(text)) return

  const state = userState[chatId]
  if (!state) return

  // ── User sends topic ──
  if (state.step === "waiting_input") {
    userState[chatId] = { step: "generating_script" }
    try {
      await bot.sendMessage(chatId, `✍️ Writing ${TARGET_VIDEO_MINUTES}-minute script...`)
      const rawScript = await generateFullScript(text)
      const wordCount = countWords(rawScript)
      const topic = text.startsWith("http") ? text.split("/").pop().replace(/_/g, " ") : text.slice(0, 60)

      userState[chatId] = { step: "waiting_script_approval", input: text, topic, rawScript }
      await sendLongMessage(chatId, `📄 Script (${wordCount} words, ~${Math.round(wordCount / 2.5 / 60)} min):\n\n${rawScript}`)
      await bot.sendMessage(chatId, `✅ Send "ok" to continue\n🔄 "redo" for a new script\n💬 Or send feedback like "make the opening more dramatic"`)
    } catch (err) {
      console.error("Script failed:", err)
      await bot.sendMessage(chatId, `❌ Script failed: ${err.message}\n\nSend 'do it' to try again.`)
      userState[chatId] = {}
    }
    return
  }

  // ── Script approval ──
  if (state.step === "waiting_script_approval") {
    if (/^ok$/i.test(text)) {
      userState[chatId] = { ...state, step: "waiting_visual_suggestion" }
      await bot.sendMessage(chatId, `🎨 Any suggestions for the image prompts?\n\nDescribe visual details like clothing style, environment, era, colors, etc.\n\nOr send "none" to skip.`)
      return
    }

    if (/^redo$/i.test(text)) {
      // Plain redo — regenerate from scratch
      try {
        await bot.sendMessage(chatId, `✍️ Rewriting script...`)
        const rawScript = await generateFullScript(state.input)
        const wordCount = countWords(rawScript)
        userState[chatId] = { ...state, rawScript }
        await sendLongMessage(chatId, `📄 Script (${wordCount} words, ~${Math.round(wordCount / 2.5 / 60)} min):\n\n${rawScript}`)
        await bot.sendMessage(chatId, `✅ Send "ok" to continue\n🔄 "redo" for a new script\n💬 Or send feedback like "make the opening more dramatic"`)
      } catch (err) {
        await bot.sendMessage(chatId, `❌ Script failed: ${err.message}`)
      }
      return
    }

    // Any other text = feedback to modify the script
    try {
      await bot.sendMessage(chatId, `✍️ Rewriting script with your feedback...`)
      const rawScript = await callClaude(
        `You are rewriting a YouTube narration script based on user feedback.
Rewrite the ENTIRE script (1500-1650 words) incorporating the user's feedback. Keep the same topic and overall story but apply the requested changes.
Write ONLY the narration text. End with: Thanks for watching.`,
        `Original script:\n\n${state.rawScript}\n\nUser feedback: ${text}`,
        8000
      )
      let cleaned = rawScript.trim()
      cleaned = cleaned.replace(/^(Here's|Here is|Below is|The following)[\s\S]*?:\s*\n/i, "").trim()
      const wordCount = countWords(cleaned)
      userState[chatId] = { ...state, rawScript: cleaned }
      await sendLongMessage(chatId, `📄 Script (${wordCount} words, ~${Math.round(wordCount / 2.5 / 60)} min):\n\n${cleaned}`)
      await bot.sendMessage(chatId, `✅ Send "ok" to continue\n🔄 "redo" for a new script\n💬 Or send more feedback`)
    } catch (err) {
      await bot.sendMessage(chatId, `❌ Rewrite failed: ${err.message}`)
    }
    return
  }

  // ── Visual suggestions ──
  if (state.step === "waiting_visual_suggestion") {
    const visualSuggestion = /^none$/i.test(text) ? "" : text
    const { topic, rawScript } = state

    try {
      // Visual style (once for whole video)
      await bot.sendMessage(chatId, "🎨 Defining visual style...")
      const style = await generateVisualStyle(topic, rawScript)
      await bot.sendMessage(chatId, `🎨 ${style.styleTag} | ${style.mood}`)

      // Store style in state immediately so we don't lose it
      userState[chatId] = { step: "generating_thumbnail", topic, rawScript, style, visualSuggestion }

      // Generate thumbnail
      await bot.sendMessage(chatId, "🖼 Generating thumbnail...")
      const thumb = await generateThumbnail(topic, rawScript, style, chatId)

      userState[chatId] = { step: "waiting_thumbnail_approval", topic, rawScript, style, visualSuggestion, thumb }
      await bot.sendDocument(chatId, thumb.path, { caption: "🎨 Thumbnail preview" })
      await bot.sendMessage(chatId, `✅ Send "yes" to approve thumbnail\n🔄 Describe changes you want (e.g. "make it darker" or "add more fire")`)
    } catch (err) {
      console.error("Style/thumbnail failed:", err)
      // Keep the state so user can retry
      userState[chatId] = { ...userState[chatId], step: "waiting_thumbnail_retry", topic, rawScript, visualSuggestion, style: userState[chatId]?.style }
      await bot.sendMessage(chatId, `⚠️ Thumbnail generation failed: ${err.message}\n\n🔄 Send "retry" to try again with a different prompt`)
    }
    return
  }

  // ── Thumbnail retry ──
  if (state.step === "waiting_thumbnail_retry") {
    const { topic, rawScript, style, visualSuggestion } = state

    if (/^skip$/i.test(text)) {
      // Skip thumbnail, go straight to chunk processing
      const chunks = splitScriptIntoChunks(rawScript)
      await bot.sendMessage(chatId, `⏭ Skipping thumbnail.\n\n📦 Script split into ${chunks.length} chunks (~1 min each)\n\nStarting chunk 1...`)
      userState[chatId] = { step: "processing_chunks", topic, rawScript, style: style || {}, visualSuggestion, chunks, chunkPaths: [], currentChunk: 0, globalSceneIndex: 0, totalDuration: 0 }
      try {
        await processChunk(chatId, 0, chunks.length, await splitChunkIntoScenes(chunks[0]), style || {}, visualSuggestion, 0, topic, rawScript)
      } catch (err) {
        if (err.message === "Stopped by user") return
        await bot.sendMessage(chatId, `❌ Failed: ${err.message}`)
        userState[chatId] = {}
      }
      return
    }

    try {
      await bot.sendMessage(chatId, "🖼 Retrying thumbnail with safer prompt...")
      const thumb = await generateThumbnail(topic, rawScript, style || {}, chatId)
      userState[chatId] = { step: "waiting_thumbnail_approval", topic, rawScript, style: style || {}, visualSuggestion, thumb }
      await bot.sendDocument(chatId, thumb.path, { caption: "🎨 Thumbnail preview" })
      await bot.sendMessage(chatId, `✅ Send "yes" to approve thumbnail\n🔄 Describe changes you want`)
    } catch (err) {
      userState[chatId] = { ...state, step: "waiting_thumbnail_retry" }
      await bot.sendMessage(chatId, `⚠️ Still failing: ${err.message}\n\n🔄 Send "retry" to try again or "skip" to continue without thumbnail`)
    }
    return
  }

  // ── Thumbnail approval ──
  if (state.step === "waiting_thumbnail_approval") {
    if (/^yes$/i.test(text)) {
      // Split script into chunks and start processing
      const { topic, rawScript, style, visualSuggestion } = state
      const chunks = splitScriptIntoChunks(rawScript)

      await bot.sendMessage(chatId, `📦 Script split into ${chunks.length} chunks (~1 min each)\n\nStarting chunk 1...`)

      userState[chatId] = { step: "processing_chunks", topic, rawScript, style, visualSuggestion, chunks, chunkPaths: [], currentChunk: 0, globalSceneIndex: 0, totalDuration: 0 }

      try {
        await processChunk(chatId, 0, chunks.length, await splitChunkIntoScenes(chunks[0]), style, visualSuggestion, 0, topic, rawScript)
      } catch (err) {
        if (err.message === "Stopped by user") return
        console.error("Chunk processing failed:", err)
        await bot.sendMessage(chatId, `❌ Failed: ${err.message}\n\nSend 'do it' to try again.`)
        userState[chatId] = {}
      }
      return
    }

    // User wants changes to thumbnail
    try {
      await bot.sendMessage(chatId, "🖼 Regenerating thumbnail with your feedback...")
      const thumbPrompt = await callClaude(
        `Modify this thumbnail concept based on user feedback. Write a new 100-word image prompt.
User feedback: ${text}
Keep it dramatic and eye-catching for YouTube.`,
        `Original topic: ${state.topic}`,
        400
      )
      const thumb = await generateImage(thumbPrompt.trim(), 999, chatId)
      userState[chatId] = { ...state, thumb }
      await bot.sendDocument(chatId, thumb.path, { caption: "🎨 Updated thumbnail" })
      await bot.sendMessage(chatId, `✅ Send "yes" to approve or describe more changes`)
    } catch (err) {
      await bot.sendMessage(chatId, `⚠️ Thumbnail redo failed: ${err.message}\nTry again or send "yes" to continue`)
    }
    return
  }

  // ── Presenter image approval ──
  if (state.step === "waiting_presenter_image_approval") {
    const { scenes, images, voices, lipSyncFlags, lipSyncVideos, globalSceneIndex, chunkIndex, totalChunks, style, visualSuggestion, presenterImgPath, presenterSceneIndex, presenterAbsIdx, presenterIsStudio, topic, rawScript, remainingSceneStart } = state

    if (/^yes$/i.test(text)) {
      // Approved — advance counter, generate lip sync + SFX, then continue remaining scenes
      advancePresenterCounter()
      try {
        await bot.sendMessage(chatId, `🎤 Generating presenter lip sync + SFX...`)
        const i = presenterSceneIndex
        const absIdx = presenterAbsIdx

        // Generate SFX
        let sfxVideoPath = null
        try {
          const presenterImgUrl = await uploadToReplicate(presenterImgPath, "image/jpeg")
          const sfxRes = await fetch("https://api.replicate.com/v1/models/kwaivgi/kling-v2.6/predictions", {
            method: "POST",
            headers: { Authorization: `Bearer ${REPLICATE_TOKEN}`, "Content-Type": "application/json" },
            body: JSON.stringify({
              input: { start_image: presenterImgUrl, prompt: "camera slowly pans across the scene, only environmental sounds, wind, machinery, nature, no human voices, no speech", negative_prompt: "human voice, speech, dialogue, talking, narration", duration: 5, aspect_ratio: "16:9", generate_audio: true }
            })
          })
          const sfxPred = await sfxRes.json()
          if (sfxPred.id) {
            const sfxResult = await withTimeout(pollReplicate(sfxPred.id, `SFX ${absIdx}`, chatId), `SFX ${absIdx}`)
            const sfxUrl = Array.isArray(sfxResult.output) ? sfxResult.output[0] : sfxResult.output
            sfxVideoPath = `/tmp/videos/presenter_sfx_${absIdx}.mp4`
            fs.writeFileSync(sfxVideoPath, await (await fetch(sfxUrl)).buffer())
          }
        } catch (e) { console.log(`SFX failed: ${e.message}`) }

        // Generate lip sync
        const vidPath = await generateLipSync(presenterImgPath, voices[i].voicePath, absIdx, chatId)
        lipSyncVideos[i] = { vidPath, sfxVideoPath, isStudio: presenterIsStudio }
        await bot.sendVideo(chatId, vidPath, { caption: `🎤 Presenter scene ${i + 1}` })

        // Continue processing remaining scenes
        for (let j = remainingSceneStart; j < scenes.length; j++) {
          if (isStopped(chatId)) throw new Error("Stopped by user")
          const s = scenes[j]
          const absJ = globalSceneIndex + j
          const isLipSync = isLipSyncScene(absJ)

          await bot.sendMessage(chatId, `📝 Scene ${j + 1} script:\n"${s.script}"`)

          if (isLipSync) {
            // Another presenter scene — pause for approval again
            const isStudio2 = isCurrentStudio()
            const sceneType2 = isStudio2 ? "studio" : "location"
            await bot.sendMessage(chatId, `🎤 Scene ${j + 1} — presenter (${sceneType2}), generating image...`)
            const voicePath2 = await generatePresenterVoice(s.script, absJ)
            const audioDuration2 = getDuration(voicePath2)
            voices.push({ voicePath: voicePath2, audioDuration: audioDuration2 })
            lipSyncFlags.push(true)
            const presenterImgPath2 = await generatePresenterImage(s.script, topic, isStudio2, chatId)
            await bot.sendDocument(chatId, presenterImgPath2, { caption: `📸 Presenter image (${sceneType2})` })
            images.push(null)
            userState[chatId] = {
              step: "waiting_presenter_image_approval",
              scenes, images, voices, lipSyncFlags, lipSyncVideos, globalSceneIndex, chunkIndex, totalChunks, style, visualSuggestion,
              presenterImgPath: presenterImgPath2, presenterSceneIndex: j, presenterAbsIdx: absJ, presenterIsStudio: isStudio2,
              topic, rawScript, remainingSceneStart: j + 1
            }
            await bot.sendMessage(chatId, `✅ Send "yes" to approve presenter image\n🔄 Send "redo" or "redo, suggestion here" to regenerate`)
            return
          } else {
            try {
              const voicePath2 = await generateVoice(s.script, absJ)
              const audioDuration2 = getDuration(voicePath2)
              voices.push({ voicePath: voicePath2, audioDuration: audioDuration2 })
              lipSyncFlags.push(false)
              const img = await generateImage(s.imagePrompt, absJ, chatId)
              images.push(img)
              await bot.sendMessage(chatId, `🖼 Full image prompt:\n\n${s.imagePrompt}${REALISM_STYLE_SUFFIX}`)
              await bot.sendDocument(chatId, img.path, { caption: `📸 Image ${j + 1} of ${scenes.length}` })
            } catch (err) {
              if (err.message === "Stopped by user") throw err
              await bot.sendMessage(chatId, `⚠️ Scene ${j + 1} failed: ${err.message}`)
              images.push(null)
              voices.push(null)
              lipSyncFlags.push(false)
            }
          }
        }

        // All scenes done — wait for chunk image approval
        userState[chatId] = { step: "waiting_chunk_image_approval", scenes, images, voices, lipSyncFlags, lipSyncVideos, globalSceneIndex, chunkIndex, totalChunks, style, visualSuggestion, topic, rawScript }
        await bot.sendMessage(chatId, `🖼 All images for chunk ${chunkIndex + 1} generated.\n\n✅ Send "yes" to approve\n🔄 Send "redo 2" or "redo 1,3" to regenerate`)
      } catch (err) {
        if (err.message === "Stopped by user") return
        console.error("Presenter approval continuation failed:", err)
        await bot.sendMessage(chatId, `⚠️ Failed: ${err.message}\n\nSend "yes" to retry from where it stopped`)
        // Don't clear state — keep it so user can retry
      }
      return
    }

    // Redo presenter image — with optional feedback
    const feedback = text.replace(/^redo\s*/i, "").replace(/^,\s*/, "").trim()
    try {
      await bot.sendMessage(chatId, `🔄 Regenerating presenter image...`)
      const newImgPath = await generatePresenterImage(
        feedback ? `${scenes[presenterSceneIndex].script}. ${feedback}` : scenes[presenterSceneIndex].script,
        topic, presenterIsStudio, chatId
      )
      await bot.sendDocument(chatId, newImgPath, { caption: `📸 Presenter image (redone)` })
      userState[chatId] = { ...state, presenterImgPath: newImgPath }
      await bot.sendMessage(chatId, `✅ Send "yes" to approve\n🔄 Send "redo" or "redo, suggestion" to regenerate`)
    } catch (err) {
      await bot.sendMessage(chatId, `⚠️ Redo failed: ${err.message}\n\nSend "redo" to try again or "yes" to skip`)
    }
    return
  }

  // ── Chunk image approval ──
  if (state.step === "waiting_chunk_image_approval") {
    const { scenes, images, voices, lipSyncFlags, lipSyncVideos, globalSceneIndex, chunkIndex, totalChunks, style, visualSuggestion } = state

    if (/^yes$/i.test(text)) {
      // Generate videos for this chunk (lip sync already done)
      try {
        await bot.sendMessage(chatId, `🎥 Generating videos for chunk ${chunkIndex + 1}...`)
        const videos = []

        for (let i = 0; i < scenes.length; i++) {
          if (isStopped(chatId)) { userState[chatId] = {}; return }
          const absIdx = globalSceneIndex + i

          if (lipSyncFlags[i]) {
            // LIP SYNC — already generated, just use it
            if (lipSyncVideos && lipSyncVideos[i]) {
              const lsData = lipSyncVideos[i]
              videos.push(typeof lsData === "string" ? lsData : lsData.vidPath)
              await bot.sendMessage(chatId, `🎤 Video ${i + 1}/${scenes.length} — presenter (already generated)`)
            } else {
              videos.push(null)
            }
          } else {
            // NORMAL SCENE — use Kling
            if (!images[i]) { videos.push(null); continue }
            try {
              await bot.sendMessage(chatId, `🎥 Video ${i + 1}/${scenes.length} — ${scenes[i].cameraName}...`)
              const vidPath = await generateVideo(images[i].url, images[i].path, scenes[i].motion, scenes[i].imagePrompt, absIdx, chatId)
              videos.push(vidPath)
              await bot.sendVideo(chatId, vidPath, { caption: `🎬 Video ${i + 1} of ${scenes.length}` })
            } catch (err) {
              if (err.message === "Stopped by user") { userState[chatId] = {}; return }
              // Auto-retry once
              console.log(`Video ${i + 1} failed, retrying: ${err.message}`)
              await bot.sendMessage(chatId, `⚠️ Video ${i + 1} failed, retrying...`)
              try {
                const vidPath = await generateVideo(images[i].url, images[i].path, scenes[i].motion, scenes[i].imagePrompt, absIdx, chatId)
                videos.push(vidPath)
                await bot.sendVideo(chatId, vidPath, { caption: `🎬 Video ${i + 1} of ${scenes.length} (retry)` })
              } catch (err2) {
                if (err2.message === "Stopped by user") { userState[chatId] = {}; return }
                await bot.sendMessage(chatId, `⚠️ Video ${i + 1} failed again: ${err2.message}`)
                videos.push(null)
              }
            }
          }
        }

        userState[chatId] = { ...userState[chatId], step: "waiting_chunk_video_approval", videos }
        await bot.sendMessage(chatId, `🎬 All videos for chunk ${chunkIndex + 1} generated.\n\n✅ Send "yes" to approve\n🔄 Send "redo 2" or "redo 1,3" to regenerate`)
      } catch (err) {
        if (err.message === "Stopped by user") return
        await bot.sendMessage(chatId, `❌ Failed: ${err.message}`)
        userState[chatId] = {}
      }
      return
    }

    // Redo images — with optional feedback like "redo 2, make it more dramatic"
    const redoMatch = text.match(/^redo\s+([\d,\s]+)(.*)/i)
    if (redoMatch) {
      const indices = redoMatch[1].split(/[,\s]+/).map(n => parseInt(n) - 1).filter(n => n >= 0 && n < scenes.length)
      const feedback = redoMatch[2] ? redoMatch[2].replace(/^[,\s]+/, "").trim() : ""
      try {
        for (const i of indices) {
          const absIdx = globalSceneIndex + i

          if (lipSyncFlags[i]) {
            // PRESENTER SCENE — redo image + lip sync video together
            await bot.sendMessage(chatId, `🔄 Redoing presenter scene ${i + 1}...`)
            const isStudio = (lipSyncVideos[i] && lipSyncVideos[i].isStudio) || false

            // If feedback, modify the presenter prompt approach
            if (feedback) {
              await bot.sendMessage(chatId, `💬 Applying feedback: ${feedback}`)
            }

            // Regenerate presenter image
            const presenterImgPath = await generatePresenterImage(
              feedback ? `${scenes[i].script}. ${feedback}` : scenes[i].script,
              state.topic || "", isStudio, chatId
            )
            await bot.sendDocument(chatId, presenterImgPath, { caption: `📸 Presenter image ${i + 1} (redone)` })

            // Regenerate lip sync video
            const vidPath = await generateLipSync(presenterImgPath, voices[i].voicePath, absIdx, chatId)

            // Generate SFX
            let sfxVideoPath = null
            try {
              const presenterImgUrl = await uploadToReplicate(presenterImgPath, "image/jpeg")
              const sfxRes = await fetch("https://api.replicate.com/v1/models/kwaivgi/kling-v2.6/predictions", {
                method: "POST",
                headers: { Authorization: `Bearer ${REPLICATE_TOKEN}`, "Content-Type": "application/json" },
                body: JSON.stringify({
                  input: { start_image: presenterImgUrl, prompt: "camera slowly pans across the scene, only environmental sounds, wind, machinery, nature, no human voices", negative_prompt: "human voice, speech, dialogue, talking", duration: 5, aspect_ratio: "16:9", generate_audio: true }
                })
              })
              const sfxPred = await sfxRes.json()
              if (sfxPred.id) {
                const sfxResult = await withTimeout(pollReplicate(sfxPred.id, `SFX redo`, chatId), `SFX redo`)
                const sfxUrl = Array.isArray(sfxResult.output) ? sfxResult.output[0] : sfxResult.output
                sfxVideoPath = `/tmp/videos/presenter_sfx_redo_${absIdx}.mp4`
                fs.writeFileSync(sfxVideoPath, await (await fetch(sfxUrl)).buffer())
              }
            } catch (e) { console.log(`Presenter SFX redo failed: ${e.message}`) }

            lipSyncVideos[i] = { vidPath, sfxVideoPath, isStudio }
            await bot.sendVideo(chatId, vidPath, { caption: `🎤 Presenter ${i + 1} (redone)` })
          } else {
            // NORMAL SCENE — redo image only
            let newPrompt = scenes[i].imagePrompt
            if (feedback) {
              newPrompt = await callClaude(
                `Modify this image prompt based on user feedback. Keep it SHORT (20-30 words max). Write ONLY the new prompt.
User feedback: ${feedback}`,
                `Original prompt: ${scenes[i].imagePrompt}`,
                100
              )
              newPrompt = newPrompt.trim().replace(/^["']|["']$/g, "")
              scenes[i].imagePrompt = newPrompt
              await bot.sendMessage(chatId, `🖼 Updated prompt: ${newPrompt}`)
            }
            await bot.sendMessage(chatId, `🔄 Regenerating image ${i + 1}...`)
            const img = await generateImage(newPrompt, absIdx, chatId)
            images[i] = img
            await bot.sendDocument(chatId, img.path, { caption: `📸 Image ${i + 1} (redone)` })
          }
        }
        userState[chatId] = { ...state, images, scenes, lipSyncVideos }
        await bot.sendMessage(chatId, `✅ Send "yes" to approve or "redo 2" to redo again`)
      } catch (err) {
        await bot.sendMessage(chatId, `⚠️ Redo failed: ${err.message}`)
      }
      return
    }

    await bot.sendMessage(chatId, `Send "yes" to approve or "redo 2" / "redo 1,3" to regenerate.`)
    return
  }

  // ── Chunk video approval ──
  if (state.step === "waiting_chunk_video_approval") {
    const { scenes, images, voices, videos, lipSyncFlags, lipSyncVideos, globalSceneIndex, chunkIndex, totalChunks, style, visualSuggestion } = state

    if (/^yes$/i.test(text)) {
      try {
        // Build this chunk
        await bot.sendMessage(chatId, `✂️ Building chunk ${chunkIndex + 1}...`)
        const scenePaths = []
        let chunkDuration = 0

        const validIndices = videos.map((v, i) => v && voices[i] ? i : -1).filter(i => i >= 0)
        for (const i of validIndices) {
          const absIdx = globalSceneIndex + i
          const { voicePath, audioDuration } = voices[i]

          if (lipSyncFlags && lipSyncFlags[i]) {
            // Lip sync scene — with SFX from Kling
            chunkDuration += audioDuration
            const sfxPath = lipSyncVideos && lipSyncVideos[i] && typeof lipSyncVideos[i] === "object" ? lipSyncVideos[i].sfxVideoPath : null
            scenePaths.push(buildLipSyncScene(videos[i], voicePath, audioDuration, absIdx, sfxPath))
          } else {
            // Normal scene — with pacing-based delay and SFX
            const pacing = scenes[i]?.pacing || "normal"
            const sceneDur = Math.max(TARGET_SCENE_SECONDS, audioDuration + getVoiceDelay(absIdx, pacing))
            chunkDuration += sceneDur
            scenePaths.push(buildScene(videos[i], voicePath, audioDuration, absIdx, pacing))
          }
        }

        const chunkVideo = concatScenes(scenePaths)
        const chunkPath = `/tmp/chunks/chunk_${chunkIndex}.mp4`
        fs.copyFileSync(chunkVideo, chunkPath)

        // Show chunk for approval
        await bot.sendVideo(chatId, chunkPath, { caption: `📦 Chunk ${chunkIndex + 1}/${totalChunks} (${chunkDuration.toFixed(1)}s)` })

        // Get parent state
        const parent = userState[chatId]
        const parentChunkPaths = parent.chunkPaths || []
        parentChunkPaths.push(chunkPath)
        const parentTotalDuration = (parent.totalDuration || 0) + chunkDuration

        userState[chatId] = {
          step: "waiting_chunk_approval",
          ...parent,
          chunkPaths: parentChunkPaths,
          totalDuration: parentTotalDuration,
          currentChunkDuration: chunkDuration
        }
        await bot.sendMessage(chatId, `📦 Chunk ${chunkIndex + 1} built (${chunkDuration.toFixed(1)}s)\nTotal so far: ${parentTotalDuration.toFixed(1)}s\n\n✅ Send "yes" to approve and continue to next chunk`)
      } catch (err) {
        console.error("Build chunk failed:", err)
        await bot.sendMessage(chatId, `❌ Build failed: ${err.message}`)
        userState[chatId] = {}
      }
      return
    }

    // Redo videos — with optional feedback like "redo 2, the camera should orbit around the tree"
    const redoMatch = text.match(/^redo\s+([\d,\s]+)(.*)/i)
    if (redoMatch) {
      const indices = redoMatch[1].split(/[,\s]+/).map(n => parseInt(n) - 1).filter(n => n >= 0 && n < scenes.length)
      const feedback = redoMatch[2] ? redoMatch[2].replace(/^[,\s]+/, "").trim() : ""
      try {
        for (const i of indices) {
          const absIdx = globalSceneIndex + i
          if (lipSyncFlags && lipSyncFlags[i]) {
            await bot.sendMessage(chatId, `🔄 Regenerating presenter scene ${i + 1}...`)
            const isStudio = (presenterAppearanceCount - 1) % 4 === 3 // check if last was studio
            const presenterImgPath = await generatePresenterImage(scenes[i].script, state.topic || "", isStudio, chatId)
            const vidPath = await generateLipSync(presenterImgPath, voices[i].voicePath, absIdx, chatId)
            videos[i] = vidPath
            await bot.sendVideo(chatId, vidPath, { caption: `🎤 Presenter ${i + 1} (redone)` })
          } else {
            if (!images[i]) continue
            let motionPrompt = scenes[i].motion
            if (feedback) {
              motionPrompt = feedback
              await bot.sendMessage(chatId, `🎥 Using custom motion: ${feedback}`)
            }
            await bot.sendMessage(chatId, `🔄 Regenerating video ${i + 1}...`)
            const vidPath = await generateVideo(images[i].url, images[i].path, motionPrompt, scenes[i].imagePrompt, absIdx, chatId)
            videos[i] = vidPath
            await bot.sendVideo(chatId, vidPath, { caption: `🎬 Video ${i + 1} (redone)` })
          }
        }
        userState[chatId] = { ...state, videos }
        await bot.sendMessage(chatId, `✅ Send "yes" to approve or "redo 2" to redo again`)
      } catch (err) {
        await bot.sendMessage(chatId, `⚠️ Redo failed: ${err.message}`)
      }
      return
    }

    await bot.sendMessage(chatId, `Send "yes" to approve or "redo 2" / "redo 1,3" to regenerate.`)
    return
  }

  // ── Chunk built — approval to continue ──
  if (state.step === "waiting_chunk_approval") {
    if (/^yes$/i.test(text)) {
      const { chunks, chunkPaths, currentChunk, globalSceneIndex, style, visualSuggestion, totalDuration, topic, rawScript } = state
      const nextChunk = (currentChunk || 0) + 1
      const scenesInLastChunk = (await splitChunkIntoScenes(chunks[currentChunk || 0])).length
      const nextGlobalIndex = globalSceneIndex + scenesInLastChunk

      if (nextChunk >= chunks.length) {
        // ALL CHUNKS DONE — ask for music choice
        const fullVideo = concatChunks(chunkPaths)

        userState[chatId] = { step: "waiting_music_choice", topic, rawScript, fullVideo, totalDuration, chunkPaths }
        await bot.sendMessage(chatId, `🎬 All ${chunks.length} chunks complete! Total: ${totalDuration.toFixed(1)}s\n\n🎵 Which music?\n\n1. Hopeful\n2. Suspense\n3. Space\n\nSend 1, 2, or 3`)
        return
      }

      // Process next chunk
      try {
        await bot.sendMessage(chatId, `\n📦 Starting chunk ${nextChunk + 1}/${chunks.length}...`)
        userState[chatId] = { ...state, currentChunk: nextChunk, globalSceneIndex: nextGlobalIndex }

        await processChunk(chatId, nextChunk, chunks.length, await splitChunkIntoScenes(chunks[nextChunk]), style, visualSuggestion, nextGlobalIndex, topic, rawScript)
      } catch (err) {
        if (err.message === "Stopped by user") return
        await bot.sendMessage(chatId, `❌ Failed: ${err.message}`)
        userState[chatId] = {}
      }
      return
    }

    await bot.sendMessage(chatId, `Send "yes" to approve chunk and continue.`)
    return
  }

  // ── Music choice ──
  if (state.step === "waiting_music_choice") {
    const choice = parseInt(text)
    if (choice >= 1 && choice <= 3) {
      const { topic, rawScript, fullVideo, totalDuration } = state
      try {
        const musicName = MUSIC_OPTIONS[choice - 1].name
        await bot.sendMessage(chatId, `🎵 Adding ${musicName} music with ducking...`)
        const musicPath = await downloadMusicByChoice(choice)
        const finalVideo = addMusicHD(fullVideo, musicPath, totalDuration)

        await bot.sendVideo(chatId, finalVideo, {
          width: 1280, height: 720,
          caption: `🎬 Final video (${totalDuration.toFixed(1)}s) | 🎵 ${musicName}\n🎤 Voice 100% | 🔊 SFX 15% | 🎵 Music (ducked)`
        })
        await bot.sendDocument(chatId, finalVideo, { caption: `📁 HD file (YouTube-ready)` })

        userState[chatId] = { step: "waiting_youtube_meta", topic, rawScript }
        await bot.sendMessage(chatId, `✅ Video complete!\n\n📝 Want me to generate YouTube title, description, and tags?\n\nSend "yes" or "no"`)
      } catch (err) {
        console.error("Music/assembly failed:", err)
        await bot.sendMessage(chatId, `❌ Failed: ${err.message}\n\nTry again: send 1, 2, or 3`)
      }
      return
    }
    await bot.sendMessage(chatId, `🎵 Which music?\n\n1. Hopeful\n2. Suspense\n3. Space\n\nSend 1, 2, or 3`)
    return
  }

  // ── YouTube metadata ──
  if (state.step === "waiting_youtube_meta") {
    if (/^yes$/i.test(text)) {
      try {
        await bot.sendMessage(chatId, "📝 Generating YouTube metadata...")
        const meta = await callClaude(
          `Generate YouTube metadata for this video. Return ONLY valid JSON:
{
  "title": "catchy YouTube title under 70 characters — mysterious, intriguing, makes people click",
  "description": "YouTube description 150-300 words: hook in first 2 lines, summary of what the video covers, call to action to subscribe and like, relevant hashtags at the end",
  "tags": "comma-separated list of 15-20 relevant YouTube tags for SEO"
}`,
          `Topic: ${state.topic}\nScript: ${state.rawScript.slice(0, 1500)}`,
          1000
        )
        const parsed = safeJSON(meta)
        await bot.sendMessage(chatId, `📝 **Title:**\n${parsed.title}\n\n📝 **Description:**\n${parsed.description}\n\n🏷 **Tags:**\n${parsed.tags}`)

        userState[chatId] = { step: "waiting_meta_approval", ...state, meta: parsed }
        await bot.sendMessage(chatId, `✅ Send "yes" to approve or describe changes`)
      } catch (err) {
        await bot.sendMessage(chatId, `⚠️ Metadata generation failed: ${err.message}\nSend "yes" to retry or "no" to skip`)
      }
      return
    }

    if (/^no$/i.test(text)) {
      await bot.sendMessage(chatId, "✅ All done! Send 'do it' for another video.")
      userState[chatId] = {}
      return
    }
    return
  }

  // ── Meta approval ──
  if (state.step === "waiting_meta_approval") {
    if (/^yes$/i.test(text)) {
      await bot.sendMessage(chatId, "✅ All done! Metadata approved. Send 'do it' for another video.")
      userState[chatId] = {}
      return
    }

    // User wants changes
    try {
      const meta = await callClaude(
        `Modify this YouTube metadata based on user feedback. Return ONLY valid JSON with title, description, tags.
User feedback: ${text}`,
        `Original topic: ${state.topic}\nCurrent metadata: ${JSON.stringify(state.meta)}`,
        1000
      )
      const parsed = safeJSON(meta)
      await bot.sendMessage(chatId, `📝 **Title:**\n${parsed.title}\n\n📝 **Description:**\n${parsed.description}\n\n🏷 **Tags:**\n${parsed.tags}`)
      userState[chatId] = { ...state, meta: parsed }
      await bot.sendMessage(chatId, `✅ Send "yes" to approve or describe more changes`)
    } catch (err) {
      await bot.sendMessage(chatId, `⚠️ Failed: ${err.message}`)
    }
    return
  }

  // ── TYPO PROTECTION — unrecognized input, re-show current step options ──
  const stepMessages = {
    "waiting_input": `Send a theme, article link, or paste any text.`,
    "waiting_script_approval": `✅ Send "ok" to continue\n🔄 "redo" for a new script\n💬 Or send feedback`,
    "waiting_visual_suggestion": `🎨 Send visual suggestions or "none" to skip.`,
    "waiting_thumbnail_approval": `✅ Send "yes" to approve thumbnail\n🔄 Describe changes you want`,
    "waiting_thumbnail_retry": `🔄 Send "retry" to try again or "skip" to continue without thumbnail`,
    "waiting_presenter_image_approval": `✅ Send "yes" to approve presenter image\n🔄 Send "redo" or "redo, suggestion" to regenerate`,
    "waiting_chunk_image_approval": `✅ Send "yes" to approve\n🔄 Send "redo 2" or "redo 1,3" to regenerate`,
    "waiting_chunk_video_approval": `✅ Send "yes" to approve\n🔄 Send "redo 2" or "redo 1,3" to regenerate`,
    "waiting_chunk_approval": `✅ Send "yes" to approve chunk and continue`,
    "waiting_music_choice": `🎵 Which music?\n\n1. Hopeful\n2. Suspense\n3. Space\n\nSend 1, 2, or 3`,
    "waiting_youtube_meta": `📝 Send "yes" to generate YouTube metadata or "no" to skip`
  }
  const hint = stepMessages[state.step]
  if (hint) {
    await bot.sendMessage(chatId, `❓ Didn't understand "${text}"\n\n${hint}`)
  }
})
