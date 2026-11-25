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
  const call = async (method, url, body, headers = { 'X-Requested-With': 'obsoleta' }) => {
    const res = await fetch(base + url, {
      method,
      headers: { 'Content-Type': 'application/json', cookie, ...headers },
      body: body ? JSON.stringify(body) : undefined,
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  call.cookie = () => cookie;
  return call;
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
    filesDir: `${uploadDir}-arquivos`,
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
  fs.rmSync(`${uploadDir}-arquivos`, { recursive: true, force: true });
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

  // reações em comentários
  assert.deepEqual((await caio('POST', `/comments/${c1}/reactions`, { emoji: '👍' })).body, { on: true });
  await ana('POST', `/comments/${c1}/reactions`, { emoji: '👍' });
  await ana('POST', `/comments/${c1}/reactions`, { emoji: '😂' });
  assert.deepEqual((await ana('POST', `/comments/${c1}/reactions`, { emoji: '😂' })).body, { on: false });
  assert.equal((await ana('POST', `/comments/${c1}/reactions`, { emoji: 'x' })).status, 400);
  assert.equal((await ana('POST', '/comments/99999/reactions', { emoji: '👍' })).status, 404);
  const listed = (await ana('GET', `/comments?kind=task&id=${task}`)).body;
  assert.deepEqual(Object.keys(listed[0].reactions), ['👍']);
  assert.equal(listed[0].reactions['👍'].length, 2);

  // só o autor ou admin exclui
  assert.equal((await caio('DELETE', `/comments/${c1}`)).status, 403);
  const c2 = (await caio('POST', '/comments', { kind: 'task', id: task, body: 'Vejo sim' })).body.id;
  assert.equal((await ana('DELETE', `/comments/${c2}`)).status, 200);

  // excluir a tarefa leva os comentários junto
  await ana('DELETE', `/tasks/${task}`);
  assert.equal((await ana('GET', `/comments?kind=task&id=${task}`)).status, 404);
  assert.equal(caioFull > 0, true);
});

test('passkeys: desafio é emitido e respostas inválidas são recusadas', async () => {
  const anon = client();
  const opt = await anon('POST', '/passkeys/login/options', {});
  assert.equal(opt.status, 200);
  assert.equal(opt.body.options.rpId, '127.0.0.1');
  assert.ok(opt.body.options.challenge.length > 20);
  const fake = { id: 'abc', rawId: 'abc', type: 'public-key', response: {} };
  assert.equal((await anon('POST', '/passkeys/login/verify', { flow: opt.body.flow, response: fake })).status, 401);
  // o desafio vale uma vez só
  assert.equal((await anon('POST', '/passkeys/login/verify', { flow: opt.body.flow, response: fake })).status, 400);
  assert.equal((await anon('POST', '/passkeys/register/options', {})).status, 401);

  const ana = client();
  await ana('POST', '/login', { email: 'ana@example.com', password: cookieOf.password });
  const reg = await ana('POST', '/passkeys/register/options', {});
  assert.equal(reg.body.options.user.name, 'ana@example.com');
  assert.equal((await ana('POST', '/passkeys/register/verify', { flow: reg.body.flow, response: fake })).status, 400);
  // um desafio de login não serve para cadastrar
  const other = await anon('POST', '/passkeys/login/options', {});
  assert.equal((await ana('POST', '/passkeys/register/verify', { flow: other.body.flow, response: fake })).status, 400);
  assert.deepEqual((await ana('GET', '/passkeys')).body, []);
});

test('arquivos: envio, download seguro, mover, excluir e backup', async () => {
  const cookie = await login();
  const call = (method, url, body, headers = {}) =>
    fetch(base + url, {
      method,
      headers: { 'X-Requested-With': 'obsoleta', cookie, ...(body && !headers['X-File-Name'] ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: body && !headers['X-File-Name'] ? JSON.stringify(body) : body,
    });
  const f1 = (await (await call('POST', '/folders', { name: 'Contratos' })).json()).id;
  const f2 = (await (await call('POST', '/folders', { name: 'Sócios' })).json()).id;

  const up = (name, body) => call('POST', `/folders/${f1}/files`, body, { 'X-File-Name': encodeURIComponent(name) });
  assert.equal((await up('vazio.txt', Buffer.alloc(0))).status, 400);
  assert.equal((await call('POST', `/folders/${f1}/files`, Buffer.from('x'), { 'X-File-Name': '%E0%A4%A' })).status, 400);
  const pdf = (await (await up('Contrato de aluguel – loja.pdf', Buffer.from('%PDF-1.4 teste'))).json()).id;
  const html = (await (await up('../../pagina.html', Buffer.from('<script>alert(1)</script>'))).json()).id;

  let s = await (await call('GET', '/state')).json();
  assert.deepEqual(s.files.map((f) => f.name).sort(), ['....pagina.html', 'Contrato de aluguel – loja.pdf']);

  // PDF abre no navegador; HTML nunca é servido como página
  const a = await call('GET', `/files/${pdf}`);
  assert.equal(a.headers.get('content-type'), 'application/pdf');
  assert.match(a.headers.get('content-disposition'), /^inline; .*filename\*=UTF-8''Contrato%20de%20aluguel/);
  assert.equal(await a.text(), '%PDF-1.4 teste');
  assert.match((await call('GET', `/files/${pdf}?download`)).headers.get('content-disposition'), /^attachment/);
  const h = await call('GET', `/files/${html}`);
  assert.equal(h.headers.get('content-type'), 'application/octet-stream');
  assert.match(h.headers.get('content-disposition'), /^attachment/);
  assert.equal((await fetch(`${base}/files/${pdf}`)).status, 401);

  // renomear e mover; pasta com arquivos não é excluída
  assert.equal((await call('PATCH', `/files/${pdf}`, { name: 'Aluguel.pdf', folder_id: f2 })).status, 200);
  s = await (await call('GET', '/state')).json();
  assert.deepEqual(s.files.find((f) => f.id === pdf), { ...s.files.find((f) => f.id === pdf), name: 'Aluguel.pdf', folder_id: f2 });
  assert.equal((await call('DELETE', `/folders/${f2}`)).status, 409);

  // backup: gzip com o banco e os arquivos
  const bk = await call('GET', '/backup');
  assert.equal(bk.status, 200);
  const tar = require('node:zlib').gunzipSync(Buffer.from(await bk.arrayBuffer()));
  const names = [];
  for (let off = 0; off + 512 <= tar.length; ) {
    const name = tar.toString('utf8', off, off + 100).replace(/\0.*$/, '');
    if (!name) break;
    const size = parseInt(tar.toString('ascii', off + 124, off + 135), 8);
    names.push(name);
    off += 512 + Math.ceil(size / 512) * 512;
  }
  assert.equal(names[0], 'obsoleta.db');
  assert.equal(names.filter((n) => n.startsWith('files/')).length, 2);
  assert.equal(tar.toString('latin1', 512, 528), 'SQLite format 3\0');

  assert.equal((await call('DELETE', `/files/${html}`)).status, 200);
  assert.equal((await call('GET', `/files/${html}`)).status, 404);
});

test('novidades: registra o que os outros fizeram e marca como visto', async () => {
  const ana = client();
  await ana('POST', '/login', { email: 'ana@example.com', password: cookieOf.password });
  await ana('POST', '/users', { name: 'Dora', email: 'dora@example.com', password: 'senha-da-dora-123' });
  const dora = client();
  await dora('POST', '/login', { email: 'dora@example.com', password: 'senha-da-dora-123' });
  // quem acabou de chegar começa sem pendências
  assert.equal((await dora('GET', '/state')).body.activity_unread, 0);
  await ana('POST', '/activity/seen', {});

  const cat = (await dora('POST', '/categories', { name: 'Marketing' })).body.id;
  const task = (await dora('POST', '/tasks', { category_id: cat, title: 'Criar logo' })).body.id;
  await dora('PATCH', `/tasks/${task}`, { status: 'done' });
  await dora('PATCH', `/tasks/${task}`, { before_id: null }); // só reordenar não gera novidade
  await dora('POST', '/comments', { kind: 'task', id: task, body: 'Ficou pronto' });
  const th = (await dora('POST', '/themes', { name: 'Marca' })).body.id;
  const ref = (await dora('POST', '/refs', { theme_id: th, title: 'Paleta' })).body.id;
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]);
  for (let i = 0; i < 3; i++) {
    await fetch(`${base}/refs/${ref}/images`, { method: 'POST', headers: { 'X-Requested-With': 'obsoleta', 'Content-Type': 'image/png', cookie: dora.cookie() }, body: png });
  }

  // a autora não é notificada das próprias ações
  assert.equal((await dora('GET', '/state')).body.activity_unread, 0);
  assert.equal((await ana('GET', '/state')).body.activity_unread, 7);
  const feed = (await ana('GET', '/activity')).body;
  assert.deepEqual(
    feed.slice(0, 7).map((a) => a.text),
    ['anexou imagens à referência', 'adicionou a referência', 'criou o tema', 'comentou em', 'concluiu a tarefa', 'criou a tarefa', 'criou a categoria']
  );
  assert.ok(feed.slice(0, 7).every((a) => a.unread));
  assert.equal(feed[3].detail, 'Ficou pronto');
  assert.equal(feed[3].target_id, task);

  await ana('POST', '/activity/seen', {});
  assert.equal((await ana('GET', '/state')).body.activity_unread, 0);
  assert.ok((await ana('GET', '/activity')).body.every((a) => !a.unread));
});

test('dependências entre tarefas: sem ciclos, e concluir avisa o que liberou', async () => {
  const ana = client();
  await ana('POST', '/login', { email: 'ana@example.com', password: cookieOf.password });
  const dora = client();
  await dora('POST', '/login', { email: 'dora@example.com', password: 'senha-da-dora-123' });
  await dora('POST', '/activity/seen', {});
  const cat = (await ana('POST', '/categories', { name: 'Abertura' })).body.id;
  const mk = async (title) => (await ana('POST', '/tasks', { category_id: cat, title })).body.id;
  const contrato = await mk('Contrato social');
  const cnpj = await mk('Abrir CNPJ');
  const conta = await mk('Abrir conta PJ');

  assert.equal((await ana('PATCH', `/tasks/${cnpj}`, { depends_on: [contrato] })).status, 200);
  assert.equal((await ana('PATCH', `/tasks/${conta}`, { depends_on: [cnpj] })).status, 200);
  assert.equal((await ana('PATCH', `/tasks/${cnpj}`, { depends_on: [cnpj] })).status, 400);
  assert.equal((await ana('PATCH', `/tasks/${cnpj}`, { depends_on: [99999] })).status, 400);
  // ciclo indireto: contrato -> conta -> cnpj -> contrato
  const cyc = await ana('PATCH', `/tasks/${contrato}`, { depends_on: [conta] });
  assert.equal(cyc.status, 400);
  assert.match(cyc.body.error, /circular/);

  const s = (await ana('GET', '/state')).body;
  assert.deepEqual(s.tasks.find((t) => t.id === cnpj).depends_on, [contrato]);
  assert.deepEqual(s.tasks.find((t) => t.id === contrato).depends_on, []);

  await ana('PATCH', `/tasks/${contrato}`, { status: 'done' });
  const feed = (await dora('GET', '/activity')).body;
  assert.equal(feed[0].text, 'concluiu a tarefa');
  assert.equal(feed[0].detail, 'Liberou: Abrir CNPJ');

  // excluir uma tarefa remove as dependências ligadas a ela
  await ana('DELETE', `/tasks/${cnpj}`);
  assert.deepEqual((await ana('GET', '/state')).body.tasks.find((t) => t.id === conta).depends_on, []);
});
