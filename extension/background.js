// Wisdom Vault - Background Service Worker
// Handles communication between popup, content scripts, and external APIs

const API_BASE_URL = 'http://localhost:3001';

// Store for recent insights
let recentInsights = [];

// Initialize extension
chrome.runtime.onInstalled.addListener(() => {
  console.log('[Wisdom Vault] Extension installed');
  
  // Initialize storage
  chrome.storage.local.set({
    insights: [],
    settings: {
      apiUrl: API_BASE_URL,
      autoSave: false
    }
  });
});

// Handle messages from popup or content scripts
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  switch (request.action) {
    case 'PROCESS_INSIGHT':
      handleProcessInsight(request.data)
        .then(sendResponse)
        .catch(error => sendResponse({ success: false, error: error.message }));
      return true; // Keep channel open for async response
      
    case 'SAVE_TO_NOTION':
      handleSaveToNotion(request.data)
        .then(sendResponse)
        .catch(error => sendResponse({ success: false, error: error.message }));
      return true;
      
    case 'GET_RECENT_INSIGHTS':
      sendResponse({ success: true, insights: recentInsights });
      break;
      
    case 'GET_SETTINGS':
      chrome.storage.local.get(['settings'], (result) => {
        sendResponse({ success: true, settings: result.settings });
      });
      return true;
      
    case 'UPDATE_SETTINGS':
      chrome.storage.local.set({ settings: request.settings }, () => {
        sendResponse({ success: true });
      });
      return true;
  }
});

// Process insight via backend API
async function handleProcessInsight(spotifyData) {
  try {
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
    
    const result = await response.json();
    
    // Store in recent insights
    recentInsights.unshift({
      ...spotifyData,
      ...result,
      timestamp: new Date().toISOString()
    });
    
    // Keep only last 10 insights
    if (recentInsights.length > 10) {
      recentInsights = recentInsights.slice(0, 10);
    }
    
    // Persist to storage
    chrome.storage.local.set({ insights: recentInsights });
    
    return { success: true, data: result };
  } catch (error) {
    console.error('[Wisdom Vault] Process insight error:', error);
    throw error;
  }
}

// Save to Notion via backend API
async function handleSaveToNotion(data) {
  try {
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
    
    return await response.json();
  } catch (error) {
    console.error('[Wisdom Vault] Save to Notion error:', error);
    throw error;
  }
}

// Handle keyboard shortcut (if configured in manifest)
chrome.commands?.onCommand?.addListener((command) => {
  if (command === 'save-insight') {
    // Get active tab and trigger save
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = tabs[0];
      if (tab && tab.url && tab.url.includes('open.spotify.com')) {
        chrome.tabs.sendMessage(tab.id, { action: 'GET_SPOTIFY_DATA' }, (response) => {
          if (response && response.success) {
            handleProcessInsight(response.data)
              .then(() => {
                // Show notification
                chrome.notifications?.create({
                  type: 'basic',
                  iconUrl: 'icons/icon48.png',
                  title: 'Wisdom Vault',
                  message: 'Insight saved successfully!'
                });
              })
              .catch(error => {
                chrome.notifications?.create({
                  type: 'basic',
                  iconUrl: 'icons/icon48.png',
                  title: 'Wisdom Vault',
                  message: `Error: ${error.message}`
                });
              });
          }
        });
      }
    });
  }
});

// Log service worker status
console.log('[Wisdom Vault] Service worker started');

