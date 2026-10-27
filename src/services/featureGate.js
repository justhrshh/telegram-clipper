/**
 * Feature Gate Service
 *
 * Enforces entitlement access for premium features (e.g. SQUARE_FOCUS).
 * Integrates with authService so OWNER and ADMIN automatically bypass paywalls.
 */

import {
  assertFeatureAccess as authAssertFeatureAccess,
  canUseFeature,
  FeatureLockedError,
  FEATURE_SQUARE_FOCUS,
} from './authService.js';

export { FeatureLockedError, FEATURE_SQUARE_FOCUS, canUseFeature };

/**
 * Asserts that a user has access to a specific premium feature.
 * Throws FeatureLockedError if access is denied.
 *
 * @param {object} params
 * @param {string|number} params.userId
 * @param {string} params.feature
 * @returns {Promise<boolean>}
 */
export async function assertFeatureAccess({ userId, feature }) {
  return await authAssertFeatureAccess({ userId, feature });
}
