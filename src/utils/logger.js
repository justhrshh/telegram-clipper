/**
 * Application Logger
 * Provides structured timestamped logging and sanitizes sensitive tokens.
 */

const SENSITIVE_PATTERNS = [
  /\b\d{8,10}:[a-zA-Z0-9_-]{35}\b/g, // Telegram bot token pattern
];

function sanitize(message) {
  if (typeof message !== 'string') {
    return message;
  }
  let sanitized = message;
  for (const pattern of SENSITIVE_PATTERNS) {
    sanitized = sanitized.replace(pattern, '[REDACTED_BOT_TOKEN]');
  }
  return sanitized;
}

function formatMessage(level, message, ...args) {
  const timestamp = new Date().toISOString();
  const safeMessage = sanitize(message);
  const safeArgs = args.map((arg) => {
    if (arg instanceof Error) {
      const errCopy = new Error(sanitize(arg.message));
      errCopy.stack = sanitize(arg.stack || '');
      return errCopy;
    }
    if (typeof arg === 'object' && arg !== null) {
      try {
        return JSON.parse(sanitize(JSON.stringify(arg)));
      } catch {
        return arg;
      }
    }
    return sanitize(arg);
  });

  return [`[${timestamp}] [${level.toUpperCase()}] ${safeMessage}`, ...safeArgs];
}

export const logger = {
  info(message, ...args) {
    console.log(...formatMessage('info', message, ...args));
  },
  warn(message, ...args) {
    console.warn(...formatMessage('warn', message, ...args));
  },
  error(message, ...args) {
    console.error(...formatMessage('error', message, ...args));
  },
  debug(message, ...args) {
    if (process.env.NODE_ENV !== 'production') {
      console.debug(...formatMessage('debug', message, ...args));
    }
  },
};
