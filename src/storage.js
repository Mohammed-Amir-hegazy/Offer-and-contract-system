// Uploaded files (logos, stamps, plans, fonts): Vercel Blob when BLOB_READ_WRITE_TOKEN is set,
// a local folder otherwise. The value stored in the database is either a full Blob URL or a
// local file name; uploadUrl() turns either into something a page can link to.
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { DATA_DIR, ConfigError, envBySuffix } = require('./db');
const { upload } = require('./format');

const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(DATA_DIR, 'uploads');
const blobToken = () => envBySuffix(['BLOB_READ_WRITE_TOKEN']);

async function saveUpload(buffer, ext, contentType) {
  const name = `${crypto.randomBytes(12).toString('hex')}${ext}`;
  if (blobToken()) {
    const { put } = require('@vercel/blob');
    const blob = await put(`uploads/${name}`, buffer, { access: 'public', contentType, addRandomSuffix: false, token: blobToken() });
    return blob.url;
  }
  if (process.env.VERCEL) throw new ConfigError('لم يتم ربط مخزن الملفات: أنشئ Vercel Blob للمشروع من تبويب Storage');
  await fs.mkdir(UPLOAD_DIR, { recursive: true });
  await fs.writeFile(path.join(UPLOAD_DIR, name), buffer);
  return name;
}

// Files are not deleted when replaced: issued quotes and contracts keep referencing them.
const uploadUrl = upload;

module.exports = { UPLOAD_DIR, saveUpload, uploadUrl };
