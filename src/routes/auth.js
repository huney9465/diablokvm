'use strict';
const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const config = require('../config');
const { db, setting, audit, discordConfig } = require('../db');
const { loginLimiter } = require('../middleware/auth');
const { PANEL_USER_RE } = require('../util');

const router = express.Router();
const discordOn = () => discordConfig().enabled;
const view = (res, name, extra = {}) => res.render(name, { title: 'Sign in', error: null, discord: discordOn(), ...extra });

function signIn(req, res, user) {
  const returnTo = req.session.returnTo;
  req.session.regenerate((err) => {
    if (err) throw err;
    req.session.uid = user.id;
    audit(user.id, 'login', user.username);
    const safe = returnTo && returnTo.startsWith('/') && !returnTo.startsWith('//') ? returnTo : '/dashboard';
    res.redirect(safe);
  });
}

router.get('/login', (req, res) => (req.user ? res.redirect('/dashboard') : view(res, 'login')));

router.post('/login', loginLimiter, async (req, res) => {
  const { username = '', password = '' } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username.trim());
  // Compare even when the user is unknown so timing does not reveal valid names.
  const ok = await bcrypt.compare(password, user?.password_hash || '$2a$12$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidin');
  if (!user || !user.password_hash || !ok || user.disabled) {
    req.recordFailure();
    return view(res, 'login', { error: 'Wrong username or password.' });
  }
  req.clearFailures();
  signIn(req, res, user);
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

// ---- self-registration (off unless an admin enables it) ------------------------------------
router.get('/register', (req, res) => {
  if (setting('allow_registration') !== '1') return res.redirect('/login');
  res.render('register', { title: 'Create account', error: null });
});
router.post('/register', loginLimiter, async (req, res) => {
  if (setting('allow_registration') !== '1') return res.redirect('/login');
  const { username = '', email = '', password = '' } = req.body;
  const fail = (error) => res.render('register', { title: 'Create account', error });
  if (!PANEL_USER_RE.test(username)) return fail('Usernames are 3 to 32 characters: letters, numbers, dot, dash or underscore.');
  if (password.length < 8) return fail('Use a password of at least 8 characters.');
  if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) return fail('That username is taken.');
  const info = db.prepare("INSERT INTO users (username, email, password_hash, role, max_vms) VALUES (?,?,?,'user',3)")
    .run(username, email.trim() || null, await bcrypt.hash(password, 12));
  signIn(req, res, db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid));
});

// ---- Discord OAuth2 ------------------------------------------------------------------------
router.get('/auth/discord', (req, res) => {
  const dc = discordConfig();
  if (!dc.enabled) return res.redirect('/login');
  const state = crypto.randomBytes(16).toString('hex');
  req.session.oauthState = state;
  const q = new URLSearchParams({
    client_id: dc.clientId, redirect_uri: dc.redirectUri,
    response_type: 'code', scope: 'identify email', state,
    // Deliberately no prompt=none: that forces a silent check and fails for anyone who has not
    // already authorised the app, which is why a first-time login never completed. Letting Discord
    // show its consent screen is what makes "Continue with Discord" actually sign people in.
  });
  res.redirect(`https://discord.com/oauth2/authorize?${q}`);
});

router.get('/auth/discord/callback', async (req, res) => {
  try {
    if (!discordOn()) return res.redirect('/login');
    const dc = discordConfig();
    const { code, state, error, error_description } = req.query;
    if (error) throw new Error(error_description || 'Discord sign-in was cancelled or refused.');
    if (!code || !state || state !== req.session.oauthState) throw new Error('Login state did not match. Try again.');
    delete req.session.oauthState;
    const tokenRes = await fetch('https://discord.com/api/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: dc.clientId, client_secret: dc.clientSecret,
        grant_type: 'authorization_code', code, redirect_uri: dc.redirectUri,
      }),
    });
    if (!tokenRes.ok) {
      const detail = await tokenRes.text().catch(() => '');
      throw new Error(`Discord rejected the login code.${detail ? ` (${detail.slice(0, 180)})` : ''}`);
    }
    const { access_token } = await tokenRes.json();
    const meRes = await fetch('https://discord.com/api/users/@me', { headers: { Authorization: `Bearer ${access_token}` } });
    if (!meRes.ok) throw new Error('Could not read your Discord profile.');
    const me = await meRes.json();

    let user = db.prepare('SELECT * FROM users WHERE discord_id = ?').get(me.id);
    if (!user && req.user) { // logged-in user linking their account
      db.prepare('UPDATE users SET discord_id = ? WHERE id = ?').run(me.id, req.user.id);
      req.flash('ok', 'Discord account linked.');
      return res.redirect('/profile');
    }
    // If the Discord account carries an email that matches an existing, unlinked panel account,
    // link the two instead of making a duplicate. This is what lets an admin-created user sign in
    // with Discord without an extra step.
    if (!user && me.email) {
      const byEmail = db.prepare('SELECT * FROM users WHERE email = ? AND discord_id IS NULL').get(me.email);
      if (byEmail) {
        db.prepare('UPDATE users SET discord_id = ? WHERE id = ?').run(me.id, byEmail.id);
        user = db.prepare('SELECT * FROM users WHERE id = ?').get(byEmail.id);
      }
    }
    if (!user) {
      if (setting('allow_discord_signup') !== '1') throw new Error('No panel account is linked to this Discord user. Ask an admin, or link Discord from your profile after signing in.');
      let name = (me.username || 'user').replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 24) || 'user';
      while (db.prepare('SELECT 1 FROM users WHERE username = ?').get(name)) name = name.slice(0, 24) + Math.floor(Math.random() * 1000);
      const info = db.prepare("INSERT INTO users (username, email, role, discord_id, max_vms) VALUES (?,?,'user',?,3)").run(name, me.email || null, me.id);
      user = db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);
    }
    if (user.disabled) throw new Error('This account is disabled.');
    signIn(req, res, user);
  } catch (e) {
    view(res, 'login', { error: e.message });
  }
});

module.exports = router;
