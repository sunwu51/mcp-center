import { randomUUID } from 'crypto';
import { mkdir, writeFile } from 'fs/promises';
import { extname, resolve } from 'path';
import { tmpdir } from 'os';

export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
export const MAX_UPLOAD_BODY_BYTES = Math.ceil(MAX_UPLOAD_BYTES * 4 / 3) + 64 * 1024;

const MIME_EXTENSIONS = new Map([
  ['image/gif', '.gif'],
  ['image/jpeg', '.jpg'],
  ['image/png', '.png'],
  ['image/webp', '.webp'],
  ['image/bmp', '.bmp'],
  ['image/tiff', '.tiff'],
  ['image/avif', '.avif'],
  ['image/svg+xml', '.svg'],
]);

function normalizeExtension(filename, mimeType) {
  const candidate = typeof filename === 'string' ? extname(filename) : '';
  if (candidate && /^\.[a-zA-Z0-9]{1,10}$/.test(candidate)) {
    return candidate.toLowerCase();
  }
  return MIME_EXTENSIONS.get(mimeType?.toLowerCase()) || '';
}

function decodeBase64(value) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new UploadError(400, 'base64 is required');
  }

  let encoded = value;
  let dataUrlMimeType;
  const dataUrlMatch = value.match(/^data:([^;,]+);base64,(.*)$/s);
  if (dataUrlMatch) {
    dataUrlMimeType = dataUrlMatch[1];
    encoded = dataUrlMatch[2];
  }

  encoded = encoded.replace(/\s/g, '');
  if (!encoded || encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) {
    throw new UploadError(400, 'Invalid base64 data');
  }

  const buffer = Buffer.from(encoded, 'base64');
  if (buffer.length > MAX_UPLOAD_BYTES) {
    throw new UploadError(413, `Decoded file exceeds ${MAX_UPLOAD_BYTES} bytes`);
  }
  return { buffer, dataUrlMimeType };
}

export class UploadError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.statusCode = statusCode;
  }
}

export async function saveBase64Upload({ base64, data, filename, mimeType } = {}, options = {}) {
  const { buffer, dataUrlMimeType } = decodeBase64(base64 ?? data);
  const extension = normalizeExtension(filename, mimeType || dataUrlMimeType);
  if (!extension) {
    throw new UploadError(400, 'A valid filename extension or supported image mimeType is required');
  }

  const uploadDirectory = resolve(options.uploadDirectory || tmpdir(), 'mcp-center');
  await mkdir(uploadDirectory, { recursive: true });
  const path = resolve(uploadDirectory, `${randomUUID()}${extension}`);
  await writeFile(path, buffer, { flag: 'wx' });
  return { path };
}

export async function readJsonBody(req, maxBytes = MAX_UPLOAD_BODY_BYTES) {
  const contentType = req.headers['content-type'] || '';
  if (!contentType.toLowerCase().startsWith('application/json')) {
    throw new UploadError(415, 'Content-Type must be application/json');
  }

  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) {
      throw new UploadError(413, `Request body exceeds ${maxBytes} bytes`);
    }
    chunks.push(chunk);
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new UploadError(400, 'Invalid JSON');
  }
}
