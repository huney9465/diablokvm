'use strict';
const express = require('express');
const bcrypt = require('bcryptjs');
const config = require('../config');
const { db, audit } = require('../db');
const { randomToken, sha256 } = require('../util');

const router = express.Router();

const keysFor = (uid) => db.prepare('SELECT id, name, prefix, created_at, last_used FROM api_keys WHERE user_id = ? ORDER BY id DESC').all(uid);
const page = (req, res, extra = {}) => res.render('profile', {
  title: 'Profile', keys: keysFor(req.user.id), newKey: null,
  discordAvailable: !!(config.discord.clientId && config.discord.clientSecret && config.discord.redirectUri), ...extra,
});

router.get('/profile', (req, res) => page(req, res));

router.post('/profile/details', (req, res) => {
  const b = req.body;
  // A logo/banner may be a URL, an uploaded image, or cleared. Uploads land in /branding.
  const pick = (urlField, fileField, clearField) => {
    let val = String(b[urlField] || '').trim().slice(0, 500);
    if (!/^(https?:\/\/|\/branding\/)/.test(val)) val = '';
    const f = (req.files || []).find((x) => x.fieldname === fileField);
    if (f) val = `/branding/${f.filename}`;
    if (b[clearField]) val = '';
    return val;
  };
  const logo = pick('logo_image', 'logo_file', 'logo_clear');
  const banner = pick('banner_image', 'banner_file', 'banner_clear');
  db.prepare('UPDATE users SET email = ?, logo_image = ?, banner_image = ? WHERE id = ?')
    .run(String(b.email || '').trim().slice(0, 200) || null, logo || null, banner || null, req.user.id);
  audit(req.user.id, 'user.profile', req.user.username);
  req.flash('ok', 'Profile saved.');
  res.redirect('/profile');
});

router.post('/profile/password', async (req, res) => {
  const { current = '', next = '', confirm = '' } = req.body;
  const forced = !!req.user.must_change_password;
  if (req.user.password_hash && !(await bcrypt.compare(current, req.user.password_hash))) req.flash('err', 'Your current password is wrong.');
  else if (next.length < 8) req.flash('err', 'Use a new password of at least 8 characters.');
  else if (next !== confirm) req.flash('err', 'The two new passwords do not match.');
  else {
    db.prepare('UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?').run(await bcrypt.hash(next, 12), req.user.id);
    audit(req.user.id, 'user.password', req.user.username);
    req.flash('ok', forced ? 'Password updated. You are all set.' : 'Password changed.');
    return res.redirect('/dashboard');
  }
  res.redirect('/profile');
});

router.post('/profile/discord/unlink', (req, res) => {
  if (!req.user.password_hash) req.flash('err', 'Set a password first, otherwise you would lock yourself out.');
  else { db.prepare('UPDATE users SET discord_id = NULL WHERE id = ?').run(req.user.id); req.flash('ok', 'Discord account unlinked.'); }
  res.redirect('/profile');
});

router.post('/profile/api-keys', (req, res) => {
  const name = String(req.body.name || '').trim().slice(0, 60) || 'Unnamed key';
  if (db.prepare('SELECT COUNT(*) c FROM api_keys WHERE user_id = ?').get(req.user.id).c >= 20) {
    req.flash('err', 'You can keep up to 20 API keys. Delete one first.');
    return res.redirect('/profile');
  }
  const token = `kvmp_${randomToken(24)}`;
  db.prepare('INSERT INTO api_keys (user_id, name, prefix, key_hash) VALUES (?,?,?,?)').run(req.user.id, name, token.slice(0, 10), sha256(token));
  audit(req.user.id, 'apikey.create', name);
  page(req, res, { newKey: token });
});

router.post('/profile/api-keys/:id/delete', (req, res) => {
  db.prepare('DELETE FROM api_keys WHERE id = ? AND user_id = ?').run(req.params.id, req.user.id);
  req.flash('ok', 'API key deleted.');
  res.redirect('/profile');
});

module.exports = router;
