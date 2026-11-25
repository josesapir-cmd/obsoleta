'use strict';

// Busca título, descrição e imagem (Open Graph) de um link para montar a prévia.
// Como o servidor acessa um endereço escolhido pelo usuário, só aceitamos destinos
// públicos: a checagem é feita no IP já resolvido, a cada redirecionamento.

const http = require('node:http');
const https = require('node:https');
const dns = require('node:dns');
const net = require('node:net');

const MAX_BYTES = 512 * 1024;
const MAX_REDIRECTS = 3;
const TIMEOUT_MS = 4000;
const DEADLINE_MS = 7000;

const blockList = new net.BlockList();
for (const [addr, bits] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 3],
]) {
  blockList.addSubnet(addr, bits, 'ipv4');
}
for (const [addr, bits] of [
  ['::', 127], ['::ffff:0:0', 96], ['64:ff9b::', 96], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8],
]) {
  blockList.addSubnet(addr, bits, 'ipv6');
}
const isBlocked = (ip) => blockList.check(ip, net.isIPv6(ip) ? 'ipv6' : 'ipv4');

function safeLookup(hostname, options, cb) {
  dns.lookup(hostname, { ...options, all: true }, (err, addrs) => {
    if (err) return cb(err);
    if (!addrs.length || addrs.some((a) => isBlocked(a.address))) return cb(new Error('destino não permitido'));
    if (options.all) cb(null, addrs);
    else cb(null, addrs[0].address, addrs[0].family);
  });
}

function get(urlStr, allowPrivate) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return reject(new Error('protocolo'));
    if (u.username || u.password) return reject(new Error('credenciais no link'));
    if (!allowPrivate) {
      if (u.port) return reject(new Error('porta não permitida'));
      const host = u.hostname.replace(/^\[|\]$/g, '');
      if (net.isIP(host) && isBlocked(host)) return reject(new Error('destino não permitido'));
    }
    const req = (u.protocol === 'https:' ? https : http).get(
      u,
      {
        lookup: allowPrivate ? undefined : safeLookup,
        timeout: TIMEOUT_MS,
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; LinkPreviewBot/1.0)',
          Accept: 'text/html,application/xhtml+xml',
          'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.5',
        },
      },
      (res) => {
        const loc = res.headers.location;
        if (res.statusCode >= 300 && res.statusCode < 400 && loc) {
          res.resume();
          return resolve({ redirect: new URL(loc, u).href });
        }
        if (res.statusCode !== 200 || !/html/i.test(res.headers['content-type'] || '')) {
          res.destroy();
          return resolve({ html: '' });
        }
        const chunks = [];
        let size = 0;
        const done = () => resolve({ html: Buffer.concat(chunks).toString('utf8') });
        res.on('data', (c) => {
          size += c.length;
          chunks.push(c);
          if (size >= MAX_BYTES) {
            res.destroy();
            done();
          }
        });
        res.on('end', done);
        res.on('error', reject);
      }
    );
    req.on('timeout', () => req.destroy(new Error('tempo esgotado')));
    req.on('error', reject);
  });
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
function decode(s) {
  return s
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
      if (e[0] !== '#') return ENTITIES[e.toLowerCase()] ?? m;
      const code = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
    })
    .replace(/\s+/g, ' ')
    .trim();
}

function parse(html, baseUrl) {
  const meta = {};
  for (const tag of html.match(/<meta\b[^>]*>/gi) || []) {
    const attrs = {};
    for (const m of tag.matchAll(/([a-z:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi)) {
      attrs[m[1].toLowerCase()] = m[2] ?? m[3] ?? m[4] ?? '';
    }
    const key = (attrs.property || attrs.name || '').toLowerCase();
    if (key && attrs.content && !(key in meta)) meta[key] = decode(attrs.content);
  }
  const titleTag = /<title[^>]*>([^<]*)<\/title>/i.exec(html);
  let image = meta['og:image'] || meta['og:image:secure_url'] || meta['twitter:image'] || '';
  if (image) {
    try {
      const abs = new URL(image, baseUrl);
      image = abs.protocol === 'https:' ? abs.href : '';
    } catch {
      image = '';
    }
  }
  return {
    title: (meta['og:title'] || meta['twitter:title'] || (titleTag ? decode(titleTag[1]) : '')).slice(0, 300),
    description: (meta['og:description'] || meta['twitter:description'] || meta.description || '').slice(0, 500),
    image: image.slice(0, 2000),
    site: (meta['og:site_name'] || '').slice(0, 100),
  };
}

async function fetchPreview(url, { allowPrivate = false } = {}) {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('tempo esgotado')), DEADLINE_MS);
  });
  const work = (async () => {
    let current = url;
    for (let i = 0; i <= MAX_REDIRECTS; i++) {
      const r = await get(current, allowPrivate);
      if (r.redirect) {
        current = r.redirect;
        continue;
      }
      const p = parse(r.html, current);
      return p.title || p.description || p.image ? p : null;
    }
    return null;
  })();
  try {
    return await Promise.race([work, deadline]);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { fetchPreview, parse };
