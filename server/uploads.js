'use strict';
// Secure file uploads: memory buffer -> magic-byte check -> random filename in a private folder
// that is never served statically. Files are streamed back only through authorised routes.
const multer = require('multer');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const { DATA_DIR } = require('./db');
const { bad } = require('./lib');

const PRIVATE_DIR = path.join(DATA_DIR, 'private');
const PUBLIC_DIR = path.join(DATA_DIR, 'public-uploads');
fs.mkdirSync(PRIVATE_DIR, { recursive: true });
fs.mkdirSync(PUBLIC_DIR, { recursive: true });

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 6, fields: 20 },
});

function sniff(buf) {
  if (buf.length < 4) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { mime: 'image/jpeg', ext: '.jpg' };
  if (buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { mime: 'image/png', ext: '.png' };
  if (buf.slice(0, 4).toString() === '%PDF') return { mime: 'application/pdf', ext: '.pdf' };
  if (buf.slice(0, 4).toString() === 'RIFF' && buf.slice(8, 12).toString() === 'WEBP') return { mime: 'image/webp', ext: '.webp' };
  return null;
}

// Saves a multer file. visibility: 'private' (KYC, payment proofs) or 'public' (ad images, QR code).
function saveFile(file, { visibility = 'private', imagesOnly = false } = {}) {
  if (!file) throw bad('File is required');
  const t = sniff(file.buffer);
  if (!t) throw bad('Only JPG, PNG, WEBP or PDF files are allowed');
  if (imagesOnly && t.mime === 'application/pdf') throw bad('Please upload an image (JPG, PNG or WEBP)');
  const name = crypto.randomBytes(16).toString('hex') + t.ext;
  const dir = visibility === 'public' ? PUBLIC_DIR : PRIVATE_DIR;
  fs.writeFileSync(path.join(dir, name), file.buffer, { mode: 0o600 });
  return { stored_name: name, mime: t.mime, original_name: String(file.originalname || '').slice(0, 120) };
}

function sendPrivate(res, storedName, mime) {
  if (!/^[a-f0-9]{32}\.(jpg|png|pdf|webp)$/.test(storedName)) return res.status(400).end();
  res.set('Content-Type', mime);
  res.set('Cache-Control', 'no-store');
  res.set('Content-Disposition', 'inline');
  res.sendFile(path.join(PRIVATE_DIR, storedName));
}

module.exports = { upload, saveFile, sendPrivate, PUBLIC_DIR };
