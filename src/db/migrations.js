/**
 * PostgreSQL Database Migrations & Seeding
 *
 * Creates tables, indexes, seeds the Owner record, and migrates legacy users.json data.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { query, withTransaction } from './pool.js';
import { config } from '../config/env.js';
import { logger } from '../utils/logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const USERS_JSON_PATH = path.resolve(__dirname, '../../data/users.json');

const DDL_MIGRATIONS = [
  // 1. Users table
  `CREATE TABLE IF NOT EXISTS users (
    telegram_user_id VARCHAR(64) PRIMARY KEY,
    username VARCHAR(255),
    first_name VARCHAR(255),
    last_name VARCHAR(255),
    role VARCHAR(32) NOT NULL DEFAULT 'USER',
    plan VARCHAR(32) NOT NULL DEFAULT 'FREE',
    access_enabled BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_request_at TIMESTAMPTZ,
    total_requests INTEGER NOT NULL DEFAULT 0,
    total_clips INTEGER NOT NULL DEFAULT 0,
    successful_clips INTEGER NOT NULL DEFAULT 0,
    failed_clips INTEGER NOT NULL DEFAULT 0
  );`,

  // Indexes for users
  `CREATE INDEX IF NOT EXISTS idx_users_username ON users (LOWER(username));`,
  `CREATE INDEX IF NOT EXISTS idx_users_role ON users (role);`,
  `CREATE INDEX IF NOT EXISTS idx_users_plan ON users (plan);`,
  `CREATE INDEX IF NOT EXISTS idx_users_access_enabled ON users (access_enabled);`,
  `CREATE INDEX IF NOT EXISTS idx_users_last_seen_at ON users (last_seen_at DESC);`,

  // 2. Clip Requests table
  `CREATE TABLE IF NOT EXISTS clip_requests (
    id BIGSERIAL PRIMARY KEY,
    telegram_user_id VARCHAR(64) NOT NULL REFERENCES users(telegram_user_id) ON DELETE CASCADE,
    youtube_url TEXT NOT NULL,
    requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    start_seconds NUMERIC(10, 2),
    end_seconds NUMERIC(10, 2),
    duration NUMERIC(10, 2),
    format VARCHAR(64),
    presentation_style VARCHAR(64),
    captions VARCHAR(64),
    status VARCHAR(32) NOT NULL DEFAULT 'REQUESTED',
    job_id VARCHAR(128) UNIQUE,
    completed_at TIMESTAMPTZ,
    error_message TEXT
  );`,

  // Indexes for clip_requests
  `CREATE INDEX IF NOT EXISTS idx_clip_requests_user ON clip_requests (telegram_user_id);`,
  `CREATE INDEX IF NOT EXISTS idx_clip_requests_job_id ON clip_requests (job_id);`,
  `CREATE INDEX IF NOT EXISTS idx_clip_requests_status ON clip_requests (status);`,
  `CREATE INDEX IF NOT EXISTS idx_clip_requests_requested_at ON clip_requests (requested_at DESC);`,

  // 3. Admin Actions table
  `CREATE TABLE IF NOT EXISTS admin_actions (
    id BIGSERIAL PRIMARY KEY,
    admin_user_id VARCHAR(64) NOT NULL,
    target_user_id VARCHAR(64) NOT NULL,
    action VARCHAR(64) NOT NULL,
    timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    metadata JSONB DEFAULT '{}'::jsonb
  );`,

  // Indexes for admin_actions
  `CREATE INDEX IF NOT EXISTS idx_admin_actions_target ON admin_actions (target_user_id);`,
  `CREATE INDEX IF NOT EXISTS idx_admin_actions_timestamp ON admin_actions (timestamp DESC);`,

  // 4. Subscriptions table (preparation for future payments)
  `CREATE TABLE IF NOT EXISTS subscriptions (
    id BIGSERIAL PRIMARY KEY,
    telegram_user_id VARCHAR(64) NOT NULL REFERENCES users(telegram_user_id) ON DELETE CASCADE,
    plan VARCHAR(32) NOT NULL DEFAULT 'PRO',
    status VARCHAR(32) NOT NULL DEFAULT 'ACTIVE',
    provider VARCHAR(64) NOT NULL DEFAULT 'MANUAL',
    provider_subscription_id VARCHAR(255),
    started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );`,

  // Indexes for subscriptions
  `CREATE INDEX IF NOT EXISTS idx_subscriptions_user ON subscriptions (telegram_user_id);`,
  `CREATE INDEX IF NOT EXISTS idx_subscriptions_status ON subscriptions (status);`,

  // 5. Video Canonicalization & Recent Videos columns
  `ALTER TABLE clip_requests ADD COLUMN IF NOT EXISTS video_id VARCHAR(64);`,
  `ALTER TABLE clip_requests ADD COLUMN IF NOT EXISTS canonical_url TEXT;`,
  `CREATE INDEX IF NOT EXISTS idx_clip_requests_user_canonical ON clip_requests (telegram_user_id, canonical_url);`,
  `CREATE INDEX IF NOT EXISTS idx_clip_requests_user_video_id ON clip_requests (telegram_user_id, video_id);`,
  `UPDATE clip_requests SET canonical_url = youtube_url WHERE canonical_url IS NULL;`,

  // 6. User Caption Presets & Preferences
  `CREATE TABLE IF NOT EXISTS user_caption_presets (
    id BIGSERIAL PRIMARY KEY,
    telegram_user_id VARCHAR(64) NOT NULL REFERENCES users(telegram_user_id) ON DELETE CASCADE,
    preset_name VARCHAR(64) NOT NULL,
    config JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_caption_presets_user_name ON user_caption_presets (telegram_user_id, LOWER(preset_name));`,
  `CREATE INDEX IF NOT EXISTS idx_caption_presets_user ON user_caption_presets (telegram_user_id);`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS last_caption_config JSONB;`
];

/**
 * Executes all database migrations and seeds initial records.
 */
export async function runMigrations() {
  logger.info('[DB_MIGRATIONS] Starting PostgreSQL schema migration...');

  for (const ddl of DDL_MIGRATIONS) {
    try {
      await query(ddl);
    } catch (err) {
      logger.error(`[DB_MIGRATION_ERROR] Migration failed for statement: ${ddl.slice(0, 60)}... Error: ${err.message}`);
      throw err;
    }
  }

  // 1. Ensure Owner is seeded
  await ensureOwnerSeed();

  // 2. Migrate legacy data/users.json if present
  await migrateLegacyUsersJson();

  logger.info('[DB_MIGRATIONS] Database schema migrations completed successfully.');
}

/**
 * Ensures the configured owner exists in the database with role=OWNER, plan=PRO, access_enabled=true.
 */
export async function ensureOwnerSeed() {
  const ownerId = (config.adminTelegramUserId || '').trim();
  if (!ownerId) {
    logger.warn('[DB_SEED] No ADMIN_TELEGRAM_USER_ID configured in .env. Owner record cannot be pre-seeded.');
    return;
  }

  try {
    const upsertSql = `
      INSERT INTO users (telegram_user_id, role, plan, access_enabled, last_seen_at)
      VALUES ($1, 'OWNER', 'PRO', true, NOW())
      ON CONFLICT (telegram_user_id)
      DO UPDATE SET
        role = 'OWNER',
        plan = 'PRO',
        access_enabled = true;
    `;
    await query(upsertSql, [ownerId]);
    logger.info(`[DB_SEED] Owner ${ownerId} ensured as role=OWNER, plan=PRO, access_enabled=true`);
  } catch (err) {
    logger.error(`[DB_SEED] Failed to seed owner: ${err.message}`);
  }
}

/**
 * Imports any users from legacy data/users.json into the PostgreSQL users table.
 */
export async function migrateLegacyUsersJson() {
  if (!fs.existsSync(USERS_JSON_PATH)) {
    return;
  }

  try {
    const content = fs.readFileSync(USERS_JSON_PATH, 'utf8');
    const legacyUsers = JSON.parse(content || '{}');
    const ownerId = (config.adminTelegramUserId || '').trim();

    for (const [userId, record] of Object.entries(legacyUsers)) {
      if (!userId || typeof record !== 'object') continue;

      const isOwnerUser = String(userId) === ownerId;
      const role = isOwnerUser ? 'OWNER' : 'USER';
      const plan = isOwnerUser ? 'PRO' : (record.plan === 'PRO' ? 'PRO' : 'FREE');

      const upsertSql = `
        INSERT INTO users (telegram_user_id, role, plan, access_enabled, last_seen_at)
        VALUES ($1, $2, $3, true, NOW())
        ON CONFLICT (telegram_user_id)
        DO UPDATE SET
          plan = EXCLUDED.plan
        WHERE users.role != 'OWNER';
      `;
      await query(upsertSql, [String(userId), role, plan]);
    }
    logger.info(`[DB_MIGRATION] Migrated legacy users from ${USERS_JSON_PATH}`);
  } catch (err) {
    logger.warn(`[DB_MIGRATION] Failed to migrate users.json: ${err.message}`);
  }
}
