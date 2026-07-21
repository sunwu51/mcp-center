import { createServer } from 'http';
import { mkdtemp, readFile, readdir, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join, extname, basename } from 'path';
import { saveMultipartUpload, UploadError } from '../src/fileUpload.js';

describe('multipart file uploads', () => {
  let directory;
  let server;
  let endpoint;
  let maxUploadBytes;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'mcp-center-upload-test-'));
    maxUploadBytes = undefined;
    server = createServer(async (req, res) => {
      try {
        const result = await saveMultipartUpload(req, { uploadDirectory: directory, maxUploadBytes });
        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (error) {
        const statusCode = error instanceof UploadError ? error.statusCode : 500;
        res.writeHead(statusCode, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: error.message }));
      }
    });
    await new Promise((resolve, reject) => {
      server.listen(0, '127.0.0.1', resolve);
      server.on('error', reject);
    });
    endpoint = `http://127.0.0.1:${server.address().port}`;
  });

  afterEach(async () => {
    await new Promise(resolve => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });

  it('streams the file under a UUID filename and preserves the extension', async () => {
    const form = new FormData();
    form.append('file', new Blob(['image bytes'], { type: 'image/png' }), 'result.PNG');

    const response = await fetch(endpoint, { method: 'POST', body: form });
    const result = await response.json();

    expect(response.status).toBe(201);
    expect(extname(result.path)).toBe('.png');
    expect(basename(result.path)).toMatch(/^[0-9a-f-]{36}\.png$/);
    expect(await readFile(result.path, 'utf8')).toBe('image bytes');
  });

  it('derives the extension from the MIME type when the filename has none', async () => {
    const form = new FormData();
    form.append('file', new Blob(['jpeg'], { type: 'image/jpeg' }), 'image');

    const response = await fetch(endpoint, { method: 'POST', body: form });
    const result = await response.json();

    expect(response.status).toBe(201);
    expect(result.path.endsWith('.jpg')).toBe(true);
    expect(await readFile(result.path, 'utf8')).toBe('jpeg');
  });

  it('rejects non-multipart requests', async () => {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });

    expect(response.status).toBe(415);
  });

  it('rejects files over the configured limit and removes the partial file', async () => {
    maxUploadBytes = 3;
    const form = new FormData();
    form.append('file', new Blob(['four'], { type: 'image/png' }), 'image.png');

    const response = await fetch(endpoint, { method: 'POST', body: form });

    expect(response.status).toBe(413);
    expect(await readdir(join(directory, 'mcp-center'))).toEqual([]);
  });
});
