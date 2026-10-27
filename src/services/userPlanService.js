/**
 * User Plan Service
 *
 * Integrates user plan management with the PostgreSQL database and central auth service.
 */

import {
  getUser as repoGetUser,
  setUserPlan as repoSetUserPlan,
  isConfiguredOwner,
  PLAN_FREE,
  PLAN_PRO,
} from '../db/userRepository.js';
import { canUseFeature, FEATURE_SQUARE_FOCUS } from './authService.js';
import { logger } from '../utils/logger.js';

export { PLAN_FREE, PLAN_PRO, FEATURE_SQUARE_FOCUS };

/**
 * Retrieves the plan for a specific Telegram user ID.
 * Returns 'PRO' if owner/admin or user plan is PRO, else 'FREE'.
 *
 * @param {string|number} userId
 * @returns {Promise<string>} 'FREE' | 'PRO'
 */
export async function getUserPlan(userId) {
  if (!userId) return PLAN_FREE;
  if (isConfiguredOwner(userId)) return PLAN_PRO;

  const user = await repoGetUser(userId);
  return user?.plan === PLAN_PRO ? PLAN_PRO : PLAN_FREE;
}

/**
 * Checks if a user has active PRO status.
 *
 * @param {string|number} userId
 * @returns {Promise<boolean>}
 */
export async function isPro(userId) {
  if (isConfiguredOwner(userId)) return true;
  return await canUseFeature(userId, FEATURE_SQUARE_FOCUS);
}

/**
 * Updates a user's plan and persists to database.
 *
 * @param {string|number} userId
 * @param {string} plan - 'FREE' | 'PRO'
 * @returns {Promise<object>}
 */
export async function setUserPlan(userId, plan) {
  return await repoSetUserPlan(userId, plan);
}
