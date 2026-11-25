'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../server');

let server;
let base;

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

before(async () => {
  const app = createApp({
    dbPath: ':memory:',
    admin: { name: 'Ana', email: 'ana@example.com', password: 'senha-da-ana-123' },
  });
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}/api`;
});

after(() => server.close());

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
});

test('bloqueia após tentativas repetidas de login', async () => {
  const c = client();
  let last;
  for (let i = 0; i < 9; i++) last = await c('POST', '/login', { email: 'ninguem@example.com', password: 'x' });
  assert.equal(last.status, 429);
});
