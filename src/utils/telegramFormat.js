/**
 * Telegram Message Formatting & Escaping Utilities
 *
 * Centralized, safe escaping for Telegram parse modes:
 * - HTML: Escapes &, <, >, " to prevent broken entities or markup injection.
 * - MarkdownV2: Escapes all 18 reserved characters per official Telegram Bot API spec.
 * - Markdown (legacy): Escapes _, *, `, [, \ for backward compatibility.
 */

/**
 * Escapes characters for Telegram's HTML parse mode.
 *
 * All <, >, &, " symbols that are not part of tags MUST be replaced
 * with corresponding HTML entities per Telegram Bot API specifications:
 * - & -> &amp;
 * - < -> &lt;
 * - > -> &gt;
 * - " -> &quot;
 *
 * Non-string values (null, undefined) are safely handled.
 *
 * @param {any} value - Raw string, number, or object to escape
 * @returns {string} Safe HTML string for Telegram
 */
export function escapeTelegramHtml(value) {
  if (value === null || value === undefined) {
    return '';
  }
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Escapes characters for Telegram's MarkdownV2 parse mode.
 * Reserved characters in MarkdownV2:
 * _ * [ ] ( ) ~ ` > # + - = | { } . ! \
 *
 * @param {any} value - Raw string or value
 * @returns {string} Safe MarkdownV2 string
 */
export function escapeTelegramMarkdownV2(value) {
  if (value === null || value === undefined) {
    return '';
  }
  return String(value).replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, '\\$&');
}

/**
 * Escapes characters for Telegram's legacy Markdown parse mode.
 * Reserved characters in legacy Markdown:
 * _ * ` [ \
 *
 * @param {any} value - Raw string or value
 * @returns {string} Safe legacy Markdown string
 */
export function escapeTelegramMarkdown(value) {
  if (value === null || value === undefined) {
    return '';
  }
  return String(value).replace(/[_*`[\\]/g, '\\$&');
}
