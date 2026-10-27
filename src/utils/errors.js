/**
 * Structured Pipeline Errors and Sanitization Utilities
 */

export const PipelineStage = Object.freeze({
  DOWNLOAD_FAILED: 'DOWNLOAD_FAILED',
  CLIP_FAILED: 'CLIP_FAILED',
  TRANSCRIPTION_FAILED: 'TRANSCRIPTION_FAILED',
  TRANSCRIPTION_INPUT_RANGE_ERROR: 'TRANSCRIPTION_INPUT_RANGE_ERROR',
  CAPTION_RENDER_FAILED: 'CAPTION_RENDER_FAILED',
  TELEGRAM_UPLOAD_FAILED: 'TELEGRAM_UPLOAD_FAILED',
});

/**
 * Sanitizes URLs to remove sensitive credentials, tokens, or signatures from query parameters.
 *
 * @param {string} rawUrl
 * @returns {string} Sanitized URL
 */
export function sanitizeUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') return '';
  try {
    const parsed = new URL(rawUrl);
    const SENSITIVE_PARAMS = [
      'token',
      'key',
      'api_key',
      'auth',
      'access_token',
      'signature',
      'sig',
      'session',
      'secret',
      'password',
      'bot_token',
    ];
    for (const param of SENSITIVE_PARAMS) {
      if (parsed.searchParams.has(param)) {
        parsed.searchParams.set(param, '[REDACTED]');
      }
    }
    return parsed.toString();
  } catch {
    return rawUrl;
  }
}

/**
 * Sanitizes an argument array for safe logging.
 *
 * @param {string[]} args
 * @returns {string[]} Sanitized argument array
 */
export function sanitizeArgs(args) {
  if (!Array.isArray(args)) return [];
  const sanitized = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (typeof arg !== 'string') {
      sanitized.push(String(arg));
      continue;
    }

    if (arg === '--cookies') {
      sanitized.push('--cookies');
      if (i + 1 < args.length) {
        sanitized.push('[REDACTED_COOKIE_FILE]');
        i++;
      }
      continue;
    }

    if (arg.startsWith('--cookies=')) {
      sanitized.push('--cookies=[REDACTED_COOKIE_FILE]');
      continue;
    }

    if (arg.startsWith('http://') || arg.startsWith('https://')) {
      sanitized.push(sanitizeUrl(arg));
      continue;
    }

    // Redact Telegram bot token pattern
    sanitized.push(arg.replace(/\b\d{8,10}:[a-zA-Z0-9_-]{35}\b/g, '[REDACTED_BOT_TOKEN]'));
  }
  return sanitized;
}

/**
 * Structured error class representing a failure at a specific stage of the video pipeline.
 */
export class PipelineError extends Error {
  /**
   * @param {object} params
   * @param {string} params.stage - One of PipelineStage
   * @param {string} params.message - Human-readable error message
   * @param {string|null} [params.code=null] - Specific machine-readable classification code
   * @param {number|null} [params.exitCode=null] - Subprocess exit code if applicable
   * @param {string|null} [params.signal=null] - Termination signal if applicable
   * @param {string} [params.stderr=''] - Complete standard error output
   * @param {string} [params.stdout=''] - Complete standard output
   * @param {string} [params.jobId='unknown'] - Associated job ID
   * @param {object|null} [params.classification=null] - Extended classification details
   * @param {Error|null} [params.cause=null] - Underlying causal error
   */
  constructor({
    stage,
    message,
    code = null,
    exitCode = null,
    signal = null,
    stderr = '',
    stdout = '',
    jobId = 'unknown',
    classification = null,
    cause = null,
  }) {
    super(message);
    this.name = 'PipelineError';
    this.stage = stage;
    this.code = code;
    this.classification = classification;
    this.exitCode = exitCode;
    this.signal = signal;
    this.stderr = stderr ? String(stderr).trim() : '';
    this.stdout = stdout ? String(stdout).trim() : '';
    this.jobId = jobId;
    if (cause) {
      this.cause = cause;
    }
  }

  toJSON() {
    return {
      name: this.name,
      stage: this.stage,
      code: this.code,
      message: this.message,
      exitCode: this.exitCode,
      signal: this.signal,
      stderr: this.stderr,
      stdout: this.stdout,
      jobId: this.jobId,
    };
  }
}
