# Wisdom Vault 🎧✨

A Chrome Extension that captures podcast insights from Spotify with AI-powered transcription and summarization.

## Features

- 🎯 **One-Click Capture**: Save insights directly from Spotify Web Player
- 🔍 **Smart Search**: Uses Listen Notes API to find podcast episodes
- 🎙️ **AI Transcription**: OpenAI Whisper for accurate transcription
- ✨ **Smart Summaries**: GPT-4o-mini generates 3 key takeaways
- 📝 **Notion Integration**: Automatically saves to your Notion database
- 📊 **Logging**: Tracks all captures in Supabase

## Project Structure

```
wisdom-vault/
├── extension/           # Chrome Extension (Manifest V3)
│   ├── manifest.json
│   ├── popup.html       # Beautiful Tailwind CSS UI
│   ├── popup.js
│   ├── content_script.js
│   ├── background.js
│   └── icons/
│
├── server/              # Node.js/Express Backend
│   ├── server.js
│   ├── package.json
│   ├── env.example
│   └── supabase-schema.sql
│
└── README.md
```

## Quick Start

### 1. Set Up the Backend

```bash
cd server
npm install
cp env.example .env
# Edit .env with your API keys
npm run dev
```

### 2. Load the Chrome Extension

1. Open Chrome → `chrome://extensions/`
2. Enable **Developer mode** (top right)
3. Click **Load unpacked** → select the `extension` folder
4. Add icon images (16px, 48px, 128px) to `extension/icons/`

### 3. Configure APIs

You'll need:
- **OpenAI API Key** - [platform.openai.com](https://platform.openai.com)
- **Listen Notes API Key** - [listennotes.com/api](https://www.listennotes.com/api/)
- **Notion Integration** - [notion.so/my-integrations](https://www.notion.so/my-integrations)
- **Supabase Project** - [supabase.com](https://supabase.com)

### 4. Use It!

1. Go to [open.spotify.com](https://open.spotify.com)
2. Play a podcast episode
3. Click the Wisdom Vault extension icon
4. Click **Save Insight**

## How It Works

```
┌─────────────────────────────────────────────────────────────┐
│                     WISDOM VAULT FLOW                        │
└─────────────────────────────────────────────────────────────┘

1. User clicks "Save Insight" on Spotify
           │
           ▼
2. Content Script extracts:
   • Episode title
   • Show name  
   • Current timestamp
           │
           ▼
3. Backend searches Listen Notes for the episode
           │
           ▼
4. Hybrid Transcription:
   ┌──────────────────────────────────────┐
   │ Listen Notes has transcript?         │
   │                                      │
   │   YES ──► Use existing transcript    │
   │                                      │
   │   NO  ──► Download audio (yt-dlp)    │
   │           Crop 30s snippet (ffmpeg)  │
   │           Transcribe (Whisper)       │
   └──────────────────────────────────────┘
           │
           ▼
5. GPT-4o-mini summarizes into 3 bullets
           │
           ▼
6. Save to Notion + Log to Supabase
```

## Prerequisites

- Node.js 18+
- yt-dlp: `brew install yt-dlp`
- ffmpeg: `brew install ffmpeg`

## License

MIT

