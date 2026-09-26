'use strict';
const path = require('path');
const http = require('http');
const express = require('express');
const session = require('express-session');
const helmet = require('helmet');
const config = require('./config');
const { db } = require('./db');
const SqliteStore = require('./sessionStore');
const { loadContext, verifyCsrf, requireLogin, requireAdmin, apiAuth } = require('./middleware/auth');
const host = require('./host');
const { attachWebSockets } = require('./ws');
const { upload, vmUpload } = require('./upload');

const app = express();
if (config.trustProxy) app.set('trust proxy', 1);
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '..', 'views'));
app.disable('x-powered-by');

app.use(helmet({
  hsts: false,
  contentSecurityPolicy: {
    useDefaults: false,
    directives: {
      'default-src': ["'self'"],
      'script-src': ["'self'"],
      'style-src': ["'self'", "'unsafe-inline'"],
      'img-src': ["'self'", 'data:', 'https:', 'http:'],
      'connect-src': ["'self'", 'ws:', 'wss:'],
      'font-src': ["'self'"],
      'frame-ancestors': ["'none'"],
      'form-action': ["'self'"],
      'base-uri': ["'self'"],
    },
  },
}));

const pub = path.join(__dirname, '..', 'public');
const mod = (p) => path.join(__dirname, '..', 'node_modules', p);
// Cache-busting version for static assets. /static is served with a 1h max-age, so without this
// an upgrade would keep serving the previous CSS/JS from the browser cache for up to an hour.
const fs = require('fs');
app.locals.assetVersion = (() => {
  try { return String(Math.floor(fs.statSync(path.join(pub, 'css', 'app.css')).mtimeMs)); }
  catch { return '1'; }
})();
app.use('/static', express.static(pub, { maxAge: '1h' }));
app.use('/branding', express.static(config.brandingDir, { maxAge: '1h', fallthrough: true }));
app.use('/vendor/novnc', express.static(mod('@novnc/novnc')));
app.use('/vendor/xterm', express.static(mod('@xterm/xterm')));
app.use('/vendor/xterm-fit', express.static(mod('@xterm/addon-fit')));

// Node installer endpoints: no session, the codes and tokens are the credentials.
app.use(require('./routes/deploy'));

// JSON API is stateless (bearer tokens) so it skips sessions and CSRF.
app.use('/api/v1', express.json({ limit: '100kb' }), apiAuth, require('./routes/api'));

const sessionParser = session({
  name: 'kvmp.sid',
  secret: config.getSessionSecret(),
  resave: false,
  saveUninitialized: false,
  store: new SqliteStore(db),
  cookie: { httpOnly: true, sameSite: 'lax', secure: config.secureCookies, maxAge: 7 * 24 * 3600 * 1000 },
});
app.use(sessionParser);
// Multipart forms (background/branding uploads) are parsed before the body parser so
// req.body and req.files are both available to the CSRF check and route handlers.
// The settings forms use the small 12 MB parser; the per-VM file upload uses its own 1 GB
// parser. Both run here, before verifyCsrf, so the multipart _csrf field is parsed in time.
const smallUpload = upload.any();
const vmFileUpload = vmUpload.single('file');
app.use((req, res, next) => {
  if (/^\/vms\/\d+\/files\/upload$/.test(req.path)) {
    // Parse the 1 GB upload first. A multer error (e.g. file too large) is stashed so the
    // route can report it after CSRF has been verified.
    return vmFileUpload(req, res, (err) => { req.uploadError = err || null; next(); });
  }
  return smallUpload(req, res, next);
});
app.use(express.urlencoded({ extended: false, limit: '100kb' }));
app.use(loadContext);
app.use(verifyCsrf);

app.use(require('./routes/auth'));
app.get('/', (req, res) => res.redirect(req.user ? '/dashboard' : '/login'));
app.use(requireLogin);
app.use(require('./routes/dashboard'));
app.use(require('./routes/vms'));
app.use(require('./routes/profile'));
app.use('/admin', requireAdmin, require('./routes/admin'));

app.use((req, res) => res.status(404).render('error', { title: 'Not found', message: 'That page does not exist.' }));
app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  console.error(err);
  if (res.headersSent) return;
  res.status(500).render('error', { title: 'Something broke', message: 'The panel hit an unexpected error. Details are in the server log.' });
});

const server = http.createServer(app);
attachWebSockets(server, sessionParser);

server.listen(config.port, config.host, () => {
  console.log(`Diablo listening on http://${config.host}:${config.port}`);
  console.log(host.HAS_KVM ? 'Local node KVM acceleration: available' : 'Local node KVM acceleration: NOT available (/dev/kvm missing), VMs there will be slow');
  // Boot the Local node's autostart VMs. Other nodes do the same on their own when their agent starts.
  host.reconcile(db.prepare('SELECT * FROM vms WHERE node_id = 1').all()).catch((e) => console.error('reconcile failed:', e.message));
  // Watch running VMs for mining-like CPU use.
  require('./services/mining').start();
});

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { server.close(); process.exit(0); }); // VMs keep running: they are daemonized
