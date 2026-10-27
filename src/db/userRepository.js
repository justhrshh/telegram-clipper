/**
 * User Repository
 *
 * Provides persistent user management, statistics aggregation, and role/plan/access enforcement.
 * Guaranteed protection for the OWNER account at all times.
 */

import { query } from './pool.js';
import { config } from '../config/env.js';
import { logger } from '../utils/logger.js';

export const ROLE_OWNER = 'OWNER';
export const ROLE_ADMIN = 'ADMIN';
export const ROLE_USER = 'USER';

export const PLAN_FREE = 'FREE';
export const PLAN_PRO = 'PRO';

/**
 * Checks if a telegram user ID corresponds to the configured Owner.
 *
 * @param {string|number} userId
 * @returns {boolean}
 */
export function isConfiguredOwner(userId) {
  if (!userId) return false;
  const ownerId = (config.adminTelegramUserId || '').trim();
  return Boolean(ownerId && String(userId) === ownerId);
}

/**
 * Inserts or updates a user upon activity, recording latest metadata and last_seen_at.
 * Guarantees OWNER privileges if userId matches ADMIN_TELEGRAM_USER_ID.
 * Preserves previously known username unless explicitly removed.
 *
 * @param {object} params
 * @param {string|number} params.telegramUserId
 * @param {string|null} [params.username]
 * @param {string|null} [params.firstName]
 * @param {string|null} [params.lastName]
 * @param {boolean} [params.removeUsername=false]
 * @returns {Promise<object>}
 */
export async function touchUser({ telegramUserId, username, firstName, lastName, removeUsername = false }) {
  if (!telegramUserId) return null;

  const uid = String(telegramUserId);
  const isOwner = isConfiguredOwner(uid);
  const defaultRole = isOwner ? ROLE_OWNER : ROLE_USER;
  const defaultPlan = isOwner ? PLAN_PRO : PLAN_FREE;

  const cleanUsername = (username && typeof username === 'string' && username.trim() !== '')
    ? username.trim().replace(/^@/, '')
    : null;
  const cleanFirstName = (firstName && typeof firstName === 'string') ? firstName.trim() : null;
  const cleanLastName = (lastName && typeof lastName === 'string') ? lastName.trim() : null;

  const sql = `
    INSERT INTO users (
      telegram_user_id, username, first_name, last_name, role, plan, access_enabled, last_seen_at
    )
    VALUES ($1, $2, $3, $4, $5, $6, true, NOW())
    ON CONFLICT (telegram_user_id)
    DO UPDATE SET
      username = CASE
        WHEN $7::boolean = true THEN NULL
        WHEN EXCLUDED.username IS NOT NULL AND EXCLUDED.username != '' THEN EXCLUDED.username
        ELSE users.username
      END,
      first_name = COALESCE(EXCLUDED.first_name, users.first_name),
      last_name = COALESCE(EXCLUDED.last_name, users.last_name),
      last_seen_at = NOW(),
      role = CASE WHEN users.role = 'OWNER' OR EXCLUDED.role = 'OWNER' THEN 'OWNER' ELSE users.role END,
      plan = CASE WHEN users.role = 'OWNER' OR EXCLUDED.role = 'OWNER' THEN 'PRO' ELSE users.plan END,
      access_enabled = CASE WHEN users.role = 'OWNER' OR EXCLUDED.role = 'OWNER' THEN true ELSE users.access_enabled END
    RETURNING *;
  `;

  const res = await query(sql, [
    uid,
    cleanUsername,
    cleanFirstName,
    cleanLastName,
    defaultRole,
    defaultPlan,
    Boolean(removeUsername),
  ]);
  return res.rows[0] || null;
}

/**
 * Retrieves a user record by Telegram ID.
 * If user does not exist in DB but matches ADMIN_TELEGRAM_USER_ID, automatically touches and returns owner.
 *
 * @param {string|number} telegramUserId
 * @returns {Promise<object|null>}
 */
export async function getUser(telegramUserId) {
  if (!telegramUserId) return null;
  const uid = String(telegramUserId);

  const res = await query('SELECT * FROM users WHERE telegram_user_id = $1;', [uid]);
  let user = res.rows[0] || null;

  if (isConfiguredOwner(uid)) {
    if (!user) {
      user = await touchUser({ telegramUserId: uid });
    } else if (user.role !== ROLE_OWNER || user.plan !== PLAN_PRO || !user.access_enabled) {
      // Force OWNER guarantees
      await query(
        `UPDATE users SET role = 'OWNER', plan = 'PRO', access_enabled = true WHERE telegram_user_id = $1;`,
        [uid]
      );
      user.role = ROLE_OWNER;
      user.plan = PLAN_PRO;
      user.access_enabled = true;
    }
  }

  return user;
}

/**
 * Finds a user by ID or Username (strips leading @, case-insensitive).
 *
 * @param {string} queryStr
 * @returns {Promise<object|null>}
 */
export async function findUserByIdOrUsername(queryStr) {
  if (!queryStr) return null;
  const clean = queryStr.trim();
  const cleanUname = clean.replace(/^@/, '');

  const sql = `
    SELECT * FROM users
    WHERE telegram_user_id = $1 OR LOWER(username) = LOWER($2)
    LIMIT 1;
  `;
  const res = await query(sql, [clean, cleanUname]);
  return res.rows[0] || null;
}

/**
 * Lists users with pagination and optional filter.
 *
 * @param {object} params
 * @param {number} [params.page=1]
 * @param {number} [params.limit=10]
 * @param {string} [params.filter='ALL'] - 'ALL' | 'PRO' | 'DISABLED'
 * @returns {Promise<{ users: Array<object>, total: number, page: number, totalPages: number }>}
 */
export async function listUsers({ page = 1, limit = 10, filter = 'ALL' } = {}) {
  const pageNum = Math.max(1, parseInt(page, 10) || 1);
  const limitNum = Math.max(1, parseInt(limit, 10) || 10);
  const offset = (pageNum - 1) * limitNum;

  let whereClause = '';
  if (filter === 'PRO') {
    whereClause = "WHERE plan = 'PRO'";
  } else if (filter === 'DISABLED') {
    whereClause = 'WHERE access_enabled = false';
  }

  const countSql = `SELECT COUNT(*) FROM users ${whereClause};`;
  const countRes = await query(countSql);
  const total = parseInt(countRes.rows[0]?.count || 0, 10);

  const selectSql = `
    SELECT * FROM users
    ${whereClause}
    ORDER BY last_seen_at DESC
    LIMIT $1 OFFSET $2;
  `;
  const selectRes = await query(selectSql, [limitNum, offset]);

  return {
    users: selectRes.rows,
    total,
    page: pageNum,
    totalPages: Math.max(1, Math.ceil(total / limitNum)),
  };
}

/**
 * Updates a user's role.
 * Protects OWNER from demotion.
 *
 * @param {string|number} telegramUserId
 * @param {string} role - 'OWNER' | 'ADMIN' | 'USER'
 * @returns {Promise<object>}
 */
export async function setUserRole(telegramUserId, role) {
  const uid = String(telegramUserId);
  const target = await getUser(uid);

  if (target?.role === ROLE_OWNER && role !== ROLE_OWNER) {
    throw new Error('Protected account: The OWNER cannot be demoted.');
  }

  const res = await query('UPDATE users SET role = $1 WHERE telegram_user_id = $2 RETURNING *;', [role, uid]);
  return res.rows[0];
}

/**
 * Updates a user's plan.
 * Protects OWNER from losing PRO status.
 *
 * @param {string|number} telegramUserId
 * @param {string} plan - 'FREE' | 'PRO'
 * @returns {Promise<object>}
 */
export async function setUserPlan(telegramUserId, plan) {
  const uid = String(telegramUserId);
  const normalizedPlan = plan === PLAN_PRO ? PLAN_PRO : PLAN_FREE;

  if (isConfiguredOwner(uid) && normalizedPlan !== PLAN_PRO) {
    throw new Error('Protected account: The OWNER cannot lose PRO status.');
  }

  const res = await query('UPDATE users SET plan = $1 WHERE telegram_user_id = $2 RETURNING *;', [normalizedPlan, uid]);
  logger.info(`[USER_PLAN] User ${uid} plan updated to ${normalizedPlan}`);
  return res.rows[0];
}

/**
 * Updates a user's access toggle (enabled or disabled).
 * Protects OWNER from being disabled.
 *
 * @param {string|number} telegramUserId
 * @param {boolean} accessEnabled
 * @returns {Promise<object>}
 */
export async function setUserAccess(telegramUserId, accessEnabled) {
  const uid = String(telegramUserId);
  const isEnabled = Boolean(accessEnabled);

  if (isConfiguredOwner(uid) && !isEnabled) {
    throw new Error('Protected account: The OWNER cannot be disabled.');
  }

  const res = await query('UPDATE users SET access_enabled = $1 WHERE telegram_user_id = $2 RETURNING *;', [isEnabled, uid]);
  logger.info(`[USER_ACCESS] User ${uid} access_enabled set to ${isEnabled}`);
  return res.rows[0];
}

/**
 * Increments a user's request count and updates last_request_at.
 *
 * @param {string|number} telegramUserId
 * @returns {Promise<object>}
 */
export async function recordUserRequest(telegramUserId) {
  const uid = String(telegramUserId);
  const sql = `
    UPDATE users
    SET total_requests = total_requests + 1,
        last_request_at = NOW(),
        last_seen_at = NOW()
    WHERE telegram_user_id = $1
    RETURNING *;
  `;
  const res = await query(sql, [uid]);
  return res.rows[0];
}

/**
 * Increments clip execution counters ('total_clips', 'successful_clips', 'failed_clips').
 *
 * @param {string|number} telegramUserId
 * @param {'total_clips'|'successful_clips'|'failed_clips'} field
 * @returns {Promise<object>}
 */
export async function incrementUserCounter(telegramUserId, field) {
  const uid = String(telegramUserId);
  const allowed = ['total_clips', 'successful_clips', 'failed_clips'];
  if (!allowed.includes(field)) {
    throw new Error(`Invalid counter field: ${field}`);
  }

  const sql = `
    UPDATE users
    SET ${field} = ${field} + 1
    WHERE telegram_user_id = $1
    RETURNING *;
  `;
  const res = await query(sql, [uid]);
  return res.rows[0];
}

/**
 * Aggregates live metrics for the admin dashboard.
 *
 * @returns {Promise<object>}
 */
export async function getDashboardStats() {
  const sql = `
    SELECT
      COUNT(*) AS total_users,
      COUNT(*) FILTER (WHERE plan = 'PRO') AS pro_users,
      COUNT(*) FILTER (WHERE access_enabled = false) AS disabled_users,
      COALESCE(SUM(total_clips), 0) AS total_clips,
      COALESCE(SUM(successful_clips), 0) AS successful_clips,
      COALESCE(SUM(failed_clips), 0) AS failed_clips,
      (SELECT COUNT(*) FROM clip_requests WHERE requested_at >= CURRENT_DATE) AS requests_today
    FROM users;
  `;
  const res = await query(sql);
  const row = res.rows[0] || {};
  return {
    total_users: parseInt(row.total_users || 0, 10),
    pro_users: parseInt(row.pro_users || 0, 10),
    disabled_users: parseInt(row.disabled_users || 0, 10),
    total_clips: parseInt(row.total_clips || 0, 10),
    successful_clips: parseInt(row.successful_clips || 0, 10),
    failed_clips: parseInt(row.failed_clips || 0, 10),
    requests_today: parseInt(row.requests_today || 0, 10),
  };
}

/**
 * Retrieves top users by completed clip volume.
 *
 * @param {number} [limit=5]
 * @returns {Promise<Array<object>>}
 */
export async function getTopUsers(limit = 5) {
  const sql = `
    SELECT telegram_user_id, username, first_name, plan, role, total_clips, successful_clips, total_requests
    FROM users
    ORDER BY total_clips DESC, total_requests DESC
    LIMIT $1;
  `;
  const res = await query(sql, [limit]);
  return res.rows;
}

/**
 * Returns daily clip request counts for the past N days.
 *
 * @param {number} [days=7]
 * @returns {Promise<Array<{ day: string, count: number }>>}
 */
export async function getDailyStats(days = 7) {
  const sql = `
    SELECT
      TO_CHAR(d.day, 'YYYY-MM-DD') AS day,
      COUNT(c.id) AS count
    FROM (
      SELECT generate_series(
        CURRENT_DATE - INTERVAL '${days - 1} days',
        CURRENT_DATE,
        '1 day'::interval
      )::date AS day
    ) d
    LEFT JOIN clip_requests c
      ON c.requested_at::date = d.day
    GROUP BY d.day
    ORDER BY d.day ASC;
  `;

  try {
    const res = await query(sql);
    return res.rows.map((r) => ({ day: r.day, count: parseInt(r.count || 0, 10) }));
  } catch {
    // Fallback if generate_series is unavailable or in memory mode
    const counts = [];
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      counts.push({ day: d.toISOString().split('T')[0], count: 0 });
    }
    return counts;
  }
}
