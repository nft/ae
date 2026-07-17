// Static dev server for the demo. Usage: bun run serve  (PORT=n to override)

const port = Number(process.env.PORT ?? 4242);

Bun.serve({
  port,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === '/') {
      return new Response('', {
        status: 302,
        headers: { Location: '/site/index.html' },
      });
    }
    let path = url.pathname;
    if (path === '/logo.svg') {
      path = '/site/logo.svg';
    }
    const file = Bun.file(`${import.meta.dir}/..${path}`);
    if (!(await file.exists())) return new Response('Not found', { status: 404 });
    return new Response(file);
  },
});

console.log(`ae demo → http://localhost:${port}`);
