import { mkdtemp, readFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join, extname, basename } from 'path';
import { saveBase64Upload, UploadError } from '../src/fileUpload.js';

describe('base64 file uploads', () => {
  let directory;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'mcp-center-upload-test-'));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('writes decoded data under a UUID filename and preserves the extension', async () => {
    const result = await saveBase64Upload({
      base64: Buffer.from('image bytes').toString('base64'),
      filename: 'result.PNG',
    }, { uploadDirectory: directory });

    expect(extname(result.path)).toBe('.png');
    expect(basename(result.path)).toMatch(/^[0-9a-f-]{36}\.png$/);
    expect(await readFile(result.path, 'utf8')).toBe('image bytes');
  });

  it('accepts a data URL and derives its extension from the MIME type', async () => {
    const result = await saveBase64Upload({
      base64: `data:image/jpeg;base64,${Buffer.from('jpeg').toString('base64')}`,
    }, { uploadDirectory: directory });

    expect(result.path.endsWith('.jpg')).toBe(true);
    expect(await readFile(result.path, 'utf8')).toBe('jpeg');
  });

  it('accepts function-result style data and mimeType fields', async () => {
    const result = await saveBase64Upload({
      data: Buffer.from('webp').toString('base64'),
      mimeType: 'image/webp',
    }, { uploadDirectory: directory });

    expect(result.path.endsWith('.webp')).toBe(true);
  });

  it('rejects invalid base64 and missing file type information', async () => {
    await expect(saveBase64Upload({ base64: 'not base64!', filename: 'x.png' }, {
      uploadDirectory: directory,
    })).rejects.toMatchObject({ statusCode: 400 });
    await expect(saveBase64Upload({ base64: 'dGVzdA==' }, {
      uploadDirectory: directory,
    })).rejects.toBeInstanceOf(UploadError);
  });
});
