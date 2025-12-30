/**
 * Wisdom Vault - Backend Server
 * 
 * Handles podcast insight processing with:
 * - Listen Notes API for podcast search
 * - yt-dlp + ffmpeg for audio extraction
 * - OpenAI Whisper for transcription
 * - GPT-4o-mini for summarization
 * - Notion for storage
 * - Supabase for logging
 */

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const { exec } = require('child_process');
const { promisify } = require('util');
const fs = require('fs').promises;
const path = require('path');
const { Client } = require('@notionhq/client');
const { createClient } = require('@supabase/supabase-js');
const FormData = require('form-data');
const { createReadStream } = require('fs');

const execAsync = promisify(exec);

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors({
  origin: ['chrome-extension://*', 'http://localhost:*'],
  credentials: true
}));
app.use(express.json());

// Initialize clients
const notion = new Client({ auth: process.env.NOTION_API_KEY });
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

// Temp directory for audio files
const TEMP_DIR = path.join(__dirname, 'temp');

// Ensure temp directory exists
async function ensureTempDir() {
  try {
    await fs.mkdir(TEMP_DIR, { recursive: true });
  } catch (error) {
    // Directory already exists
  }
}

// Clean up temp files
async function cleanupTempFiles(files) {
  for (const file of files) {
    try {
      await fs.unlink(file);
    } catch (error) {
      console.error(`Failed to delete temp file ${file}:`, error.message);
    }
  }
}

/**
 * Search Listen Notes API for podcast episode
 */
async function searchListenNotes(title, showName) {
  const query = `${title} ${showName}`.trim();
  
  try {
    const response = await axios.get('https://listen-api.listennotes.com/api/v2/search', {
      headers: {
        'X-ListenAPI-Key': process.env.LISTENNOTES_API_KEY
      },
      params: {
        q: query,
        type: 'episode',
        len_min: 1,
        sort_by_date: 0
      }
    });
    
    if (response.data.results && response.data.results.length > 0) {
      const episode = response.data.results[0];
      return {
        id: episode.id,
        title: episode.title_original,
        showName: episode.podcast?.title_original || showName,
        audioUrl: episode.audio,
        thumbnail: episode.thumbnail,
        description: episode.description_original,
        hasTranscript: episode.transcript ? true : false,
        transcript: episode.transcript || null
      };
    }
    
    return null;
  } catch (error) {
    console.error('Listen Notes API error:', error.message);
    throw new Error('Failed to search for podcast episode');
  }
}

/**
 * Get episode details with transcript from Listen Notes
 */
async function getEpisodeTranscript(episodeId) {
  try {
    const response = await axios.get(`https://listen-api.listennotes.com/api/v2/episodes/${episodeId}`, {
      headers: {
        'X-ListenAPI-Key': process.env.LISTENNOTES_API_KEY
      },
      params: {
        show_transcript: 1
      }
    });
    
    if (response.data.transcript) {
      return response.data.transcript;
    }
    
    return null;
  } catch (error) {
    console.error('Failed to get episode transcript:', error.message);
    return null;
  }
}

/**
 * Extract transcript segment at timestamp
 */
function extractTranscriptSegment(transcript, timestampSeconds, duration = 30) {
  // Transcript format varies - try to parse and extract relevant segment
  if (typeof transcript === 'string') {
    // Simple text transcript - just return a portion
    const words = transcript.split(' ');
    const approximateWordIndex = Math.floor((timestampSeconds / 60) * 150); // ~150 words per minute
    const startIndex = Math.max(0, approximateWordIndex - 25);
    const endIndex = Math.min(words.length, approximateWordIndex + 75);
    return words.slice(startIndex, endIndex).join(' ');
  }
  
  // Structured transcript with timestamps
  if (Array.isArray(transcript)) {
    const relevantSegments = transcript.filter(seg => {
      const segStart = seg.start_time || seg.start || 0;
      const segEnd = seg.end_time || seg.end || segStart + 5;
      return segStart >= timestampSeconds - 5 && segEnd <= timestampSeconds + duration + 5;
    });
    
    return relevantSegments.map(seg => seg.text || seg.words || '').join(' ');
  }
  
  return null;
}

/**
 * Download and crop audio using yt-dlp and ffmpeg
 */
async function extractAudioSnippet(audioUrl, timestampSeconds, duration = 30) {
  await ensureTempDir();
  
  const timestamp = Date.now();
  const tempAudioPath = path.join(TEMP_DIR, `audio_${timestamp}.mp3`);
  const snippetPath = path.join(TEMP_DIR, `snippet_${timestamp}.mp3`);
  
  try {
    // Calculate start time (5 seconds before to capture context)
    const startTime = Math.max(0, timestampSeconds - 5);
    const totalDuration = duration + 10; // Extra buffer
    
    // Use yt-dlp to download audio segment
    // Note: yt-dlp has limited support for podcast audio URLs, may need direct download
    try {
      // First try yt-dlp (works for some podcast hosts)
      await execAsync(
        `yt-dlp -x --audio-format mp3 --postprocessor-args "-ss ${startTime} -t ${totalDuration}" -o "${tempAudioPath}" "${audioUrl}"`,
        { timeout: 60000 }
      );
    } catch (ytdlpError) {
      // Fallback: Direct download with curl + ffmpeg processing
      console.log('yt-dlp failed, trying direct download...');
      
      // Download full audio (or range if server supports it)
      await execAsync(
        `curl -L -o "${tempAudioPath}" "${audioUrl}"`,
        { timeout: 120000 }
      );
      
      // Use ffmpeg to extract the snippet
      await execAsync(
        `ffmpeg -y -ss ${startTime} -i "${tempAudioPath}" -t ${totalDuration} -c:a libmp3lame -q:a 4 "${snippetPath}"`,
        { timeout: 60000 }
      );
      
      // Clean up full audio
      await fs.unlink(tempAudioPath).catch(() => {});
      
      return snippetPath;
    }
    
    // If yt-dlp succeeded, the file is at tempAudioPath
    // Rename to snippetPath for consistency
    await fs.rename(tempAudioPath, snippetPath);
    
    return snippetPath;
  } catch (error) {
    // Clean up on error
    await cleanupTempFiles([tempAudioPath, snippetPath]);
    console.error('Audio extraction error:', error.message);
    throw new Error('Failed to extract audio snippet');
  }
}

/**
 * Transcribe audio using OpenAI Whisper API
 */
async function transcribeWithWhisper(audioPath) {
  try {
    const formData = new FormData();
    formData.append('file', createReadStream(audioPath));
    formData.append('model', 'whisper-1');
    formData.append('response_format', 'text');
    
    const response = await axios.post(
      'https://api.openai.com/v1/audio/transcriptions',
      formData,
      {
        headers: {
          'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
          ...formData.getHeaders()
        },
        maxContentLength: Infinity,
        maxBodyLength: Infinity
      }
    );
    
    return response.data;
  } catch (error) {
    console.error('Whisper API error:', error.response?.data || error.message);
    throw new Error('Failed to transcribe audio');
  }
}

/**
 * Summarize transcript using GPT-4o-mini
 */
async function summarizeTranscript(transcript, title) {
  try {
    const response = await axios.post(
      'https://api.openai.com/v1/chat/completions',
      {
        model: 'gpt-4o-mini',
        messages: [
          {
            role: 'system',
            content: 'You are a helpful assistant that summarizes podcast insights. Create exactly 3 concise bullet points that capture the key takeaways from the transcript. Each bullet should be actionable or insightful. Keep each bullet under 100 characters.'
          },
          {
            role: 'user',
            content: `Podcast Episode: "${title}"\n\nTranscript segment:\n${transcript}\n\nProvide 3 bullet point takeaways:`
          }
        ],
        temperature: 0.7,
        max_tokens: 300
      },
      {
        headers: {
          'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
          'Content-Type': 'application/json'
        }
      }
    );
    
    const content = response.data.choices[0].message.content;
    
    // Parse bullet points
    const bullets = content
      .split('\n')
      .filter(line => line.trim().match(/^[-•*]\s/) || line.trim().match(/^\d+\.\s/))
      .map(line => line.replace(/^[-•*\d.]\s*/, '').trim())
      .slice(0, 3);
    
    return bullets.length > 0 ? bullets : [content.trim()];
  } catch (error) {
    console.error('GPT summarization error:', error.response?.data || error.message);
    throw new Error('Failed to summarize transcript');
  }
}

/**
 * Save to Supabase for logging
 */
async function logToSupabase(data) {
  try {
    const { error } = await supabase
      .from('wisdom_vault_logs')
      .insert({
        title: data.title,
        show_name: data.showName,
        timestamp_seconds: data.timestamp,
        spotify_url: data.spotifyUrl,
        created_at: new Date().toISOString()
      });
    
    if (error) {
      console.error('Supabase log error:', error);
    }
  } catch (error) {
    console.error('Failed to log to Supabase:', error.message);
    // Non-blocking - don't throw
  }
}

/**
 * POST /process-insight
 * Main endpoint to process a Spotify podcast insight
 */
app.post('/process-insight', async (req, res) => {
  const { title, showName, timestamp, spotifyUrl } = req.body;
  
  if (!title) {
    return res.status(400).json({ success: false, message: 'Title is required' });
  }
  
  const timestampSeconds = parseInt(timestamp) || 0;
  let audioPath = null;
  
  try {
    console.log(`Processing insight: "${title}" by ${showName} at ${timestampSeconds}s`);
    
    // Step 1: Search Listen Notes for the episode
    const episode = await searchListenNotes(title, showName || '');
    
    if (!episode) {
      return res.status(404).json({ 
        success: false, 
        message: 'Could not find podcast episode in Listen Notes' 
      });
    }
    
    console.log(`Found episode: ${episode.title}`);
    
    let transcript = null;
    
    // Step 2: Hybrid logic - check for existing transcript first
    if (episode.hasTranscript) {
      console.log('Using Listen Notes transcript');
      const fullTranscript = await getEpisodeTranscript(episode.id);
      if (fullTranscript) {
        transcript = extractTranscriptSegment(fullTranscript, timestampSeconds);
      }
    }
    
    // Step 3: If no transcript, use audio extraction + Whisper
    if (!transcript) {
      console.log('No transcript available, extracting audio...');
      
      if (!episode.audioUrl) {
        return res.status(404).json({
          success: false,
          message: 'No audio URL available for this episode'
        });
      }
      
      // Extract 30-second audio snippet
      audioPath = await extractAudioSnippet(episode.audioUrl, timestampSeconds, 30);
      console.log(`Audio snippet saved to: ${audioPath}`);
      
      // Transcribe with Whisper
      console.log('Transcribing with Whisper...');
      transcript = await transcribeWithWhisper(audioPath);
    }
    
    if (!transcript || transcript.trim().length === 0) {
      return res.status(500).json({
        success: false,
        message: 'Failed to get transcript for this segment'
      });
    }
    
    console.log(`Transcript (${transcript.length} chars): ${transcript.substring(0, 100)}...`);
    
    // Step 4: Summarize with GPT-4o-mini
    console.log('Summarizing transcript...');
    const summary = await summarizeTranscript(transcript, title);
    
    // Log to Supabase (non-blocking)
    logToSupabase({ title, showName, timestamp: timestampSeconds, spotifyUrl });
    
    // Respond with processed data
    res.json({
      success: true,
      data: {
        episodeTitle: episode.title,
        showName: episode.showName,
        thumbnail: episode.thumbnail,
        transcript: transcript,
        summary: summary,
        timestampSeconds: timestampSeconds
      }
    });
    
  } catch (error) {
    console.error('Process insight error:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to process insight'
    });
  } finally {
    // Clean up audio file
    if (audioPath) {
      await cleanupTempFiles([audioPath]);
    }
  }
});

/**
 * POST /save-to-notion
 * Save the processed insight to a Notion database
 */
app.post('/save-to-notion', async (req, res) => {
  const { 
    title, 
    showName, 
    transcript, 
    summary, 
    spotifyUrl, 
    thumbnail,
    timestampSeconds 
  } = req.body;
  
  if (!title || !transcript) {
    return res.status(400).json({ 
      success: false, 
      message: 'Title and transcript are required' 
    });
  }
  
  try {
    const databaseId = process.env.NOTION_DATABASE_ID;
    
    if (!databaseId) {
      throw new Error('Notion database ID not configured');
    }
    
    // Format summary as bullet points
    const summaryText = Array.isArray(summary) 
      ? summary.map(s => `• ${s}`).join('\n')
      : summary;
    
    // Create Notion page
    const response = await notion.pages.create({
      parent: { database_id: databaseId },
      icon: {
        type: 'emoji',
        emoji: '💡'
      },
      cover: thumbnail ? {
        type: 'external',
        external: { url: thumbnail }
      } : undefined,
      properties: {
        // Title property (required)
        'Name': {
          title: [
            {
              text: {
                content: title.substring(0, 100)
              }
            }
          ]
        },
        // Show Name
        'Show': {
          rich_text: [
            {
              text: {
                content: showName || 'Unknown Show'
              }
            }
          ]
        },
        // Spotify URL
        'Spotify URL': {
          url: spotifyUrl || null
        },
        // Timestamp
        'Timestamp': {
          number: timestampSeconds || 0
        },
        // Date saved
        'Saved': {
          date: {
            start: new Date().toISOString()
          }
        }
      },
      children: [
        // Key Takeaways heading
        {
          object: 'block',
          type: 'heading_2',
          heading_2: {
            rich_text: [{ text: { content: '✨ Key Takeaways' } }]
          }
        },
        // Summary bullets
        {
          object: 'block',
          type: 'paragraph',
          paragraph: {
            rich_text: [{ text: { content: summaryText } }]
          }
        },
        // Divider
        {
          object: 'block',
          type: 'divider',
          divider: {}
        },
        // Transcript heading
        {
          object: 'block',
          type: 'heading_2',
          heading_2: {
            rich_text: [{ text: { content: '📝 Transcript' } }]
          }
        },
        // Transcript content
        {
          object: 'block',
          type: 'paragraph',
          paragraph: {
            rich_text: [
              { 
                text: { 
                  content: transcript.substring(0, 2000) // Notion has text limits
                } 
              }
            ]
          }
        },
        // Callout with source
        {
          object: 'block',
          type: 'callout',
          callout: {
            icon: { type: 'emoji', emoji: '🎧' },
            rich_text: [
              {
                text: {
                  content: `From "${showName}" at ${formatTime(timestampSeconds)}`
                }
              }
            ]
          }
        }
      ]
    });
    
    console.log(`Saved to Notion: ${response.id}`);
    
    res.json({
      success: true,
      data: {
        notionPageId: response.id,
        notionUrl: response.url
      }
    });
    
  } catch (error) {
    console.error('Notion save error:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to save to Notion'
    });
  }
});

// Helper: Format seconds to MM:SS
function formatTime(seconds) {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    service: 'Wisdom Vault API',
    timestamp: new Date().toISOString()
  });
});

// Root endpoint
app.get('/', (req, res) => {
  res.json({
    name: 'Wisdom Vault API',
    version: '1.0.0',
    endpoints: [
      'POST /process-insight',
      'POST /save-to-notion',
      'GET /health'
    ]
  });
});

// Start server
app.listen(PORT, () => {
  console.log(`\n🎧 Wisdom Vault API running on http://localhost:${PORT}`);
  console.log('━'.repeat(50));
  console.log('Endpoints:');
  console.log('  POST /process-insight  - Process podcast insight');
  console.log('  POST /save-to-notion   - Save to Notion database');
  console.log('  GET  /health           - Health check');
  console.log('━'.repeat(50));
});

module.exports = app;

