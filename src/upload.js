'use strict';
// Multipart uploads (background image / GIF). Files land in DATA_DIR/branding and are served
// read-only from /branding. Only a strict set of image types is accepted, and the stored file
// name is generated here, so nothing a visitor sends can escape the folder.
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const config = require('./config');

const EXT = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/jpg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp' };

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, config.brandingDir),
  filename: (req, file, cb) => {
    const ext = EXT[file.mimetype] || (path.extname(file.originalname || '').toLowerCase().match(/^\.(png|jpe?g|gif|webp)$/) || [''])[0] || '.img';
    cb(null, `bg-${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}${ext}`);
  },
});

function fileFilter(req, file, cb) {
  const ok = !!EXT[file.mimetype] || /\.(png|jpe?g|gif|webp)$/i.test(file.originalname || '');
  cb(ok ? null : new Error('Only PNG, JPEG, GIF or WebP images are allowed.'), ok);
}

const upload = multer({ storage, fileFilter, limits: { fileSize: 12 * 1024 * 1024, files: 4 } });

// Per-VM file uploads. These are arbitrary files (any type) a user drops into their VM folder,
// so they are spooled to DATA_DIR/uploads first and then moved onto the VM's node. 1 GB limit.
const VM_MAX = 1024 * 1024 * 1024;
const vmStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, config.uploadDir),
  filename: (req, file, cb) => cb(null, `vm-${Date.now().toString(36)}-${crypto.randomBytes(6).toString('hex')}.part`),
});
const vmUpload = multer({ storage: vmStorage, limits: { fileSize: VM_MAX, files: 1 } });

// A file name we are willing to serve back out of DATA_DIR/branding.
const BRANDING_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,120}\.(png|jpg|jpeg|gif|webp)$/i;
const isBrandingFile = (name) => BRANDING_RE.test(String(name || '')) && !String(name).includes('..');

module.exports = { upload, vmUpload, VM_MAX, isBrandingFile };
