// Reads a short-lived upload session from hidden stdin. Never persists credentials.
import { readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { extname, join, relative } from 'node:path';
const directory = new URL('../dist/', import.meta.url);
const types = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json', '.wav': 'audio/wav', '.woff2': 'font/woff2' };
export async function assets() {
  const manifest = {}, files = {};
  const { fileURLToPath } = await import('node:url');
  const root = fileURLToPath(directory);
  // Use the decoded native root for paths containing spaces.
  async function walk(path) {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const full = join(path, entry.name);
      if (entry.isDirectory()) { await walk(full); continue; }
      const bytes = await readFile(full), extension = extname(entry.name);
      const hash = createHash('sha256').update(bytes.toString('base64') + extension.slice(1)).digest('hex').slice(0, 32);
      manifest['/' + relative(root, full).replaceAll('\\', '/')] = { hash, size: bytes.length };
      files[hash] = { bytes, type: types[extension] || 'application/octet-stream' };
    }
  }
  await walk(root); return { manifest, files };
}
if (process.argv.includes('--manifest')) console.log(JSON.stringify((await assets()).manifest));
if (process.argv.includes('--upload')) {
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.setEncoding('utf8'); process.stdin.resume();
  console.log('Ready for upload session on hidden stdin.');
  let input = '';
  process.stdin.on('data', async chunk => {
    input += chunk;
    if (!input.includes('\n') && !input.includes('\r')) return;
    process.stdin.pause();
    try {
      const session = JSON.parse(input.trim()); input = '';
      const { files } = await assets(); let completion = session.jwt;
      for (const bucket of session.buckets) {
        const form = new FormData();
        for (const hash of bucket) {
          if (!files[hash]) throw new Error('Build changed after manifest registration.');
          form.append(hash, new Blob([files[hash].bytes.toString('base64')], { type: files[hash].type }), hash);
        }
        const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${session.account}/workers/assets/upload?base64=true`, { method: 'POST', headers: { Authorization: `Bearer ${session.jwt}` }, body: form });
        const result = await response.json();
        if (!response.ok || result.success === false) throw new Error(`Upload failed (${response.status}): ${JSON.stringify(result.errors)}`);
        if (result.result?.jwt || result.jwt) completion = result.result?.jwt || result.jwt;
      }
      console.log(JSON.stringify({ jwt: completion })); process.exit(0);
    } catch (error) { console.error(error.message); process.exit(1); }
  });
}
