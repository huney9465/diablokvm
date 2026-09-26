'use strict';
// Recovery tool: resets (or recreates) an administrator account directly in the database.
// Use this whenever "admin / admin" (or whatever ADMIN_USERNAME/ADMIN_PASSWORD you expect) is
// rejected with "Wrong username or password" — most often because the account already existed
// in the database from an earlier install/upgrade with a different, forgotten password, or the
// account was disabled/deleted and the panel's normal first-run seeding only ever runs once
// (when the users table is completely empty), so it never repairs an existing account.
//
// Usage:
//   node src/reset-admin.js                                  # reset $ADMIN_USERNAME (default
//                                                             # "admin") to $ADMIN_PASSWORD, or a
//                                                             # fresh random one if unset
//   node src/reset-admin.js <username>                       # reset that user to a random password
//   node src/reset-admin.js <username> <password>            # reset that user to a chosen password
//   node src/reset-admin.js <username> <password> <email>    # also set/update the account's email
//
// Always re-enables the account, clears any "disabled" flag, makes sure the role is 'admin',
// and forces a password change on next sign-in (unless you pass an explicit password). This is
// the same script `npm run reset-admin` runs, and it doubles as "create an admin account": if
// <username> doesn't exist yet it is created fresh with whatever username/password/email you gave.
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const config = require('./config');
const { db } = require('./db');

const argUser = process.argv[2] || config.adminUser;
const argPass = process.argv[3] || config.adminPassword;
const argEmail = process.argv[4] || config.adminEmail || null;
const usingRandom = !argPass;
const password = argPass || crypto.randomBytes(9).toString('base64url');
const hash = bcrypt.hashSync(password, 12);

const existing = db.prepare('SELECT * FROM users WHERE username = ?').get(argUser);

if (existing) {
  // Only touch the email if one was actually supplied, so a plain reset never wipes it.
  db.prepare('UPDATE users SET password_hash = ?, role = ?, disabled = 0, must_change_password = ?, email = COALESCE(?, email) WHERE id = ?')
    .run(hash, 'admin', usingRandom ? 1 : 0, argEmail, existing.id);
  console.log(`\n  Updated existing account "${argUser}" (was role="${existing.role}", disabled=${existing.disabled}).`);
} else {
  db.prepare("INSERT INTO users (username, email, password_hash, role, max_vms, must_change_password) VALUES (?, ?, ?, 'admin', 1000, ?)")
    .run(argUser, argEmail, hash, usingRandom ? 1 : 0);
  console.log(`\n  Created new admin account "${argUser}" (no user with that name existed).`);
}

console.log(`  username: ${argUser}`);
if (argEmail) console.log(`  email: ${argEmail}`);
console.log(`  password: ${password}${usingRandom ? '  (random — you will be asked to change it after signing in)' : ''}\n`);
console.log('  Restart the panel is NOT required, this took effect immediately in the database.\n');
