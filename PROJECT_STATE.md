PROJECT: Telegram AI Video Automation Bot

GOAL:
Fully automated system that:
- Takes theme / link / text from Telegram
- Generates 10-minute documentary video
- Sends final video back to Telegram
- Uses NO permanent storage (only /tmp)

---

CURRENT STATUS:

✅ Telegram bot working on Railway
✅ Google Drive REMOVED
✅ /tmp pipeline implemented
✅ Basic pipeline working (script → images → videos → audio → ffmpeg → send)
⚠️ Video step sometimes FAILS (ffmpeg or temp issue)
⚠️ Script is FAKE (not using OpenAI yet)
⚠️ No scene-based logic yet (everything bulk, not sequential)

---

PIPELINE (CURRENT):

1. Telegram receives: "do it"
2. Bot replies: "Send theme / link / text"
3. User sends input
4. Bot:
   - generateScript() (fake)
   - generate images (random)
   - generate videos (ffmpeg loop)
   - generate fake audio
   - merge everything
   - send video
5. Clean /tmp

---

PIPELINE (TARGET — IMPORTANT):

1. Generate FULL 10-minute script (OpenAI)
2. Split into 120 scenes
3. For EACH scene:
   - narration text
   - image prompt
   - generate image
   - generate 5s video
4. Generate full narration audio
5. Merge clips sequentially
6. Add music
7. Send final video
8. Delete everything (/tmp)

---

TECH STACK:

- Node.js
- Railway (hosting)
- Telegram Bot API
- OpenAI (script generation)
- Replicate (image generation)
- Kling (video generation)
- ElevenLabs (voice)
- FFMPEG (merge)

---

KNOWN ISSUES:

- Railway must be the ONLY running instance (no local run at same time)
- 409 error happens if multiple instances
- ffmpeg errors can break pipeline
- large video may need chunking later

---

NEXT STEP:

👉 Replace fake script with REAL OpenAI script
👉 Implement scene-by-scene pipeline (NOT bulk)
👉 Generate image prompt per scene
👉 Improve error handling

---

RULES:

- NEVER use Google Drive again
- NEVER store files permanently
- ALWAYS use /tmp
- ALWAYS delete after processing
- NEVER run bot locally + Railway at same time