/**
 * Subscription Repository
 *
 * Prepares the platform for future subscription management and monetization.
 */

import { query } from './pool.js';
import { logger } from '../utils/logger.js';

export const SubscriptionStatus = {
  ACTIVE: 'ACTIVE',
  CANCELLED: 'CANCELLED',
  EXPIRED: 'EXPIRED',
  INTERESTED: 'INTERESTED',
};

export const SubscriptionProvider = {
  MANUAL: 'MANUAL',
  NOTIFY_ME: 'NOTIFY_ME',
};

/**
 * Records or updates a subscription for a user.
 *
 * @param {object} params
 * @param {string|number} params.telegramUserId
 * @param {string} [params.plan='PRO']
 * @param {string} [params.status='ACTIVE']
 * @param {string} [params.provider='MANUAL']
 * @param {string} [params.providerSubscriptionId]
 * @param {Date|string} [params.expiresAt]
 * @returns {Promise<object>}
 */
export async function recordSubscription({
  telegramUserId,
  plan = 'PRO',
  status = SubscriptionStatus.ACTIVE,
  provider = 'MANUAL',
  providerSubscriptionId = null,
  expiresAt = null,
}) {
  const uid = String(telegramUserId);
  const expires = expiresAt ? new Date(expiresAt) : null;

  const sql = `
    INSERT INTO subscriptions (
      telegram_user_id, plan, status, provider, provider_subscription_id, started_at, expires_at, created_at, updated_at
    )
    VALUES ($1, $2, $3, $4, $5, NOW(), $6, NOW(), NOW())
    RETURNING *;
  `;

  const res = await query(sql, [uid, plan, status, provider, providerSubscriptionId, expires]);
  return res.rows[0];
}

/**
 * Retrieves the latest active subscription for a user.
 *
 * @param {string|number} telegramUserId
 * @returns {Promise<object|null>}
 */
export async function getUserSubscription(telegramUserId) {
  const uid = String(telegramUserId);
  const sql = `
    SELECT *
    FROM subscriptions
    WHERE telegram_user_id = $1
    ORDER BY created_at DESC
    LIMIT 1;
  `;
  const res = await query(sql, [uid]);
  return res.rows[0] || null;
}

/**
 * Retrieves the PRO interest subscription entry for a user if present.
 *
 * @param {string|number} telegramUserId
 * @returns {Promise<object|null>}
 */
export async function getProInterest(telegramUserId) {
  const uid = String(telegramUserId);
  const sql = `
    SELECT *
    FROM subscriptions
    WHERE telegram_user_id = $1 AND status = 'INTERESTED'
    ORDER BY created_at DESC
    LIMIT 1;
  `;
  const res = await query(sql, [uid]);
  return res.rows[0] || null;
}

/**
 * Checks if a user has expressed interest in PRO notifications.
 *
 * @param {string|number} telegramUserId
 * @returns {Promise<boolean>}
 */
export async function hasProInterest(telegramUserId) {
  const interest = await getProInterest(telegramUserId);
  return Boolean(interest);
}

/**
 * Records a user's interest in PRO notifications.
 * Idempotent: does not insert duplicates if already registered.
 *
 * @param {string|number} telegramUserId
 * @returns {Promise<{ alreadyRegistered: boolean, subscription: object }>}
 */
export async function recordProInterest(telegramUserId) {
  const uid = String(telegramUserId);
  const existing = await getProInterest(uid);
  if (existing) {
    return { alreadyRegistered: true, subscription: existing };
  }

  const subscription = await recordSubscription({
    telegramUserId: uid,
    plan: 'PRO',
    status: SubscriptionStatus.INTERESTED,
    provider: SubscriptionProvider.NOTIFY_ME,
  });

  logger.info(`[PRO_INTEREST] User ${uid} registered interest in PRO notifications`);
  return { alreadyRegistered: false, subscription };
}

/**
 * Gets the total count of unique users who registered interest in PRO.
 *
 * @returns {Promise<number>}
 */
export async function getProInterestCount() {
  const sql = `
    SELECT COUNT(DISTINCT telegram_user_id)::integer AS count
    FROM subscriptions
    WHERE status = 'INTERESTED';
  `;
  const res = await query(sql);
  return res.rows[0]?.count ? parseInt(res.rows[0].count, 10) : 0;
}

/**
 * Lists users who registered interest in PRO with pagination and user metadata.
 *
 * @param {object} [options]
 * @param {number} [options.limit=10]
 * @param {number} [options.offset=0]
 * @returns {Promise<Array<object>>}
 */
export async function getProInterestedUsers({ limit = 10, offset = 0 } = {}) {
  const sql = `
    SELECT s.id, s.telegram_user_id, s.created_at,
           u.username, u.first_name, u.last_name, u.plan, u.role
    FROM subscriptions s
    LEFT JOIN users u ON s.telegram_user_id = u.telegram_user_id
    WHERE s.status = 'INTERESTED'
    ORDER BY s.created_at DESC
    LIMIT $1 OFFSET $2;
  `;
  const res = await query(sql, [limit, offset]);
  return res.rows || [];
}

