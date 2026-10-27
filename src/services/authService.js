/**
 * Central Authorization & Access Control Service
 *
 * Enforces role hierarchy:
 * OWNER -> ADMIN -> ACCESS STATUS -> PLAN -> FEATURE
 *
 * Rules:
 * - OWNER: Full unrestricted access, all PRO features, cannot be disabled or demoted.
 * - ADMIN: Full access, all PRO features, user management, cannot touch OWNER.
 * - USER: Restricted by access_enabled and active plan (FREE vs PRO).
 */

import {
  getUser as dbGetUser,
  isConfiguredOwner,
  ROLE_OWNER,
  ROLE_ADMIN,
  ROLE_USER,
  PLAN_FREE,
  PLAN_PRO,
} from '../db/userRepository.js';
import { getPlanLimits } from '../config/planLimits.js';
import { getDailyUsageCount } from '../db/clipRequestRepository.js';
import { logger } from '../utils/logger.js';

export { ROLE_OWNER, ROLE_ADMIN, ROLE_USER, PLAN_FREE, PLAN_PRO };
export const FEATURE_SQUARE_FOCUS = 'SQUARE_FOCUS';
export const FEATURE_CAPTION_STUDIO = 'CAPTION_STUDIO';

export class AccessDeniedError extends Error {
  constructor(message = 'Your access to the clipper bot has been disabled by an administrator.') {
    super(message);
    this.name = 'AccessDeniedError';
    this.code = 'ACCESS_DENIED';
  }
}

export class DailyQuotaExceededError extends Error {
  constructor(usage, limit, message) {
    super(
      message ||
        `Daily limit reached (${usage}/${limit} clips). Upgrade to PRO for higher daily limits and premium features.`
    );
    this.name = 'DailyQuotaExceededError';
    this.code = 'DAILY_QUOTA_EXCEEDED';
    this.usage = usage;
    this.limit = limit;
  }
}

export class FeatureLockedError extends Error {
  constructor(feature, message) {
    super(message || `${feature} is a PRO feature.`);
    this.name = 'FeatureLockedError';
    this.code = 'FEATURE_LOCKED';
    this.feature = feature;
  }
}

/**
 * Retrieves the user record, guaranteeing OWNER privileges for configured owner.
 *
 * @param {string|number} userId
 * @returns {Promise<object|null>}
 */
export async function getUser(userId) {
  if (!userId) return null;
  return await dbGetUser(userId);
}

/**
 * Retrieves the resolved role for a user.
 *
 * @param {string|number} userId
 * @returns {Promise<string>} 'OWNER' | 'ADMIN' | 'USER'
 */
export async function getRole(userId) {
  if (!userId) return ROLE_USER;
  if (isConfiguredOwner(userId)) return ROLE_OWNER;

  const user = await dbGetUser(userId);
  return user?.role || ROLE_USER;
}

/**
 * Checks if a user is the OWNER.
 *
 * @param {string|number} userId
 * @returns {boolean}
 */
export function isOwner(userId) {
  return isConfiguredOwner(userId);
}

/**
 * Checks if a user is an ADMIN or OWNER.
 *
 * @param {string|number} userId
 * @returns {Promise<boolean>}
 */
export async function isAdmin(userId) {
  if (!userId) return false;
  if (isConfiguredOwner(userId)) return true;

  const role = await getRole(userId);
  return role === ROLE_OWNER || role === ROLE_ADMIN;
}

/**
 * Checks if a user has unrestricted application access (OWNER or ADMIN).
 *
 * @param {string|number} userId
 * @returns {Promise<boolean>}
 */
export async function hasFullAccess(userId) {
  return await isAdmin(userId);
}

/**
 * Checks if a user is allowed access to the bot.
 * OWNER and ADMIN are always enabled.
 *
 * @param {string|number} userId
 * @returns {Promise<boolean>}
 */
export async function isAccessEnabled(userId) {
  if (!userId) return false;
  if (isConfiguredOwner(userId)) return true;

  const user = await dbGetUser(userId);
  if (!user) return true; // Default new users are enabled
  if (user.role === ROLE_OWNER || user.role === ROLE_ADMIN) return true;

  return Boolean(user.access_enabled);
}

/**
 * Checks if a user has a specific plan.
 * OWNER and ADMIN always satisfy PLAN_PRO.
 *
 * @param {string|number} userId
 * @param {string} plan - 'FREE' | 'PRO'
 * @returns {Promise<boolean>}
 */
export async function hasPlan(userId, plan) {
  if (!userId) return false;
  if (isConfiguredOwner(userId)) return true;

  const user = await dbGetUser(userId);
  if (user?.role === ROLE_OWNER || user?.role === ROLE_ADMIN) return true;

  if (plan === PLAN_PRO) {
    return user?.plan === PLAN_PRO;
  }
  return true;
}

/**
 * Checks if a user can use a specific feature (e.g. SQUARE_FOCUS).
 *
 * OWNER & ADMIN -> ALWAYS TRUE
 * USER -> must be access_enabled and have PRO plan for SQUARE_FOCUS.
 *
 * @param {string|number} userId
 * @param {string} feature
 * @returns {Promise<boolean>}
 */
export async function canUseFeature(userId, feature) {
  if (!userId) return false;

  // 1. Owner & Admin bypass all feature paywalls
  if (await isAdmin(userId)) {
    return true;
  }

  // 2. Check general access
  const enabled = await isAccessEnabled(userId);
  if (!enabled) {
    return false;
  }

  // 3. Feature paywalls (Square Focus & Caption Studio)
  if (feature === FEATURE_SQUARE_FOCUS || feature === FEATURE_CAPTION_STUDIO) {
    return await hasPlan(userId, PLAN_PRO);
  }

  return true;
}

/**
 * Asserts that a user has general bot access. Throws AccessDeniedError if disabled.
 *
 * @param {string|number} userId
 */
export async function assertAccessEnabled(userId) {
  const allowed = await isAccessEnabled(userId);
  if (!allowed) {
    logger.warn(`[AUTH] Access denied for disabled user ${userId}`);
    throw new AccessDeniedError();
  }
}

/**
 * Asserts that a user has permission to use a specific feature.
 * Throws FeatureLockedError if paywalled, or AccessDeniedError if disabled.
 *
 * @param {object} params
 * @param {string|number} params.userId
 * @param {string} params.feature
 */
export async function assertFeatureAccess({ userId, feature }) {
  await assertAccessEnabled(userId);

  const allowed = await canUseFeature(userId, feature);
  if (!allowed) {
    logger.warn(`[AUTH_GATE] Feature ${feature} locked for user ${userId}`);
    throw new FeatureLockedError(
      feature,
      'Square Focus is a PRO feature. Upgrade to Pro to unlock premium 1:1 cinematic exports.'
    );
  }

  return true;
}

/**
 * Returns the number of clips used today by a user.
 *
 * @param {string|number} userId
 * @returns {Promise<number>}
 */
export async function getDailyUsage(userId) {
  if (!userId) return 0;
  return await getDailyUsageCount(userId);
}

/**
 * Retrieves daily quota breakdown for a user.
 *
 * @param {string|number} userId
 * @returns {Promise<{ usage: number, limit: number, remaining: number, isUnlimited: boolean, role: string, plan: string }>}
 */
export async function getRemainingDailyQuota(userId) {
  if (!userId) {
    return { usage: 0, limit: 0, remaining: 0, isUnlimited: false, role: ROLE_USER, plan: PLAN_FREE };
  }

  const role = await getRole(userId);
  const isFullAccess = role === ROLE_OWNER || role === ROLE_ADMIN;
  const usage = await getDailyUsageCount(userId);

  if (isFullAccess) {
    return {
      usage,
      limit: Infinity,
      remaining: Infinity,
      isUnlimited: true,
      role,
      plan: role,
    };
  }

  const user = await dbGetUser(userId);
  const plan = user?.plan || PLAN_FREE;
  const limits = getPlanLimits(role, plan);
  const limit = limits.dailyClips;
  const remaining = Math.max(0, limit - usage);

  return {
    usage,
    limit,
    remaining,
    isUnlimited: false,
    role,
    plan,
  };
}

/**
 * Checks whether a user has enough remaining daily quota to create clips.
 *
 * @param {string|number} userId
 * @param {number} [count=1]
 * @returns {Promise<boolean>}
 */
export async function canCreateClip(userId, count = 1) {
  if (!userId) return false;
  if (await isAdmin(userId)) return true;

  const enabled = await isAccessEnabled(userId);
  if (!enabled) return false;

  const quota = await getRemainingDailyQuota(userId);
  return quota.remaining >= count;
}

/**
 * Asserts that a user has sufficient quota and is allowed to create clips.
 * Throws DailyQuotaExceededError or AccessDeniedError.
 *
 * @param {string|number} userId
 * @param {number} [count=1]
 * @returns {Promise<boolean>}
 */
export async function assertCanCreateClip(userId, count = 1) {
  await assertAccessEnabled(userId);

  if (await isAdmin(userId)) {
    return true;
  }

  const quota = await getRemainingDailyQuota(userId);
  if (quota.remaining < count) {
    logger.warn(`[QUOTA_GATE] User ${userId} exceeded daily quota: ${quota.usage}/${quota.limit}, requested: ${count}`);
    throw new DailyQuotaExceededError(
      quota.usage,
      quota.limit,
      `Daily limit reached (${quota.usage}/${quota.limit} clips). Upgrade to PRO for higher daily limits and premium features.`
    );
  }

  return true;
}

/**
 * Validates quota reservation for upfront batch or single clips.
 *
 * @param {string|number} userId
 * @param {number} [count=1]
 * @returns {Promise<{ usage: number, limit: number, remaining: number, isUnlimited: boolean, role: string, plan: string }>}
 */
export async function reserveClipQuota(userId, count = 1) {
  await assertCanCreateClip(userId, count);
  return await getRemainingDailyQuota(userId);
}

