'use strict';
const crypto = require('crypto');
const { db, allSettings } = require('../db');
const { sha256 } = require('../util');

// Attaches req.user, flash helpers and template locals to every request.
function loadContext(req, res, next) {
  req.user = null;
  if (req.session.uid) {
    const u = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.uid);
    if (u && !u.disabled) req.user = u;
    else delete req.session.uid;
  }
  req.flash = (type, message) => { (req.session.flash ||= []).push({ type, message }); };
  // Messages are shown (and cleared) only when a page is rendered. JSON polling requests such as
  // /vms/status must never consume them, or the user would miss what their click just did.
  const render = res.render.bind(res);
  res.render = (view, options, callback) => {
    if (typeof options === 'function') { callback = options; options = {}; }
    const flash = req.session.flash || [];
    delete req.session.flash;
    return render(view, { flash, ...(options || {}) }, callback);
  };
  res.locals.flash = [];
  res.locals.user = req.user;
  res.locals.settings = allSettings();
  res.locals.csrfToken = csrfToken(req);
  res.locals.path = req.path;
  next();
}

function csrfToken(req) {
  if (!req.session.csrf) req.session.csrf = crypto.randomBytes(24).toString('hex');
  return req.session.csrf;
}

function verifyCsrf(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const sent = req.body?._csrf || req.get('x-csrf-token');
  const want = req.session.csrf;
  if (sent && want && sent.length === want.length && crypto.timingSafeEqual(Buffer.from(sent), Buffer.from(want))) return next();
  res.status(403).render('error', { title: 'Session expired', message: 'Your form session expired. Go back, reload the page and try again.' });
}

function requireLogin(req, res, next) {
  if (!req.user) {
    if (req.method === 'GET') req.session.returnTo = req.originalUrl;
    return res.redirect('/login');
  }
  // Accounts seeded with the default password must change it before they can do anything else.
  // The profile pages (where the change happens) and logout stay reachable.
  if (req.user.must_change_password && !req.path.startsWith('/profile') && req.path !== '/logout') {
    req.flash('warn', 'For your security, please set a new password before continuing.');
    return res.redirect('/profile');
  }
  next();
}
function requireAdmin(req, res, next) {
  if (req.user?.role === 'admin') return next();
  res.status(403).render('error', { title: 'Admins only', message: 'You need an administrator account to open this page.' });
}

// Bearer-token auth for /api/v1.
function apiAuth(req, res, next) {
  const h = req.get('authorization') || '';
  const token = h.startsWith('Bearer ') ? h.slice(7).trim() : '';
  if (!token) return res.status(401).json({ error: 'Missing bearer token' });
  const key = db.prepare('SELECT * FROM api_keys WHERE key_hash = ?').get(sha256(token));
  const user = key && db.prepare('SELECT * FROM users WHERE id = ? AND disabled = 0').get(key.user_id);
  if (!user) return res.status(401).json({ error: 'Invalid API key' });
  db.prepare("UPDATE api_keys SET last_used = datetime('now') WHERE id = ?").run(key.id);
  req.user = user;
  next();
}

// Tiny in-memory limiter for login attempts.
const attempts = new Map();
function loginLimiter(req, res, next) {
  const now = Date.now();
  const key = req.ip;
  const rec = (attempts.get(key) || []).filter((t) => now - t < 15 * 60 * 1000);
  if (rec.length >= 10) {
    return res.status(429).render('login', { title: 'Sign in', error: 'Too many attempts. Wait 15 minutes and try again.', discord: false });
  }
  req.recordFailure = () => { rec.push(now); attempts.set(key, rec); };
  req.clearFailures = () => attempts.delete(key);
  attempts.set(key, rec);
  next();
}

module.exports = { loadContext, verifyCsrf, requireLogin, requireAdmin, apiAuth, loginLimiter };
