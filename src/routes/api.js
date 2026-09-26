'use strict';
const express = require('express');
const nodes = require('../services/nodes');
const { audit } = require('../db');
const V = require('../services/vmdata');

const router = express.Router();

const shape = (vm) => ({
  id: vm.id, name: vm.name, status: vm.status, owner: vm.owner_name, cpu: vm.cpu, ram_mb: vm.ram_mb, disk_gb: vm.disk_gb,
  os: vm.template_name, node: vm.node_name, network: vm.net_mode, ip: vm.ip, created_at: vm.created_at,
});

router.get('/vms', (req, res) => res.json({ vms: V.listVms(req.user, req.query.all === '1').map(shape) }));

router.param('id', (req, res, next, id) => {
  const vm = /^\d+$/.test(id) ? V.getVm(Number(id)) : null;
  if (!vm || !V.canAccess(req.user, vm)) return res.status(404).json({ error: 'VM not found' });
  req.vm = vm;
  next();
});

router.get('/vms/:id', (req, res) => res.json(shape(req.vm)));

const actions = { start: 'start', stop: 'stop', 'force-stop': 'forceStop', reboot: 'reboot' };
router.post('/vms/:id/:action', async (req, res) => {
  const method = actions[req.params.action];
  if (!method) return res.status(400).json({ error: `Unknown action. Use one of: ${Object.keys(actions).join(', ')}` });
  try {
    await nodes.exec(req.vm.node_id)[method](req.vm);
    audit(req.user.id, `api.vm.${req.params.action}`, `${req.vm.id}:${req.vm.name}`);
    res.json({ ok: true });
  } catch (e) { res.status(409).json({ error: e.message }); }
});

router.use((req, res) => res.status(404).json({ error: 'Not found' }));
module.exports = router;
