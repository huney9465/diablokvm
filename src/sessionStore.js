'use strict';
const session = require('express-session');

// Small express-session store backed by the panel's SQLite database.
class SqliteStore extends session.Store {
  constructor(db, ttlMs = 7 * 24 * 3600 * 1000) {
    super();
    this.db = db;
    this.ttl = ttlMs;
    this.q = {
      get: db.prepare('SELECT sess FROM sessions WHERE sid = ? AND expires > ?'),
      set: db.prepare('INSERT INTO sessions (sid, sess, expires) VALUES (?,?,?) ON CONFLICT(sid) DO UPDATE SET sess = excluded.sess, expires = excluded.expires'),
      del: db.prepare('DELETE FROM sessions WHERE sid = ?'),
      prune: db.prepare('DELETE FROM sessions WHERE expires <= ?'),
    };
    setInterval(() => this.q.prune.run(Date.now()), 15 * 60 * 1000).unref();
  }
  expiry(sess) { return sess?.cookie?.expires ? new Date(sess.cookie.expires).getTime() : Date.now() + this.ttl; }
  get(sid, cb) {
    try { const r = this.q.get.get(sid, Date.now()); cb(null, r ? JSON.parse(r.sess) : null); } catch (e) { cb(e); }
  }
  set(sid, sess, cb) {
    try { this.q.set.run(sid, JSON.stringify(sess), this.expiry(sess)); cb && cb(null); } catch (e) { cb && cb(e); }
  }
  touch(sid, sess, cb) { this.set(sid, sess, cb); }
  destroy(sid, cb) {
    try { this.q.del.run(sid); cb && cb(null); } catch (e) { cb && cb(e); }
  }
}
module.exports = SqliteStore;
