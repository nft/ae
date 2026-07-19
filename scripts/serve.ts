// Static dev server for the demo. Usage: bun run serve  (PORT/HOST to override)

import { resolve } from 'node:path';

const DEFAULT_PORT = 4242;
const ROOT = resolve(import.meta.dir, '..');
const ALLOWED_DIRS = new Set(['site', 'examples', 'dist']);
const ALLOWED_FILES = new Set([
  'API.md',
  'README.md',
  'LICENSE',
  'llms.txt',
  'test/browser/fixture.html', // the Playwright test page — not all of test/
]);
const NOT_FOUND = () => new Response('Not found', { status: 404 });

/** Decoded, validated path segments — or null if the path is not servable. */
function safeSegments(pathname: string): string[] | null {
  const segments: string[] = [];
  for (const raw of pathname.split('/')) {
    if (raw === '') continue;
    let seg: string;
    try {
      seg = decodeURIComponent(raw);
    } catch {
      return null; // malformed percent-escape
    }
    // Dotfiles, and separators or control characters that only appear after
    // decoding (%5c, %00), could smuggle a path past the allowlist.
    if (seg.startsWith('.') || /[/\\\x00-\x1f\x7f]/.test(seg)) return null;
    segments.push(seg);
  }
  return segments;
}

const server = Bun.serve({
  port: Number(process.env.PORT ?? DEFAULT_PORT),
  hostname: process.env.HOST ?? 'localhost',
  async fetch(req) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return new Response('Method not allowed', { status: 405 });
    }
    const url = new URL(req.url);
    if (url.pathname === '/') {
      return new Response('', {
        status: 302,
        headers: { Location: '/site/index.html' },
      });
    }
    const pathname = url.pathname === '/logo.svg' ? '/site/logo.svg' : url.pathname;
    const segments = safeSegments(pathname);
    if (!segments || segments.length === 0) return NOT_FOUND();
    const rel = segments.join('/');
    if (!ALLOWED_DIRS.has(segments[0]) && !ALLOWED_FILES.has(rel)) return NOT_FOUND();
    const abs = resolve(ROOT, rel);
    if (!abs.startsWith(ROOT + '/')) return NOT_FOUND();
    const file = Bun.file(abs);
    if (!(await file.exists())) return NOT_FOUND();
    return new Response(file);
  },
});

console.log(`ae demo → http://${server.hostname}:${server.port}`);
