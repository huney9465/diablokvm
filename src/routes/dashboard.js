'use strict';
const express = require('express');
const { db } = require('../db');
const nodes = require('../services/nodes');
const V = require('../services/vmdata');

const router = express.Router();

router.get('/dashboard', async (req, res) => {
  const admin = req.user.role === 'admin';
  const vms = V.listVms(req.user, admin);
  const running = vms.filter((v) => v.status === 'running');
  const data = {
    title: 'Dashboard', vms: vms.slice(0, 8), total: vms.length, running: running.length,
    usedCpu: running.reduce((s, v) => s + v.cpu, 0), usedRamMb: running.reduce((s, v) => s + v.ram_mb, 0),
    quota: req.user.max_vms,
  };
  if (admin) {
    const alloc = Object.fromEntries(db.prepare('SELECT node_id, COUNT(*) AS vms, SUM(ram_mb) AS mb FROM vms GROUP BY node_id').all().map((r) => [r.node_id, r]));
    data.nodes = [];
    for (const n of db.prepare('SELECT * FROM nodes ORDER BY id').all()) {
      const i = await nodes.info(n.id);
      data.nodes.push({ ...n, online: i.online, stats: i.stats, vms: alloc[n.id]?.vms || 0, allocMb: alloc[n.id]?.mb || 0 });
    }
    data.users = db.prepare('SELECT COUNT(*) c FROM users').all()[0].c;
    data.activity = db.prepare(`SELECT a.*, u.username FROM audit a LEFT JOIN users u ON u.id = a.user_id ORDER BY a.id DESC LIMIT 12`).all();
  }
  res.render('dashboard', data);
});

module.exports = router;
