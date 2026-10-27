/**
 * YouTube Authentication & Anti-Bot Strategy Manager
 *
 * Provides robust, production-ready authentication configuration for yt-dlp:
 * - Netscape format cookie files (--cookies <path>)
 * - Direct browser cookie extraction (--cookies-from-browser <browser>)
 * - Inline/base64 environment cookie injection (for serverless/container deployments)
 * - Safe diagnostic inspection and credential redaction
 */

import fs from 'node:fs';
import path from 'node:path';
import { config } from '../../config/env.js';
import { logger } from '../../utils/logger.js';

export const YouTubeAuthMode = Object.freeze({
  AUTO: 'auto',
  COOKIES_FILE: 'cookies_file',
  BROWSER: 'browser',
  NONE: 'none',
});

// Runtime temporary file for inline/base64 cookies if configured
let runtimeCookieFilePath = null;

/**
 * Resolves the effective YouTube authentication context based on configuration and host environment.
 *
 * @param {object} [overrideConfig]
 * @returns {{
 *   mode: string,
 *   active: boolean,
 *   strategy: 'cookies_file'|'browser'|'none',
 *   cookiesFilePath: string|null,
 *   browserSpec: string|null,
 *   diagnostics: object
 * }}
 */
export function resolveYouTubeAuth(overrideConfig = null) {
  const cfg = overrideConfig || config;
  const mode = (cfg.youtubeAuthMode || 'auto').trim().toLowerCase();
  const cookiesFileSetting = (cfg.youtubeCookiesFile || '').trim();
  const browserSetting = (cfg.youtubeBrowser || '').trim().toLowerCase();
  const browserProfile = (cfg.youtubeBrowserProfile || '').trim();
  const cookiesContent = (cfg.youtubeCookiesContent || '').trim();

  // 1. Check explicit NONE
  if (mode === YouTubeAuthMode.NONE) {
    return {
      mode: YouTubeAuthMode.NONE,
      active: false,
      strategy: 'none',
      cookiesFilePath: null,
      browserSpec: null,
      diagnostics: {
        mode: 'none',
        configured: false,
        active: false,
        description: 'Authentication disabled by configuration (unauthenticated requests)',
      },
    };
  }

  // 2. Handle inline/base64 cookie content if present
  if (cookiesContent) {
    try {
      const tempDir = path.resolve(process.cwd(), 'temp');
      if (!fs.existsSync(tempDir)) {
        fs.mkdirSync(tempDir, { recursive: true });
      }
      runtimeCookieFilePath = path.join(tempDir, '.runtime_youtube_cookies.txt');

      let rawText = cookiesContent;
      // Decode base64 if it does not look like raw text
      if (!cookiesContent.includes('# Netscape') && !cookiesContent.includes('.youtube.com') && !cookiesContent.includes('\t')) {
        try {
          const decoded = Buffer.from(cookiesContent, 'base64').toString('utf8');
          if (decoded.includes('.youtube.com') || decoded.includes('# Netscape') || decoded.includes('\t')) {
            rawText = decoded;
          }
        } catch {}
      }

      fs.writeFileSync(runtimeCookieFilePath, rawText, { mode: 0o600 });
      const stats = fs.statSync(runtimeCookieFilePath);

      return {
        mode: mode === 'auto' ? 'auto' : YouTubeAuthMode.COOKIES_FILE,
        active: true,
        strategy: 'cookies_file',
        cookiesFilePath: runtimeCookieFilePath,
        browserSpec: null,
        diagnostics: {
          mode,
          configured: true,
          active: true,
          strategy: 'cookies_file',
          source: 'environment (inline/base64 cookies)',
          fileSizeBytes: stats.size,
          description: `Active via environment cookies (${stats.size} bytes)`,
        },
      };
    } catch (err) {
      logger.warn(`[YOUTUBE_AUTH] Failed to write runtime cookie file from env: ${err.message}`);
    }
  }

  // 3. Check cookies file
  const candidateFiles = [];
  if (cookiesFileSetting) {
    candidateFiles.push(path.isAbsolute(cookiesFileSetting) ? cookiesFileSetting : path.resolve(process.cwd(), cookiesFileSetting));
  }
  if (mode === YouTubeAuthMode.AUTO || mode === YouTubeAuthMode.COOKIES_FILE) {
    // Default project root locations
    candidateFiles.push(path.resolve(process.cwd(), 'cookies.txt'));
    candidateFiles.push(path.resolve(process.cwd(), 'youtube_cookies.txt'));
  }

  for (const candidate of candidateFiles) {
    try {
      if (fs.existsSync(candidate)) {
        const stats = fs.statSync(candidate);
        if (stats.isFile() && stats.size > 10) {
          const safeDisplayPath = path.basename(candidate);
          return {
            mode: mode === 'auto' ? 'auto' : YouTubeAuthMode.COOKIES_FILE,
            active: true,
            strategy: 'cookies_file',
            cookiesFilePath: candidate,
            browserSpec: null,
            diagnostics: {
              mode,
              configured: true,
              active: true,
              strategy: 'cookies_file',
              source: `file (${safeDisplayPath})`,
              fileSizeBytes: stats.size,
              description: `Active Netscape cookies file: ${safeDisplayPath} (${(stats.size / 1024).toFixed(1)} KB)`,
            },
          };
        }
      }
    } catch {}
  }

  // If mode is explicitly cookies_file but file was not found
  if (mode === YouTubeAuthMode.COOKIES_FILE) {
    const missingName = cookiesFileSetting ? path.basename(cookiesFileSetting) : 'cookies.txt';
    return {
      mode: YouTubeAuthMode.COOKIES_FILE,
      active: false,
      strategy: 'cookies_file',
      cookiesFilePath: null,
      browserSpec: null,
      diagnostics: {
        mode,
        configured: true,
        active: false,
        strategy: 'cookies_file',
        error: `Cookies file not found or empty (${missingName})`,
        description: `Configured cookies file '${missingName}' was not found on host`,
      },
    };
  }

  // 4. Check browser mode
  if (browserSetting || mode === YouTubeAuthMode.BROWSER) {
    const browserName = browserSetting || 'chrome';
    const browserSpec = browserProfile ? `${browserName}:${browserProfile}` : browserName;
    return {
      mode: mode === 'auto' ? 'auto' : YouTubeAuthMode.BROWSER,
      active: true,
      strategy: 'browser',
      cookiesFilePath: null,
      browserSpec,
      diagnostics: {
        mode,
        configured: true,
        active: true,
        strategy: 'browser',
        source: `browser (${browserSpec})`,
        description: `Active browser cookies extraction: ${browserSpec}`,
      },
    };
  }

  // 5. Unauthenticated fallback
  return {
    mode: YouTubeAuthMode.NONE,
    active: false,
    strategy: 'none',
    cookiesFilePath: null,
    browserSpec: null,
    diagnostics: {
      mode: 'auto',
      configured: false,
      active: false,
      strategy: 'none',
      description: 'No cookies configured; running unauthenticated',
    },
  };
}

/**
 * Generates yt-dlp CLI arguments for authentication.
 *
 * @param {object} [customAuthContext]
 * @returns {string[]} Array of CLI flags to pass to yt-dlp
 */
export function getYtDlpAuthArgs(customAuthContext = null) {
  const auth = customAuthContext || resolveYouTubeAuth();
  if (!auth || !auth.active) {
    return [];
  }

  if (auth.strategy === 'cookies_file' && auth.cookiesFilePath) {
    return ['--cookies', auth.cookiesFilePath];
  }

  if (auth.strategy === 'browser' && auth.browserSpec) {
    return ['--cookies-from-browser', auth.browserSpec];
  }

  return [];
}

/**
 * Returns safe diagnostic info about current YouTube authentication setup
 * without exposing sensitive tokens, file contents, or personal paths.
 *
 * @returns {object}
 */
export function getYtDlpAuthDiagnostics() {
  const auth = resolveYouTubeAuth();
  return auth.diagnostics;
}

/**
 * Sanitizes command arguments for logging to ensure cookies paths or browser
 * profiles do not leak sensitive personal paths or tokens into logs.
 *
 * @param {string[]} args
 * @returns {string[]}
 */
export function sanitizeYtDlpArgs(args) {
  if (!Array.isArray(args)) return [];
  const sanitized = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--cookies') {
      sanitized.push('--cookies');
      if (i + 1 < args.length) {
        const nextArg = args[i + 1];
        const basename = path.basename(nextArg);
        sanitized.push(`[REDACTED_PATH/${basename}]`);
        i++;
      }
      continue;
    }
    if (arg.startsWith('--cookies=')) {
      const val = arg.slice('--cookies='.length);
      const basename = path.basename(val);
      sanitized.push(`--cookies=[REDACTED_PATH/${basename}]`);
      continue;
    }
    if (arg === '--cookies-from-browser') {
      sanitized.push('--cookies-from-browser');
      if (i + 1 < args.length) {
        sanitized.push(args[i + 1]);
        i++;
      }
      continue;
    }
    if (arg.startsWith('--cookies-from-browser=')) {
      sanitized.push(arg);
      continue;
    }
    sanitized.push(arg);
  }
  return sanitized;
}

/**
 * Saves cookie content to the default cookies.txt in project root.
 *
 * @param {string|Buffer} content - Raw or Netscape format cookies text
 * @returns {{ success: boolean, path: string, size: number }}
 */
export function saveCookiesFile(content) {
  const filePath = path.resolve(process.cwd(), 'cookies.txt');
  const text = typeof content === 'string' ? content : content.toString('utf8');
  fs.writeFileSync(filePath, text, { encoding: 'utf8', mode: 0o600 });
  const stats = fs.statSync(filePath);
  logger.info(`[YOUTUBE_AUTH] Saved cookies.txt (${stats.size} bytes)`);
  return { success: true, path: filePath, size: stats.size };
}

/**
 * Deletes the default cookies.txt in project root if present.
 *
 * @returns {boolean}
 */
export function removeCookiesFile() {
  const filePath = path.resolve(process.cwd(), 'cookies.txt');
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
    logger.info(`[YOUTUBE_AUTH] Removed cookies.txt`);
    return true;
  }
  return false;
}

/**
 * Returns user-facing status of current YouTube authentication.
 *
 * @returns {{ configured: boolean, summary: string, hasCookiesFile: boolean }}
 */
export function getYouTubeAuthStatus() {
  const filePath = path.resolve(process.cwd(), 'cookies.txt');
  const hasFile = fs.existsSync(filePath);
  let fileSize = 0;
  if (hasFile) {
    try {
      fileSize = fs.statSync(filePath).size;
    } catch {}
  }
  const auth = resolveYouTubeAuth();
  return {
    configured: auth.active,
    hasCookiesFile: hasFile && fileSize > 10,
    fileSize,
    mode: auth.mode,
    strategy: auth.strategy,
    summary: auth.diagnostics?.description || 'Unauthenticated',
  };
}
