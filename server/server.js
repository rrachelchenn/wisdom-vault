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

// Middleware - Allow all origins for development
app.use(cors());
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
  try {
    // Search with show name as primary, title as secondary for better accuracy
    // Put show name in quotes to prioritize exact match
    const query = showName ? `"${showName}" ${title}` : title;
    
    console.log(`Searching Listen Notes for: ${query}`);
    
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
      // Try to find a result that matches the show name
      let episode = response.data.results[0];
      
      if (showName) {
        const showNameLower = showName.toLowerCase();
        const matchingEpisode = response.data.results.find(ep => {
          const podcastName = (ep.podcast?.title_original || '').toLowerCase();
          return podcastName.includes(showNameLower) || showNameLower.includes(podcastName);
        });
        
        if (matchingEpisode) {
          episode = matchingEpisode;
          console.log(`Found matching episode: "${episode.title_original}" from "${episode.podcast?.title_original}"`);
        } else {
          console.log(`Warning: No exact show match found. Using best result: "${episode.podcast?.title_original}"`);
        }
      }
      
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
 * Download and crop audio using curl + ffmpeg
 */
async function extractAudioSnippet(audioUrl, timestampSeconds, duration = 30) {
  await ensureTempDir();
  
  const timestamp = Date.now();
  const fullAudioPath = path.join(TEMP_DIR, `full_${timestamp}.mp3`);
  const snippetPath = path.join(TEMP_DIR, `snippet_${timestamp}.mp3`);
  
  try {
    // Calculate start time (5 seconds before to capture context)
    const startTime = Math.max(0, timestampSeconds - 5);
    const totalDuration = duration + 10; // Extra buffer
    
    console.log(`Extracting audio from ${startTime}s for ${totalDuration}s`);
    console.log(`Audio URL: ${audioUrl.substring(0, 100)}...`);
    
    // Step 1: Download with curl using proper headers (Listen Notes blocks direct ffmpeg access)
    console.log('Downloading audio with curl...');
    const curlCmd = `curl -L -A "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36" -o "${fullAudioPath}" "${audioUrl}"`;
    
    await execAsync(curlCmd, { timeout: 180000 }); // 3 min timeout for download
    
    // Verify download
    const downloadStats = await fs.stat(fullAudioPath);
    console.log(`Downloaded: ${downloadStats.size} bytes`);
    
    if (downloadStats.size < 10000) {
      throw new Error('Downloaded file too small');
    }
    
    // Step 2: Extract snippet with ffmpeg
    console.log('Extracting snippet with ffmpeg...');
    const ffmpegCmd = `ffmpeg -y -ss ${startTime} -i "${fullAudioPath}" -t ${totalDuration} -c:a libmp3lame -q:a 4 -loglevel error "${snippetPath}"`;
    
    await execAsync(ffmpegCmd, { timeout: 60000 });
    
    // Clean up full audio
    await fs.unlink(fullAudioPath).catch(() => {});
    
    // Verify snippet was created
    const stats = await fs.stat(snippetPath);
    console.log(`Audio snippet created: ${stats.size} bytes`);
    
    if (stats.size < 1000) {
      throw new Error('Audio snippet too small - extraction may have failed');
    }
    
    return snippetPath;
  } catch (error) {
    // Clean up on error
    await cleanupTempFiles([fullAudioPath, snippetPath]);
    console.error('Audio extraction error:', error.message);
    throw new Error('Failed to extract audio snippet: ' + error.message);
  }
}

/**
 * Transcribe audio using Groq's free Whisper API
 */
async function transcribeWithWhisper(audioPath) {
  try {
    // Verify file exists
    const stats = await fs.stat(audioPath);
    console.log(`Transcribing audio file: ${audioPath} (${stats.size} bytes)`);
    
    const formData = new FormData();
    formData.append('file', createReadStream(audioPath), {
      filename: 'audio.mp3',
      contentType: 'audio/mpeg'
    });
    formData.append('model', 'whisper-large-v3');
    formData.append('response_format', 'text');
    
    console.log('Sending to Groq Whisper API...');
    const response = await axios.post(
      'https://api.groq.com/openai/v1/audio/transcriptions',
      formData,
      {
        headers: {
          'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
          ...formData.getHeaders()
        },
        maxContentLength: Infinity,
        maxBodyLength: Infinity,
        timeout: 60000 // 60 second timeout
      }
    );
    
    console.log('Groq transcription received:', response.data.substring(0, 100) + '...');
    return response.data;
  } catch (error) {
    console.error('Groq Whisper API error details:', {
      status: error.response?.status,
      statusText: error.response?.statusText,
      data: error.response?.data,
      message: error.message
    });
    throw new Error('Failed to transcribe audio: ' + (error.response?.data?.error?.message || error.message));
  }
}

/**
 * Summarize transcript using Groq's free LLaMA model
 */
async function summarizeTranscript(transcript, title) {
  try {
    console.log('Summarizing with Groq LLaMA...');
    const response = await axios.post(
      'https://api.groq.com/openai/v1/chat/completions',
      {
        model: 'llama-3.1-8b-instant',
        messages: [
          {
            role: 'system',
            content: 'You are a helpful assistant that summarizes podcast insights. Create exactly 3 concise bullet points that capture the key takeaways from the transcript. Each bullet should be actionable or insightful. Keep each bullet under 100 characters. Format as: - Point one\n- Point two\n- Point three'
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
          'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
          'Content-Type': 'application/json'
        }
      }
    );
    
    const content = response.data.choices[0].message.content;
    console.log('Summary received:', content.substring(0, 100) + '...');
    
    // Parse bullet points
    const bullets = content
      .split('\n')
      .filter(line => line.trim().match(/^[-•*]\s/) || line.trim().match(/^\d+\.\s/))
      .map(line => line.replace(/^[-•*\d.]\s*/, '').trim())
      .filter(line => line.length > 0)
      .slice(0, 3);
    
    return bullets.length > 0 ? bullets : [content.trim()];
  } catch (error) {
    console.error('Groq summarization error:', error.response?.data || error.message);
    throw new Error('Failed to summarize transcript: ' + (error.response?.data?.error?.message || error.message));
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
    
    // If episode not found, return success with manual mode flag
    if (!episode) {
      console.log('Episode not found in Listen Notes - using manual mode');
      
      // Log to Supabase (non-blocking)
      logToSupabase({ title, showName, timestamp: timestampSeconds, spotifyUrl });
      
      return res.json({
        success: true,
        data: {
          episodeTitle: title,
          showName: showName || 'Unknown Show',
          thumbnail: null,
          transcript: null,
          summary: null,
          timestampSeconds: timestampSeconds,
          manualMode: true,
          message: 'Podcast not found in database. You can add your own notes!'
        }
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
    
    // Respond with processed data - USE ORIGINAL SPOTIFY DATA for title/show
    res.json({
      success: true,
      data: {
        episodeTitle: title,  // Use original Spotify title
        showName: showName || episode.showName,  // Use original Spotify show name
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
    timestampSeconds,
    manualMode 
  } = req.body;
  
  if (!title) {
    return res.status(400).json({ 
      success: false, 
      message: 'Title is required' 
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
    
    // Build page content based on whether we have transcript/summary
    const pageChildren = [];
    
    if (summary && summary.length > 0) {
      // Key Takeaways heading
      pageChildren.push({
        object: 'block',
        type: 'heading_2',
        heading_2: {
          rich_text: [{ text: { content: '✨ Key Takeaways' } }]
        }
      });
      // Summary bullets
      pageChildren.push({
        object: 'block',
        type: 'paragraph',
        paragraph: {
          rich_text: [{ text: { content: summaryText } }]
        }
      });
      // Divider
      pageChildren.push({
        object: 'block',
        type: 'divider',
        divider: {}
      });
    }
    
    if (transcript) {
      // Transcript heading
      pageChildren.push({
        object: 'block',
        type: 'heading_2',
        heading_2: {
          rich_text: [{ text: { content: '📝 Transcript' } }]
        }
      });
      // Transcript content
      pageChildren.push({
        object: 'block',
        type: 'paragraph',
        paragraph: {
          rich_text: [
            { 
              text: { 
                content: transcript.substring(0, 2000)
              } 
            }
          ]
        }
      });
    } else {
      // Manual mode - add placeholder for notes
      pageChildren.push({
        object: 'block',
        type: 'heading_2',
        heading_2: {
          rich_text: [{ text: { content: '📝 Your Notes' } }]
        }
      });
      pageChildren.push({
        object: 'block',
        type: 'paragraph',
        paragraph: {
          rich_text: [
            { 
              text: { 
                content: '(Podcast not found in database - add your own notes here!)'
              } 
            }
          ]
        }
      });
    }
    
    // Callout with source
    pageChildren.push({
      object: 'block',
      type: 'callout',
      callout: {
        icon: { type: 'emoji', emoji: '🎧' },
        rich_text: [
          {
            text: {
              content: `From "${showName || 'Unknown Show'}" at ${formatTime(timestampSeconds)}`
            }
          }
        ]
      }
    });
    
    // Create Notion page
    const response = await notion.pages.create({
      parent: { database_id: databaseId },
      icon: {
        type: 'emoji',
        emoji: manualMode ? '✏️' : '💡'
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
      children: pageChildren
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

