/**
 * Caption Preset Repository
 *
 * Provides database persistence for user-created custom studio presets
 * and last-used styling preferences in PostgreSQL.
 *
 * Strict user scoping: All queries enforce WHERE telegram_user_id = $1.
 */

import { query } from './pool.js';
import { logger } from '../utils/logger.js';

/**
 * Saves or updates a user-named caption preset.
 *
 * @param {object} params
 * @param {string|number} params.telegramUserId
 * @param {string} params.presetName
 * @param {object} params.config
 * @returns {Promise<object>}
 */
export async function saveUserCaptionPreset({ telegramUserId, presetName, config }) {
  if (!telegramUserId || !presetName || !config) {
    throw new Error('telegramUserId, presetName, and config are required');
  }

  const uid = String(telegramUserId);
  const cleanName = String(presetName).trim();
  const configJson = typeof config === 'string' ? config : JSON.stringify(config);

  const sql = `
    INSERT INTO user_caption_presets (telegram_user_id, preset_name, config)
    VALUES ($1, $2, $3::jsonb)
    ON CONFLICT (telegram_user_id, LOWER(preset_name))
    DO UPDATE SET
      preset_name = EXCLUDED.preset_name,
      config = EXCLUDED.config,
      created_at = NOW()
    RETURNING *;
  `;

  const res = await query(sql, [uid, cleanName, configJson]);
  logger.info(`[CAPTION_PRESET] User ${uid} saved preset '${cleanName}'`);
  return res.rows[0];
}

/**
 * Retrieves all presets saved by a specific user.
 *
 * @param {string|number} telegramUserId
 * @returns {Promise<Array<object>>}
 */
export async function getUserCaptionPresets(telegramUserId) {
  if (!telegramUserId) return [];
  const uid = String(telegramUserId);

  const sql = `
    SELECT id, telegram_user_id, preset_name, config, created_at
    FROM user_caption_presets
    WHERE telegram_user_id = $1
    ORDER BY created_at DESC;
  `;

  const res = await query(sql, [uid]);
  return res.rows.map((row) => ({
    ...row,
    config: typeof row.config === 'string' ? JSON.parse(row.config) : row.config,
  }));
}

/**
 * Retrieves a single preset by name for a specific user.
 *
 * @param {string|number} telegramUserId
 * @param {string} presetName
 * @returns {Promise<object|null>}
 */
export async function getUserCaptionPresetByName(telegramUserId, presetName) {
  if (!telegramUserId || !presetName) return null;
  const uid = String(telegramUserId);
  const cleanName = String(presetName).trim();

  const sql = `
    SELECT id, telegram_user_id, preset_name, config, created_at
    FROM user_caption_presets
    WHERE telegram_user_id = $1 AND LOWER(preset_name) = LOWER($2)
    LIMIT 1;
  `;

  const res = await query(sql, [uid, cleanName]);
  if (!res.rows[0]) return null;

  const row = res.rows[0];
  return {
    ...row,
    config: typeof row.config === 'string' ? JSON.parse(row.config) : row.config,
  };
}

/**
 * Deletes a preset by name for a specific user.
 *
 * @param {string|number} telegramUserId
 * @param {string} presetName
 * @returns {Promise<boolean>}
 */
export async function deleteUserCaptionPreset(telegramUserId, presetName) {
  if (!telegramUserId || !presetName) return false;
  const uid = String(telegramUserId);
  const cleanName = String(presetName).trim();

  const sql = `
    DELETE FROM user_caption_presets
    WHERE telegram_user_id = $1 AND LOWER(preset_name) = LOWER($2)
    RETURNING id;
  `;

  const res = await query(sql, [uid, cleanName]);
  const deleted = (res.rowCount || 0) > 0;
  if (deleted) {
    logger.info(`[CAPTION_PRESET] User ${uid} deleted preset '${cleanName}'`);
  }
  return deleted;
}

/**
 * Retrieves the last-used caption configuration for a user.
 *
 * @param {string|number} telegramUserId
 * @returns {Promise<object|null>}
 */
export async function getUserLastCaptionConfig(telegramUserId) {
  if (!telegramUserId) return null;
  const uid = String(telegramUserId);

  const sql = `
    SELECT last_caption_config
    FROM users
    WHERE telegram_user_id = $1
    LIMIT 1;
  `;

  const res = await query(sql, [uid]);
  const row = res.rows[0];
  if (!row || !row.last_caption_config) return null;

  return typeof row.last_caption_config === 'string'
    ? JSON.parse(row.last_caption_config)
    : row.last_caption_config;
}

/**
 * Persists the user's last-used caption configuration.
 *
 * @param {string|number} telegramUserId
 * @param {object} config
 * @returns {Promise<object|null>}
 */
export async function saveUserLastCaptionConfig(telegramUserId, config) {
  if (!telegramUserId || !config) return null;
  const uid = String(telegramUserId);
  const configJson = typeof config === 'string' ? config : JSON.stringify(config);

  const sql = `
    UPDATE users
    SET last_caption_config = $2::jsonb
    WHERE telegram_user_id = $1
    RETURNING last_caption_config;
  `;

  const res = await query(sql, [uid, configJson]);
  logger.debug(`[CAPTION_PRESET] User ${uid} updated last_caption_config`);
  return res.rows[0]?.last_caption_config || null;
}
