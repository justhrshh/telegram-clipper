/**
 * Admin Audit Repository
 *
 * Persists an immutable log of administrative actions (granting/revoking PRO, enabling/disabling access).
 */

import { query } from './pool.js';
import { logger } from '../utils/logger.js';

export const AdminActionType = {
  GRANT_PRO: 'GRANT_PRO',
  REMOVE_PRO: 'REMOVE_PRO',
  DISABLE_ACCESS: 'DISABLE_ACCESS',
  ENABLE_ACCESS: 'ENABLE_ACCESS',
  SET_ROLE: 'SET_ROLE',
};

/**
 * Records an administrative action in the audit log.
 *
 * @param {object} params
 * @param {string|number} params.adminUserId
 * @param {string|number} params.targetUserId
 * @param {string} params.action
 * @param {object} [params.metadata={}]
 * @returns {Promise<object>}
 */
export async function logAdminAction({ adminUserId, targetUserId, action, metadata = {} }) {
  const sql = `
    INSERT INTO admin_actions (admin_user_id, target_user_id, action, metadata, timestamp)
    VALUES ($1, $2, $3, $4, NOW())
    RETURNING *;
  `;

  const metaJson = typeof metadata === 'string' ? metadata : JSON.stringify(metadata);

  try {
    const res = await query(sql, [String(adminUserId), String(targetUserId), action, metaJson]);
    logger.info(`[ADMIN_AUDIT] Admin ${adminUserId} executed ${action} on user ${targetUserId}`);
    return res.rows[0];
  } catch (err) {
    logger.error('[ADMIN_AUDIT_ERROR] Failed to log admin action:', err.message);
    return null;
  }
}

/**
 * Retrieves recent administrative actions.
 *
 * @param {object} [options]
 * @param {number} [options.limit=20]
 * @param {string|number} [options.targetUserId]
 * @returns {Promise<Array<object>>}
 */
export async function getRecentAdminActions({ limit = 20, targetUserId = null } = {}) {
  let sql = 'SELECT * FROM admin_actions';
  const params = [];

  if (targetUserId) {
    sql += ' WHERE target_user_id = $1';
    params.push(String(targetUserId));
  }

  sql += ' ORDER BY timestamp DESC LIMIT $' + (params.length + 1) + ';';
  params.push(limit);

  const res = await query(sql, params);
  return res.rows;
}
