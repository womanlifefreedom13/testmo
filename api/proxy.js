import http from 'node:http';
import https from 'node:https';

export const config = { maxDuration: 300 };

const UPSTREAM = process.env.UPSTREAM_URL;
if (!UPSTREAM) throw new Error('UPSTREAM_URL env var is required');
const upstreamUrl = new URL(UPSTREAM);
const upstreamLib = upstreamUrl.protocol === 'https:' ? https : http;
const upstreamPort = upstreamUrl.port || (upstreamUrl.protocol === 'https:' ? 443 : 80);

// Reuse TCP sockets across requests — Node defaults to keepAlive=false which
// burns CPU and memory on a fresh connect for every xhttp packet. Pooling
// trims Active CPU time on the Vercel bill noticeably.
const upstreamAgent = new upstreamLib.Agent({
  keepAlive: true,
  keepAliveMsecs: 30_000,
  maxSockets: 100,
  maxFreeSockets: 20,
  scheduling: 'fifo',
});

const HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'host',
]);
const STRIP_INBOUND = /^(x-vercel-|x-forwarded-|x-real-ip$|cf-|forwarded$)/i;

function filterInbound(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers)) {
    const lk = k.toLowerCase();
    if (HOP.has(lk)) continue;
    if (STRIP_INBOUND.test(lk)) continue;
    out[k] = v;
  }
  out.host = upstreamUrl.host;
  return out;
}

function filterOutbound(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers)) {
    if (HOP.has(k.toLowerCase())) continue;
    out[k] = v;
  }
  return out;
}

const PROXY_PREFIX = '/proxy/';

const FALLBACK_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Hello</title>
<style>
  body{margin:0;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;background:#0b1020;color:#e6e9f2;display:flex;min-height:100vh;align-items:center;justify-content:center;padding:2rem}
  main{max-width:560px}
  h1{font-size:2rem;margin:0 0 .5rem}
  p{color:#9aa3bd;line-height:1.5;margin:.25rem 0}
  code{background:#1a2238;padding:.1rem .35rem;border-radius:.25rem;font-size:.9em}
  .ok{color:#86efac}
</style>
</head>
<body>
<main>
  <h1>It works.</h1>
  <p class="ok">If you're reading this, the page loaded successfully.</p>
  <p>Static placeholder. Nothing here yet.</p>
</main>
</body>
</html>
`;

export default function handler(req, res) {
  if (!req.url.startsWith(PROXY_PREFIX)) {
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'public, max-age=300',
    });
    res.end(FALLBACK_HTML);
    return;
  }

  const upstreamReq = upstreamLib.request(
    {
      host: upstreamUrl.hostname,
      port: upstreamPort,
      path: req.url,
      method: req.method,
      headers: filterInbound(req.headers),
      agent: upstreamAgent,
    },
    (upstreamRes) => {
      res.writeHead(upstreamRes.statusCode, filterOutbound(upstreamRes.headers));
      upstreamRes.pipe(res);
    },
  );

  upstreamReq.on('error', (e) => {
    if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' });
    res.end(`bad gateway: ${e.message}`);
  });

  req.on('aborted', () => upstreamReq.destroy());
  req.pipe(upstreamReq);
}
