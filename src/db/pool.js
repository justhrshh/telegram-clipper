/**
 * PostgreSQL Connection Pool & Query Interface
 *
 * Uses `pg.Pool` with connection pooling, parameterized queries, and transactions.
 * Supports connection verification, automatic reconnection, and graceful fallback.
 */

import pg from 'pg';
import { config } from '../config/env.js';
import { logger } from '../utils/logger.js';

const { Pool } = pg;

let pool = null;
let isConnected = false;

// In-memory fallback database for when DATABASE_URL is not provided or during offline unit tests
class MemoryDb {
  constructor() {
    this.users = new Map();
    this.clipRequests = [];
    this.adminActions = [];
    this.subscriptions = [];
    this.captionPresets = [];
    this.nextClipId = 1;
    this.nextActionId = 1;
    this.nextSubId = 1;
    this.nextPresetId = 1;
  }
}

const memoryDb = new MemoryDb();
let useMemoryFallback = false;

/**
 * Initializes the PostgreSQL connection pool.
 */
export function getPool() {
  if (pool) return pool;

  const connectionString = config.databaseUrl || process.env.DATABASE_URL;

  if (!connectionString) {
    logger.warn('[DB] No DATABASE_URL provided. Operating in memory-backed mode for testing/fallback.');
    useMemoryFallback = true;
    return null;
  }

  try {
    pool = new Pool({
      connectionString,
      max: 20,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
    });

    pool.on('error', (err) => {
      logger.error('[DB_POOL_ERROR] Unexpected error on idle PostgreSQL client:', err.message);
    });

    return pool;
  } catch (err) {
    logger.error('[DB] Failed to construct PostgreSQL pool:', err.message);
    useMemoryFallback = true;
    return null;
  }
}

/**
 * Executes a parameterized SQL query against PostgreSQL (or memory fallback).
 *
 * @param {string} text - Parameterized SQL query
 * @param {Array} [params] - Query parameter values
 * @returns {Promise<{ rows: Array<any>, rowCount: number }>}
 */
export async function query(text, params = []) {
  const activePool = getPool();

  if (activePool && !useMemoryFallback) {
    try {
      const start = Date.now();
      const res = await activePool.query(text, params);
      const duration = Date.now() - start;
      if (duration > 1000) {
        logger.warn(`[DB_SLOW_QUERY] (${duration}ms): ${text.slice(0, 100)}`);
      }
      return res;
    } catch (err) {
      logger.error(`[DB_QUERY_ERROR] ${err.message} | Query: ${text.slice(0, 120)}`);
      throw err;
    }
  }

  // Fallback memory query handler for environments without live Postgres
  return handleMemoryQuery(text, params);
}

/**
 * Executes a function within a managed transaction.
 * Automatically handles BEGIN, COMMIT, and ROLLBACK.
 *
 * @param {Function} callback - Async function receiving the transactional client
 * @returns {Promise<any>}
 */
export async function withTransaction(callback) {
  const activePool = getPool();

  if (activePool && !useMemoryFallback) {
    const client = await activePool.connect();
    try {
      await client.query('BEGIN');
      const result = await callback(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  // Memory fallback transaction execution
  return callback({
    query: (text, params) => handleMemoryQuery(text, params),
  });
}

/**
 * Tests database connectivity.
 *
 * @returns {Promise<boolean>}
 */
export async function testConnection() {
  const activePool = getPool();
  if (!activePool || useMemoryFallback) {
    return false;
  }

  try {
    const res = await activePool.query('SELECT 1 AS alive');
    isConnected = res.rows?.[0]?.alive === 1;
    if (isConnected) {
      logger.info('[DB] PostgreSQL connection successfully established.');
    }
    return isConnected;
  } catch (err) {
    logger.warn('[DB] PostgreSQL connection check failed:', err.message);
    isConnected = false;
    return false;
  }
}

/**
 * Checks if the database is using a live PostgreSQL connection.
 *
 * @returns {boolean}
 */
export function isLiveDatabase() {
  return Boolean(pool && !useMemoryFallback && isConnected);
}

/**
 * Closes the connection pool gracefully.
 */
export async function closePool() {
  if (pool) {
    await pool.end();
    pool = null;
    isConnected = false;
    logger.info('[DB] PostgreSQL pool closed.');
  }
}

/**
 * Sets fallback mode explicitly (useful in isolated unit testing).
 *
 * @param {boolean} fallback
 */
export function setMemoryFallback(fallback) {
  useMemoryFallback = Boolean(fallback);
}

/**
 * Accessor for the memory fallback database instance.
 */
export function getMemoryDb() {
  return memoryDb;
}

/**
 * Basic SQL parser and executor for memory fallback mode.
 * Supports standard CRUD operations required by repositories.
 */
function handleMemoryQuery(text, params = []) {
  const clean = text.replace(/\s+/g, ' ').trim();
  const lower = clean.toLowerCase();

  // SELECT 1 AS alive
  if (lower.startsWith('select 1')) {
    return { rows: [{ alive: 1 }], rowCount: 1 };
  }

  // DDL queries (CREATE TABLE, CREATE INDEX, etc.)
  if (lower.startsWith('create table') || lower.startsWith('create index')) {
    return { rows: [], rowCount: 0 };
  }

  // USERS queries
  if (lower.includes('from users') || lower.includes('into users') || lower.includes('update users')) {
    return executeMemoryUserQuery(lower, params);
  }

  // CLIP_REQUESTS queries
  if (lower.includes('clip_requests')) {
    return executeMemoryClipQuery(lower, params);
  }

  // ADMIN_ACTIONS queries
  if (lower.includes('admin_actions')) {
    return executeMemoryAdminActionQuery(lower, params);
  }

  // SUBSCRIPTIONS queries
  if (lower.includes('subscriptions')) {
    return executeMemorySubscriptionQuery(lower, params);
  }

  // CAPTION PRESETS queries
  if (lower.includes('user_caption_presets')) {
    return executeMemoryCaptionPresetQuery(lower, params);
  }

  return { rows: [], rowCount: 0 };
}

function executeMemoryUserQuery(sql, params) {
  const lower = sql.toLowerCase();

  // UPSERT USER
  if (lower.startsWith('insert into users')) {
    const [userId, username, firstName, lastName, role, plan, removeUsername] = params;
    const existing = memoryDb.users.get(String(userId));
    const now = new Date();

    if (existing) {
      if (removeUsername === true) {
        existing.username = null;
      } else if (username && typeof username === 'string' && username.trim() !== '') {
        existing.username = username.trim().replace(/^@/, '');
      }
      if (firstName !== undefined && firstName !== null) existing.first_name = firstName;
      if (lastName !== undefined && lastName !== null) existing.last_name = lastName;
      existing.last_seen_at = now;
      if (role && existing.role !== 'OWNER') existing.role = role;
      if (plan && existing.role !== 'OWNER') existing.plan = plan;
      return { rows: [existing], rowCount: 1 };
    }

    const newUser = {
      telegram_user_id: String(userId),
      username: (username && typeof username === 'string' && username.trim() !== '')
        ? username.trim().replace(/^@/, '')
        : null,
      first_name: firstName || null,
      last_name: lastName || null,
      role: role || 'USER',
      plan: plan || 'FREE',
      access_enabled: true,
      created_at: now,
      last_seen_at: now,
      last_request_at: null,
      total_requests: 0,
      total_clips: 0,
      successful_clips: 0,
      failed_clips: 0,
    };
    memoryDb.users.set(String(userId), newUser);
    return { rows: [newUser], rowCount: 1 };
  }

  // SELECT user by ID or Username
  if (lower.includes('lower(username) = lower($2)')) {
    const [id, uname] = params;
    const cleanUname = (uname || '').replace(/^@/, '').toLowerCase();
    for (const u of memoryDb.users.values()) {
      if (u.telegram_user_id === String(id) || (u.username && u.username.toLowerCase() === cleanUname)) {
        return { rows: [u], rowCount: 1 };
      }
    }
    return { rows: [], rowCount: 0 };
  }

  // SELECT single user by ID
  if (lower.startsWith('select') && lower.includes('where telegram_user_id = $1')) {
    const user = memoryDb.users.get(String(params[0]));
    return { rows: user ? [user] : [], rowCount: user ? 1 : 0 };
  }

  // UPDATE users SET last_caption_config
  if (lower.includes('set last_caption_config = $2')) {
    const [id, configJson] = params;
    const user = memoryDb.users.get(String(id));
    if (user) {
      user.last_caption_config = typeof configJson === 'string' ? JSON.parse(configJson) : configJson;
      return { rows: [{ last_caption_config: user.last_caption_config }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  }

  // UPDATE users SET role
  if (lower.startsWith('update users set role = $1')) {
    const [role, id] = params;
    const user = memoryDb.users.get(String(id));
    if (user) {
      user.role = role;
      return { rows: [user], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  }

  // UPDATE users SET plan
  if (lower.startsWith('update users set plan = $1')) {
    const [plan, id] = params;
    const user = memoryDb.users.get(String(id));
    if (user) {
      user.plan = plan;
      return { rows: [user], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  }

  // UPDATE users SET access_enabled
  if (lower.startsWith('update users set access_enabled = $1')) {
    const [access, id] = params;
    const user = memoryDb.users.get(String(id));
    if (user) {
      user.access_enabled = access;
      return { rows: [user], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  }

  // UPDATE users SET last_request_at / total_requests
  if (lower.includes('total_requests = total_requests + 1')) {
    const user = memoryDb.users.get(String(params[0]));
    if (user) {
      user.total_requests = (user.total_requests || 0) + 1;
      user.last_request_at = new Date();
      return { rows: [user], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  }

  // Increment clip counters
  if (lower.includes('total_clips = total_clips + 1')) {
    const user = memoryDb.users.get(String(params[0]));
    if (user) {
      user.total_clips = (user.total_clips || 0) + 1;
      return { rows: [user], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  }
  if (lower.includes('successful_clips = successful_clips + 1')) {
    const user = memoryDb.users.get(String(params[0]));
    if (user) {
      user.successful_clips = (user.successful_clips || 0) + 1;
      return { rows: [user], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  }
  if (lower.includes('failed_clips = failed_clips + 1')) {
    const user = memoryDb.users.get(String(params[0]));
    if (user) {
      user.failed_clips = (user.failed_clips || 0) + 1;
      return { rows: [user], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  }

  // Dashboard Stats
  if (lower.includes('count(*) as total_users')) {
    const users = Array.from(memoryDb.users.values());
    const today = new Date().toISOString().split('T')[0];
    const totalUsers = users.length;
    const proUsers = users.filter((u) => u.plan === 'PRO').length;
    const disabledUsers = users.filter((u) => !u.access_enabled).length;
    const totalClips = users.reduce((acc, u) => acc + (u.total_clips || 0), 0);
    const successfulClips = users.reduce((acc, u) => acc + (u.successful_clips || 0), 0);
    const failedClips = users.reduce((acc, u) => acc + (u.failed_clips || 0), 0);
    const requestsToday = memoryDb.clipRequests.filter(
      (r) => r.requested_at && r.requested_at.toISOString().startsWith(today)
    ).length;

    return {
      rows: [
        {
          total_users: totalUsers,
          pro_users: proUsers,
          disabled_users: disabledUsers,
          total_clips: totalClips,
          successful_clips: successfulClips,
          failed_clips: failedClips,
          requests_today: requestsToday,
        },
      ],
      rowCount: 1,
    };
  }

  // Top users
  if (lower.includes('order by total_clips desc') || lower.includes('order by total_requests desc')) {
    const users = Array.from(memoryDb.users.values());
    users.sort((a, b) => (b.total_clips || 0) - (a.total_clips || 0));
    const limit = params[0] || 5;
    return { rows: users.slice(0, limit), rowCount: Math.min(users.length, limit) };
  }

  // List users with pagination
  if (lower.startsWith('select * from users')) {
    let users = Array.from(memoryDb.users.values());
    if (lower.includes("where role = 'pro'") || lower.includes("where plan = 'pro'")) {
      users = users.filter((u) => u.plan === 'PRO');
    } else if (lower.includes("where access_enabled = false")) {
      users = users.filter((u) => !u.access_enabled);
    }
    users.sort((a, b) => new Date(b.last_seen_at) - new Date(a.last_seen_at));
    const limit = params[0] || 10;
    const offset = params[1] || 0;
    return { rows: users.slice(offset, offset + limit), rowCount: users.length };
  }

  // Count users
  if (lower.startsWith('select count(*) from users')) {
    let users = Array.from(memoryDb.users.values());
    if (lower.includes("where plan = 'pro'")) {
      users = users.filter((u) => u.plan === 'PRO');
    } else if (lower.includes("where access_enabled = false")) {
      users = users.filter((u) => !u.access_enabled);
    }
    return { rows: [{ count: users.length }], rowCount: 1 };
  }

  return { rows: [], rowCount: 0 };
}

function executeMemoryClipQuery(sql, params) {
  const lower = sql.toLowerCase();

  // INSERT INTO clip_requests
  if (lower.startsWith('insert into clip_requests')) {
    let userId, youtubeUrl, canonicalUrl, videoId, startSec, endSec, duration, format, style, captions, status, jobId;
    if (params.length >= 12) {
      [userId, youtubeUrl, canonicalUrl, videoId, startSec, endSec, duration, format, style, captions, status, jobId] = params;
    } else {
      [userId, youtubeUrl, startSec, endSec, duration, format, style, captions, status, jobId] = params;
    }
    const cleanStart = typeof startSec === 'number' ? startSec : (Number(startSec) || 0);
    const cleanEnd = typeof endSec === 'number' ? endSec : (Number(endSec) || 0);
    const cleanDuration = typeof duration === 'number' ? duration : (Number(duration) || Math.max(0, cleanEnd - cleanStart));
    const record = {
      id: memoryDb.nextClipId++,
      telegram_user_id: String(userId),
      youtube_url: youtubeUrl,
      canonical_url: canonicalUrl || youtubeUrl,
      video_id: videoId || null,
      requested_at: new Date(),
      start_seconds: cleanStart,
      end_seconds: cleanEnd,
      duration: cleanDuration,
      format,
      presentation_style: style,
      captions,
      status: status || 'REQUESTED',
      job_id: jobId,
      completed_at: null,
      error_message: null,
    };
    memoryDb.clipRequests.push(record);
    return { rows: [record], rowCount: 1 };
  }

  // UPDATE clip_requests status
  if (lower.startsWith('update clip_requests set status = $1')) {
    const [status, completedAt, errorMessage, jobId] = params;
    const record = memoryDb.clipRequests.find((r) => r.job_id === jobId);
    if (record) {
      record.status = status;
      record.completed_at = completedAt ? new Date(completedAt) : new Date();
      record.error_message = errorMessage || null;
      return { rows: [record], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  }

  // SELECT COUNT(*) FROM clip_requests WHERE telegram_user_id = $1 AND requested_at >= CURRENT_DATE AND status != 'CANCELLED'
  if (lower.includes('count(*) as count') && lower.includes('clip_requests') && lower.includes('requested_at >= current_date')) {
    const userId = String(params[0]);
    const today = new Date().toISOString().split('T')[0];
    const userClips = memoryDb.clipRequests.filter(
      (r) =>
        r.telegram_user_id === userId &&
        r.status !== 'CANCELLED' &&
        r.requested_at &&
        r.requested_at.toISOString().startsWith(today)
    );
    return { rows: [{ count: userClips.length }], rowCount: 1 };
  }

  // SELECT COUNT(DISTINCT COALESCE(canonical_url, youtube_url)) FROM clip_requests WHERE telegram_user_id = $1
  if (lower.includes('count(distinct') && lower.includes('clip_requests')) {
    const userId = String(params[0]);
    const userClips = memoryDb.clipRequests.filter((r) => r.telegram_user_id === userId);
    const uniqueVideos = new Set(userClips.map((r) => r.canonical_url || r.youtube_url));
    return { rows: [{ count: uniqueVideos.size }], rowCount: 1 };
  }

  // SELECT COUNT(*) FROM clip_requests WHERE telegram_user_id = $1 AND (canonical_url = $2 ...)
  if (lower.includes('count(*)::integer as count') && lower.includes('canonical_url = $2')) {
    const userId = String(params[0]);
    const canonical = params[1];
    const videoId = params[2];
    const userClips = memoryDb.clipRequests.filter(
      (r) =>
        r.telegram_user_id === userId &&
        (r.canonical_url === canonical || r.youtube_url === canonical || (videoId && r.video_id === videoId))
    );
    return { rows: [{ count: userClips.length }], rowCount: 1 };
  }

  // SELECT COUNT(*) FROM clip_requests WHERE telegram_user_id = $1 (total clips)
  if (lower.includes('count(*)::integer as count') && lower.includes('telegram_user_id = $1')) {
    const userId = String(params[0]);
    const userClips = memoryDb.clipRequests.filter((r) => r.telegram_user_id === userId);
    return { rows: [{ count: userClips.length }], rowCount: 1 };
  }

  // SELECT single clip by ID and user ID
  if (lower.includes('select * from clip_requests where id = $1 and telegram_user_id = $2')) {
    const clipId = parseInt(params[0], 10);
    const userId = String(params[1]);
    const clip = memoryDb.clipRequests.find((r) => r.id === clipId && r.telegram_user_id === userId);
    return { rows: clip ? [clip] : [], rowCount: clip ? 1 : 0 };
  }

  // Recent videos grouped by canonical URL
  if (lower.includes('group by coalesce(canonical_url, youtube_url)') || lower.includes('group by coalesce')) {
    const userId = String(params[0]);
    const limit = params[1] || 5;
    const offset = params[2] || 0;

    const grouped = new Map();
    for (const r of memoryDb.clipRequests) {
      if (r.telegram_user_id !== userId) continue;
      const key = r.canonical_url || r.youtube_url;
      if (!grouped.has(key)) {
        grouped.set(key, {
          canonical_url: key,
          video_id: r.video_id || null,
          clip_count: 0,
          last_used_at: r.requested_at,
        });
      }
      const entry = grouped.get(key);
      entry.clip_count++;
      if (r.requested_at > entry.last_used_at) {
        entry.last_used_at = r.requested_at;
      }
    }

    const list = Array.from(grouped.values()).sort((a, b) => b.last_used_at - a.last_used_at);
    return { rows: list.slice(offset, offset + limit), rowCount: list.length };
  }

  // Recent clips for a specific video
  if (lower.includes('canonical_url = $2') || lower.includes('video_id = $3')) {
    const userId = String(params[0]);
    const canonical = params[1];
    const videoId = params[2];
    const limit = params[3] || 5;
    const offset = params[4] || 0;

    const matched = memoryDb.clipRequests
      .filter(
        (r) =>
          r.telegram_user_id === userId &&
          (r.canonical_url === canonical || r.youtube_url === canonical || (videoId && r.video_id === videoId))
      )
      .sort((a, b) => b.requested_at - a.requested_at);

    return { rows: matched.slice(offset, offset + limit), rowCount: matched.length };
  }

  // SELECT from clip_requests by user
  if (lower.includes('where telegram_user_id = $1 order by requested_at desc')) {
    const userId = String(params[0]);
    const limit = params[1] || 5;
    const offset = params[2] || 0;
    const userClips = memoryDb.clipRequests
      .filter((r) => r.telegram_user_id === userId)
      .sort((a, b) => b.requested_at - a.requested_at);
    return { rows: userClips.slice(offset, offset + limit), rowCount: userClips.length };
  }

  // Daily stats for past days
  if (lower.includes('date_trunc') || lower.includes('group by date')) {
    const countsByDay = {};
    for (let i = 6; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const dateStr = d.toISOString().split('T')[0];
      countsByDay[dateStr] = 0;
    }
    for (const req of memoryDb.clipRequests) {
      const dateStr = req.requested_at.toISOString().split('T')[0];
      if (countsByDay[dateStr] !== undefined) {
        countsByDay[dateStr]++;
      }
    }
    const rows = Object.entries(countsByDay).map(([day, count]) => ({
      day,
      count,
    }));
    return { rows, rowCount: rows.length };
  }

  return { rows: [], rowCount: 0 };
}

function executeMemoryAdminActionQuery(sql, params) {
  const lower = sql.toLowerCase();

  if (lower.startsWith('insert into admin_actions')) {
    const [adminId, targetId, action, metadata] = params;
    const record = {
      id: memoryDb.nextActionId++,
      admin_user_id: String(adminId),
      target_user_id: String(targetId),
      action,
      timestamp: new Date(),
      metadata: metadata || {},
    };
    memoryDb.adminActions.push(record);
    return { rows: [record], rowCount: 1 };
  }

  if (lower.startsWith('select * from admin_actions')) {
    const limit = params[0] || 10;
    const actions = [...memoryDb.adminActions].sort((a, b) => b.timestamp - a.timestamp);
    return { rows: actions.slice(0, limit), rowCount: actions.length };
  }

  return { rows: [], rowCount: 0 };
}

function executeMemorySubscriptionQuery(sql, params) {
  const lower = sql.toLowerCase();

  if (lower.startsWith('insert into subscriptions')) {
    const [userId, plan, status, provider, subId, expiresAt] = params;
    const record = {
      id: memoryDb.nextSubId++,
      telegram_user_id: String(userId),
      plan: plan || 'PRO',
      status: status || 'ACTIVE',
      provider: provider || 'MANUAL',
      provider_subscription_id: subId || null,
      started_at: new Date(),
      expires_at: expiresAt ? new Date(expiresAt) : null,
      created_at: new Date(),
      updated_at: new Date(),
    };
    memoryDb.subscriptions.push(record);
    return { rows: [record], rowCount: 1 };
  }

  // Count distinct users with status = 'INTERESTED'
  if (lower.includes('count(distinct telegram_user_id)') && lower.includes("status = 'interested'")) {
    const interested = memoryDb.subscriptions.filter((s) => s.status === 'INTERESTED');
    const uniqueUsers = new Set(interested.map((s) => s.telegram_user_id));
    return { rows: [{ count: uniqueUsers.size }], rowCount: 1 };
  }

  // Get PRO interest for a single user
  if (lower.includes('where telegram_user_id = $1') && lower.includes("status = 'interested'")) {
    const userId = String(params[0]);
    const sub = memoryDb.subscriptions
      .filter((s) => s.telegram_user_id === userId && s.status === 'INTERESTED')
      .sort((a, b) => b.created_at - a.created_at)[0];
    return { rows: sub ? [sub] : [], rowCount: sub ? 1 : 0 };
  }

  // List interested users with user profile join
  if (lower.includes("where s.status = 'interested'") || (lower.includes('from subscriptions') && lower.includes("status = 'interested'"))) {
    const limit = params[0] || 10;
    const offset = params[1] || 0;
    const interested = memoryDb.subscriptions
      .filter((s) => s.status === 'INTERESTED')
      .sort((a, b) => b.created_at - a.created_at);

    const rows = interested.slice(offset, offset + limit).map((s) => {
      const u = memoryDb.users.get(s.telegram_user_id);
      return {
        id: s.id,
        telegram_user_id: s.telegram_user_id,
        created_at: s.created_at,
        username: u?.username || null,
        first_name: u?.first_name || null,
        last_name: u?.last_name || null,
        plan: u?.plan || 'FREE',
        role: u?.role || 'USER',
      };
    });

    return { rows, rowCount: rows.length };
  }

  if (lower.includes('where telegram_user_id = $1')) {
    const userId = String(params[0]);
    const sub = memoryDb.subscriptions
      .filter((s) => s.telegram_user_id === userId)
      .sort((a, b) => b.created_at - a.created_at)[0];
    return { rows: sub ? [sub] : [], rowCount: sub ? 1 : 0 };
  }

  return { rows: [], rowCount: 0 };
}

function executeMemoryCaptionPresetQuery(sql, params) {
  const lower = sql.toLowerCase();

  // INSERT / UPSERT preset
  if (lower.startsWith('insert into user_caption_presets')) {
    const [userId, presetName, configJson] = params;
    const uid = String(userId);
    const cleanName = String(presetName).trim();
    const parsedConfig = typeof configJson === 'string' ? JSON.parse(configJson) : configJson;
    const now = new Date();

    const existing = memoryDb.captionPresets.find(
      (p) => p.telegram_user_id === uid && p.preset_name.toLowerCase() === cleanName.toLowerCase()
    );

    if (existing) {
      existing.preset_name = cleanName;
      existing.config = parsedConfig;
      existing.created_at = now;
      return { rows: [existing], rowCount: 1 };
    }

    const newPreset = {
      id: memoryDb.nextPresetId++,
      telegram_user_id: uid,
      preset_name: cleanName,
      config: parsedConfig,
      created_at: now,
    };
    memoryDb.captionPresets.push(newPreset);
    return { rows: [newPreset], rowCount: 1 };
  }

  // SELECT single preset by name
  if (lower.includes('where telegram_user_id = $1 and lower(preset_name) = lower($2)')) {
    const [userId, presetName] = params;
    const found = memoryDb.captionPresets.find(
      (p) => p.telegram_user_id === String(userId) && p.preset_name.toLowerCase() === String(presetName).toLowerCase()
    );
    return { rows: found ? [found] : [], rowCount: found ? 1 : 0 };
  }

  // SELECT all presets for user
  if (lower.includes('from user_caption_presets') && lower.includes('where telegram_user_id = $1')) {
    const [userId] = params;
    const list = memoryDb.captionPresets
      .filter((p) => p.telegram_user_id === String(userId))
      .sort((a, b) => b.created_at - a.created_at);
    return { rows: list, rowCount: list.length };
  }

  // DELETE preset by name
  if (lower.startsWith('delete from user_caption_presets')) {
    const [userId, presetName] = params;
    const idx = memoryDb.captionPresets.findIndex(
      (p) => p.telegram_user_id === String(userId) && p.preset_name.toLowerCase() === String(presetName).toLowerCase()
    );
    if (idx >= 0) {
      const removed = memoryDb.captionPresets.splice(idx, 1)[0];
      return { rows: [{ id: removed.id }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  }

  return { rows: [], rowCount: 0 };
}

/**
 * Resets the in-memory fallback database. Useful for clean isolated tests.
 */
export function resetMemoryDb() {
  memoryDb.users.clear();
  memoryDb.clipRequests = [];
  memoryDb.adminActions = [];
  memoryDb.subscriptions = [];
  memoryDb.captionPresets = [];
  memoryDb.nextClipId = 1;
  memoryDb.nextActionId = 1;
  memoryDb.nextSubId = 1;
  memoryDb.nextPresetId = 1;
}

