'use strict';

// ── Reelogue database layer ──────────────────────────────────────────
// Pure better-sqlite3. No ORM. Shared by both server.js and bot.js.

const path = require('path');
const Database = require('better-sqlite3');

const db = new Database(path.join(__dirname, 'reelogue.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  telegram_id   INTEGER UNIQUE NOT NULL,
  username      TEXT UNIQUE NOT NULL,
  display_name  TEXT NOT NULL,
  avatar_url    TEXT,
  bio           TEXT DEFAULT '',
  created_at    INTEGER NOT NULL
);

-- One-time auth tokens. Created by the site, claimed by the bot,
-- consumed by /auth/callback (or by polling). Cleaned up on use/expiry.
CREATE TABLE IF NOT EXISTS auth_tokens (
  token        TEXT PRIMARY KEY,
  status       TEXT NOT NULL DEFAULT 'pending',  -- pending | authenticated
  telegram_id  INTEGER,
  user_id      INTEGER,
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL
);

-- Browser sessions (httpOnly cookie -> session id)
CREATE TABLE IF NOT EXISTS sessions (
  id          TEXT PRIMARY KEY,
  user_id     INTEGER NOT NULL,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Watch status per title: watching | watched | watchlist
CREATE TABLE IF NOT EXISTS watch_status (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL,
  tmdb_id     INTEGER NOT NULL,
  media_type  TEXT NOT NULL,            -- movie | tv
  status      TEXT NOT NULL,            -- watching | watched | watchlist
  title       TEXT,
  poster      TEXT,
  updated_at  INTEGER NOT NULL,
  UNIQUE (user_id, tmdb_id, media_type),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Diary entries / reviews. rating 1..10 (nullable), text optional.
CREATE TABLE IF NOT EXISTS reviews (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL,
  tmdb_id     INTEGER NOT NULL,
  media_type  TEXT NOT NULL,
  title       TEXT,
  poster      TEXT,
  rating      INTEGER,                  -- 1..10
  text        TEXT,
  watched_on  TEXT,                     -- YYYY-MM-DD
  created_at  INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Comments on reviews
CREATE TABLE IF NOT EXISTS comments (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  review_id   INTEGER NOT NULL,
  user_id     INTEGER NOT NULL,
  text        TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  FOREIGN KEY (review_id) REFERENCES reviews(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id)   REFERENCES users(id)   ON DELETE CASCADE
);

-- 4 favourite films on the profile (position 0..3)
CREATE TABLE IF NOT EXISTS favorites (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL,
  position    INTEGER NOT NULL,
  tmdb_id     INTEGER NOT NULL,
  media_type  TEXT NOT NULL,
  title       TEXT,
  poster      TEXT,
  UNIQUE (user_id, position),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Custom lists
CREATE TABLE IF NOT EXISTS lists (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL,
  name        TEXT NOT NULL,
  description TEXT DEFAULT '',
  created_at  INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS list_items (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  list_id     INTEGER NOT NULL,
  tmdb_id     INTEGER NOT NULL,
  media_type  TEXT NOT NULL,
  title       TEXT,
  poster      TEXT,
  position    INTEGER NOT NULL DEFAULT 0,
  UNIQUE (list_id, tmdb_id, media_type),
  FOREIGN KEY (list_id) REFERENCES lists(id) ON DELETE CASCADE
);

-- Follows (social graph)
CREATE TABLE IF NOT EXISTS follows (
  follower_id   INTEGER NOT NULL,
  following_id  INTEGER NOT NULL,
  created_at    INTEGER NOT NULL,
  PRIMARY KEY (follower_id, following_id),
  FOREIGN KEY (follower_id)  REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (following_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Activity feed events
CREATE TABLE IF NOT EXISTS activity (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL,
  type        TEXT NOT NULL,            -- review | status | list | follow
  payload     TEXT NOT NULL,            -- JSON
  created_at  INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_reviews_tmdb     ON reviews (tmdb_id, media_type);
CREATE INDEX IF NOT EXISTS idx_reviews_user     ON reviews (user_id);
CREATE INDEX IF NOT EXISTS idx_watch_user       ON watch_status (user_id, status);
CREATE INDEX IF NOT EXISTS idx_activity_user    ON activity (user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_follows_follower ON follows (follower_id);
`);

// Remove expired auth tokens & sessions; runs at boot and on an interval.
function cleanup() {
  const now = Date.now();
  db.prepare('DELETE FROM auth_tokens WHERE expires_at < ?').run(now);
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now);
}
cleanup();

module.exports = { db, cleanup };
