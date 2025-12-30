// Wisdom Vault - Popup Script
const API_BASE_URL = 'http://localhost:3001';

// UI State Management
const UI = {
  defaultState: document.getElementById('default-state'),
  nowPlayingState: document.getElementById('now-playing-state'),
  processingState: document.getElementById('processing-state'),
  successState: document.getElementById('success-state'),
  errorState: document.getElementById('error-state'),
  saveBtn: document.getElementById('save-btn'),
  episodeTitle: document.getElementById('episode-title'),
  showName: document.getElementById('show-name'),
  timestamp: document.getElementById('timestamp'),
  processingText: document.getElementById('processing-text'),
  errorMessage: document.getElementById('error-message')
};

// Hide all states
function hideAllStates() {
  UI.defaultState.classList.add('hidden');
  UI.nowPlayingState.classList.add('hidden');
  UI.processingState.classList.add('hidden');
  UI.successState.classList.add('hidden');
  UI.errorState.classList.add('hidden');
}

// Show specific state
function showState(stateName, data = {}) {
  hideAllStates();
  
  switch (stateName) {
    case 'default':
      UI.defaultState.classList.remove('hidden');
      UI.saveBtn.disabled = false;
      break;
      
    case 'nowPlaying':
      UI.nowPlayingState.classList.remove('hidden');
      UI.episodeTitle.textContent = data.title || 'Unknown Episode';
      UI.showName.textContent = data.showName || 'Unknown Show';
      UI.timestamp.textContent = formatTimestamp(data.timestamp || 0);
      UI.saveBtn.disabled = false;
      break;
      
    case 'processing':
      UI.processingState.classList.remove('hidden');
      UI.processingText.textContent = data.message || 'Processing insight...';
      UI.saveBtn.disabled = true;
      break;
      
    case 'success':
      UI.successState.classList.remove('hidden');
      UI.saveBtn.disabled = false;
      break;
      
    case 'error':
      UI.errorState.classList.remove('hidden');
      UI.errorMessage.textContent = data.message || 'Something went wrong';
      UI.saveBtn.disabled = false;
      break;
  }
}

// Format seconds to MM:SS
function formatTimestamp(seconds) {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
}

// Get current Spotify data from content script
async function getSpotifyData() {
  return new Promise((resolve, reject) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = tabs[0];
      
      if (!tab || !tab.url || !tab.url.includes('open.spotify.com')) {
        reject(new Error('Please open Spotify Web Player'));
        return;
      }
      
      chrome.tabs.sendMessage(tab.id, { action: 'GET_SPOTIFY_DATA' }, (response) => {
        if (chrome.runtime.lastError) {
          reject(new Error('Could not connect to Spotify. Please refresh the page.'));
          return;
        }
        
        if (response && response.success) {
          resolve(response.data);
        } else {
          reject(new Error(response?.error || 'No podcast currently playing'));
        }
      });
    });
  });
}

// Process insight via backend
async function processInsight(spotifyData) {
  const response = await fetch(`${API_BASE_URL}/process-insight`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(spotifyData)
  });
  
  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.message || 'Failed to process insight');
  }
  
  return response.json();
}

// Save to Notion via backend
async function saveToNotion(data) {
  const response = await fetch(`${API_BASE_URL}/save-to-notion`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(data)
  });
  
  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.message || 'Failed to save to Notion');
  }
  
  return response.json();
}

// Main save handler
async function handleSaveInsight() {
  try {
    // Step 1: Get Spotify data
    showState('processing', { message: 'Fetching Spotify data...' });
    const spotifyData = await getSpotifyData();
    
    // Show what we found
    showState('nowPlaying', spotifyData);
    await new Promise(resolve => setTimeout(resolve, 500));
    
    // Step 2: Process the insight
    showState('processing', { message: 'Searching for podcast...' });
    await new Promise(resolve => setTimeout(resolve, 500));
    
    showState('processing', { message: 'Transcribing audio...' });
    const processedData = await processInsight(spotifyData);
    
    // Step 3: Save to Notion
    showState('processing', { message: 'Saving to Notion...' });
    await saveToNotion({
      ...spotifyData,
      ...processedData
    });
    
    // Success!
    showState('success');
    
    // Reset after 3 seconds
    setTimeout(() => {
      showState('default');
    }, 3000);
    
  } catch (error) {
    console.error('Error saving insight:', error);
    showState('error', { message: error.message });
    
    // Reset after 5 seconds
    setTimeout(() => {
      showState('default');
    }, 5000);
  }
}

// Initialize
document.addEventListener('DOMContentLoaded', () => {
  showState('default');
  
  // Try to get current playing data on popup open
  getSpotifyData()
    .then(data => showState('nowPlaying', data))
    .catch(() => showState('default'));
  
  // Save button click handler
  UI.saveBtn.addEventListener('click', handleSaveInsight);
});

