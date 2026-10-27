/**
 * YouTube Error Classifier & Fallback Analyzer
 *
 * Categorizes raw yt-dlp and ffmpeg error outputs to:
 * 1. Accurately detect YouTube bot verification / anti-scraping challenges
 * 2. Prevent pointless repeated download attempts (e.g. attempting full source when bot blocked)
 * 3. Provide human-readable, actionable error messages for Telegram users
 */

export const DownloadErrorType = Object.freeze({
  BOT_VERIFICATION_REQUIRED: 'BOT_VERIFICATION_REQUIRED',
  AGE_RESTRICTED: 'AGE_RESTRICTED',
  GEO_RESTRICTED: 'GEO_RESTRICTED',
  PRIVATE_OR_UNAVAILABLE: 'PRIVATE_OR_UNAVAILABLE',
  FORMAT_UNAVAILABLE: 'FORMAT_UNAVAILABLE',
  NETWORK_ERROR: 'NETWORK_ERROR',
  FFMPEG_ERROR: 'FFMPEG_ERROR',
  DOWNLOAD_STALLED: 'DOWNLOAD_STALLED',
  UNKNOWN_DOWNLOAD_ERROR: 'UNKNOWN_DOWNLOAD_ERROR',
});

/**
 * Inspects stdout, stderr, and error message to classify the failure.
 *
 * @param {string} stderr - Process stderr
 * @param {string} stdout - Process stdout
 * @param {Error|null} [err] - Associated Javascript error
 * @returns {{
 *   type: string,
 *   isRecoverableViaFullDownload: boolean,
 *   isAuthIssue: boolean,
 *   userMessage: string,
 *   developerNote: string
 * }}
 */
export function classifyDownloadError(stderr = '', stdout = '', err = null) {
  const combinedText = [
    String(stderr || ''),
    String(stdout || ''),
    err?.message || '',
  ].join('\n');

  // 1. YouTube Bot Challenge / Sign-in Verification
  if (
    combinedText.includes("Sign in to confirm you're not a bot") ||
    combinedText.includes("Sign in to confirm you’re not a bot") ||
    combinedText.includes('confirm your identity') ||
    combinedText.includes('Use --cookies-from-browser or --cookies for the authentication') ||
    combinedText.includes('HTTP Error 429') ||
    combinedText.includes('Too Many Requests') ||
    combinedText.includes('bot verification')
  ) {
    return {
      type: DownloadErrorType.BOT_VERIFICATION_REQUIRED,
      isRecoverableViaFullDownload: false,
      isAuthIssue: true,
      userMessage:
        'YouTube requires bot verification to access this video.\n\n' +
        '• Bot authentication cookies must be configured by an administrator.\n' +
        '• Please try again shortly or with a different video.',
      developerNote: "YouTube anti-bot challenge encountered ('Sign in to confirm you're not a bot'). Configure YOUTUBE_COOKIES_FILE or YOUTUBE_BROWSER.",
    };
  }

  // 2. Age Restriction
  if (
    combinedText.includes('Sign in to confirm your age') ||
    combinedText.includes('Age-restricted video') ||
    combinedText.includes('confirm your age') ||
    combinedText.includes('content is age-restricted')
  ) {
    return {
      type: DownloadErrorType.AGE_RESTRICTED,
      isRecoverableViaFullDownload: false,
      isAuthIssue: true,
      userMessage:
        'This video is age-restricted on YouTube and requires sign-in authentication to view.',
      developerNote: 'Age-restricted YouTube video requires authenticated session cookies.',
    };
  }

  // 3. Geographic / Region Restriction
  if (
    combinedText.includes('not made this video available in your country') ||
    combinedText.includes('not available in your country') ||
    combinedText.includes('georestricted') ||
    combinedText.includes('blocked in your country')
  ) {
    return {
      type: DownloadErrorType.GEO_RESTRICTED,
      isRecoverableViaFullDownload: false,
      isAuthIssue: false,
      userMessage:
        'This video is region-restricted by the uploader and not available in the bot server\'s geographic region.',
      developerNote: 'YouTube video is blocked by geographic restriction.',
    };
  }

  // 4. Private, Removed, or Unavailable Video
  if (
    combinedText.includes('Video unavailable') ||
    combinedText.includes('Private video') ||
    combinedText.includes('This video has been removed') ||
    combinedText.includes('This video does not exist') ||
    combinedText.includes('This video is private') ||
    combinedText.includes('The playlist does not exist') ||
    combinedText.includes('Premieres in') ||
    combinedText.includes('Live event will begin in')
  ) {
    return {
      type: DownloadErrorType.PRIVATE_OR_UNAVAILABLE,
      isRecoverableViaFullDownload: false,
      isAuthIssue: false,
      userMessage:
        'This YouTube video is private, deleted, premiering soon, or unavailable.',
      developerNote: 'Video is unavailable, private, or has not premiered.',
    };
  }

  // 5. Format Unavailable
  if (
    combinedText.includes('Requested format is not available') ||
    combinedText.includes('No video formats found') ||
    combinedText.includes('format extraction failed')
  ) {
    return {
      type: DownloadErrorType.FORMAT_UNAVAILABLE,
      isRecoverableViaFullDownload: true,
      isAuthIssue: false,
      userMessage:
        'The requested video format or resolution is not available for this video.',
      developerNote: 'Target video/audio stream format is not present on YouTube for this media ID.',
    };
  }

  // 6. Network / Connection Failures
  if (
    combinedText.includes('Connection reset by peer') ||
    combinedText.includes('WinError 10054') ||
    combinedText.includes('ETIMEDOUT') ||
    combinedText.includes('timed out') ||
    combinedText.includes('Temporary failure in name resolution') ||
    combinedText.includes('Unable to download webpage') ||
    combinedText.includes('Network is unreachable') ||
    combinedText.includes('IncompleteRead')
  ) {
    return {
      type: DownloadErrorType.NETWORK_ERROR,
      isRecoverableViaFullDownload: true,
      isAuthIssue: false,
      userMessage:
        'A temporary network connection issue occurred while communicating with YouTube. Please try again in a few seconds.',
      developerNote: 'Network socket or DNS resolution failure during download.',
    };
  }

  // 7. FFmpeg Multiplexer / Slicing Failures
  if (
    combinedText.includes('ffmpeg exited with code') ||
    combinedText.includes('Error while opening decoder') ||
    combinedText.includes('Invalid data found when processing input') ||
    combinedText.includes('ffmpeg_i') ||
    combinedText.includes('muxing overhead')
  ) {
    return {
      type: DownloadErrorType.FFMPEG_ERROR,
      isRecoverableViaFullDownload: true,
      isAuthIssue: false,
      userMessage:
        'A stream processing error occurred while cutting the requested video segment.',
      developerNote: 'FFmpeg child process failed during range download or stream remuxing.',
    };
  }

  // 8. Download Watchdog Stall
  if (
    combinedText.includes('no data received from YouTube') ||
    combinedText.includes('Download stalled') ||
    combinedText.includes('DOWNLOAD_STALLED') ||
    combinedText.includes('exceeded maximum job duration')
  ) {
    return {
      type: DownloadErrorType.DOWNLOAD_STALLED,
      isRecoverableViaFullDownload: false,
      isAuthIssue: false,
      userMessage:
        'YouTube download stalled or timed out before completion.',
      developerNote: 'Watchdog timer detected inactivity or hard ceiling timeout.',
    };
  }

  // Default unknown download failure (potentially recoverable via full source if section range was malformed)
  return {
    type: DownloadErrorType.UNKNOWN_DOWNLOAD_ERROR,
    isRecoverableViaFullDownload: true,
    isAuthIssue: false,
    userMessage:
      'We couldn\'t download the requested video from YouTube. Please verify the link is public and accessible.',
    developerNote: 'Unclassified yt-dlp failure.',
  };
}

/**
 * Determines whether a section-download error should trigger the full-source fallback download.
 *
 * @param {{ isRecoverableViaFullDownload: boolean, isAuthIssue: boolean, type: string }} classification
 * @returns {boolean}
 */
export function isRecoverableViaFullDownload(classification) {
  if (!classification) return true;
  return Boolean(classification.isRecoverableViaFullDownload);
}
