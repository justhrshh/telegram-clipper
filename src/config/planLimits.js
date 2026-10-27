/**
 * Centralized Plan & Usage Limits Configuration
 *
 * Defines daily clip limits and feature entitlements per tier/role.
 */

export const PLAN_LIMITS = {
  FREE: {
    dailyClips: 10,
    squareFocus: false,
    label: 'FREE',
  },
  PRO: {
    dailyClips: 100,
    squareFocus: true,
    label: 'PRO',
  },
  ADMIN: {
    dailyClips: Infinity,
    squareFocus: true,
    label: 'ADMIN',
  },
  OWNER: {
    dailyClips: Infinity,
    squareFocus: true,
    label: 'OWNER',
  },
};

/**
 * Returns the configured limits for a role/plan.
 *
 * @param {string} role - 'OWNER' | 'ADMIN' | 'USER'
 * @param {string} [plan='FREE'] - 'FREE' | 'PRO'
 * @returns {{ dailyClips: number, squareFocus: boolean, label: string }}
 */
export function getPlanLimits(role, plan = 'FREE') {
  if (role === 'OWNER') return PLAN_LIMITS.OWNER;
  if (role === 'ADMIN') return PLAN_LIMITS.ADMIN;
  if (plan === 'PRO') return PLAN_LIMITS.PRO;
  return PLAN_LIMITS.FREE;
}
