'use strict';

// ── Reelogue — единая точка запуска ─────────────────────────────────
// Запускает Express-сервер (API + фронт) и Telegram-бота из одного процесса.
// Использование: node bot.js

require('dotenv').config();
const fs      = require('fs');
const path    = require('path');
const crypto  = require('crypto');
const express = require('express');
const cookieParser = require('cookie-parser');
const { Bot, session, InlineKeyboard } = require('grammy');
const { db, cleanup } = require('./db');

// ── Env ──────────────────────────────────────────────────────────────
const { BOT_TOKEN, SITE_URL, TMDB_API_KEY, KINOPOISK_API_KEY } = process.env;
if (!BOT_TOKEN) throw new Error('BOT_TOKEN is missing in .env');

const PORT = process.env.PORT || 3000;
const SITE = (SITE_URL || `http://localhost:${PORT}`).replace(/\/+$/, '');

if (!TMDB_API_KEY) console.warn('⚠  TMDB_API_KEY missing — catalogue will not work.');

// ════════════════════════════════════════════════════════════════════
//  CONSTANTS & HELPERS
// ════════════════════════════════════════════════════════════════════
const TOKEN_TTL   = 10 * 60 * 1000;           // 10 минут
const SESSION_TTL = 30 * 24 * 60 * 60 * 1000; // 30 дней
const now  = () => Date.now();
const rid  = () => crypto.randomBytes(24).toString('hex');

const AVATAR_DIR = path.join(__dirname, 'site', 'avatars');
fs.mkdirSync(AVATAR_DIR, { recursive: true });

function escapeHtml(s) {
  return String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}

// ── Premium-эмодзи ───────────────────────────────────────────────────
const E = {
  bot:     '6030400221232501136',
  check:   '5870633910337015697',
  cross:   '5870657884844462243',
  link:    '5769289093221454192',
  profile: '5870994129244131212',
  pen:     '5870676941614354370',
  party:   '6041731551845159060',
  clock:   '5983150113483134607',
  write:   '5870753782874246579',
  film:    '5870528606328852614',
};
const em = (id, fallback) => `<tg-emoji emoji-id="${id}">${fallback}</tg-emoji>`;

// ════════════════════════════════════════════════════════════════════
//  PREPARED STATEMENTS
// ════════════════════════════════════════════════════════════════════
const Q = {
  // --- auth tokens ---
  insertToken:  db.prepare('INSERT INTO auth_tokens (token, status, created_at, expires_at) VALUES (?, ?, ?, ?)'),
  getToken:     db.prepare('SELECT * FROM auth_tokens WHERE token = ?'),
  delToken:     db.prepare('DELETE FROM auth_tokens WHERE token = ?'),
  tokenByValue: db.prepare('SELECT * FROM auth_tokens WHERE token = ?'),  // alias, удобен в боте
  claimToken:   db.prepare(`UPDATE auth_tokens SET status='authenticated', telegram_id=?, user_id=? WHERE token=?`),

  // --- sessions ---
  insertSession: db.prepare('INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)'),
  getSession:    db.prepare('SELECT * FROM sessions WHERE id = ?'),
  delSession:    db.prepare('DELETE FROM sessions WHERE id = ?'),

  // --- users ---
  userById:     db.prepare('SELECT * FROM users WHERE id = ?'),
  userByName:   db.prepare('SELECT * FROM users WHERE lower(username) = lower(?)'),
  userByTg:     db.prepare('SELECT * FROM users WHERE telegram_id = ?'),
  insertUser:   db.prepare(`INSERT INTO users (telegram_id, username, display_name, avatar_url, bio, created_at)
                             VALUES (?, ?, ?, ?, '', ?)`),
  setAvatar:    db.prepare('UPDATE users SET avatar_url = ? WHERE id = ?'),
  setBio:       db.prepare('UPDATE users SET bio = ? WHERE id = ?'),

  // --- watch_status ---
  upsertStatus: db.prepare(`INSERT INTO watch_status (user_id, tmdb_id, media_type, status, title, poster, updated_at)
                             VALUES (@user_id, @tmdb_id, @media_type, @status, @title, @poster, @updated_at)
                             ON CONFLICT(user_id, tmdb_id, media_type)
                             DO UPDATE SET status=@status, title=@title, poster=@poster, updated_at=@updated_at`),
  delStatus:    db.prepare('DELETE FROM watch_status WHERE user_id=? AND tmdb_id=? AND media_type=?'),
  getStatus:    db.prepare('SELECT * FROM watch_status WHERE user_id=? AND tmdb_id=? AND media_type=?'),
  statusList:   db.prepare('SELECT * FROM watch_status WHERE user_id=? AND status=? ORDER BY updated_at DESC'),
  countStatus:  db.prepare('SELECT COUNT(*) c FROM watch_status WHERE user_id=? AND status=?'),

  // --- reviews ---
  insertReview:       db.prepare(`INSERT INTO reviews (user_id, tmdb_id, media_type, title, poster, rating, text, watched_on, created_at)
                                   VALUES (@user_id, @tmdb_id, @media_type, @title, @poster, @rating, @text, @watched_on, @created_at)`),
  reviewsForTitle:    db.prepare(`SELECT r.*, u.username, u.display_name, u.avatar_url
                                   FROM reviews r JOIN users u ON u.id = r.user_id
                                   WHERE r.tmdb_id=? AND r.media_type=? ORDER BY r.created_at DESC`),
  reviewById:         db.prepare(`SELECT r.*, u.username, u.display_name, u.avatar_url
                                   FROM reviews r JOIN users u ON u.id = r.user_id WHERE r.id=?`),
  delReview:          db.prepare('DELETE FROM reviews WHERE id=? AND user_id=?'),
  userDiary:          db.prepare('SELECT * FROM reviews WHERE user_id=? ORDER BY created_at DESC LIMIT ?'),
  userRatingForTitle: db.prepare(`SELECT rating FROM reviews WHERE user_id=? AND tmdb_id=? AND media_type=? AND rating IS NOT NULL
                                   ORDER BY created_at DESC LIMIT 1`),
  ratingsDist:        db.prepare('SELECT rating, COUNT(*) c FROM reviews WHERE user_id=? AND rating IS NOT NULL GROUP BY rating'),
  avgRating:          db.prepare('SELECT AVG(rating) a, COUNT(rating) c FROM reviews WHERE user_id=? AND rating IS NOT NULL'),

  // --- comments ---
  insertComment:     db.prepare('INSERT INTO comments (review_id, user_id, text, created_at) VALUES (?, ?, ?, ?)'),
  commentsForReview: db.prepare(`SELECT c.*, u.username, u.display_name, u.avatar_url
                                  FROM comments c JOIN users u ON u.id=c.user_id
                                  WHERE c.review_id=? ORDER BY c.created_at ASC`),

  // --- favorites ---
  favorites:   db.prepare('SELECT * FROM favorites WHERE user_id=? ORDER BY position'),
  setFavorite: db.prepare(`INSERT INTO favorites (user_id, position, tmdb_id, media_type, title, poster)
                            VALUES (@user_id,@position,@tmdb_id,@media_type,@title,@poster)
                            ON CONFLICT(user_id, position)
                            DO UPDATE SET tmdb_id=@tmdb_id, media_type=@media_type, title=@title, poster=@poster`),
  delFavorite: db.prepare('DELETE FROM favorites WHERE user_id=? AND position=?'),

  // --- lists ---
  insertList:     db.prepare('INSERT INTO lists (user_id, name, description, created_at) VALUES (?, ?, ?, ?)'),
  listsForUser:   db.prepare('SELECT * FROM lists WHERE user_id=? ORDER BY created_at DESC'),
  listById:       db.prepare(`SELECT l.*, u.username, u.display_name FROM lists l JOIN users u ON u.id=l.user_id WHERE l.id=?`),
  delList:        db.prepare('DELETE FROM lists WHERE id=? AND user_id=?'),
  listItems:      db.prepare('SELECT * FROM list_items WHERE list_id=? ORDER BY position, id'),
  addListItem:    db.prepare(`INSERT OR IGNORE INTO list_items (list_id, tmdb_id, media_type, title, poster, position)
                               VALUES (?, ?, ?, ?, ?, ?)`),
  delListItem:    db.prepare('DELETE FROM list_items WHERE list_id=? AND tmdb_id=? AND media_type=?'),
  countListItems: db.prepare('SELECT COUNT(*) c FROM list_items WHERE list_id=?'),

  // --- follows ---
  follow:         db.prepare('INSERT OR IGNORE INTO follows (follower_id, following_id, created_at) VALUES (?, ?, ?)'),
  unfollow:       db.prepare('DELETE FROM follows WHERE follower_id=? AND following_id=?'),
  isFollowing:    db.prepare('SELECT 1 FROM follows WHERE follower_id=? AND following_id=?'),
  followers:      db.prepare('SELECT COUNT(*) c FROM follows WHERE following_id=?'),
  followingCount: db.prepare('SELECT COUNT(*) c FROM follows WHERE follower_id=?'),
  followingUsers: db.prepare(`SELECT u.id, u.username, u.display_name, u.avatar_url
                               FROM follows f JOIN users u ON u.id=f.following_id WHERE f.follower_id=?`),

  // --- activity ---
  insertActivity: db.prepare('INSERT INTO activity (user_id, type, payload, created_at) VALUES (?, ?, ?, ?)'),
  feed:           db.prepare(`SELECT a.*, u.username, u.display_name, u.avatar_url
                               FROM activity a JOIN users u ON u.id=a.user_id
                               WHERE a.user_id IN (SELECT following_id FROM follows WHERE follower_id=?)
                                  OR a.user_id=?
                               ORDER BY a.created_at DESC LIMIT 60`),
};

// ════════════════════════════════════════════════════════════════════
//  EXPRESS SERVER
// ════════════════════════════════════════════════════════════════════
const app = express();
app.use(express.json({ limit: '256kb' }));
app.use(cookieParser());

// ── Вспомогательные функции ──────────────────────────────────────────
function logActivity(userId, type, payload) {
  Q.insertActivity.run(userId, type, JSON.stringify(payload), now());
}

function publicUser(u) {
  if (!u) return null;
  return { id: u.id, username: u.username, display_name: u.display_name, avatar_url: u.avatar_url, bio: u.bio };
}

function currentUser(req) {
  const sid = req.cookies.session;
  if (!sid) return null;
  const s = Q.getSession.get(sid);
  if (!s || s.expires_at < now()) return null;
  return Q.userById.get(s.user_id) || null;
}
function requireAuth(req, res, next) {
  const u = currentUser(req);
  if (!u) return res.status(401).json({ error: 'unauthorized' });
  req.user = u;
  next();
}
function createSession(res, userId) {
  const id = rid();
  Q.insertSession.run(id, userId, now(), now() + SESSION_TTL);
  res.cookie('session', id, {
    httpOnly: true, sameSite: 'lax',
    maxAge: SESSION_TTL,
    secure: SITE.startsWith('https'),
  });
}

// ── Кэш имени бота (для deep-link) ──────────────────────────────────
const BOT_USERNAME_CACHE = { name: null };
async function getBotUsername() {
  if (BOT_USERNAME_CACHE.name) return BOT_USERNAME_CACHE.name;
  try {
    const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/getMe`);
    const j = await r.json();
    if (j.ok) BOT_USERNAME_CACHE.name = j.result.username;
  } catch { /* ignore */ }
  return BOT_USERNAME_CACHE.name;
}

// ════════════════════════════════════════════════════════════════════
//  AUTH ROUTES
// ════════════════════════════════════════════════════════════════════
app.post('/api/auth/request', async (req, res) => {
  const token = rid();
  Q.insertToken.run(token, 'pending', now(), now() + TOKEN_TTL);
  const username = await getBotUsername();
  const deepLink = username ? `https://t.me/${username}?start=auth_${token}` : null;
  res.json({ token, deepLink, expiresIn: TOKEN_TTL });
});

app.get('/api/auth/status', (req, res) => {
  const token = String(req.query.token || '');
  const row = Q.getToken.get(token);
  if (!row) return res.json({ status: 'gone' });
  if (row.expires_at < now()) { Q.delToken.run(token); return res.json({ status: 'expired' }); }
  if (row.status === 'authenticated' && row.user_id) {
    createSession(res, row.user_id);
    Q.delToken.run(token);
    return res.json({ status: 'authenticated', user: publicUser(Q.userById.get(row.user_id)) });
  }
  res.json({ status: 'pending' });
});

app.get('/auth/callback', (req, res) => {
  const token = String(req.query.token || '');
  const row = Q.getToken.get(token);
  if (!row || row.expires_at < now() || row.status !== 'authenticated' || !row.user_id) {
    if (row) Q.delToken.run(token);
    return res.redirect('/login.html?error=expired');
  }
  createSession(res, row.user_id);
  Q.delToken.run(token);
  res.redirect('/');
});

app.post('/api/auth/logout', (req, res) => {
  const sid = req.cookies.session;
  if (sid) Q.delSession.run(sid);
  res.clearCookie('session');
  res.json({ ok: true });
});

app.get('/api/me', (req, res) => {
  const u = currentUser(req);
  if (!u) return res.status(401).json({ error: 'unauthorized' });
  res.json({ user: publicUser(u) });
});

// ════════════════════════════════════════════════════════════════════
//  TMDB PROXY
// ════════════════════════════════════════════════════════════════════
const TMDB_BASE = 'https://api.themoviedb.org/3';
const tmdbCache = new Map();

async function tmdb(endpoint, params = {}) {
  const url = new URL(TMDB_BASE + endpoint);
  url.searchParams.set('api_key', TMDB_API_KEY);
  url.searchParams.set('language', 'ru-RU');
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const key = url.toString();
  const hit = tmdbCache.get(key);
  if (hit && hit.exp > now()) return hit.data;
  const r = await fetch(key);
  if (!r.ok) throw new Error(`TMDB ${r.status}`);
  const data = await r.json();
  tmdbCache.set(key, { data, exp: now() + 1000 * 60 * 30 });
  return data;
}

const img = (p, size = 'w500') => (p ? `https://image.tmdb.org/t/p/${size}${p}` : null);

function normCard(item, forcedType) {
  const type = forcedType || item.media_type || (item.title ? 'movie' : 'tv');
  if (type === 'person') return null;
  return {
    tmdb_id: item.id, media_type: type,
    title: item.title || item.name,
    original_title: item.original_title || item.original_name,
    poster: img(item.poster_path),
    backdrop: img(item.backdrop_path, 'w780'),
    year: (item.release_date || item.first_air_date || '').slice(0, 4),
    vote: item.vote_average ? Number(item.vote_average.toFixed(1)) : null,
    overview: item.overview,
  };
}

app.get('/api/tmdb/trending', async (req, res) => {
  try {
    const data = await tmdb('/trending/all/week');
    res.json({ results: data.results.map((x) => normCard(x)).filter(Boolean) });
  } catch (e) { res.status(502).json({ error: String(e.message) }); }
});

app.get('/api/tmdb/popular', async (req, res) => {
  try {
    const type = req.query.type === 'tv' ? 'tv' : 'movie';
    const page = Math.max(1, Math.min(500, +req.query.page || 1));
    const data = await tmdb(`/${type}/popular`, { page });
    res.json({ page: data.page, total_pages: data.total_pages, results: data.results.map((x) => normCard(x, type)).filter(Boolean) });
  } catch (e) { res.status(502).json({ error: String(e.message) }); }
});

app.get('/api/tmdb/search', async (req, res) => {
  try {
    const q = String(req.query.q || '').trim();
    if (!q) return res.json({ results: [] });
    const page = Math.max(1, +req.query.page || 1);
    const data = await tmdb('/search/multi', { query: q, page, include_adult: 'false' });
    res.json({ page: data.page, total_pages: data.total_pages, results: data.results.map((x) => normCard(x)).filter(Boolean) });
  } catch (e) { res.status(502).json({ error: String(e.message) }); }
});

app.get('/api/tmdb/title/:type/:id', async (req, res) => {
  try {
    const type = req.params.type === 'tv' ? 'tv' : 'movie';
    const id = +req.params.id;
    const data = await tmdb(`/${type}/${id}`, { append_to_response: 'videos,credits,external_ids,recommendations' });
    let videos = data.videos?.results || [];
    if (videos.length === 0) {
      const enData = await tmdb(`/${type}/${id}/videos`, { language: 'en-US' });
      videos = enData.results || [];
    }
    const yt = videos.find((v) => v.site === 'YouTube' && /trailer/i.test(v.type))
      || videos.find((v) => v.site === 'YouTube');
    res.json({
      tmdb_id: data.id, media_type: type,
      title: data.title || data.name, original_title: data.original_title || data.original_name,
      tagline: data.tagline, overview: data.overview,
      poster: img(data.poster_path, 'w500'), backdrop: img(data.backdrop_path, 'original'),
      year: (data.release_date || data.first_air_date || '').slice(0, 4),
      runtime: data.runtime || (data.episode_run_time && data.episode_run_time[0]) || null,
      genres: (data.genres || []).map((g) => g.name),
      vote: data.vote_average ? Number(data.vote_average.toFixed(1)) : null,
      vote_count: data.vote_count,
      seasons: data.number_of_seasons || null, episodes: data.number_of_episodes || null,
      imdb_id: data.external_ids?.imdb_id || data.imdb_id || null,
      trailer: yt ? `https://www.youtube.com/embed/${yt.key}` : null,
      cast: (data.credits?.cast || []).slice(0, 12).map((c) => ({ name: c.name, character: c.character, photo: img(c.profile_path, 'w185') })),
      directors: (data.credits?.crew || []).filter((c) => c.job === 'Director' || c.job === 'Series Director').map((c) => c.name),
      recommendations: (data.recommendations?.results || []).map((x) => normCard(x, x.media_type || type)).filter(Boolean).slice(0, 12),
    });
  } catch (e) { res.status(502).json({ error: String(e.message) }); }
});

app.get('/api/tmdb/random', async (req, res) => {
  try {
    const type = Math.random() > 0.5 ? 'movie' : 'tv';
    const page = 1 + Math.floor(Math.random() * 20);
    const data = await tmdb(`/${type}/popular`, { page });
    const pool = data.results.filter((x) => x.poster_path);
    const pick = pool[Math.floor(Math.random() * pool.length)];
    res.json(normCard(pick, type));
  } catch (e) { res.status(502).json({ error: String(e.message) }); }
});

// ── «Смотреть» → sspoisk ────────────────────────────────────────────
app.get('/watch/:type/:id', async (req, res) => {
  const type = req.params.type === 'tv' ? 'tv' : 'movie';
  const id = +req.params.id;
  try {
    const data = await tmdb(`/${type}/${id}`, { append_to_response: 'external_ids' });
    const imdb  = data.external_ids?.imdb_id || data.imdb_id;
    const title = data.title || data.name || '';
    if (KINOPOISK_API_KEY && imdb) {
      try {
        const r = await fetch(
          `https://api.kinopoisk.dev/v1.4/movie?externalId.imdb=${encodeURIComponent(imdb)}`,
          { headers: { 'X-API-KEY': KINOPOISK_API_KEY, accept: 'application/json' } }
        );
        const j = await r.json();
        const kpId = j?.docs?.[0]?.id || j?.id;
        if (kpId) return res.redirect(`https://www.sspoisk.ru/film/${kpId}/`);
      } catch { /* fall through */ }
    }
    return res.redirect(`https://www.sspoisk.ru/search/${encodeURIComponent(title)}`);
  } catch {
    return res.redirect('https://www.sspoisk.ru/');
  }
});

// ════════════════════════════════════════════════════════════════════
//  TITLE STATE
// ════════════════════════════════════════════════════════════════════
app.get('/api/title/:type/:id/state', requireAuth, (req, res) => {
  const type = req.params.type === 'tv' ? 'tv' : 'movie';
  const id   = +req.params.id;
  const st     = Q.getStatus.get(req.user.id, id, type);
  const rating = Q.userRatingForTitle.get(req.user.id, id, type);
  res.json({ status: st ? st.status : null, rating: rating ? rating.rating : null });
});

app.post('/api/status', requireAuth, (req, res) => {
  const { tmdb_id, media_type, status, title, poster } = req.body || {};
  const type = media_type === 'tv' ? 'tv' : 'movie';
  if (!tmdb_id || !['watching', 'watched', 'watchlist'].includes(status))
    return res.status(400).json({ error: 'bad request' });
  Q.upsertStatus.run({ user_id: req.user.id, tmdb_id, media_type: type, status, title: title || null, poster: poster || null, updated_at: now() });
  logActivity(req.user.id, 'status', { tmdb_id, media_type: type, status, title, poster });
  res.json({ ok: true });
});

app.delete('/api/status/:type/:id', requireAuth, (req, res) => {
  Q.delStatus.run(req.user.id, +req.params.id, req.params.type === 'tv' ? 'tv' : 'movie');
  res.json({ ok: true });
});

// ════════════════════════════════════════════════════════════════════
//  REVIEWS / DIARY & COMMENTS
// ════════════════════════════════════════════════════════════════════
function shapeReview(r) {
  return {
    id: r.id, tmdb_id: r.tmdb_id, media_type: r.media_type,
    title: r.title, poster: r.poster, rating: r.rating, text: r.text,
    watched_on: r.watched_on, created_at: r.created_at,
    user: { username: r.username, display_name: r.display_name, avatar_url: r.avatar_url },
  };
}

app.get('/api/reviews/:type/:id', (req, res) => {
  const type = req.params.type === 'tv' ? 'tv' : 'movie';
  res.json({ reviews: Q.reviewsForTitle.all(+req.params.id, type).map(shapeReview) });
});

app.post('/api/reviews', requireAuth, (req, res) => {
  const { tmdb_id, media_type, title, poster, rating, text, watched_on } = req.body || {};
  const type = media_type === 'tv' ? 'tv' : 'movie';
  if (!tmdb_id) return res.status(400).json({ error: 'bad request' });
  const rt = rating == null || rating === '' ? null : Math.max(1, Math.min(10, +rating));
  const info = Q.insertReview.run({
    user_id: req.user.id, tmdb_id, media_type: type,
    title: title || null, poster: poster || null,
    rating: rt, text: text ? String(text).slice(0, 5000) : null,
    watched_on: watched_on || new Date().toISOString().slice(0, 10),
    created_at: now(),
  });
  Q.upsertStatus.run({ user_id: req.user.id, tmdb_id, media_type: type, status: 'watched', title: title || null, poster: poster || null, updated_at: now() });
  logActivity(req.user.id, 'review', { tmdb_id, media_type: type, title, poster, rating: rt, text });
  res.json({ ok: true, id: info.lastInsertRowid });
});

app.delete('/api/reviews/:id', requireAuth, (req, res) => {
  Q.delReview.run(+req.params.id, req.user.id);
  res.json({ ok: true });
});

app.get('/api/reviews/:id/comments', (req, res) => {
  const rows = Q.commentsForReview.all(+req.params.id);
  res.json({ comments: rows.map((c) => ({ id: c.id, text: c.text, created_at: c.created_at, user: { username: c.username, display_name: c.display_name, avatar_url: c.avatar_url } })) });
});

app.post('/api/reviews/:id/comments', requireAuth, (req, res) => {
  const text = String(req.body?.text || '').trim().slice(0, 2000);
  if (!text) return res.status(400).json({ error: 'empty' });
  if (!Q.reviewById.get(+req.params.id)) return res.status(404).json({ error: 'not found' });
  Q.insertComment.run(+req.params.id, req.user.id, text, now());
  res.json({ ok: true });
});

// ════════════════════════════════════════════════════════════════════
//  FAVORITES & BIO
// ════════════════════════════════════════════════════════════════════
app.post('/api/me/bio', requireAuth, (req, res) => {
  Q.setBio.run(String(req.body?.bio || '').slice(0, 500), req.user.id);
  res.json({ ok: true });
});

app.put('/api/me/favorites', requireAuth, (req, res) => {
  const { position, item } = req.body || {};
  const pos = +position;
  if (!(pos >= 0 && pos <= 3)) return res.status(400).json({ error: 'bad position' });
  if (item === null) { Q.delFavorite.run(req.user.id, pos); return res.json({ ok: true }); }
  if (!item || !item.tmdb_id) return res.status(400).json({ error: 'bad item' });
  Q.setFavorite.run({ user_id: req.user.id, position: pos, tmdb_id: item.tmdb_id, media_type: item.media_type === 'tv' ? 'tv' : 'movie', title: item.title || null, poster: item.poster || null });
  res.json({ ok: true });
});

// ════════════════════════════════════════════════════════════════════
//  LISTS
// ════════════════════════════════════════════════════════════════════
app.get('/api/me/lists', requireAuth, (req, res) => {
  res.json({ lists: Q.listsForUser.all(req.user.id).map((l) => ({ ...l, count: Q.countListItems.get(l.id).c })) });
});

app.post('/api/lists', requireAuth, (req, res) => {
  const name = String(req.body?.name || '').trim().slice(0, 80);
  if (!name) return res.status(400).json({ error: 'name required' });
  const desc = String(req.body?.description || '').slice(0, 500);
  const info = Q.insertList.run(req.user.id, name, desc, now());
  logActivity(req.user.id, 'list', { list_id: info.lastInsertRowid, name });
  res.json({ ok: true, id: info.lastInsertRowid });
});

app.get('/api/lists/:id', (req, res) => {
  const list = Q.listById.get(+req.params.id);
  if (!list) return res.status(404).json({ error: 'not found' });
  res.json({ list, items: Q.listItems.all(list.id) });
});

app.delete('/api/lists/:id', requireAuth, (req, res) => {
  Q.delList.run(+req.params.id, req.user.id);
  res.json({ ok: true });
});

app.post('/api/lists/:id/items', requireAuth, (req, res) => {
  const list = Q.listById.get(+req.params.id);
  if (!list || list.user_id !== req.user.id) return res.status(403).json({ error: 'forbidden' });
  const { tmdb_id, media_type, title, poster } = req.body || {};
  if (!tmdb_id) return res.status(400).json({ error: 'bad item' });
  Q.addListItem.run(list.id, tmdb_id, media_type === 'tv' ? 'tv' : 'movie', title || null, poster || null, Q.countListItems.get(list.id).c);
  res.json({ ok: true });
});

app.delete('/api/lists/:id/items/:type/:tmdbId', requireAuth, (req, res) => {
  const list = Q.listById.get(+req.params.id);
  if (!list || list.user_id !== req.user.id) return res.status(403).json({ error: 'forbidden' });
  Q.delListItem.run(list.id, +req.params.tmdbId, req.params.type === 'tv' ? 'tv' : 'movie');
  res.json({ ok: true });
});

// ════════════════════════════════════════════════════════════════════
//  FOLLOWS & FEED
// ════════════════════════════════════════════════════════════════════
app.post('/api/follow/:userId', requireAuth, (req, res) => {
  const target = +req.params.userId;
  if (target === req.user.id) return res.status(400).json({ error: 'self' });
  if (!Q.userById.get(target)) return res.status(404).json({ error: 'no user' });
  Q.follow.run(req.user.id, target, now());
  logActivity(req.user.id, 'follow', { target });
  res.json({ ok: true });
});

app.delete('/api/follow/:userId', requireAuth, (req, res) => {
  Q.unfollow.run(req.user.id, +req.params.userId);
  res.json({ ok: true });
});

app.get('/api/me/following', requireAuth, (req, res) => {
  res.json({ following: Q.followingUsers.all(req.user.id) });
});

app.get('/api/feed', requireAuth, (req, res) => {
  const rows = Q.feed.all(req.user.id, req.user.id);
  res.json({ feed: rows.map((a) => ({ id: a.id, type: a.type, created_at: a.created_at, payload: JSON.parse(a.payload), user: { username: a.username, display_name: a.display_name, avatar_url: a.avatar_url } })) });
});

// ════════════════════════════════════════════════════════════════════
//  PROFILES & STATS
// ════════════════════════════════════════════════════════════════════
function buildStats(userId) {
  const watched   = Q.countStatus.get(userId, 'watched').c;
  const watching  = Q.countStatus.get(userId, 'watching').c;
  const watchlist = Q.countStatus.get(userId, 'watchlist').c;
  const avg  = Q.avgRating.get(userId);
  const dist = {};
  for (let i = 1; i <= 10; i++) dist[i] = 0;
  for (const row of Q.ratingsDist.all(userId)) dist[row.rating] = row.c;
  const thisYear = String(new Date().getFullYear());
  const diary = Q.userDiary.all(userId, 1000);
  const watchedThisYear = diary.filter((d) => (d.watched_on || '').startsWith(thisYear)).length;
  return { watched, watching, watchlist, rated: avg.c, avg_rating: avg.a ? Number(avg.a.toFixed(2)) : null, distribution: dist, this_year: watchedThisYear };
}

app.get('/api/users/:username', (req, res) => {
  const u = Q.userByName.get(req.params.username);
  if (!u) return res.status(404).json({ error: 'not found' });
  const me = currentUser(req);
  res.json({
    user: publicUser(u), stats: buildStats(u.id),
    favorites: Q.favorites.all(u.id),
    diary: Q.userDiary.all(u.id, 12).map((r) => ({ id: r.id, tmdb_id: r.tmdb_id, media_type: r.media_type, title: r.title, poster: r.poster, rating: r.rating, text: r.text, watched_on: r.watched_on, created_at: r.created_at })),
    lists: Q.listsForUser.all(u.id).map((l) => ({ ...l, count: Q.countListItems.get(l.id).c })),
    followers: Q.followers.get(u.id).c, following: Q.followingCount.get(u.id).c,
    is_following: me ? !!Q.isFollowing.get(me.id, u.id) : false,
    is_me: me ? me.id === u.id : false,
  });
});

app.get('/api/users/:username/collection/:status', (req, res) => {
  const u = Q.userByName.get(req.params.username);
  if (!u) return res.status(404).json({ error: 'not found' });
  const status = req.params.status;
  if (!['watching', 'watched', 'watchlist'].includes(status)) return res.status(400).json({ error: 'bad status' });
  res.json({ items: Q.statusList.all(u.id, status) });
});

// ── Static site ──────────────────────────────────────────────────────
const SITE_DIR = path.join(__dirname, 'site');
app.use(express.static(SITE_DIR, { extensions: ['html'] }));
app.get('*', (req, res) => {
  if (req.path.startsWith('/api') || req.path.startsWith('/auth'))
    return res.status(404).json({ error: 'not found' });
  res.sendFile(path.join(SITE_DIR, 'index.html'));
});

// ════════════════════════════════════════════════════════════════════
//  TELEGRAM BOT
// ════════════════════════════════════════════════════════════════════
const bot = new Bot(BOT_TOKEN);
bot.use(session({ initial: () => ({ step: null, token: null, username: null }) }));

const html = { parse_mode: 'HTML' };

function isValidUsername(name) { return /^[a-zA-Z0-9_]{3,20}$/.test(name); }
function tokenValid(row) { return row && row.status === 'pending' && row.expires_at > now(); }

async function downloadAvatar(ctx, userId) {
  try {
    const photos = await ctx.api.getUserProfilePhotos(ctx.from.id, { limit: 1 });
    if (!photos.total_count) return null;
    const sizes  = photos.photos[0];
    const fileId = sizes[sizes.length - 1].file_id;
    const file   = await ctx.api.getFile(fileId);
    const url    = `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`;
    const res    = await fetch(url);
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    const rel = `/avatars/${userId}.jpg`;
    fs.writeFileSync(path.join(AVATAR_DIR, `${userId}.jpg`), buf);
    return rel;
  } catch { return null; }
}

async function completeAuth(ctx, token, user) {
  Q.claimToken.run(ctx.from.id, user.id, token);
  const callback = `${SITE}/auth/callback?token=${encodeURIComponent(token)}`;
  const kb = { inline_keyboard: [[{ text: 'Войти на Reelogue', url: callback, icon_custom_emoji_id: E.link }]] };
  await ctx.reply(
    `<b>${em(E.check, '✅')} Готово, ${escapeHtml(user.display_name)}!</b>\n\n` +
    `${em(E.clock, '⏰')} Ссылка действует <b>10 минут</b>. ` +
    `Нажми кнопку ниже, чтобы открыть сайт уже авторизованным.`,
    { ...html, reply_markup: kb }
  );
}

// /start
bot.command('start', async (ctx) => {
  const payload = ctx.match;
  ctx.session.step = null; ctx.session.token = null; ctx.session.username = null;

  if (!payload || !payload.startsWith('auth_')) {
    const kb = new InlineKeyboard().url('Открыть Reelogue', SITE);
    return ctx.reply(
      `<b>${em(E.bot, '🤖')} Reelogue</b>\n\n` +
      `${em(E.film, '📁')} Дневник фильмов и сериалов в стиле Letterboxd.\n\n` +
      `Чтобы войти, открой сайт и нажми <b>«Войти через Telegram»</b>.`,
      { ...html, reply_markup: kb }
    );
  }

  const token = payload.slice('auth_'.length);
  const row   = Q.tokenByValue.get(token);

  if (!tokenValid(row)) {
    return ctx.reply(
      `<b>${em(E.cross, '❌')} Ссылка устарела.</b>\n\nВернись на сайт и запроси вход заново.`,
      html
    );
  }

  const existing = Q.userByTg.get(ctx.from.id);
  if (existing) return completeAuth(ctx, token, existing);

  ctx.session.step  = 'username';
  ctx.session.token = token;
  return ctx.reply(
    `<b>${em(E.party, '🎉')} Добро пожаловать в Reelogue!</b>\n\n` +
    `${em(E.pen, '🖋')} Давай создадим профиль. Придумай <b>имя пользователя</b> ` +
    `(латиница, цифры и «_», 3–20 символов):`,
    html
  );
});

// Регистрация — шаги
bot.on('message:text', async (ctx) => {
  const step = ctx.session.step;
  if (!step) return;
  const text = ctx.message.text.trim();

  if (step === 'username') {
    const uname = text.replace(/^@/, '');
    if (!isValidUsername(uname))
      return ctx.reply(`${em(E.cross, '❌')} Неверный формат. Используй 3–20 символов: латиница, цифры и «_». Попробуй ещё раз:`, html);
    if (Q.userByName.get(uname))
      return ctx.reply(`${em(E.cross, '❌')} <b>@${escapeHtml(uname)}</b> уже занято. Выбери другое:`, html);
    ctx.session.username = uname;
    ctx.session.step     = 'display';
    return ctx.reply(
      `${em(E.check, '✅')} Отлично!\n\n${em(E.write, '✍')} Теперь введи <b>отображаемое имя</b> (как тебя будут видеть, до 40 символов):`,
      html
    );
  }

  if (step === 'display') {
    const display = text.slice(0, 40);
    if (!display.length)
      return ctx.reply(`${em(E.cross, '❌')} Имя не может быть пустым. Попробуй ещё раз:`, html);

    const token = ctx.session.token;
    const row   = Q.tokenByValue.get(token);
    if (!tokenValid(row)) {
      ctx.session.step = null;
      return ctx.reply(`${em(E.cross, '❌')} Ссылка для входа устарела. Вернись на сайт и начни заново.`, html);
    }
    if (Q.userByName.get(ctx.session.username)) {
      ctx.session.step = 'username';
      return ctx.reply(`${em(E.cross, '❌')} Это имя только что заняли. Придумай другое:`, html);
    }

    const info   = Q.insertUser.run(ctx.from.id, ctx.session.username, display, null, now());
    const userId = info.lastInsertRowid;
    const avatar = await downloadAvatar(ctx, userId);
    if (avatar) Q.setAvatar.run(avatar, userId);

    const uname = ctx.session.username;
    const user  = { id: userId, display_name: display };
    ctx.session.step = null; ctx.session.username = null;

    await ctx.reply(`<b>${em(E.profile, '👤')} Профиль @${escapeHtml(uname)} создан!</b>`, html);
    return completeAuth(ctx, token, user);
  }
});

bot.catch((err) => console.error('Bot error:', err.error || err));

// ════════════════════════════════════════════════════════════════════
//  ЗАПУСК
// ════════════════════════════════════════════════════════════════════
setInterval(cleanup, 60 * 1000);

// Сначала поднимаем HTTP-сервер, затем запускаем бота
app.listen(PORT, async () => {
  console.log(`🎬 Reelogue server → ${SITE} (port ${PORT})`);
  const botName = await getBotUsername();
  if (botName) console.log(`   deep-link: https://t.me/${botName}?start=auth_…`);
});

bot.start({
  onStart: (info) => console.log(`🤖 Reelogue bot @${info.username} started`),
});
