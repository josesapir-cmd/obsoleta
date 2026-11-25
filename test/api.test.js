'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../server');
const { fetchPreview } = require('../preview');

let server;
let base;
let site;
let siteUrl;
let uploadDir;
let cookieOf;

function client() {
  let cookie = '';
  return async (method, url, body, headers = { 'X-Requested-With': 'obsoleta' }) => {
    const res = await fetch(base + url, {
      method,
      headers: { 'Content-Type': 'application/json', cookie, ...headers },
      body: body ? JSON.stringify(body) : undefined,
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    return { status: res.status, body: await res.json().catch(() => null) };
  };
}

async function login() {
  const res = await fetch(`${base}/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'obsoleta' },
    body: JSON.stringify({ email: 'ana@example.com', password: cookieOf.password }),
  });
  return res.headers.get('set-cookie').split(';')[0];
}

before(async () => {
  uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'obsoleta-test-'));
  cookieOf = { password: 'senha-da-ana-123' };
  site = http.createServer((req, res) => {
    if (req.url === '/redir') return res.writeHead(302, { Location: '/pagina' }).end();
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<html><head><title>Fallback</title>
      <meta property="og:title" content="Livraria &amp; Caf&#233;">
      <meta content='Um lugar "bom"' property='og:description'>
      <meta property="og:image" content="https://cdn.example.com/capa.jpg">
      <meta property="og:site_name" content="Exemplo"></head></html>`);
  }).listen(0);
  await new Promise((r) => site.once('listening', r));
  siteUrl = `http://127.0.0.1:${site.address().port}`;
  const app = createApp({
    dbPath: ':memory:',
    uploadDir,
    previewAllowPrivate: true,
    admin: { name: 'Ana', email: 'ana@example.com', password: 'senha-da-ana-123' },
  });
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}/api`;
});

after(() => {
  server.close();
  site.close();
  fs.rmSync(uploadDir, { recursive: true, force: true });
});

test('exige login e o cabeçalho anti-CSRF', async () => {
  const anon = client();
  assert.equal((await anon('GET', '/state')).status, 401);
  assert.equal((await anon('POST', '/login', { email: 'ana@example.com', password: 'senha-da-ana-123' }, {})).status, 403);
  assert.equal((await anon('POST', '/login', { email: 'ana@example.com', password: 'errada' })).status, 401);
});

test('fluxo de tarefas, referências e permissões', async () => {
  const ana = client();
  assert.equal((await ana('POST', '/login', { email: 'ANA@example.com', password: 'senha-da-ana-123' })).status, 200);

  // pessoas: só admin cria; senha curta é recusada
  assert.equal((await ana('POST', '/users', { name: 'Beto', email: 'beto@example.com', password: 'curta' })).status, 400);
  const beto = (await ana('POST', '/users', { name: 'Beto', email: 'beto@example.com', password: 'senha-do-beto-123' })).body.id;
  const b = client();
  assert.equal((await b('POST', '/login', { email: 'beto@example.com', password: 'senha-do-beto-123' })).status, 200);
  assert.equal((await b('GET', '/users')).status, 403);
  assert.equal((await b('POST', '/users', { name: 'X', email: 'x@example.com', password: 'senha-qualquer-1' })).status, 403);

  // categorias e tarefas
  const c1 = (await ana('POST', '/categories', { name: 'Jurídico' })).body.id;
  const c2 = (await ana('POST', '/categories', { name: 'Ponto' })).body.id;
  const t1 = (await b('POST', '/tasks', { category_id: c1, title: 'Abrir CNPJ', assignees: [beto] })).body.id;
  const t2 = (await b('POST', '/tasks', { category_id: c1, title: 'Contrato social' })).body.id;
  const t3 = (await b('POST', '/tasks', { category_id: c2, title: 'Visitar imóveis' })).body.id;
  assert.equal((await b('POST', '/tasks', { category_id: 999, title: 'x' })).status, 400);
  assert.equal((await b('PATCH', `/tasks/${t1}`, { status: 'inventado' })).status, 400);

  // mover t3 para antes de t2 em c1
  assert.equal((await b('PATCH', `/tasks/${t3}`, { category_id: c1, before_id: t2, status: 'doing' })).status, 200);
  let s = (await ana('GET', '/state')).body;
  assert.deepEqual(s.tasks.filter((t) => t.category_id === c1).map((t) => t.id), [t1, t3, t2]);
  assert.equal(s.tasks.find((t) => t.id === t3).status, 'doing');
  assert.deepEqual(s.tasks.find((t) => t.id === t1).assignees, [beto]);

  // categoria com tarefas não pode ser excluída; reordenação funciona
  assert.equal((await ana('DELETE', `/categories/${c1}`)).status, 409);
  assert.equal((await ana('DELETE', `/categories/${c2}`)).status, 200);
  const c3 = (await ana('POST', '/categories', { name: 'Acervo' })).body.id;
  await ana('PATCH', `/categories/${c3}`, { position: 0, color: 'azul' });
  s = (await ana('GET', '/state')).body;
  assert.deepEqual(s.categories.map((c) => c.id), [c3, c1]);

  // referências: só http(s)
  const th = (await ana('POST', '/themes', { name: 'Fornecedores' })).body.id;
  assert.equal((await ana('POST', '/refs', { theme_id: th, title: 'x', url: 'javascript:alert(1)' })).status, 400);
  const r = await ana('POST', '/refs', { theme_id: th, title: 'Distribuidora', url: 'exemplo.com.br/catalogo' });
  assert.equal(r.status, 201);
  s = (await ana('GET', '/state')).body;
  assert.equal(s.refs[0].url, 'https://exemplo.com.br/catalogo');

  // desativar encerra a sessão; admin não se rebaixa
  assert.equal((await ana('PATCH', `/users/${beto}`, { active: false })).status, 200);
  assert.equal((await b('GET', '/state')).status, 401);
  assert.equal((await b('POST', '/login', { email: 'beto@example.com', password: 'senha-do-beto-123' })).status, 401);
  const anaId = (await ana('GET', '/me')).body.id;
  assert.equal((await ana('PATCH', `/users/${anaId}`, { is_admin: false })).status, 400);

  // troca de senha
  assert.equal((await ana('POST', '/me/password', { current: 'errada', next: 'nova-senha-da-ana' })).status, 400);
  assert.equal((await ana('POST', '/me/password', { current: 'senha-da-ana-123', next: 'nova-senha-da-ana' })).status, 200);
  assert.equal((await ana('GET', '/me')).status, 200);
  cookieOf.password = 'nova-senha-da-ana';
});

test('prévia de link: lê Open Graph e recusa destinos internos', async () => {
  const p = await fetchPreview(`${siteUrl}/redir`, { allowPrivate: true });
  assert.deepEqual(p, { title: 'Livraria & Café', description: 'Um lugar "bom"', image: 'https://cdn.example.com/capa.jpg', site: 'Exemplo' });
  assert.equal(await fetchPreview(`${siteUrl}/pagina`), null);
  assert.equal(await fetchPreview('http://localhost/'), null);
  assert.equal(await fetchPreview('http://[::1]/'), null);
  assert.equal(await fetchPreview('http://169.254.169.254/latest/meta-data/'), null);
  assert.equal(await fetchPreview('http://[::ffff:127.0.0.1]/'), null);
});

test('referência guarda a prévia e aceita imagens', async () => {
  const cookie = await login();
  const call = async (method, url, body, type = 'application/json') => {
    const res = await fetch(base + url, {
      method,
      headers: { 'Content-Type': type, 'X-Requested-With': 'obsoleta', cookie },
      body: type === 'application/json' && body ? JSON.stringify(body) : body,
    });
    return res;
  };
  const th = (await (await call('POST', '/themes', { name: 'Inspirações' })).json()).id;
  const ref = (await (await call('POST', '/refs', { theme_id: th, title: 'Vitrine', url: `${siteUrl}/pagina` })).json()).id;
  let s = await (await call('GET', '/state')).json();
  assert.equal(s.refs.find((r) => r.id === ref).preview_title, 'Livraria & Café');

  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]);
  assert.equal((await call('POST', `/refs/${ref}/images`, '<svg onload=alert(1)>', 'image/svg+xml')).status, 400);
  assert.equal((await call('POST', `/refs/${ref}/images`, Buffer.alloc(11 * 1024 * 1024), 'image/png')).status, 413);
  const up = await call('POST', `/refs/${ref}/images`, png, 'image/png');
  assert.equal(up.status, 201);
  const imgId = (await up.json()).id;
  s = await (await call('GET', '/state')).json();
  assert.deepEqual(s.refs.find((r) => r.id === ref).images, [imgId]);

  // reações: liga, desliga, recusa emoji fora da lista
  const react = (emoji) => call('POST', `/images/${imgId}/reactions`, { emoji });
  assert.deepEqual(await (await react('❤️')).json(), { on: true });
  await react('👍');
  assert.deepEqual(await (await react('👍')).json(), { on: false });
  assert.equal((await react('💩')).status, 400);
  assert.equal((await call('POST', '/images/99999/reactions', { emoji: '👍' })).status, 404);
  s = await (await call('GET', '/state')).json();
  assert.deepEqual(s.reactions, { [imgId]: { '❤️': [1] } });

  const got = await call('GET', `/images/${imgId}`);
  assert.equal(got.headers.get('content-type'), 'image/png');
  assert.deepEqual(Buffer.from(await got.arrayBuffer()), png);
  assert.equal((await fetch(`${base}/images/${imgId}`)).status, 401);

  assert.equal(fs.readdirSync(uploadDir).length, 1);
  assert.equal((await call('DELETE', `/refs/${ref}`)).status, 200);
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(fs.readdirSync(uploadDir).length, 0);
  assert.equal((await call('GET', `/images/${imgId}`)).status, 404);
  assert.deepEqual((await (await call('GET', '/state')).json()).reactions, {});
});

test('bloqueia após tentativas repetidas de login', async () => {
  const c = client();
  let last;
  for (let i = 0; i < 9; i++) last = await c('POST', '/login', { email: 'ninguem@example.com', password: 'x' });
  assert.equal(last.status, 429);
});

test('comentários, menções e permissão de exclusão', async () => {
  const ana = client();
  await ana('POST', '/login', { email: 'ana@example.com', password: cookieOf.password });
  await ana('POST', '/users', { name: 'Caio', email: 'caio@example.com', password: 'senha-do-caio-123' });
  const caioFull = (await ana('POST', '/users', { name: 'Caio Reis', email: 'caioreis@example.com', password: 'senha-do-caio-456' })).body.id;
  const caio = client();
  await caio('POST', '/login', { email: 'caioreis@example.com', password: 'senha-do-caio-456' });

  const cat = (await ana('POST', '/categories', { name: 'Obra' })).body.id;
  const task = (await ana('POST', '/tasks', { category_id: cat, title: 'Orçar estantes' })).body.id;
  assert.equal((await ana('POST', '/comments', { kind: 'task', id: 99999, body: 'x' })).status, 404);
  assert.equal((await ana('POST', '/comments', { kind: 'users', id: 1, body: 'x' })).status, 400);
  assert.equal((await ana('POST', '/comments', { kind: 'task', id: task, body: '  ' })).status, 400);

  // "@Caio Reis" menciona só o nome mais longo; "@Ana" (a própria autora) não gera menção
  const c1 = (await ana('POST', '/comments', { kind: 'task', id: task, body: 'Oi @caio reis, vê isso? cc @Ana email@caio.com' })).body.id;
  let s = (await caio('GET', '/state')).body;
  assert.deepEqual(s.mentions.map((m) => [m.comment_id, m.kind, m.target_id]), [[c1, 'task', task]]);
  assert.equal(s.tasks.find((t) => t.id === task).comments, 1);
  assert.equal((await ana('GET', '/state')).body.mentions.length, 0);
  const caioShort = client();
  await caioShort('POST', '/login', { email: 'caio@example.com', password: 'senha-do-caio-123' });
  assert.equal((await caioShort('GET', '/state')).body.mentions.length, 0);

  assert.equal((await caio('GET', `/comments?kind=task&id=${task}`)).body.length, 1);
  await caio('POST', '/comments/seen', { kind: 'task', id: task });
  assert.equal((await caio('GET', '/state')).body.mentions.length, 0);

  // só o autor ou admin exclui
  assert.equal((await caio('DELETE', `/comments/${c1}`)).status, 403);
  const c2 = (await caio('POST', '/comments', { kind: 'task', id: task, body: 'Vejo sim' })).body.id;
  assert.equal((await ana('DELETE', `/comments/${c2}`)).status, 200);

  // excluir a tarefa leva os comentários junto
  await ana('DELETE', `/tasks/${task}`);
  assert.equal((await ana('GET', `/comments?kind=task&id=${task}`)).status, 404);
  assert.equal(caioFull > 0, true);
});
