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

  app.use(express.static(path.join(__dirname, 'public'), { maxAge: production ? '5m' : 0 }));

  const api = express.Router();
  app.use('/api', api);

  api.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    // Cabeçalho próprio: um site de terceiros não consegue enviá-lo sem CORS (proteção CSRF).
    if (req.method !== 'GET' && req.get('X-Requested-With') !== 'obsoleta') {
      throw new HttpError(403, 'Requisição recusada.');
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
        .map((t) => ({ ...t, assignees: assignees.get(t.id) || [], comments: counts.get(`task:${t.id}`) || 0 })),
      themes: q('SELECT id, name FROM themes ORDER BY position, id').all(),
      folders: q('SELECT id, name FROM folders ORDER BY position, id').all(),
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
      if ('assignees' in b) setAssignees(id, b.assignees);
      const categoryId = 'category_id' in b ? intId(b.category_id, 'Categoria') : t.category_id;
      if ('before_id' in b) {
        placeTask(id, categoryId, b.before_id == null ? null : intId(b.before_id));
      } else if (categoryId !== t.category_id) {
        placeTask(id, categoryId, null);
      }
      const now = q('SELECT * FROM tasks WHERE id = ?').get(id);
      if (now.status !== t.status) {
        if (now.status === 'done') log(req, 'concluiu a tarefa', 'tasks', id, now.title);
        else if (t.status === 'done') log(req, 'reabriu a tarefa', 'tasks', id, now.title);
        else log(req, 'mudou a situação da tarefa', 'tasks', id, now.title, STATUS_LABEL[now.status]);
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
  api.post('/folders/:id/files', async (req, res) => {
    const folder = folderId(req.params.id);
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
    const r = q('INSERT INTO files (folder_id, name, filename, size, uploaded_by) VALUES (?, ?, ?, ?, ?)').run(folder, name, stored, size, req.user.id);
    log(req, 'enviou o arquivo', 'files', Number(r.lastInsertRowid), name, `Na pasta ${q('SELECT name FROM folders WHERE id = ?').get(folder).name}`);
    res.status(201).json({ id: Number(r.lastInsertRowid) });
  });

  api.get('/files/:id', (req, res) => {
    const f = q('SELECT name, filename FROM files WHERE id = ?').get(intId(req.params.id));
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
