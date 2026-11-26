'use strict';

const express = require('express');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { DatabaseSync } = require('node:sqlite');
const { fetchPreview } = require('./preview');
const {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} = require('@simplewebauthn/server');

const SESSION_DAYS = 30;
const MIN_PASSWORD = 10;
const STATUSES = ['todo', 'doing', 'done'];
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_IMAGES_PER_REF = 30;
const MAX_FILE_BYTES = 50 * 1024 * 1024;
// Só estes tipos abrem no navegador; o resto é sempre baixado, para que um arquivo
// enviado (HTML, SVG...) nunca rode como página do próprio sistema.
const INLINE_TYPES = {
  pdf: 'application/pdf',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
  txt: 'text/plain; charset=utf-8',
};
const REACTIONS = ['👍', '❤️', '😂', '😮', '🤔', '👎'];
const COLORS = ['vinho', 'ambar', 'oliva', 'petroleo', 'azul', 'ameixa', 'grafite'];

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const bad = (msg) => {
  throw new HttpError(400, msg);
};

// ---------- validação ----------

function text(v, label, max, required = false) {
  if (v == null) v = '';
  if (typeof v !== 'string') bad(`${label}: valor inválido.`);
  v = v.trim();
  if (required && !v) bad(`${label} é obrigatório.`);
  if (v.length > max) bad(`${label}: máximo de ${max} caracteres.`);
  return v;
}

function intId(v, label = 'Identificador') {
  const n = typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : v;
  if (!Number.isSafeInteger(n) || n < 1) bad(`${label} inválido.`);
  return n;
}

function httpUrl(v) {
  let s = text(v, 'Link', 2000);
  if (!s) return '';
  if (!/^[a-z][a-z0-9+.-]*:/i.test(s)) s = `https://${s}`;
  let u;
  try {
    u = new URL(s);
  } catch {
    bad('Link inválido.');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') bad('O link precisa ser http ou https.');
  return u.href;
}

function dueDate(v) {
  if (v == null || v === '') return null;
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(Date.parse(v))) {
    bad('Prazo inválido.');
  }
  return v;
}

function email(v) {
  const s = text(v, 'E-mail', 200, true).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) bad('E-mail inválido.');
  return s;
}

function password(v) {
  if (typeof v !== 'string' || v.length < MIN_PASSWORD) {
    bad(`A senha precisa ter pelo menos ${MIN_PASSWORD} caracteres.`);
  }
  if (v.length > 200) bad('Senha longa demais.');
  return v;
}

// ---------- senhas e sessões ----------

function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(pw, salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

function verifyPassword(pw, stored) {
  const [, saltHex, hashHex] = stored.split('$');
  const expected = Buffer.from(hashHex, 'hex');
  const actual = crypto.scryptSync(pw, Buffer.from(saltHex, 'hex'), expected.length);
  return crypto.timingSafeEqual(actual, expected);
}

const DUMMY_HASH = hashPassword(crypto.randomBytes(16).toString('hex'));
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

// Tipo decidido pelo conteúdo do arquivo, nunca pelo que o navegador declara.
function imageType(buf) {
  if (buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  const head = buf.toString('latin1', 0, 12);
  if (head.startsWith('GIF87a') || head.startsWith('GIF89a')) return 'image/gif';
  if (head.startsWith('RIFF') && head.endsWith('WEBP')) return 'image/webp';
  return null;
}

// ---------- pesquisa de mercado: leitura da planilha e itens-âncora ----------

const foldText = (v) => String(v || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();

// CSV separado por ponto e vírgula, com campos entre aspas (o formato pedido à coleta).
function parseCsv(text) {
  const rows = [];
  let row = [];
  let cur = '';
  let quoted = false;
  const src = text.replace(/^\ufeff/, '');
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          cur += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ';') {
      row.push(cur);
      cur = '';
    } else if (ch === '\n') {
      row.push(cur);
      rows.push(row);
      row = [];
      cur = '';
    } else if (ch !== '\r') {
      cur += ch;
    }
  }
  if (cur || row.length) {
    row.push(cur);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim()));
}

// Seções da tela de Cardápio e os itens comparáveis de cada uma.
const MARKET_SECTIONS = [
  { title: 'Cafés quentes', items: ['Espresso', 'Espresso duplo', 'Filtrado da casa', 'Filtrado por método ou grão especial', 'Macchiato', 'Cappuccino', 'Latte ou café com leite', 'Flat white', 'Mocha'] },
  { title: 'Gelados e outras bebidas', items: ['Cold brew', 'Iced latte', 'Espresso tônica', 'Chocolate quente', 'Matcha latte', 'Suco de laranja', 'Água'] },
  { title: 'Para comer', items: ['Pão de queijo (porção varia)', 'Pão na chapa', 'Croissant simples', 'Misto quente', 'Queijo quente', 'Bolo (fatia)', 'Cookie', 'Brownie'] },
];
const MARKET_ANCHORS = MARKET_SECTIONS.flatMap((sec) => sec.items);
const HOUSE_TYPES = ['cafe', 'padaria', 'brunch', 'livraria'];

// Reconhece, pelo nome escrito no cardápio, os itens que dá para comparar entre casas.
// Fica de fora o que distorce a comparação: combos, versões com sabor, leite vegetal, adicionais.
const ML = '( ?\\(?\\d+ ?ml\\)?)?';
const whole = (pattern, value) => new RegExp(`^(?:${pattern})$`).test(value);
function anchorOf(item, variation, category) {
  const it = foldText(item).replace(/\s+/g, ' ');
  const v = foldText(variation);
  const cat = foldText(category);
  if (/combo|combinado/.test(cat) || it.includes('nude') || v.includes('adicional') || v.includes('vegetal')) return '';
  if (whole(`(cafe )?(espresso|expresso)( simples| curto| classico| padrao)?${ML}`, it) && !cat.includes('gelad') && !/long|duplo|x2/.test(v)) return 'Espresso';
  if (whole('(espresso|expresso)( simples)? ?/ ?(duplo|carioca)', it)) return /duplo|x2/.test(v) ? 'Espresso duplo' : 'Espresso';
  if (whole(`(double espresso|(espresso|expresso) duplo)${ML}`, it)) return 'Espresso duplo';
  if (whole(`(cafe da casa|coado|filtrado da casa( \\(batch brew\\))?|filtrado do dia|cafe coado especial hario system)${ML}`, it)) return 'Filtrado da casa';
  if (whole(`(filtrado( \\(filter\\)| v60| especial| visitante| microlote)?|v60|coados|cafe na prensa)${ML}`, it) && !cat.includes('gelad') && !v.includes('x2')) {
    return 'Filtrado por método ou grão especial';
  }
  if (whole(`cap+uc+ino( italiano| tradicional)?${ML}`, it) || ((it === 'cappuccino / latte' || it === 'cappuccino / duplo') && v === 'cappuccino')) return 'Cappuccino';
  if (whole(`(latte|cafe com leite|pingado|latte macchiato)${ML}`, it) || (it === 'cappuccino / latte' && v === 'latte')) return 'Latte ou café com leite';
  if (whole(`flat white${ML}`, it)) return 'Flat white';
  if (whole(`macchiat+o${ML}`, it)) return 'Macchiato';
  if (whole(`(mocha|mocaccino|mochaccino|mocaccino caramelo)${ML}`, it)) return 'Mocha';
  if (whole(`chocolate quente( cremoso| \\(hot chocolate\\))?${ML}`, it)) return 'Chocolate quente';
  if (whole(`cold ?brew${ML}`, it)) return 'Cold brew';
  if (whole('(espresso|expresso) tonica', it)) return 'Espresso tônica';
  if (whole('(iced latte|latte gelado( \\(iced latte\\))?|iced latte/latte gelado)', it) && !v) return 'Iced latte';
  if (whole('matcha latte( quente| \\(quente ou gelado\\))?', it) && (v === '' || v === 'quente')) return 'Matcha latte';
  if (whole('suco de laranja( natural| \\(laranja legal\\))?', it)) return 'Suco de laranja';
  if (whole('agua( mineral| prata( [sc]/ gas)?| com gas| sem gas| com (ou|e) sem gas| - ?\\d+ml)?( ?-? ?\\d+ ?ml)?', it)) return 'Água';
  if (it.startsWith('pao de queijo')) return 'Pão de queijo (porção varia)';
  if (it === 'croissant' || it === 'croissant na chapa') return 'Croissant simples';
  if (whole('(bolo|bolo do dia|bolos caseiros|bolo \\(cake\\)|bolo da estacao|bolo do dia \\(consultar sabor\\))', it)) return 'Bolo (fatia)';
  if (it.startsWith('cookie') && !v.includes('2 un')) return 'Cookie';
  if (whole('brownie( traco| chocolatudo)?', it) && !v.includes('sorvete')) return 'Brownie';
  if ((it === 'misto quente' || it === 'misto na torrada petropolis') && !v.includes('croissant')) return 'Misto quente';
  if (it === 'queijo quente' && !v.includes('croissant')) return 'Queijo quente';
  if (it.startsWith('pao na chapa')) return 'Pão na chapa';
  return '';
}

function fileName(v) {
  let s;
  try {
    s = decodeURIComponent(typeof v === 'string' ? v : '');
  } catch {
    s = '';
  }
  s = s.replace(/[\u0000-\u001f\u007f/\\]/g, '').trim();
  if (!s || s.length > 200) bad('Nome de arquivo inválido (máximo de 200 caracteres).');
  return s;
}

// Cabeçalho de uma entrada de arquivo .tar (formato ustar), para o backup.
function tarHeader(name, size, mtimeMs) {
  const b = Buffer.alloc(512);
  b.write(name, 0, 100);
  b.write('0000600\0', 100);
  b.write('0000000\0', 108);
  b.write('0000000\0', 116);
  b.write(`${size.toString(8).padStart(11, '0')}\0`, 124);
  b.write(`${Math.floor(mtimeMs / 1000).toString(8).padStart(11, '0')}\0`, 136);
  b.write('        ', 148);
  b.write('0', 156);
  b.write('ustar\0', 257);
  b.write('00', 263);
  let sum = 0;
  for (const byte of b) sum += byte;
  b.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
  return b;
}

// ---------- app ----------

function createApp({ dbPath, uploadDir, filesDir, production = false, admin, previewAllowPrivate = false, appOrigin } = {}) {
  if (!uploadDir || !filesDir) throw new Error('uploadDir e filesDir são obrigatórios.');
  fs.mkdirSync(uploadDir, { recursive: true });
  fs.mkdirSync(filesDir, { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      pass_hash TEXT NOT NULL,
      is_admin INTEGER NOT NULL DEFAULT 0,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS categories (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      color TEXT NOT NULL DEFAULT 'grafite',
      position INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS tasks (
      id INTEGER PRIMARY KEY,
      category_id INTEGER NOT NULL REFERENCES categories(id),
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'todo',
      due_date TEXT,
      position INTEGER NOT NULL DEFAULT 0,
      created_by INTEGER REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS task_assignees (
      task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id),
      PRIMARY KEY (task_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS themes (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      position INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS refs (
      id INTEGER PRIMARY KEY,
      theme_id INTEGER NOT NULL REFERENCES themes(id),
      title TEXT NOT NULL,
      url TEXT NOT NULL DEFAULT '',
      note TEXT NOT NULL DEFAULT '',
      created_by INTEGER REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS ref_images (
      id INTEGER PRIMARY KEY,
      ref_id INTEGER NOT NULL REFERENCES refs(id) ON DELETE CASCADE,
      filename TEXT NOT NULL UNIQUE,
      mime TEXT NOT NULL,
      size INTEGER NOT NULL,
      created_by INTEGER REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS comments (
      id INTEGER PRIMARY KEY,
      kind TEXT NOT NULL,
      target_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL REFERENCES users(id),
      body TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS folders (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      position INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS files (
      id INTEGER PRIMARY KEY,
      folder_id INTEGER NOT NULL REFERENCES folders(id),
      name TEXT NOT NULL,
      filename TEXT NOT NULL UNIQUE,
      size INTEGER NOT NULL,
      uploaded_by INTEGER REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS expenses (
      id INTEGER PRIMARY KEY,
      date TEXT NOT NULL,
      description TEXT NOT NULL,
      amount_cents INTEGER NOT NULL,
      paid_by INTEGER NOT NULL REFERENCES users(id),
      note TEXT NOT NULL DEFAULT '',
      settled_at TEXT,
      created_by INTEGER REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS expense_files (
      id INTEGER PRIMARY KEY,
      expense_id INTEGER NOT NULL REFERENCES expenses(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      filename TEXT NOT NULL UNIQUE,
      size INTEGER NOT NULL,
      uploaded_by INTEGER REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS market_houses (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      address TEXT NOT NULL DEFAULT '',
      distance_km REAL,
      rating REAL,
      reviews INTEGER,
      price_range TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT '',
      maps_url TEXT NOT NULL DEFAULT '',
      tipo TEXT NOT NULL DEFAULT 'cafe',
      is_ref INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS market_items (
      id INTEGER PRIMARY KEY,
      house_id INTEGER NOT NULL REFERENCES market_houses(id) ON DELETE CASCADE,
      category TEXT NOT NULL DEFAULT '',
      item TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      variation TEXT NOT NULL DEFAULT '',
      price_cents INTEGER,
      photo_month TEXT NOT NULL DEFAULT '',
      photo_url TEXT NOT NULL DEFAULT '',
      reading TEXT NOT NULL DEFAULT '',
      notes TEXT NOT NULL DEFAULT '',
      anchor TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS market_items_anchor ON market_items (anchor);
    CREATE TABLE IF NOT EXISTS menu_draft (
      anchor TEXT PRIMARY KEY,
      included INTEGER NOT NULL DEFAULT 0,
      price_cents INTEGER,
      updated_by INTEGER REFERENCES users(id),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS passkeys (
      id INTEGER PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      credential_id TEXT NOT NULL UNIQUE,
      public_key BLOB NOT NULL,
      counter INTEGER NOT NULL DEFAULT 0,
      transports TEXT NOT NULL DEFAULT '',
      name TEXT NOT NULL,
      rp_id TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_used_at TEXT
    );
    CREATE TABLE IF NOT EXISTS task_deps (
      task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      depends_on_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      PRIMARY KEY (task_id, depends_on_id)
    );
    CREATE TABLE IF NOT EXISTS activity (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id),
      text TEXT NOT NULL,
      kind TEXT NOT NULL,
      target_id INTEGER,
      title TEXT NOT NULL DEFAULT '',
      detail TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS comment_reactions (
      comment_id INTEGER NOT NULL REFERENCES comments(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id),
      emoji TEXT NOT NULL,
      PRIMARY KEY (comment_id, user_id, emoji)
    );
    CREATE TABLE IF NOT EXISTS image_reactions (
      image_id INTEGER NOT NULL REFERENCES ref_images(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id),
      emoji TEXT NOT NULL,
      PRIMARY KEY (image_id, user_id, emoji)
    );
    CREATE INDEX IF NOT EXISTS comments_target ON comments (kind, target_id);
    CREATE TABLE IF NOT EXISTS comment_mentions (
      comment_id INTEGER NOT NULL REFERENCES comments(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id),
      seen INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (comment_id, user_id)
    );
  `);

  // Migração: até qual novidade cada pessoa já viu.
  if (!db.prepare('PRAGMA table_info(users)').all().some((c) => c.name === 'activity_seen')) {
    db.exec('ALTER TABLE users ADD COLUMN activity_seen INTEGER NOT NULL DEFAULT 0');
  }

  // Migração: colunas da prévia de link, acrescentadas depois da primeira versão.
  const refCols = db.prepare('PRAGMA table_info(refs)').all().map((c) => c.name);
  for (const col of ['preview_title', 'preview_desc', 'preview_image', 'preview_site']) {
    if (!refCols.includes(col)) db.exec(`ALTER TABLE refs ADD COLUMN ${col} TEXT NOT NULL DEFAULT ''`);
  }

  const q = (sql) => db.prepare(sql);
  const tx = (fn) => {
    db.exec('BEGIN IMMEDIATE');
    try {
      const out = fn();
      db.exec('COMMIT');
      return out;
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  };

  // Registro de novidades (o sininho). Ações repetidas da mesma pessoa sobre o mesmo item
  // em poucos minutos (várias imagens, edições seguidas) contam uma vez só.
  function log(req, what, kind, targetId, title, detail = '') {
    const last = q('SELECT * FROM activity ORDER BY id DESC LIMIT 1').get();
    if (
      last &&
      last.user_id === req.user.id &&
      last.text === what &&
      last.kind === kind &&
      last.target_id === (targetId ?? null) &&
      last.detail === detail &&
      Date.parse(`${last.created_at.replace(' ', 'T')}Z`) > Date.now() - 10 * 60 * 1000
    ) {
      return;
    }
    const r = q('INSERT INTO activity (user_id, text, kind, target_id, title, detail) VALUES (?, ?, ?, ?, ?, ?)').run(
      req.user.id,
      what,
      kind,
      targetId ?? null,
      title,
      detail
    );
    if (Number(r.lastInsertRowid) % 200 === 0) q('DELETE FROM activity WHERE id <= ?').run(Number(r.lastInsertRowid) - 2000);
  }
  const STATUS_LABEL = { todo: 'A fazer', doing: 'Em andamento', done: 'Concluída' };

  // Primeiro acesso: cria o administrador a partir das variáveis de ambiente.
  if (q('SELECT COUNT(*) AS n FROM users').get().n === 0) {
    if (!admin || !admin.email || !admin.password) {
      throw new Error(
        'Banco vazio: defina ADMIN_EMAIL e ADMIN_PASSWORD (e opcionalmente ADMIN_NAME) para criar o primeiro usuário.'
      );
    }
    q('INSERT INTO users (name, email, pass_hash, is_admin) VALUES (?, ?, ?, 1)').run(
      text(admin.name || 'Admin', 'Nome', 80, true),
      email(admin.email),
      hashPassword(password(admin.password))
    );
  }

  const app = express();
  app.disable('x-powered-by');
  if (production) app.set('trust proxy', 1);

  app.use((req, res, next) => {
    res.set({
      'Content-Security-Policy':
        "default-src 'self'; img-src 'self' data: https:; frame-src https://www.instagram.com; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'X-Robots-Tag': 'noindex, nofollow',
    });
    if (production) res.set('Strict-Transport-Security', 'max-age=31536000');
    next();
  });

  // Sempre revalida (ETag): depois de um deploy, ninguém fica preso a uma versão antiga da tela.
  app.use(express.static(path.join(__dirname, 'public'), { cacheControl: false, setHeaders: (res) => res.set('Cache-Control', 'no-cache') }));

  // Identifica a versão da interface; muda a cada deploy que altere a pasta public.
  const publicDir = path.join(__dirname, 'public');
  const uiVersion = fs
    .readdirSync(publicDir)
    .sort()
    .reduce((h, f) => h.update(f).update(fs.readFileSync(path.join(publicDir, f))), crypto.createHash('sha256'))
    .digest('hex')
    .slice(0, 12);

  // Atualização ao vivo: cada navegador mantém uma conexão aberta (/api/events) e é avisado
  // quando qualquer pessoa altera algo, para buscar os dados novos na hora.
  const liveClients = new Set();
  let liveTimer = null;
  function broadcast() {
    if (liveTimer) return;
    liveTimer = setTimeout(() => {
      liveTimer = null;
      for (const client of liveClients) client.write('event: change\ndata: 1\n\n');
    }, 150);
  }

  const api = express.Router();
  app.use('/api', api);

  api.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    // Cabeçalho próprio: um site de terceiros não consegue enviá-lo sem CORS (proteção CSRF).
    if (req.method !== 'GET' && req.get('X-Requested-With') !== 'obsoleta') {
      throw new HttpError(403, 'Requisição recusada.');
    }
    if (req.method !== 'GET') {
      res.on('finish', () => {
        if (res.statusCode < 400) broadcast();
      });
    }
    next();
  });
  api.use(express.json({ limit: '100kb' }));
  api.use((req, res, next) => {
    if (req.method !== 'GET' && (typeof req.body !== 'object' || req.body === null || Array.isArray(req.body))) {
      req.body = {};
    }
    next();
  });

  // ---------- autenticação ----------

  const cookieOpts = `HttpOnly; SameSite=Lax; Path=/${production ? '; Secure' : ''}`;
  const readSid = (req) => {
    const m = /(?:^|;\s*)sid=([a-f0-9]{64})(?:;|$)/.exec(req.headers.cookie || '');
    return m ? m[1] : null;
  };

  const attempts = new Map();
  const WINDOW_MS = 15 * 60 * 1000;
  const MAX_ATTEMPTS = 8;
  function throttle(key) {
    const now = Date.now();
    if (attempts.size > 5000) {
      for (const [k, v] of attempts) if (v.reset < now) attempts.delete(k);
    }
    const a = attempts.get(key);
    if (a && a.reset > now && a.count >= MAX_ATTEMPTS) {
      throw new HttpError(429, 'Muitas tentativas. Aguarde alguns minutos e tente de novo.');
    }
    return () => {
      const cur = attempts.get(key);
      if (cur && cur.reset > now) cur.count += 1;
      else attempts.set(key, { count: 1, reset: now + WINDOW_MS });
    };
  }

  function startSession(res, user) {
    const token = crypto.randomBytes(32).toString('hex');
    const now = Date.now();
    q('DELETE FROM sessions WHERE expires_at < ?').run(now);
    q('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)').run(sha256(token), user.id, now + SESSION_DAYS * 86400000);
    res.set('Set-Cookie', `sid=${token}; Max-Age=${SESSION_DAYS * 86400}; ${cookieOpts}`);
  }

  const publicUser = (u) => ({ id: u.id, name: u.name, email: u.email, is_admin: !!u.is_admin });

  api.post('/login', (req, res) => {
    const mail = typeof req.body.email === 'string' ? req.body.email.trim().toLowerCase() : '';
    const pw = typeof req.body.password === 'string' ? req.body.password.slice(0, 200) : '';
    const fail = throttle(`${req.ip}|${mail}`);
    const user = q('SELECT * FROM users WHERE email = ?').get(mail);
    const ok = verifyPassword(pw, user ? user.pass_hash : DUMMY_HASH) && user && user.active;
    if (!ok) {
      fail();
      throw new HttpError(401, 'E-mail ou senha incorretos.');
    }
    startSession(res, user);
    res.json(publicUser(user));
  });

  // ---------- passkeys (WebAuthn) ----------

  // A passkey vale para um domínio. Por padrão usamos o endereço pelo qual o app foi acessado;
  // APP_ORIGIN fixa esse valor se o proxy do host não repassar o endereço corretamente.
  function relyingParty(req) {
    const origin = appOrigin || `${req.protocol}://${req.get('host')}`;
    return { origin, rpID: new URL(origin).hostname };
  }

  const flows = new Map();
  function newFlow(challenge, userId = null) {
    const now = Date.now();
    for (const [k, v] of flows) if (v.expires < now) flows.delete(k);
    if (flows.size > 1000) throw new HttpError(429, 'Muitas tentativas. Aguarde alguns minutos e tente de novo.');
    const id = crypto.randomBytes(16).toString('hex');
    flows.set(id, { challenge, userId, expires: now + 5 * 60 * 1000 });
    return id;
  }
  function takeFlow(id, userId = null) {
    const flow = typeof id === 'string' ? flows.get(id) : null;
    flows.delete(id);
    if (!flow || flow.expires < Date.now() || flow.userId !== userId) bad('A solicitação expirou. Tente de novo.');
    return flow;
  }

  api.post('/passkeys/login/options', async (req, res) => {
    const { rpID } = relyingParty(req);
    const options = await generateAuthenticationOptions({ rpID, userVerification: 'preferred' });
    res.json({ flow: newFlow(options.challenge), options });
  });

  api.post('/passkeys/login/verify', async (req, res) => {
    const fail = throttle(`passkey|${req.ip}`);
    const flow = takeFlow(req.body.flow);
    const { origin, rpID } = relyingParty(req);
    const response = req.body.response;
    const key = response && typeof response.id === 'string' ? q('SELECT * FROM passkeys WHERE credential_id = ?').get(response.id) : null;
    const user = key && q('SELECT * FROM users WHERE id = ? AND active = 1').get(key.user_id);
    let result = null;
    if (user) {
      try {
        result = await verifyAuthenticationResponse({
          response,
          expectedChallenge: flow.challenge,
          expectedOrigin: origin,
          expectedRPID: rpID,
          requireUserVerification: false,
          credential: {
            id: key.credential_id,
            publicKey: new Uint8Array(key.public_key),
            counter: key.counter,
            transports: key.transports ? key.transports.split(',') : undefined,
          },
        });
      } catch (e) {
        console.warn(`Passkey recusada (${origin}): ${e.message}`);
      }
    }
    if (!result || !result.verified) {
      fail();
      throw new HttpError(401, 'Não foi possível entrar com essa passkey.');
    }
    q("UPDATE passkeys SET counter = ?, last_used_at = datetime('now') WHERE id = ?").run(result.authenticationInfo.newCounter, key.id);
    startSession(res, user);
    res.json(publicUser(user));
  });

  api.post('/logout', (req, res) => {
    const sid = readSid(req);
    if (sid) q('DELETE FROM sessions WHERE token_hash = ?').run(sha256(sid));
    res.set('Set-Cookie', `sid=; Max-Age=0; ${cookieOpts}`);
    res.json({ ok: true });
  });

  api.use((req, res, next) => {
    const sid = readSid(req);
    const user =
      sid &&
      q(
        `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
         WHERE s.token_hash = ? AND s.expires_at > ? AND u.active = 1`
      ).get(sha256(sid), Date.now());
    if (!user) throw new HttpError(401, 'Sessão expirada. Entre novamente.');
    req.user = user;
    req.sidHash = sha256(sid);
    next();
  });

  const adminOnly = (req, res, next) => {
    if (!req.user.is_admin) throw new HttpError(403, 'Apenas administradores.');
    next();
  };

  api.get('/me', (req, res) => res.json(publicUser(req.user)));

  api.get('/events', (req, res) => {
    if (liveClients.size >= 100) throw new HttpError(503, 'Muitas conexões abertas.');
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', 'X-Accel-Buffering': 'no' });
    res.flushHeaders();
    res.write(`retry: 3000\nevent: hello\ndata: ${uiVersion}\n\n`);
    liveClients.add(res);
    // Mantém a conexão viva através de proxies que derrubam conexões paradas.
    const ping = setInterval(() => res.write(': ping\n\n'), 25000);
    req.on('close', () => {
      clearInterval(ping);
      liveClients.delete(res);
    });
  });

  api.post('/me/password', (req, res) => {
    const fail = throttle(`pw|${req.user.id}`);
    if (typeof req.body.current !== 'string' || !verifyPassword(req.body.current, req.user.pass_hash)) {
      fail();
      bad('Senha atual incorreta.');
    }
    const next = password(req.body.next);
    q('UPDATE users SET pass_hash = ? WHERE id = ?').run(hashPassword(next), req.user.id);
    q('DELETE FROM sessions WHERE user_id = ? AND token_hash <> ?').run(req.user.id, req.sidHash);
    res.json({ ok: true });
  });

  api.get('/passkeys', (req, res) => {
    res.json(q('SELECT id, name, rp_id, created_at, last_used_at FROM passkeys WHERE user_id = ? ORDER BY id').all(req.user.id));
  });

  api.post('/passkeys/register/options', async (req, res) => {
    const { rpID } = relyingParty(req);
    const existing = q('SELECT credential_id, transports FROM passkeys WHERE user_id = ?').all(req.user.id);
    if (existing.length >= 10) bad('Limite de 10 passkeys por pessoa. Remova alguma antes.');
    const options = await generateRegistrationOptions({
      rpName: 'Obsoleta',
      rpID,
      userName: req.user.email,
      userDisplayName: req.user.name,
      userID: new TextEncoder().encode(`u${req.user.id}`),
      attestationType: 'none',
      excludeCredentials: existing.map((k) => ({ id: k.credential_id, transports: k.transports ? k.transports.split(',') : undefined })),
      authenticatorSelection: { residentKey: 'required', userVerification: 'preferred' },
    });
    res.json({ flow: newFlow(options.challenge, req.user.id), options });
  });

  api.post('/passkeys/register/verify', async (req, res) => {
    const flow = takeFlow(req.body.flow, req.user.id);
    const { origin, rpID } = relyingParty(req);
    let result;
    try {
      result = await verifyRegistrationResponse({
        response: req.body.response,
        expectedChallenge: flow.challenge,
        expectedOrigin: origin,
        expectedRPID: rpID,
        requireUserVerification: false,
      });
    } catch (e) {
      console.warn(`Cadastro de passkey recusado (${origin}): ${e.message}`);
      bad('Não foi possível cadastrar a passkey.');
    }
    if (!result.verified) bad('Não foi possível cadastrar a passkey.');
    const cred = result.registrationInfo.credential;
    q('INSERT INTO passkeys (user_id, credential_id, public_key, counter, transports, name, rp_id) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
      req.user.id,
      cred.id,
      Buffer.from(cred.publicKey),
      cred.counter,
      (cred.transports || []).join(','),
      text(req.body.name, 'Nome', 60) || 'Passkey',
      rpID
    );
    res.status(201).json({ ok: true });
  });

  api.delete('/passkeys/:id', (req, res) => {
    q('DELETE FROM passkeys WHERE id = ? AND user_id = ?').run(intId(req.params.id), req.user.id);
    res.json({ ok: true });
  });

  // ---------- estado ----------

  api.get('/state', (req, res) => {
    const assignees = new Map();
    for (const r of q('SELECT task_id, user_id FROM task_assignees ORDER BY user_id').all()) {
      if (!assignees.has(r.task_id)) assignees.set(r.task_id, []);
      assignees.get(r.task_id).push(r.user_id);
    }
    const images = new Map();
    for (const r of q('SELECT id, ref_id FROM ref_images ORDER BY id').all()) {
      if (!images.has(r.ref_id)) images.set(r.ref_id, []);
      images.get(r.ref_id).push(r.id);
    }
    const deps = new Map();
    for (const r of q('SELECT task_id, depends_on_id FROM task_deps ORDER BY depends_on_id').all()) {
      if (!deps.has(r.task_id)) deps.set(r.task_id, []);
      deps.get(r.task_id).push(r.depends_on_id);
    }
    const receipts = new Map();
    for (const r of q('SELECT id, expense_id, name, size FROM expense_files ORDER BY id').all()) {
      if (!receipts.has(r.expense_id)) receipts.set(r.expense_id, []);
      receipts.get(r.expense_id).push({ id: r.id, name: r.name, size: r.size });
    }
    const counts = new Map();
    for (const r of q('SELECT kind, target_id, COUNT(*) AS n FROM comments GROUP BY kind, target_id').all()) {
      counts.set(`${r.kind}:${r.target_id}`, r.n);
    }
    // { idDaImagem: { emoji: [idsDeQuemReagiu] } }
    const reactions = {};
    for (const r of q('SELECT image_id, emoji, user_id FROM image_reactions ORDER BY rowid').all()) {
      ((reactions[r.image_id] ||= {})[r.emoji] ||= []).push(r.user_id);
    }
    res.json({
      activity_unread: q('SELECT COUNT(*) AS n FROM activity WHERE id > ? AND user_id <> ?').get(req.user.activity_seen, req.user.id).n,
      reactions,
      mentions: q(
        `SELECT c.id AS comment_id, c.kind, c.target_id, c.user_id, c.body, c.created_at
         FROM comment_mentions m JOIN comments c ON c.id = m.comment_id
         WHERE m.user_id = ? AND m.seen = 0 ORDER BY c.id DESC`
      ).all(req.user.id),
      users: q('SELECT id, name, active FROM users ORDER BY name COLLATE NOCASE').all(),
      categories: q('SELECT id, name, color FROM categories ORDER BY position, id').all(),
      tasks: q(
        `SELECT id, category_id, title, description, status, due_date, created_by
         FROM tasks ORDER BY position, id`
      )
        .all()
        .map((t) => ({ ...t, assignees: assignees.get(t.id) || [], depends_on: deps.get(t.id) || [], comments: counts.get(`task:${t.id}`) || 0 })),
      themes: q('SELECT id, name FROM themes ORDER BY position, id').all(),
      folders: q('SELECT id, name FROM folders ORDER BY position, id').all(),
      expenses: q('SELECT id, date, description, amount_cents, paid_by, note, settled_at, created_by FROM expenses ORDER BY date DESC, id DESC')
        .all()
        .map((e) => ({ ...e, files: receipts.get(e.id) || [] })),
      files: q('SELECT id, folder_id, name, size, uploaded_by, created_at FROM files ORDER BY name COLLATE NOCASE').all(),
      refs: q(
        `SELECT id, theme_id, title, url, note, created_by, preview_title, preview_desc, preview_image, preview_site
         FROM refs ORDER BY title COLLATE NOCASE`
      )
        .all()
        .map((r) => ({ ...r, images: images.get(r.id) || [], comments: counts.get(`ref:${r.id}`) || 0 })),
    });
  });

  api.get('/activity', (req, res) => {
    res.json(
      q('SELECT id, user_id, text, kind, target_id, title, detail, created_at FROM activity WHERE user_id <> ? ORDER BY id DESC LIMIT 100')
        .all(req.user.id)
        .map((a) => ({ ...a, unread: a.id > req.user.activity_seen }))
    );
  });

  api.post('/activity/seen', (req, res) => {
    const max = q('SELECT COALESCE(MAX(id), 0) AS id FROM activity').get().id;
    const upTo = Number.isSafeInteger(req.body.id) ? Math.min(req.body.id, max) : max;
    q('UPDATE users SET activity_seen = MAX(activity_seen, ?) WHERE id = ?').run(upTo, req.user.id);
    res.json({ ok: true });
  });

  // ---------- listas ordenadas (categorias e temas) ----------

  function orderedList(route, table, childTable, childFk, label, extra, created) {
    const reorder = (id, index) => {
      const ids = q(`SELECT id FROM ${table} WHERE id <> ? ORDER BY position, id`)
        .all(id)
        .map((r) => r.id);
      const i = Number.isInteger(index) ? Math.max(0, Math.min(index, ids.length)) : ids.length;
      ids.splice(i, 0, id);
      const upd = q(`UPDATE ${table} SET position = ? WHERE id = ?`);
      ids.forEach((rowId, pos) => upd.run(pos, rowId));
    };

    api.post(route, (req, res) => {
      const name = text(req.body.name, 'Nome', 60, true);
      const id = tx(() => {
        const newId = Number(q(`INSERT INTO ${table} (name) VALUES (?)`).run(name).lastInsertRowid);
        if (extra) extra(newId, req.body);
        reorder(newId, null);
        log(req, created, table, newId, name);
        return newId;
      });
      res.status(201).json({ id });
    });

    api.patch(`${route}/:id`, (req, res) => {
      const id = intId(req.params.id);
      tx(() => {
        if (!q(`SELECT id FROM ${table} WHERE id = ?`).get(id)) throw new HttpError(404, `${label} não encontrado.`);
        if ('name' in req.body) {
          q(`UPDATE ${table} SET name = ? WHERE id = ?`).run(text(req.body.name, 'Nome', 60, true), id);
        }
        if (extra) extra(id, req.body);
        if ('position' in req.body) reorder(id, Number(req.body.position));
      });
      res.json({ ok: true });
    });

    api.delete(`${route}/:id`, (req, res) => {
      const id = intId(req.params.id);
      if (q(`SELECT 1 FROM ${childTable} WHERE ${childFk} = ? LIMIT 1`).get(id)) {
        throw new HttpError(409, 'Mova ou exclua os itens daqui antes de excluir.');
      }
      q(`DELETE FROM ${table} WHERE id = ?`).run(id);
      res.json({ ok: true });
    });
  }

  orderedList('/categories', 'categories', 'tasks', 'category_id', 'Categoria', (id, body) => {
    if ('color' in body) {
      if (!COLORS.includes(body.color)) bad('Cor inválida.');
      q('UPDATE categories SET color = ? WHERE id = ?').run(body.color, id);
    }
  }, 'criou a categoria');
  orderedList('/themes', 'themes', 'refs', 'theme_id', 'Tema', null, 'criou o tema');
  orderedList('/folders', 'folders', 'files', 'folder_id', 'Pasta', null, 'criou a pasta');

  // ---------- tarefas ----------

  function setAssignees(taskId, list) {
    if (!Array.isArray(list) || list.length > 50) bad('Responsáveis inválidos.');
    const ids = [...new Set(list.map((v) => intId(v, 'Responsável')))];
    q('DELETE FROM task_assignees WHERE task_id = ?').run(taskId);
    for (const uid of ids) {
      if (!q('SELECT id FROM users WHERE id = ?').get(uid)) bad('Responsável inexistente.');
      q('INSERT INTO task_assignees (task_id, user_id) VALUES (?, ?)').run(taskId, uid);
    }
  }

  function placeTask(taskId, categoryId, beforeId) {
    if (!q('SELECT id FROM categories WHERE id = ?').get(categoryId)) bad('Categoria inexistente.');
    const ids = q('SELECT id FROM tasks WHERE category_id = ? AND id <> ? ORDER BY position, id')
      .all(categoryId, taskId)
      .map((r) => r.id);
    let i = beforeId == null ? -1 : ids.indexOf(beforeId);
    if (i < 0) i = ids.length;
    ids.splice(i, 0, taskId);
    const upd = q('UPDATE tasks SET category_id = ?, position = ? WHERE id = ?');
    ids.forEach((id, pos) => upd.run(categoryId, pos, id));
  }

  const depIds = (taskId) => q('SELECT depends_on_id AS id FROM task_deps WHERE task_id = ? ORDER BY depends_on_id').all(taskId).map((r) => r.id);

  // "A depende de B": recusa a própria tarefa e ciclos (B já depender de A, direta ou indiretamente).
  function setDeps(taskId, list) {
    if (!Array.isArray(list) || list.length > 50) bad('Dependências inválidas.');
    const ids = [...new Set(list.map((v) => intId(v, 'Dependência')))];
    for (const dep of ids) {
      if (dep === taskId) bad('Uma tarefa não pode depender dela mesma.');
      const row = q('SELECT title FROM tasks WHERE id = ?').get(dep);
      if (!row) bad('Dependência inexistente.');
      const seen = new Set();
      const stack = [dep];
      while (stack.length) {
        const cur = stack.pop();
        if (cur === taskId) bad(`Dependência circular: "${row.title}" já depende desta tarefa.`);
        if (seen.has(cur)) continue;
        seen.add(cur);
        stack.push(...depIds(cur));
      }
    }
    q('DELETE FROM task_deps WHERE task_id = ?').run(taskId);
    for (const dep of ids) q('INSERT INTO task_deps (task_id, depends_on_id) VALUES (?, ?)').run(taskId, dep);
  }

  // Tarefas que estavam esperando só por esta e ficam liberadas quando ela é concluída.
  function unblockedBy(taskId) {
    return q(
      `SELECT t.title FROM task_deps d JOIN tasks t ON t.id = d.task_id
       WHERE d.depends_on_id = ? AND t.status <> 'done' AND NOT EXISTS (
         SELECT 1 FROM task_deps o JOIN tasks b ON b.id = o.depends_on_id
         WHERE o.task_id = d.task_id AND b.status <> 'done')`
    )
      .all(taskId)
      .map((t) => t.title);
  }

  const assigneeNames = (taskId) =>
    q('SELECT u.name FROM task_assignees a JOIN users u ON u.id = a.user_id WHERE a.task_id = ? ORDER BY u.name COLLATE NOCASE')
      .all(taskId)
      .map((u) => u.name)
      .join(', ');

  const status = (v) => (STATUSES.includes(v) ? v : bad('Situação inválida.'));

  api.post('/tasks', (req, res) => {
    const b = req.body;
    const categoryId = intId(b.category_id, 'Categoria');
    const id = tx(() => {
      if (!q('SELECT id FROM categories WHERE id = ?').get(categoryId)) bad('Categoria inexistente.');
      const newId = Number(
        q(
          `INSERT INTO tasks (category_id, title, description, status, due_date, created_by)
           VALUES (?, ?, ?, ?, ?, ?)`
        ).run(
          categoryId,
          text(b.title, 'Título', 200, true),
          text(b.description, 'Descrição', 5000),
          'status' in b ? status(b.status) : 'todo',
          dueDate(b.due_date),
          req.user.id
        ).lastInsertRowid
      );
      if ('assignees' in b) setAssignees(newId, b.assignees);
      if ('depends_on' in b) setDeps(newId, b.depends_on);
      placeTask(newId, categoryId, null);
      log(req, 'criou a tarefa', 'tasks', newId, text(b.title, 'Título', 200, true), assigneeNames(newId));
      return newId;
    });
    res.status(201).json({ id });
  });

  api.patch('/tasks/:id', (req, res) => {
    const id = intId(req.params.id);
    const b = req.body;
    tx(() => {
      const t = q('SELECT * FROM tasks WHERE id = ?').get(id);
      if (!t) throw new HttpError(404, 'Tarefa não encontrada.');
      q(
        `UPDATE tasks SET title = ?, description = ?, status = ?, due_date = ?, updated_at = datetime('now')
         WHERE id = ?`
      ).run(
        'title' in b ? text(b.title, 'Título', 200, true) : t.title,
        'description' in b ? text(b.description, 'Descrição', 5000) : t.description,
        'status' in b ? status(b.status) : t.status,
        'due_date' in b ? dueDate(b.due_date) : t.due_date,
        id
      );
      const before = assigneeNames(id);
      const depsBefore = depIds(id).join();
      if ('assignees' in b) setAssignees(id, b.assignees);
      if ('depends_on' in b) setDeps(id, b.depends_on);
      const categoryId = 'category_id' in b ? intId(b.category_id, 'Categoria') : t.category_id;
      if ('before_id' in b) {
        placeTask(id, categoryId, b.before_id == null ? null : intId(b.before_id));
      } else if (categoryId !== t.category_id) {
        placeTask(id, categoryId, null);
      }
      const now = q('SELECT * FROM tasks WHERE id = ?').get(id);
      // Concluir e reabrir em seguida (ou o contrário) é um engano desfeito: em vez de registrar
      // duas novidades, a primeira é retirada.
      const opposite = now.status === 'done' ? 'reabriu a tarefa' : t.status === 'done' ? 'concluiu a tarefa' : null;
      const justDid =
        now.status !== t.status &&
        opposite &&
        q(
          `SELECT id, text FROM activity WHERE kind = 'tasks' AND target_id = ? AND user_id = ?
           AND created_at > datetime('now', '-2 minutes') ORDER BY id DESC LIMIT 1`
        ).get(id, req.user.id);
      if (justDid && justDid.text === opposite) {
        q('DELETE FROM activity WHERE id = ?').run(justDid.id);
      } else if (now.status !== t.status) {
        if (now.status === 'done') {
          const freed = unblockedBy(id);
          log(req, 'concluiu a tarefa', 'tasks', id, now.title, freed.length ? `Liberou: ${freed.join(', ')}` : '');
        }
        else if (t.status === 'done') log(req, 'reabriu a tarefa', 'tasks', id, now.title);
        else log(req, 'mudou a situação da tarefa', 'tasks', id, now.title, STATUS_LABEL[now.status]);
      }
      if (depIds(id).join() !== depsBefore) {
        const names = depIds(id).map((d) => q('SELECT title FROM tasks WHERE id = ?').get(d).title);
        log(req, 'alterou as dependências da tarefa', 'tasks', id, now.title, names.length ? `Depende de: ${names.join(', ')}` : 'Sem dependências');
      }
      const after = assigneeNames(id);
      if (after !== before) log(req, 'alterou os responsáveis da tarefa', 'tasks', id, now.title, after || 'Sem responsável');
      if (now.category_id !== t.category_id) {
        log(req, 'moveu a tarefa', 'tasks', id, now.title, `Para ${q('SELECT name FROM categories WHERE id = ?').get(now.category_id).name}`);
      }
      if (now.title !== t.title || now.description !== t.description || now.due_date !== t.due_date) {
        log(req, 'editou a tarefa', 'tasks', id, now.title);
      }
    });
    res.json({ ok: true });
  });

  api.delete('/tasks/:id', (req, res) => {
    const gone = q('SELECT title FROM tasks WHERE id = ?').get(intId(req.params.id));
    if (gone) log(req, 'excluiu a tarefa', 'tasks', null, gone.title);
    q("DELETE FROM comments WHERE kind = 'task' AND target_id = ?").run(intId(req.params.id));
    q('DELETE FROM tasks WHERE id = ?').run(intId(req.params.id));
    res.json({ ok: true });
  });

  // ---------- referências ----------

  const themeId = (v) => {
    const id = intId(v, 'Tema');
    if (!q('SELECT id FROM themes WHERE id = ?').get(id)) bad('Tema inexistente.');
    return id;
  };

  async function savePreview(id, url) {
    const p = url ? await fetchPreview(url, { allowPrivate: previewAllowPrivate }) : null;
    q('UPDATE refs SET preview_title = ?, preview_desc = ?, preview_image = ?, preview_site = ? WHERE id = ?').run(
      p ? p.title : '',
      p ? p.description : '',
      p ? p.image : '',
      p ? p.site : '',
      id
    );
  }

  api.post('/refs', async (req, res) => {
    const b = req.body;
    const url = httpUrl(b.url);
    const r = q('INSERT INTO refs (theme_id, title, url, note, created_by) VALUES (?, ?, ?, ?, ?)').run(
      themeId(b.theme_id),
      text(b.title, 'Título', 200, true),
      url,
      text(b.note, 'Anotação', 5000),
      req.user.id
    );
    const id = Number(r.lastInsertRowid);
    log(req, 'adicionou a referência', 'refs', id, text(b.title, 'Título', 200, true));
    await savePreview(id, url);
    res.status(201).json({ id });
  });

  api.patch('/refs/:id', async (req, res) => {
    const id = intId(req.params.id);
    const b = req.body;
    const r = q('SELECT * FROM refs WHERE id = ?').get(id);
    if (!r) throw new HttpError(404, 'Referência não encontrada.');
    const url = 'url' in b ? httpUrl(b.url) : r.url;
    q('UPDATE refs SET theme_id = ?, title = ?, url = ?, note = ? WHERE id = ?').run(
      'theme_id' in b ? themeId(b.theme_id) : r.theme_id,
      'title' in b ? text(b.title, 'Título', 200, true) : r.title,
      url,
      'note' in b ? text(b.note, 'Anotação', 5000) : r.note,
      id
    );
    const now = q('SELECT * FROM refs WHERE id = ?').get(id);
    if (now.title !== r.title || now.url !== r.url || now.note !== r.note || now.theme_id !== r.theme_id) {
      log(req, 'editou a referência', 'refs', id, now.title);
    }
    // Busca a prévia de novo se o link mudou ou se ainda não há nenhuma guardada.
    if (url !== r.url || (url && !r.preview_title && !r.preview_desc && !r.preview_image)) await savePreview(id, url);
    res.json({ ok: true });
  });

  const removeFile = (filename) => fs.rm(path.join(uploadDir, filename), { force: true }, () => {});

  api.delete('/refs/:id', (req, res) => {
    const id = intId(req.params.id);
    const files = q('SELECT filename FROM ref_images WHERE ref_id = ?').all(id);
    const gone = q('SELECT title FROM refs WHERE id = ?').get(id);
    if (gone) log(req, 'excluiu a referência', 'refs', null, gone.title);
    q("DELETE FROM comments WHERE kind = 'ref' AND target_id = ?").run(id);
    q('DELETE FROM refs WHERE id = ?').run(id);
    files.forEach((f) => removeFile(f.filename));
    res.json({ ok: true });
  });

  // ---------- imagens das referências ----------

  api.post(
    '/refs/:id/images',
    express.raw({ type: () => true, limit: MAX_IMAGE_BYTES }),
    (req, res) => {
      const id = intId(req.params.id);
      const ref = q('SELECT title FROM refs WHERE id = ?').get(id);
      if (!ref) throw new HttpError(404, 'Referência não encontrada.');
      const mime = Buffer.isBuffer(req.body) ? imageType(req.body) : null;
      if (!mime) bad('Envie uma imagem JPEG, PNG, WebP ou GIF.');
      if (q('SELECT COUNT(*) AS n FROM ref_images WHERE ref_id = ?').get(id).n >= MAX_IMAGES_PER_REF) {
        bad(`Limite de ${MAX_IMAGES_PER_REF} imagens por referência.`);
      }
      const filename = crypto.randomBytes(16).toString('hex');
      fs.writeFileSync(path.join(uploadDir, filename), req.body, { flag: 'wx' });
      const r = q('INSERT INTO ref_images (ref_id, filename, mime, size, created_by) VALUES (?, ?, ?, ?, ?)').run(
        id,
        filename,
        mime,
        req.body.length,
        req.user.id
      );
      log(req, 'anexou imagens à referência', 'refs', id, ref.title);
      res.status(201).json({ id: Number(r.lastInsertRowid) });
    }
  );

  api.get('/images/:id', (req, res) => {
    const img = q('SELECT filename, mime FROM ref_images WHERE id = ?').get(intId(req.params.id));
    if (!img) throw new HttpError(404, 'Imagem não encontrada.');
    res.set({ 'Content-Type': img.mime, 'Cache-Control': 'private, max-age=31536000, immutable' });
    res.sendFile(img.filename, { root: uploadDir, headers: { 'Content-Type': img.mime } }, (err) => {
      if (err && !res.headersSent) res.status(404).json({ error: 'Imagem não encontrada.' });
    });
  });

  // Liga ou desliga a reação da própria pessoa.
  api.post('/images/:id/reactions', (req, res) => {
    const id = intId(req.params.id);
    if (!q('SELECT id FROM ref_images WHERE id = ?').get(id)) throw new HttpError(404, 'Imagem não encontrada.');
    const emoji = req.body.emoji;
    if (!REACTIONS.includes(emoji)) bad('Reação inválida.');
    const removed = q('DELETE FROM image_reactions WHERE image_id = ? AND user_id = ? AND emoji = ?').run(id, req.user.id, emoji).changes;
    if (!removed) q('INSERT INTO image_reactions (image_id, user_id, emoji) VALUES (?, ?, ?)').run(id, req.user.id, emoji);
    res.json({ on: !removed });
  });

  api.delete('/images/:id', (req, res) => {
    const id = intId(req.params.id);
    const img = q('SELECT filename FROM ref_images WHERE id = ?').get(id);
    if (img) {
      q('DELETE FROM ref_images WHERE id = ?').run(id);
      removeFile(img.filename);
    }
    res.json({ ok: true });
  });

  // ---------- arquivos ----------

  const folderId = (v) => {
    const id = intId(v, 'Pasta');
    if (!q('SELECT id FROM folders WHERE id = ?').get(id)) bad('Pasta inexistente.');
    return id;
  };

  // O corpo da requisição é o próprio arquivo, gravado direto em disco (sem passar pela memória).
  async function receiveUpload(req) {
    const name = fileName(req.get('X-File-Name'));
    const tooBig = () => new HttpError(413, 'Arquivo grande demais (máximo de 50 MB).');
    if (Number(req.get('Content-Length')) > MAX_FILE_BYTES) throw tooBig();
    const stored = crypto.randomBytes(16).toString('hex');
    const full = path.join(filesDir, stored);
    let size = 0;
    const limiter = new Transform({
      transform(chunk, enc, cb) {
        size += chunk.length;
        cb(size > MAX_FILE_BYTES ? tooBig() : null, chunk);
      },
    });
    try {
      await pipeline(req, limiter, fs.createWriteStream(full, { flags: 'wx' }));
      if (!size) bad('Arquivo vazio.');
    } catch (e) {
      fs.rm(full, { force: true }, () => {});
      throw e.status ? e : new HttpError(400, 'O envio foi interrompido. Tente de novo.');
    }
    return { name, stored, size };
  }

  function sendStored(req, res, f) {
    if (!f) throw new HttpError(404, 'Arquivo não encontrado.');
    const ext = f.name.includes('.') ? f.name.split('.').pop().toLowerCase() : '';
    const inline = Object.hasOwn(INLINE_TYPES, ext) && req.query.download === undefined;
    const ascii = f.name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
    res.sendFile(
      f.filename,
      {
        root: filesDir,
        headers: {
          'Content-Type': inline ? INLINE_TYPES[ext] : 'application/octet-stream',
          'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(f.name)}`,
          'Cache-Control': 'private, no-cache',
        },
      },
      (err) => {
        if (err && !res.headersSent) res.status(404).json({ error: 'Arquivo não encontrado.' });
      }
    );
  }

  api.post('/folders/:id/files', async (req, res) => {
    const folder = folderId(req.params.id);
    const { name, stored, size } = await receiveUpload(req);
    const r = q('INSERT INTO files (folder_id, name, filename, size, uploaded_by) VALUES (?, ?, ?, ?, ?)').run(folder, name, stored, size, req.user.id);
    log(req, 'enviou o arquivo', 'files', Number(r.lastInsertRowid), name, `Na pasta ${q('SELECT name FROM folders WHERE id = ?').get(folder).name}`);
    res.status(201).json({ id: Number(r.lastInsertRowid) });
  });

  api.get('/files/:id', (req, res) => {
    sendStored(req, res, q('SELECT name, filename FROM files WHERE id = ?').get(intId(req.params.id)));
  });

  api.patch('/files/:id', (req, res) => {
    const id = intId(req.params.id);
    const f = q('SELECT * FROM files WHERE id = ?').get(id);
    if (!f) throw new HttpError(404, 'Arquivo não encontrado.');
    q('UPDATE files SET name = ?, folder_id = ? WHERE id = ?').run(
      'name' in req.body ? fileName(encodeURIComponent(text(req.body.name, 'Nome', 200, true))) : f.name,
      'folder_id' in req.body ? folderId(req.body.folder_id) : f.folder_id,
      id
    );
    res.json({ ok: true });
  });

  api.delete('/files/:id', (req, res) => {
    const id = intId(req.params.id);
    const f = q('SELECT name, filename FROM files WHERE id = ?').get(id);
    if (f) {
      log(req, 'excluiu o arquivo', 'files', null, f.name);
      q('DELETE FROM files WHERE id = ?').run(id);
      fs.rm(path.join(filesDir, f.filename), { force: true }, () => {});
    }
    res.json({ ok: true });
  });

  // ---------- conta corrente dos sócios ----------

  const money = (cents) => `R$ ${(cents / 100).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const userName = (id) => (q('SELECT name FROM users WHERE id = ?').get(id) || {}).name || 'alguém';

  function expenseFields(b, current) {
    const date = 'date' in b ? dueDate(b.date) : current && current.date;
    if (!date) bad('Data é obrigatória.');
    const cents = 'amount_cents' in b ? b.amount_cents : current && current.amount_cents;
    if (!Number.isSafeInteger(cents) || cents <= 0 || cents > 1e11) bad('Valor inválido.');
    const paidBy = 'paid_by' in b ? intId(b.paid_by, 'Quem pagou') : current && current.paid_by;
    if (!q('SELECT id FROM users WHERE id = ?').get(paidBy)) bad('Pessoa inexistente.');
    return {
      date,
      cents,
      paidBy,
      description: 'description' in b ? text(b.description, 'Descrição', 200, true) : current && current.description,
      note: 'note' in b ? text(b.note, 'Observação', 2000) : current ? current.note : '',
    };
  }

  // Dinheiro pede mais cuidado: só quem lançou, quem pagou ou um admin altera um gasto;
  // depois de acertado, só um admin.
  function editableExpense(req, id) {
    const e = q('SELECT * FROM expenses WHERE id = ?').get(intId(id));
    if (!e) throw new HttpError(404, 'Gasto não encontrado.');
    const own = e.created_by === req.user.id || e.paid_by === req.user.id;
    if (!req.user.is_admin && (!own || e.settled_at)) {
      throw new HttpError(403, e.settled_at ? 'Esse gasto já foi acertado; só um admin pode alterá-lo.' : 'Só quem lançou, quem pagou ou um admin pode alterar esse gasto.');
    }
    return e;
  }

  api.post('/expenses', (req, res) => {
    const f = expenseFields({ paid_by: req.user.id, ...req.body }, null);
    if (!f.description) bad('Descrição é obrigatória.');
    const r = q('INSERT INTO expenses (date, description, amount_cents, paid_by, note, created_by) VALUES (?, ?, ?, ?, ?, ?)').run(
      f.date,
      f.description,
      f.cents,
      f.paidBy,
      f.note,
      req.user.id
    );
    log(req, 'lançou o gasto', 'expenses', Number(r.lastInsertRowid), f.description, `${money(f.cents)} · pago por ${userName(f.paidBy)}`);
    res.status(201).json({ id: Number(r.lastInsertRowid) });
  });

  api.patch('/expenses/:id', (req, res) => {
    const e = editableExpense(req, req.params.id);
    const f = expenseFields(req.body, e);
    let settledAt = e.settled_at;
    if ('settled' in req.body && !!req.body.settled !== !!e.settled_at) {
      if (!req.user.is_admin) throw new HttpError(403, 'Só um admin marca ou desmarca um gasto como acertado.');
      settledAt = req.body.settled ? new Date().toISOString().slice(0, 19).replace('T', ' ') : null;
    }
    q('UPDATE expenses SET date = ?, description = ?, amount_cents = ?, paid_by = ?, note = ?, settled_at = ? WHERE id = ?').run(
      f.date,
      f.description,
      f.cents,
      f.paidBy,
      f.note,
      settledAt,
      e.id
    );
    const changes = [];
    if (f.cents !== e.amount_cents) changes.push(`valor de ${money(e.amount_cents)} para ${money(f.cents)}`);
    if (f.paidBy !== e.paid_by) changes.push(`quem pagou de ${userName(e.paid_by)} para ${userName(f.paidBy)}`);
    if (f.date !== e.date) changes.push('data');
    if (f.description !== e.description) changes.push(`descrição (era "${e.description}")`);
    if (!!settledAt !== !!e.settled_at) changes.push(settledAt ? 'marcado como acertado' : 'reaberto');
    if (changes.length) log(req, 'alterou o gasto', 'expenses', e.id, f.description, `Mudou: ${changes.join('; ')}`);
    res.json({ ok: true });
  });

  api.delete('/expenses/:id', (req, res) => {
    const e = editableExpense(req, req.params.id);
    const files = q('SELECT filename FROM expense_files WHERE expense_id = ?').all(e.id);
    log(req, 'excluiu o gasto', 'expenses', null, e.description, `${money(e.amount_cents)} · pago por ${userName(e.paid_by)}`);
    q('DELETE FROM expenses WHERE id = ?').run(e.id);
    files.forEach((f) => fs.rm(path.join(filesDir, f.filename), { force: true }, () => {}));
    res.json({ ok: true });
  });

  // Fecha o acerto: tudo que está em aberto passa a constar como acertado.
  api.post('/expenses/settle', adminOnly, (req, res) => {
    const open = q('SELECT COUNT(*) AS n, COALESCE(SUM(amount_cents), 0) AS total FROM expenses WHERE settled_at IS NULL').get();
    if (!open.n) bad('Não há gastos em aberto.');
    q("UPDATE expenses SET settled_at = datetime('now') WHERE settled_at IS NULL").run();
    log(req, 'fechou o acerto da conta corrente', 'expenses', null, `${open.n} gasto(s)`, `Total acertado: ${money(open.total)}`);
    res.json({ count: open.n, total_cents: open.total });
  });

  api.post('/expenses/:id/files', async (req, res) => {
    const e = editableExpense(req, req.params.id);
    if (q('SELECT COUNT(*) AS n FROM expense_files WHERE expense_id = ?').get(e.id).n >= 20) bad('Limite de 20 anexos por gasto.');
    const { name, stored, size } = await receiveUpload(req);
    const r = q('INSERT INTO expense_files (expense_id, name, filename, size, uploaded_by) VALUES (?, ?, ?, ?, ?)').run(e.id, name, stored, size, req.user.id);
    log(req, 'anexou comprovante ao gasto', 'expenses', e.id, e.description);
    res.status(201).json({ id: Number(r.lastInsertRowid) });
  });

  api.get('/expense-files/:id', (req, res) => {
    sendStored(req, res, q('SELECT name, filename FROM expense_files WHERE id = ?').get(intId(req.params.id)));
  });

  api.delete('/expense-files/:id', (req, res) => {
    const id = intId(req.params.id);
    const f = q('SELECT expense_id, filename FROM expense_files WHERE id = ?').get(id);
    if (f) {
      editableExpense(req, f.expense_id);
      q('DELETE FROM expense_files WHERE id = ?').run(id);
      fs.rm(path.join(filesDir, f.filename), { force: true }, () => {});
    }
    res.json({ ok: true });
  });

  // ---------- cardápio: nosso rascunho contra os preços da região ----------

  const cents = (v) => {
    const m = /^(\d{1,6})(?:[.,](\d{1,2}))?$/.exec(String(v || '').trim().replace(/^R\$\s*/i, ''));
    return m ? Number(m[1]) * 100 + Number((m[2] || '0').padEnd(2, '0')) : null;
  };
  const decimal = (v) => {
    const n = parseFloat(String(v || '').replace(',', '.'));
    return Number.isFinite(n) ? n : null;
  };
  const cut = (v, max) => String(v || '').trim().slice(0, max);
  const httpsOrEmpty = (v) => (/^https:\/\//i.test(String(v || '').trim()) ? cut(v, 2000) : '');
  const TIPO_FROM_SHEET = { 'cafe especial': 'cafe', 'padaria artesanal': 'padaria', 'cafe-restaurante / brunch': 'brunch', 'livraria com cafe': 'livraria' };

  // Recebe a planilha da coleta. Cada casa presente no arquivo tem seus itens substituídos,
  // então reimportar uma casa (cardápio novo) não duplica nada; as demais ficam como estão.
  api.post('/market/import', express.text({ type: () => true, limit: '8mb' }), (req, res) => {
    const rows = parseCsv(typeof req.body === 'string' ? req.body : '');
    if (rows.length < 2) bad('Planilha vazia ou em formato não reconhecido.');
    const header = rows[0].map((h) => foldText(h));
    const col = (name) => header.indexOf(name);
    for (const required of ['cafe', 'item', 'preco']) {
      if (col(required) < 0) bad(`A planilha precisa ter a coluna "${required}". Use o arquivo gerado pela coleta, separado por ponto e vírgula.`);
    }
    if (rows.length > 20001) bad('Planilha grande demais (máximo de 20.000 linhas).');
    const get = (row, name) => (col(name) >= 0 ? row[col(name)] || '' : '');
    const byHouse = new Map();
    for (const row of rows.slice(1)) {
      const name = cut(get(row, 'cafe'), 120);
      if (!name) continue;
      if (!byHouse.has(name)) byHouse.set(name, []);
      byHouse.get(name).push(row);
    }
    if (!byHouse.size) bad('Nenhuma casa encontrada na planilha.');
    let items = 0;
    let anchors = 0;
    tx(() => {
      for (const [name, houseRows] of byHouse) {
        const first = houseRows[0];
        const tipo = TIPO_FROM_SHEET[foldText(get(first, 'tipo_casa'))];
        const existing = q('SELECT id FROM market_houses WHERE name = ?').get(name);
        const id = existing
          ? existing.id
          : Number(q('INSERT INTO market_houses (name) VALUES (?)').run(name).lastInsertRowid);
        q('UPDATE market_houses SET address = ?, distance_km = ?, rating = ?, reviews = ?, price_range = ?, status = ?, maps_url = ? WHERE id = ?').run(
          cut(get(first, 'endereco'), 300),
          decimal(get(first, 'distancia_km')),
          decimal(get(first, 'nota')),
          /^\d+$/.test(get(first, 'avaliacoes').trim()) ? Number(get(first, 'avaliacoes')) : null,
          cut(get(first, 'faixa_preco'), 40),
          cut(get(first, 'situacao'), 40),
          httpsOrEmpty(get(first, 'url_maps')),
          id
        );
        // Tipo e "referência" só vêm da planilha quando ela traz essas colunas; senão vale o que já foi ajustado na tela.
        if (tipo) q('UPDATE market_houses SET tipo = ? WHERE id = ?').run(tipo, id);
        if (col('referencia') >= 0) q('UPDATE market_houses SET is_ref = ? WHERE id = ?').run(foldText(get(first, 'referencia')) === 'sim' ? 1 : 0, id);
        q('DELETE FROM market_items WHERE house_id = ?').run(id);
        const insert = q(
          `INSERT INTO market_items (house_id, category, item, description, variation, price_cents, photo_month, photo_url, reading, notes, anchor)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        );
        for (const row of houseRows) {
          const item = cut(get(row, 'item'), 200);
          if (!item) continue;
          const price = cents(get(row, 'preco'));
          const anchor = price ? anchorOf(item, get(row, 'variacao'), get(row, 'categoria')) : '';
          insert.run(
            id,
            cut(get(row, 'categoria'), 120),
            item,
            cut(get(row, 'descricao'), 600),
            cut(get(row, 'variacao'), 120),
            price,
            /^\d{4}-\d{2}$/.test(get(row, 'data_foto').trim()) ? get(row, 'data_foto').trim() : '',
            httpsOrEmpty(get(row, 'url_foto')),
            cut(foldText(get(row, 'leitura')), 20),
            cut(get(row, 'observacoes'), 600),
            anchor
          );
          items += 1;
          if (anchor) anchors += 1;
        }
      }
      log(req, 'importou cardápios da região', 'market', null, `${byHouse.size} casa(s)`, `${items} itens, ${anchors} comparáveis`);
    });
    res.json({ houses: byHouse.size, items, anchors });
  });

  api.get('/market', (req, res) => {
    // Qualidade do preço: A = leitura clara e foto com até 12 meses; B = foto mais antiga; C = leitura incerta.
    const limit = new Date();
    limit.setMonth(limit.getMonth() - 12);
    const recent = limit.toISOString().slice(0, 7);
    const quality = (r) => (r.reading !== 'ok' ? 'C' : r.photo_month && r.photo_month >= recent ? 'A' : 'B');
    const rank = { A: 0, B: 1, C: 2 };
    // Um preço por casa e item: o de melhor qualidade e, entre esses, o menor (a versão básica).
    const best = new Map();
    for (const r of q("SELECT * FROM market_items WHERE anchor <> '' AND price_cents IS NOT NULL ORDER BY id").all()) {
      const key = `${r.anchor}|${r.house_id}`;
      const cur = best.get(key);
      const ql = quality(r);
      if (!cur || rank[ql] < rank[cur.q] || (ql === cur.q && r.price_cents < cur.cents)) {
        best.set(key, { anchor: r.anchor, house: r.house_id, cents: r.price_cents, q: ql, label: r.variation ? `${r.item} · ${r.variation}` : r.item, month: r.photo_month, url: r.photo_url });
      }
    }
    const points = {};
    for (const { anchor, ...point } of best.values()) (points[anchor] ||= []).push(point);
    for (const list of Object.values(points)) list.sort((a, b) => a.cents - b.cents || a.house - b.house);
    const draft = {};
    for (const d of q('SELECT anchor, included, price_cents FROM menu_draft').all()) draft[d.anchor] = { included: !!d.included, price_cents: d.price_cents };
    res.json({
      sections: MARKET_SECTIONS,
      houses: q(
        `SELECT h.id, h.name, h.distance_km, h.rating, h.reviews, h.price_range, h.maps_url, h.tipo, h.is_ref,
                (SELECT COUNT(*) FROM market_items i WHERE i.house_id = h.id) AS items
         FROM market_houses h ORDER BY h.distance_km IS NULL, h.distance_km, h.name`
      ).all(),
      points,
      draft,
    });
  });

  api.patch('/market/draft', (req, res) => {
    const b = req.body;
    if (!MARKET_ANCHORS.includes(b.anchor)) bad('Item inválido.');
    const cur = q('SELECT * FROM menu_draft WHERE anchor = ?').get(b.anchor) || { included: 0, price_cents: null };
    const included = 'included' in b ? (b.included ? 1 : 0) : cur.included;
    let price = cur.price_cents;
    if ('price_cents' in b) {
      if (b.price_cents !== null && (!Number.isSafeInteger(b.price_cents) || b.price_cents <= 0 || b.price_cents > 1e7)) bad('Preço inválido.');
      price = b.price_cents;
    }
    q(
      `INSERT INTO menu_draft (anchor, included, price_cents, updated_by) VALUES (?, ?, ?, ?)
       ON CONFLICT(anchor) DO UPDATE SET included = excluded.included, price_cents = excluded.price_cents,
         updated_by = excluded.updated_by, updated_at = datetime('now')`
    ).run(b.anchor, included, price, req.user.id);
    if (included !== cur.included) log(req, included ? 'incluiu no rascunho do cardápio' : 'tirou do rascunho do cardápio', 'market', null, b.anchor);
    if (price !== cur.price_cents) log(req, 'mudou o preço no rascunho do cardápio', 'market', null, b.anchor, price ? money(price) : 'sem preço');
    res.json({ ok: true });
  });

  api.patch('/market/houses/:id', (req, res) => {
    const id = intId(req.params.id);
    const h = q('SELECT * FROM market_houses WHERE id = ?').get(id);
    if (!h) throw new HttpError(404, 'Casa não encontrada.');
    const tipo = 'tipo' in req.body ? req.body.tipo : h.tipo;
    if (!HOUSE_TYPES.includes(tipo)) bad('Tipo de casa inválido.');
    q('UPDATE market_houses SET tipo = ?, is_ref = ? WHERE id = ?').run(tipo, 'is_ref' in req.body ? (req.body.is_ref ? 1 : 0) : h.is_ref, id);
    res.json({ ok: true });
  });

  api.delete('/market/houses/:id', (req, res) => {
    const id = intId(req.params.id);
    const h = q('SELECT name FROM market_houses WHERE id = ?').get(id);
    if (h) {
      q('DELETE FROM market_houses WHERE id = ?').run(id);
      log(req, 'removeu da pesquisa de cardápios', 'market', null, h.name);
    }
    res.json({ ok: true });
  });

  // ---------- backup (admin) ----------

  // Um .tar.gz com uma cópia consistente do banco e todos os arquivos enviados.
  // Para restaurar: extrair o conteúdo dentro de DATA_DIR com o app parado.
  api.get('/backup', adminOnly, async (req, res) => {
    const snapshot = path.join(filesDir, `.backup-${crypto.randomBytes(8).toString('hex')}.db`);
    db.exec(`VACUUM INTO '${snapshot.replace(/'/g, "''")}'`);
    try {
      // Sessões abertas não vão para o backup: quem tiver o arquivo não entra como ninguém.
      const copy = new DatabaseSync(snapshot);
      copy.exec('DELETE FROM sessions; VACUUM;');
      copy.close();
      const entries = [['obsoleta.db', snapshot]];
      for (const [prefix, dir] of [['uploads', uploadDir], ['files', filesDir]]) {
        for (const name of fs.readdirSync(dir)) {
          if (/^[a-f0-9]{32}$/.test(name)) entries.push([`${prefix}/${name}`, path.join(dir, name)]);
        }
      }
      async function* tar() {
        for (const [name, file] of entries) {
          let stat;
          try {
            stat = fs.statSync(file);
          } catch {
            continue; // excluído enquanto o backup rodava
          }
          yield tarHeader(name, stat.size, stat.mtimeMs);
          let sent = 0;
          for await (const chunk of fs.createReadStream(file, { end: Math.max(stat.size - 1, 0) })) {
            if (stat.size === 0) break;
            sent += chunk.length;
            yield chunk;
          }
          if (sent % 512) yield Buffer.alloc(512 - (sent % 512));
        }
        yield Buffer.alloc(1024);
      }
      const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
      res.set({ 'Content-Type': 'application/gzip', 'Content-Disposition': `attachment; filename="obsoleta-backup-${stamp}.tar.gz"` });
      await pipeline(Readable.from(tar()), zlib.createGzip(), res);
    } finally {
      fs.rm(snapshot, { force: true }, () => {});
    }
  });

  // ---------- busca ----------

  // A tela busca sozinha em tarefas, referências e arquivos (que já estão carregados);
  // aqui ficam só os comentários. Ignora acentos e maiúsculas; todos os termos precisam aparecer.
  const fold = (v) => v.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  api.get('/search', (req, res) => {
    const terms = fold(typeof req.query.q === 'string' ? req.query.q.slice(0, 100) : '').split(/\s+/).filter(Boolean);
    if (!terms.length) return res.json([]);
    const out = [];
    for (const c of q('SELECT id, kind, target_id, user_id, body, created_at FROM comments ORDER BY id DESC').iterate()) {
      const hay = fold(c.body);
      if (!terms.every((t) => hay.includes(t))) continue;
      const at = Math.max(0, hay.indexOf(terms[0]) - 40);
      out.push({ ...c, body: (at ? '…' : '') + c.body.slice(at, at + 160) + (c.body.length > at + 160 ? '…' : '') });
      if (out.length >= 20) break;
    }
    res.json(out);
  });

  // ---------- comentários ----------

  const TARGETS = { task: 'tasks', ref: 'refs' };
  function target(kind, id) {
    if (!Object.hasOwn(TARGETS, kind)) bad('Tipo de item inválido.');
    const targetId = intId(id, 'Item');
    if (!q(`SELECT id FROM ${TARGETS[kind]} WHERE id = ?`).get(targetId)) throw new HttpError(404, 'Item não encontrado.');
    return targetId;
  }

  // "@Nome Completo" de uma pessoa ativa vira menção. Nomes mais longos têm prioridade.
  function mentionedUsers(body) {
    const users = q('SELECT id, name FROM users WHERE active = 1').all().sort((a, b) => b.name.length - a.name.length);
    const lower = body.toLowerCase();
    const found = new Set();
    const WORD = /[\p{L}\p{N}_]/u;
    for (let i = lower.indexOf('@'); i >= 0; i = lower.indexOf('@', i + 1)) {
      // O "@" precisa começar uma palavra (senão e-mails contariam como menção).
      if (i > 0 && WORD.test(body[i - 1])) continue;
      const u = users.find((c) => lower.startsWith(c.name.toLowerCase(), i + 1) && !WORD.test(body[i + 1 + c.name.length] || ''));
      if (u) {
        found.add(u.id);
        i += u.name.length;
      }
    }
    return found;
  }

  api.get('/comments', (req, res) => {
    const id = target(req.query.kind, req.query.id);
    const reactions = new Map();
    for (const r of q(
      `SELECT r.comment_id, r.emoji, r.user_id FROM comment_reactions r JOIN comments c ON c.id = r.comment_id
       WHERE c.kind = ? AND c.target_id = ? ORDER BY r.rowid`
    ).all(req.query.kind, id)) {
      if (!reactions.has(r.comment_id)) reactions.set(r.comment_id, {});
      (reactions.get(r.comment_id)[r.emoji] ||= []).push(r.user_id);
    }
    res.json(
      q('SELECT id, user_id, body, created_at FROM comments WHERE kind = ? AND target_id = ? ORDER BY id')
        .all(req.query.kind, id)
        .map((c) => ({ ...c, reactions: reactions.get(c.id) || {} }))
    );
  });

  api.post('/comments', (req, res) => {
    const b = req.body;
    const id = target(b.kind, b.id);
    const body = text(b.body, 'Comentário', 5000, true);
    const commentId = tx(() => {
      const newId = Number(
        q('INSERT INTO comments (kind, target_id, user_id, body) VALUES (?, ?, ?, ?)').run(b.kind, id, req.user.id, body).lastInsertRowid
      );
      const title = q(`SELECT title FROM ${TARGETS[b.kind]} WHERE id = ?`).get(id).title;
      log(req, 'comentou em', TARGETS[b.kind], id, title, body.length > 140 ? `${body.slice(0, 140)}…` : body);
      for (const uid of mentionedUsers(body)) {
        if (uid !== req.user.id) q('INSERT INTO comment_mentions (comment_id, user_id) VALUES (?, ?)').run(newId, uid);
      }
      return newId;
    });
    res.status(201).json({ id: commentId });
  });

  api.post('/comments/seen', (req, res) => {
    const id = target(req.body.kind, req.body.id);
    q(
      `UPDATE comment_mentions SET seen = 1 WHERE user_id = ? AND comment_id IN
         (SELECT id FROM comments WHERE kind = ? AND target_id = ?)`
    ).run(req.user.id, req.body.kind, id);
    res.json({ ok: true });
  });

  // Liga ou desliga a reação da própria pessoa a um comentário.
  api.post('/comments/:id/reactions', (req, res) => {
    const id = intId(req.params.id);
    if (!q('SELECT id FROM comments WHERE id = ?').get(id)) throw new HttpError(404, 'Comentário não encontrado.');
    const emoji = req.body.emoji;
    if (!REACTIONS.includes(emoji)) bad('Reação inválida.');
    const removed = q('DELETE FROM comment_reactions WHERE comment_id = ? AND user_id = ? AND emoji = ?').run(id, req.user.id, emoji).changes;
    if (!removed) q('INSERT INTO comment_reactions (comment_id, user_id, emoji) VALUES (?, ?, ?)').run(id, req.user.id, emoji);
    res.json({ on: !removed });
  });

  api.delete('/comments/:id', (req, res) => {
    const id = intId(req.params.id);
    const c = q('SELECT user_id FROM comments WHERE id = ?').get(id);
    if (c) {
      if (c.user_id !== req.user.id && !req.user.is_admin) throw new HttpError(403, 'Só quem escreveu ou um admin pode excluir.');
      q('DELETE FROM comments WHERE id = ?').run(id);
    }
    res.json({ ok: true });
  });

  // ---------- pessoas (admin) ----------

  api.get('/users', adminOnly, (req, res) => {
    res.json(
      q(
        `SELECT id, name, email, is_admin, active, (SELECT COUNT(*) FROM passkeys p WHERE p.user_id = users.id) AS passkeys
         FROM users ORDER BY name COLLATE NOCASE`
      ).all()
    );
  });

  api.post('/users', adminOnly, (req, res) => {
    const b = req.body;
    const mail = email(b.email);
    if (q('SELECT id FROM users WHERE email = ?').get(mail)) {
      throw new HttpError(409, 'Já existe uma pessoa com esse e-mail.');
    }
    const r = q('INSERT INTO users (name, email, pass_hash, is_admin) VALUES (?, ?, ?, ?)').run(
      text(b.name, 'Nome', 80, true),
      mail,
      hashPassword(password(b.password)),
      b.is_admin ? 1 : 0
    );
    // Quem chega agora não recebe o histórico inteiro como "não lido".
    log(req, 'adicionou a pessoa', 'users', Number(r.lastInsertRowid), text(b.name, 'Nome', 80, true));
    q('UPDATE users SET activity_seen = (SELECT COALESCE(MAX(id), 0) FROM activity) WHERE id = ?').run(Number(r.lastInsertRowid));
    res.status(201).json({ id: Number(r.lastInsertRowid) });
  });

  api.patch('/users/:id', adminOnly, (req, res) => {
    const id = intId(req.params.id);
    const b = req.body;
    tx(() => {
      const u = q('SELECT * FROM users WHERE id = ?').get(id);
      if (!u) throw new HttpError(404, 'Pessoa não encontrada.');
      const isAdmin = 'is_admin' in b ? (b.is_admin ? 1 : 0) : u.is_admin;
      const active = 'active' in b ? (b.active ? 1 : 0) : u.active;
      if (id === req.user.id && (!isAdmin || !active)) {
        bad('Você não pode remover o próprio acesso de administrador.');
      }
      const mail = 'email' in b ? email(b.email) : u.email;
      if (q('SELECT id FROM users WHERE email = ? AND id <> ?').get(mail, id)) {
        throw new HttpError(409, 'Já existe uma pessoa com esse e-mail.');
      }
      const newPw = b.password ? hashPassword(password(b.password)) : null;
      q('UPDATE users SET name = ?, email = ?, is_admin = ?, active = ?, pass_hash = ? WHERE id = ?').run(
        'name' in b ? text(b.name, 'Nome', 80, true) : u.name,
        mail,
        isAdmin,
        active,
        newPw || u.pass_hash,
        id
      );
      if ((newPw && id !== req.user.id) || !active) q('DELETE FROM sessions WHERE user_id = ?').run(id);
      if (b.clear_passkeys) q('DELETE FROM passkeys WHERE user_id = ?').run(id);
    });
    res.json({ ok: true });
  });

  // ---------- erros ----------

  api.use((req, res) => res.status(404).json({ error: 'Não encontrado.' }));

  app.use((err, req, res, next) => {
    const status = err.status || err.statusCode || 500;
    if (status >= 500) console.error(err);
    const message =
      err.type === 'entity.too.large' ? 'Arquivo grande demais (máximo de 10 MB).' : status >= 500 ? 'Erro interno.' : err.message;
    res.status(status).json({ error: message });
  });

  app.locals.db = db;
  return app;
}

module.exports = { createApp };

if (require.main === module) {
  const dataDir = process.env.DATA_DIR || path.join(__dirname, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  const app = createApp({
    dbPath: path.join(dataDir, 'obsoleta.db'),
    uploadDir: path.join(dataDir, 'uploads'),
    filesDir: path.join(dataDir, 'files'),
    production: process.env.NODE_ENV === 'production',
    appOrigin: process.env.APP_ORIGIN || undefined,
    admin: {
      name: process.env.ADMIN_NAME,
      email: process.env.ADMIN_EMAIL,
      password: process.env.ADMIN_PASSWORD,
    },
  });
  const port = Number(process.env.PORT) || 3000;
  app.listen(port, () => console.log(`Obsoleta no ar em http://localhost:${port}`));
}
