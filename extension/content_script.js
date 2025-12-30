// Wisdom Vault - Content Script for Spotify
// This script runs on open.spotify.com/* pages

(function() {
  'use strict';

  // Parse timestamp string to seconds
  function parseTimestamp(timeString) {
    if (!timeString) return 0;
    
    // Handle formats like "1:23:45" or "23:45" or "45"
    const parts = timeString.split(':').map(Number);
    
    if (parts.length === 3) {
      // Hours:Minutes:Seconds
      return parts[0] * 3600 + parts[1] * 60 + parts[2];
    } else if (parts.length === 2) {
      // Minutes:Seconds
      return parts[0] * 60 + parts[1];
    } else if (parts.length === 1) {
      // Just seconds
      return parts[0];
    }
    
    return 0;
  }

  // Get the current Spotify URL
  function getSpotifyUrl() {
    return window.location.href;
  }

  // Extract show and episode data from the now playing widget
  function getNowPlayingData() {
    // Primary selector for now playing widget
    const nowPlayingWidget = document.querySelector('[data-testid="now-playing-widget"]');
    
    if (!nowPlayingWidget) {
      // Try alternative selectors
      const playerControls = document.querySelector('[data-testid="player-controls"]');
      if (!playerControls) {
        return null;
      }
    }

    let title = '';
    let showName = '';
    
    // Try to get title from now-playing-widget
    if (nowPlayingWidget) {
      // Look for the track/episode name link
      const titleLink = nowPlayingWidget.querySelector('a[data-testid="context-item-link"]');
      const titleElement = nowPlayingWidget.querySelector('[data-testid="context-item-info-title"]');
      const subtitleElement = nowPlayingWidget.querySelector('[data-testid="context-item-info-subtitles"]');
      
      if (titleElement) {
        title = titleElement.textContent?.trim() || '';
      } else if (titleLink) {
        title = titleLink.textContent?.trim() || '';
      }
      
      if (subtitleElement) {
        // Show name is usually in the subtitle area
        const showLink = subtitleElement.querySelector('a');
        showName = showLink?.textContent?.trim() || subtitleElement.textContent?.trim() || '';
      }
    }

    // Alternative: Try to get from player bar if widget selectors failed
    if (!title) {
      const playerTitle = document.querySelector('[data-testid="now-playing-widget"] a');
      title = playerTitle?.textContent?.trim() || '';
    }

    // Fallback selectors for different Spotify UI versions
    if (!title) {
      const altTitleSelectors = [
        '.now-playing .track-info__name a',
        '.now-playing-bar .track-info__name',
        '[class*="TrackInfo"] a:first-child',
        '[class*="nowPlayingWidget"] a'
      ];
      
      for (const selector of altTitleSelectors) {
        const element = document.querySelector(selector);
        if (element && element.textContent) {
          title = element.textContent.trim();
          break;
        }
      }
    }

    if (!showName) {
      const altShowSelectors = [
        '.now-playing .track-info__artists a',
        '.now-playing-bar .track-info__artists',
        '[class*="TrackInfo"] a:last-child',
        '[class*="nowPlayingWidget"] span a'
      ];
      
      for (const selector of altShowSelectors) {
        const element = document.querySelector(selector);
        if (element && element.textContent) {
          showName = element.textContent.trim();
          break;
        }
      }
    }

    return { title, showName };
  }

  // Get playback position/timestamp
  function getPlaybackPosition() {
    // Primary selector
    const positionElement = document.querySelector('[data-testid="playback-position"]');
    
    if (positionElement) {
      return parseTimestamp(positionElement.textContent?.trim());
    }
    
    // Alternative selectors for different UI versions
    const altSelectors = [
      '.playback-bar__progress-time:first-child',
      '[class*="playback-bar"] [class*="progress-time"]:first-child',
      '.progress-bar__progress-time',
      '[data-testid="progress-bar"] + span'
    ];
    
    for (const selector of altSelectors) {
      const element = document.querySelector(selector);
      if (element && element.textContent) {
        return parseTimestamp(element.textContent.trim());
      }
    }
    
    return 0;
  }

  // Check if currently playing content is a podcast
  function isPodcast() {
    // Check URL patterns for podcasts/shows
    const url = window.location.href;
    if (url.includes('/show/') || url.includes('/episode/')) {
      return true;
    }
    
    // Check for podcast-specific UI elements
    const podcastIndicators = [
      '[data-testid="episode-page"]',
      '[data-testid="show-page"]',
      '.podcast-header',
      '[class*="EpisodePage"]',
      '[class*="ShowPage"]'
    ];
    
    for (const selector of podcastIndicators) {
      if (document.querySelector(selector)) {
        return true;
      }
    }
    
    // Check if now-playing widget has podcast-like structure (shows have different metadata)
    const widget = document.querySelector('[data-testid="now-playing-widget"]');
    if (widget) {
      const href = widget.querySelector('a')?.getAttribute('href') || '';
      if (href.includes('/episode/') || href.includes('/show/')) {
        return true;
      }
    }
    
    return false;
  }

  // Main function to get all Spotify data
  function getSpotifyData() {
    const nowPlaying = getNowPlayingData();
    
    if (!nowPlaying || !nowPlaying.title) {
      return {
        success: false,
        error: 'No content currently playing. Please play a podcast episode.'
      };
    }

    const timestamp = getPlaybackPosition();
    const spotifyUrl = getSpotifyUrl();
    
    return {
      success: true,
      data: {
        title: nowPlaying.title,
        showName: nowPlaying.showName,
        timestamp: timestamp,
        spotifyUrl: spotifyUrl,
        isPodcast: isPodcast()
      }
    };
  }

  // Listen for messages from popup/background
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'GET_SPOTIFY_DATA') {
      const data = getSpotifyData();
      sendResponse(data);
    }
    
    // Return true to indicate we'll respond asynchronously if needed
    return true;
  });

  // Log that content script is loaded (for debugging)
  console.log('[Wisdom Vault] Content script loaded on Spotify');
})();

