import { randomUUID } from 'crypto';
import { createWriteStream } from 'fs';
import { mkdir, unlink } from 'fs/promises';
import { extname, resolve } from 'path';
import { tmpdir } from 'os';
import { pipeline } from 'stream/promises';
import Busboy from 'busboy';

export const MAX_UPLOAD_BYTES = 500 * 1024 * 1024;

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

export class UploadError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.statusCode = statusCode;
  }
}

export async function saveMultipartUpload(req, options = {}) {
  const contentType = req.headers['content-type'] || '';
  if (!contentType.toLowerCase().startsWith('multipart/form-data')) {
    throw new UploadError(415, 'Content-Type must be multipart/form-data');
  }

  const maxUploadBytes = options.maxUploadBytes || MAX_UPLOAD_BYTES;
  const uploadDirectory = resolve(options.uploadDirectory || tmpdir(), 'mcp-center');
  await mkdir(uploadDirectory, { recursive: true });

  return new Promise((resolveUpload, rejectUpload) => {
    let fileReceived = false;
    let filePath;
    let fileTooLarge = false;
    let validationError;
    let writeError;
    let writePromise;

    let parser;
    try {
      parser = Busboy({
        headers: req.headers,
        limits: { fileSize: maxUploadBytes, files: 1, fields: 0 },
      });
    } catch (error) {
      rejectUpload(new UploadError(400, error.message));
      return;
    }

    parser.on('file', (fieldName, file, { filename, mimeType }) => {
      if (fieldName !== 'file') {
        validationError = new UploadError(400, 'Multipart field must be named file');
        file.resume();
        return;
      }

      fileReceived = true;
      const extension = normalizeExtension(filename, mimeType);
      if (!extension) {
        validationError = new UploadError(400, 'A valid filename extension or supported image MIME type is required');
        file.resume();
        return;
      }

      filePath = resolve(uploadDirectory, `${randomUUID()}${extension}`);
      file.on('limit', () => {
        fileTooLarge = true;
      });
      writePromise = pipeline(file, createWriteStream(filePath, { flags: 'wx' })).catch((error) => {
        writeError = error;
      });
    });

    parser.on('filesLimit', () => {
      validationError ||= new UploadError(400, 'Exactly one file is allowed');
    });
    parser.on('fieldsLimit', () => {
      validationError ||= new UploadError(400, 'Only the file field is allowed');
    });
    parser.on('error', (error) => {
      validationError ||= new UploadError(400, error.message);
    });

    parser.on('close', async () => {
      if (writePromise) await writePromise;

      let error = validationError || writeError;
      if (!error && !fileReceived) error = new UploadError(400, 'Multipart field file is required');
      if (!error && fileTooLarge) error = new UploadError(413, `File exceeds ${maxUploadBytes} bytes`);

      if (error) {
        if (filePath) await unlink(filePath).catch(() => {});
        rejectUpload(error);
        return;
      }

      resolveUpload({ path: filePath });
    });

    req.once('aborted', () => {
      parser.destroy(new Error('Upload aborted'));
    });
    req.pipe(parser);
  });
}
