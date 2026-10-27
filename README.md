# Telegram Clipper 🎬✂️

Production-oriented Telegram bot that turns YouTube videos into podcast-ready 4K vertical shorts (2160×3840, 9:16) with an advanced, data-driven **Kinetic Caption Engine**.

---

## What's New in Phase 5.1: GPU Acceleration & High-Performance Pipeline ⚡🚀

- **Deterministic CUDA 12 & cuDNN 9 GPU Transcription**:
  - Direct integration with official NVIDIA CUDA 12 runtime wheels (`nvidia-cublas-cu12`, `nvidia-cudnn-cu12`, `nvidia-cuda-nvrtc-cu12`).
  - Completely fixes the Windows runtime error: `Library cublas64_12.dll is not found or cannot be loaded`.
  - Self-diagnosing GPU startup verification with structured logging:
    `[GPU TRANSCRIPTION] device=cuda compute_type=float16 model=large-v3`
  - High-performance VAD filtering (`vad_filter=True`, `min_silence_duration_ms=300`) with word-level micro-timestamps.
  - Automatic model caching relocated to `assets/hf_cache` on `D:` drive to prevent exhausting space-constrained `C:` system partitions.
- **NVIDIA NVENC Hardware Video Encoding (`h264_nvenc`)**:
  - Live probe resolution calibrated to $256\times 256$, enabling auto-detection of NVIDIA NVENC on the RTX 3050 Laptop GPU.
  - Generates 4K vertical masters ($2160\times 3840$, 9:16) at **1.63x realtime** (~49 FPS).
- **Sub-30-Second End-to-End Turnaround**:
  - 15-second podcast clip with AI transcription (`large-v3`), 4K kinetic ASS caption generation, and NVENC render completes in **22.0 seconds** (down from 10–14 minutes!).
- **System Health Check (`npm run diagnose`)**:
  - Comprehensive diagnostic CLI reporting Python, faster-whisper, CTranslate2, GPU hardware, VRAM, NVIDIA drivers, CUDA runtime DLLs, and NVENC encoder readiness.
- **Reproducible Setup Script (`scripts/setup-transcription.ps1`)**:
  - One-click setup script to provision the isolated `.venv`, install faster-whisper, download NVIDIA CUDA 12 wheels, and verify the GPU environment.

---

## What's New in Phase 5: Podcast Caption System V2 🎙️✨

- **Podcast Caption Composition Engine (`podcastComposition.js`)**:
  - Replaces generic subtitle segmenters with an editorial podcast beat composer.
  - Generates natural **1–4 word high-energy visual beats** paced by speech rhythm, pauses ($\ge 0.25$s), and syntactic boundaries.
  - **Single-Word Punch (Climax Isolation)**: High-impact climax words (e.g. `REPLACED`, `AI`, `SECRET`, `MASSIVE`, `10X`) automatically break out into their own visual beat with 1.25–1.35x font scaling, preset accent color, and micro-shake.
  - **Balanced Two-Line Stacking**: Contrasting phrases (e.g. `NOW` / `HUGE`, `BEING` / `REPLACED`, `BUILDING` / `MASSIVE WEALTH`) format into balanced, stacked lines (`\N`) avoiding awkward orphans.
- **Emphasis Engine V2 (`captionEmphasis.js`)**:
  - Deterministic multi-signal scoring: numeric/currency, superlatives (`-EST`), impact verbs, strong nouns, contrast markers, and sentence-final punctuation.
  - Graded intensity levels: `NONE`, `SUBTLE`, `MEDIUM`, `STRONG`, and `PUNCH`.
  - Guarantees salient accent highlight per beat in keyword modes without over-saturation.
- **Kinetic Animation System V2 (`captionAnimation.js`)**:
  - **Punch Overshoot Easing**: Polished 4-stage temporal scale progression ($1.00 \rightarrow 1.14 \rightarrow 1.06 \rightarrow 1.00$) over spoken duration.
  - **Deterministic Micro-Shake**: Subtle rotational wobble ($-1.2^\circ \rightarrow +1.2^\circ \rightarrow -0.6^\circ \rightarrow 0^\circ$) without random jitter.
  - **Entrances & Exits**: Elastic pop, zoom-in, directional slides (`slide-up`, `slide-down`, `slide-left`, `slide-right`), and smooth fades.
- **UI-Safe Canvas Positioning (`captionPositioning.js`)**:
  - Coordinates vertical margin ($Y \approx 2740$ on $2160\times 3840$ canvas) safely clearing Reels, Shorts, and TikTok bottom controls.
  - Extensible architecture supporting future face-tracking and speaker safe regions.
- **5 Production-Quality Presets (`captionStyles.js`)**:
  1. 🎙 **Podcast Pro (Flagship)**: Montserrat Black 145pt, pure white with electric cyan (`#00E5FF`) punch words, elastic pop entrance, overshoot punch, and micro-shake.
  2. 🔥 **Viral**: Impact 165pt, electric volt lime (`#CCFF00`), zoom-in entrance, fast cadence, aggressive scale pops.
  3. ⚡ **Karaoke**: Arial Black 135pt, glowing neon orange (`#FF9100`) active word, dimmed background words (`#777777`), smooth progressive tracking.
  4. 💥 **Punch**: Montserrat Black 155pt, vivid crimson red (`#FF2A55`) climax words, slide-up entrances, intense micro-shake ($1.5\times$).
  5. 🧼 **Clean**: Segoe UI Black 125pt, restrained editorial elegance, warm gold accent (`#FFD700`), balanced two-line layout, zero jitter.
- **Broadcast-Grade 4K ASS Generation (`assGenerator.js`)**:
  - Generates 4K native subtitles (`PlayResX: 2160`, `PlayResY: 3840`) with heavy 10–16px outlines and 6–10px drop shadows for razor-sharp legibility across all backgrounds.

---

## Project Structure

```
telegram-clipper/
├── .env.example               # Environment variables template
├── .gitignore                 # Git ignore (excludes .env, node_modules, temp/, .venv/)
├── package.json               # Node.js manifest and scripts
├── README.md                  # Documentation and setup guide
├── index.js                   # Root entry point
├── assets/
│   └── fonts/                 # Custom font directory for FFmpeg libass
├── python/
│   └── transcription.py       # faster-whisper word-level transcription worker
└── src/
    ├── index.js               # Application bootstrap & lifecycle
    ├── bot/
    │   └── bot.js             # Telegraf initialization & action routing
    ├── config/
    │   └── env.js             # Environment validation and config loader
    ├── handlers/
    │   ├── startHandler.js    # /start & /help command handlers
    │   ├── clipHandler.js     # /clip workflow, text routing, and /cancel handler
    │   └── callbackHandler.js # Captions YES/NO and dynamic style selector
    ├── services/
    │   ├── youtubeDownloader.js # yt-dlp wrapper with argument arrays & timeout
    │   ├── videoProcessor.js  # FFmpeg 2160x3840 4K center-crop, CRF 18, and ffprobe
    │   ├── clipService.js     # Master job orchestrator & progress dispatcher
    │   ├── transcription/
    │   │   └── transcriptionService.js # Audio extraction & faster-whisper runner
    │   └── captions/
    │       ├── captionEngine.js     # High-level caption pipeline
    │       ├── captionStyles.js     # Data-driven style registry (5 presets)
    │       ├── captionSegmenter.js  # 3-5 word intelligent cadence grouping
    │       ├── captionEmphasis.js   # Deterministic keyword scoring
    │       ├── captionAnimation.js  # Kinetic ASS tags (pop, grow, shake, fade)
    │       ├── assGenerator.js      # Programmatic 4K ASS file generator
    │       └── captionRenderer.js   # FFmpeg libass caption burning
    ├── session/
    │   └── sessionStore.js    # In-memory session store & state transitions
    └── utils/
        ├── logger.js          # Structured logger with token redaction
        └── validator.js       # YouTube URL & timestamp validation logic
```

---

## Prerequisites

- **Node.js**: v18.0.0 or higher (v25 recommended)
- **Python**: 3.13 with `py` launcher available
- **FFmpeg & FFprobe**: Installed and in system `PATH` (compiled with `libass`, standard in Gyan/MSYS builds)
- A **Telegram Bot Token** from [@BotFather](https://t.me/botfather)

---

## Installation & Setup

1. **Install Node.js dependencies:**
   ```bash
   npm install
   ```

2. **Configure Python Virtual Environment:**
   The project uses an isolated Python virtual environment (`.venv`) for faster-whisper:
   ```powershell
   py -3.13 -m venv .venv
   .\.venv\Scripts\pip.exe install faster-whisper
   ```

3. **Configure Environment Variables:**
   Copy `.env.example` to `.env`:
   ```env
   TELEGRAM_BOT_TOKEN=your_token_from_botfather
   NODE_ENV=development

   # Optional: Whisper Model Configuration (tiny, base, small, medium, large-v3)
   WHISPER_MODEL=base
   WHISPER_DEVICE=auto
   WHISPER_COMPUTE_TYPE=auto
   ```

4. **Start the Bot:**
   ```powershell
   # Development mode with auto-reload:
   npm run dev

   # Production mode:
   npm start
   ```

---

## Manual Test Procedure

### Flow A: 4K Short WITH Kinetic Captions
1. Send `/clip` to your bot.
2. Send a valid YouTube URL.
3. Send start timestamp: `00:10`
4. Send end timestamp: `00:25`
5. Choose **YES** for captions.
6. Select any style preset (e.g. **🎙 Podcast Pro** or **🔥 Viral**).
7. Watch real-time status updates:
   - `⬇️ Downloading video (fetching highest quality)...`
   - `✂️ Clipping and converting to 2160×3840 vertical video...`
   - `🎙 Transcribing audio with AI (faster-whisper)...`
   - `✨ Rendering kinetic captions (Podcast Pro)...`
   - `📤 Preparing 4K vertical clip for Telegram...`
8. Receive the final 4K MP4 with crisp kinetic captions burned into the video!

### Flow B: 4K Short WITHOUT Captions
- At the captions prompt, click **NO** to export the pure uncaptioned 4K vertical clip.

---

## Caption Preset Customization Guide 🎨

All presets are fully data-driven in `src/services/captions/captionStyles.js`.

### How to Customize an Existing Preset
Modify properties in `CAPTION_PRESETS` in [`src/services/captions/captionStyles.js`](file:///d:/telegram-clipper/src/services/captions/captionStyles.js):
```javascript
{
  id: 'podcast-pro',
  name: 'Podcast Pro',
  icon: '🎙',
  typography: {
    fontFamily: 'Montserrat Black',
    fontSize: 145,               // 4K canvas scale (120 - 170)
    letterSpacing: 2,
    uppercase: true,
  },
  colors: {
    primary: '#FFFFFF',          // Base text
    highlight: '#00E5FF',        // Climax punch accent (Electric Cyan)
    secondary: '#D0D0D0',
  },
  stroke: { width: 14, color: '#000000' },
  shadow: { enabled: true, depth: 8, color: '#000000', opacity: 0.75 },
  animation: {
    mode: 'keyword',             // 'keyword' | 'karaoke' | 'phrase' | 'none'
    entrance: 'pop',             // 'pop' | 'zoom-in' | 'slide-up' | 'fade'
    emphasis: ['punch', 'shake'],// 'punch' (4-stage overshoot) | 'grow' | 'shake'
    singleWordPunch: true,       // Break out punch words into isolated beats
    growScale: 1.15,
    punchGrowScale: 1.25,
    shakeIntensity: 0.8,
    exit: 'fade',
  },
}
```

### How to Add a New Preset
1. Append your new style definition to `CAPTION_PRESETS` in `src/services/captions/captionStyles.js`.
2. The interactive Telegram inline buttons automatically derive from `listCaptionStyles()`, so your new preset will immediately appear in the bot UI without any handler modifications!

