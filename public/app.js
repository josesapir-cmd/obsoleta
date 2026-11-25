'use strict';

const STATUS = { todo: 'A fazer', doing: 'Em andamento', done: 'Concluída' };
const STATUS_NEXT = { todo: 'doing', doing: 'done', done: 'todo' };
const REACTIONS = ['👍', '❤️', '😂', '😮', '🤔', '👎'];
const COLORS = ['vinho', 'ambar', 'oliva', 'petroleo', 'azul', 'ameixa', 'grafite'];

const root = document.getElementById('app');
let me = null;
let state = null;
let stateJson = '';
let people = null; // lista completa, só para admin
let view = location.hash === '#referencias' ? 'refs' : 'tasks';
const filter = { who: 'all', hideDone: false };
let dragId = null;
let focusCat = null;
const openEmbeds = new Set(); // referências com a publicação do Instagram aberta
const IMAGE_TYPES = 'image/jpeg,image/png,image/webp,image/gif';

// ---------- utilidades ----------

function el(tag, attrs, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (k === 'class') n.className = v;
    else if (k in n && k !== 'list' && k !== 'form') n[k] = v;
    else n.setAttribute(k, v === true ? '' : v);
  }
  n.append(...kids.flat().filter((k) => k != null && k !== false));
  return n;
}

async function api(method, url, body) {
  const res = await fetch(`/api${url}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'obsoleta' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && url !== '/login') {
    me = null;
    state = null;
    render();
  }
  if (!res.ok) throw new Error(data.error || 'Algo deu errado. Tente de novo.');
  return data;
}

let toastTimer;
function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 4000);
}

// Executa uma ação rápida (sem diálogo) e atualiza a tela.
async function act(fn) {
  try {
    await fn();
  } catch (e) {
    toast(e.message);
  }
  await refresh(true);
}

const userById = (id) => state.users.find((u) => u.id === id);
const initials = (name) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .map((p) => p[0])
    .slice(0, 2)
    .join('')
    .toUpperCase();

function avatar(id) {
  const u = userById(id);
  if (!u) return null;
  return el('span', { class: `avatar av-${id % 6}${u.active ? '' : ' inactive'}`, title: u.name }, initials(u.name));
}

function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
const fmtDate = (iso) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}${iso.slice(0, 4) === today().slice(0, 4) ? '' : `/${iso.slice(2, 4)}`}`;

// ---------- diálogo de formulário ----------

function formDialog({ title, fields, submit = 'Salvar', onSubmit, onDelete, deleteLabel = 'Excluir' }) {
  const getters = {};
  const picked = [];
  let addFiles = null;
  const err = el('p', { class: 'form-error', role: 'alert' });

  const rows = fields.map((f) => {
    const id = `f-${f.name}`;
    let input;
    if (f.type === 'textarea') {
      input = el('textarea', { id, rows: 4, value: f.value || '' });
      getters[f.name] = () => input.value;
    } else if (f.type === 'select') {
      input = el(
        'select',
        { id },
        f.options.map(([v, label]) => el('option', { value: String(v), selected: v === f.value }, label))
      );
      getters[f.name] = () => (f.numeric ? Number(input.value) : input.value);
    } else if (f.type === 'checks' || f.type === 'swatch') {
      const multi = f.type === 'checks';
      const boxes = f.options.map(([v, label]) => {
        const box = el('input', {
          type: multi ? 'checkbox' : 'radio',
          name: id,
          value: String(v),
          checked: multi ? f.value.includes(v) : f.value === v,
        });
        return { v, box, node: el('label', { class: multi ? 'check' : `swatch c-${v}`, title: label }, box, multi ? label : el('span', { class: 'sr' }, label)) };
      });
      getters[f.name] = () => {
        const on = boxes.filter((b) => b.box.checked).map((b) => b.v);
        return multi ? on : on[0];
      };
      return el('fieldset', { class: 'field' }, el('legend', null, f.label), el('div', { class: multi ? 'checks' : 'swatches' }, boxes.map((b) => b.node)));
    } else if (f.type === 'files') {
      const info = el('p', { class: 'hint' }, f.hint);
      const show = () => {
        info.textContent = picked.length ? `${picked.length} imagem(ns) para enviar ao salvar.` : f.hint;
      };
      addFiles = (list) => {
        picked.push(...imagesOnly(list));
        show();
      };
      input = el('input', { id, type: 'file', accept: IMAGE_TYPES, multiple: true, onchange: () => { addFiles(input.files); input.value = ''; } });
      getters[f.name] = () => picked;
      return el('div', { class: 'field' }, el('label', { for: id }, f.label), input, info);
    } else if (f.type === 'checkbox') {
      input = el('input', { id, type: 'checkbox', checked: !!f.value });
      getters[f.name] = () => input.checked;
      return el('div', { class: 'field' }, el('label', { class: 'check' }, input, f.label));
    } else {
      input = el('input', {
        id,
        type: f.type || 'text',
        value: f.value || '',
        required: !!f.required,
        autocomplete: f.autocomplete || 'off',
        minLength: f.minLength,
        placeholder: f.placeholder,
      });
      getters[f.name] = () => input.value;
    }
    return el('div', { class: 'field' }, el('label', { for: id }, f.label), input, f.hint && el('p', { class: 'hint' }, f.hint));
  });

  const saveBtn = el('button', { class: 'btn primary', type: 'submit' }, submit);
  const dlg = el(
    'dialog',
    { class: 'modal' },
    el(
      'form',
      {
        onsubmit: async (e) => {
          e.preventDefault();
          err.textContent = '';
          saveBtn.disabled = true;
          try {
            const values = {};
            for (const k of Object.keys(getters)) values[k] = getters[k]();
            await onSubmit(values);
            dlg.close();
          } catch (ex) {
            err.textContent = ex.message;
            saveBtn.disabled = false;
          }
        },
      },
      el('h2', null, title),
      rows,
      err,
      el(
        'div',
        { class: 'modal-actions' },
        onDelete &&
          el(
            'button',
            {
              class: 'btn danger',
              type: 'button',
              onclick: async () => {
                if (!confirm(`${deleteLabel}? Não dá para desfazer.`)) return;
                try {
                  await onDelete();
                  dlg.close();
                } catch (ex) {
                  err.textContent = ex.message;
                }
              },
            },
            deleteLabel
          ),
        el('span', { class: 'spacer' }),
        el('button', { class: 'btn', type: 'button', onclick: () => dlg.close() }, 'Cancelar'),
        saveBtn
      )
    )
  );
  dlg.addEventListener('close', () => {
    dlg.remove();
    refresh(true);
  });
  if (addFiles) {
    dlg.addEventListener('dragover', (e) => hasFiles(e) && e.preventDefault());
    dlg.addEventListener('drop', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      addFiles(e.dataTransfer.files);
    });
  }
  document.body.append(dlg);
  dlg.showModal();
}

// ---------- imagens ----------

const hasFiles = (e) => e.dataTransfer && [...e.dataTransfer.types].includes('Files');
const imagesOnly = (list) => [...list].filter((f) => IMAGE_TYPES.split(',').includes(f.type));

// Reduz fotos grandes (celular) antes de enviar: no máximo 2000 px no maior lado.
async function shrink(file) {
  if (file.type === 'image/gif') return file;
  try {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, 2000 / Math.max(bmp.width, bmp.height));
    if (scale === 1 && file.size < 1.5e6) return file;
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * scale);
    c.height = Math.round(bmp.height * scale);
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.drawImage(bmp, 0, 0, c.width, c.height);
    const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.85));
    return blob || file;
  } catch {
    return file;
  }
}

async function uploadImages(refId, files) {
  let n = 0;
  for (const f of files) {
    n += 1;
    toast(`Enviando imagem ${n} de ${files.length}…`);
    const blob = await shrink(f);
    const res = await fetch(`/api/refs/${refId}/images`, {
      method: 'POST',
      headers: { 'Content-Type': blob.type || 'application/octet-stream', 'X-Requested-With': 'obsoleta' },
      body: blob,
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || 'Não foi possível enviar a imagem.');
    }
  }
  if (n) toast(n === 1 ? 'Imagem enviada.' : `${n} imagens enviadas.`);
}

function sendImages(refId, list) {
  const files = imagesOnly(list);
  if (!files.length) return toast('Só é possível anexar imagens JPEG, PNG, WebP ou GIF.');
  return act(() => uploadImages(refId, files));
}

// Visualizador das imagens de uma referência: setas na tela, setas do teclado e deslizar no celular.
function lightbox(ids, index) {
  let i = index;
  const img = el('img', { alt: 'Imagem anexada' });
  const counter = el('span', { class: 'hint', 'aria-live': 'polite' });
  const openLink = el('a', { class: 'btn', target: '_blank', rel: 'noopener' }, 'Abrir em nova aba');
  const many = ids.length > 1;
  const reactBar = el('div', { class: 'reactions', role: 'group', 'aria-label': 'Reações' });
  const drawReactions = () => {
    const mine = state.reactions[ids[i]] || {};
    // Redesenhar troca os botões; devolve o foco ao mesmo emoji para não perder o teclado.
    const focused = [...reactBar.children].indexOf(document.activeElement);
    reactBar.replaceChildren(
      ...REACTIONS.map((emoji) => {
        const who = mine[emoji] || [];
        const on = who.includes(me.id);
        return el(
          'button',
          {
            class: `react${on ? ' on' : ''}`,
            type: 'button',
            'aria-pressed': String(on),
            title: who.length ? who.map((id) => (userById(id) || {}).name).filter(Boolean).join(', ') : 'Reagir',
            onclick: async () => {
              const imageId = ids[i];
              try {
                await api('POST', `/images/${imageId}/reactions`, { emoji });
              } catch (e) {
                toast(e.message);
              }
              await refresh(true);
              if (ids[i] === imageId) drawReactions();
            },
          },
          emoji,
          who.length > 0 && el('span', null, String(who.length))
        );
      })
    );
    if (focused >= 0) reactBar.children[focused].focus();
  };
  const show = (n) => {
    i = (n + ids.length) % ids.length;
    drawReactions();
    img.src = `/api/images/${ids[i]}`;
    openLink.href = img.src;
    counter.textContent = many ? `${i + 1} de ${ids.length}` : '';
    if (many) new Image().src = `/api/images/${ids[(i + 1) % ids.length]}`; // adianta a próxima
  };
  const nav = (dir, label, glyph) =>
    many && el('button', { class: `nav ${dir < 0 ? 'prev' : 'next'}`, type: 'button', 'aria-label': label, title: label, onclick: () => show(i + dir) }, glyph);

  let touchX = null;
  const stage = el(
    'div',
    {
      class: 'stage',
      ontouchstart: (e) => {
        touchX = e.touches.length === 1 ? e.touches[0].clientX : null;
      },
      ontouchend: (e) => {
        if (touchX == null || !many) return;
        const dx = e.changedTouches[0].clientX - touchX;
        touchX = null;
        if (Math.abs(dx) > 40) show(i + (dx < 0 ? 1 : -1));
      },
    },
    nav(-1, 'Imagem anterior', '‹'),
    img,
    nav(1, 'Próxima imagem', '›')
  );

  const dlg = el(
    'dialog',
    { class: 'modal lightbox' },
    stage,
    reactBar,
    el(
      'div',
      { class: 'modal-actions' },
      el(
        'button',
        {
          class: 'btn danger',
          type: 'button',
          onclick: async () => {
            if (!confirm('Excluir imagem? Não dá para desfazer.')) return;
            try {
              await api('DELETE', `/images/${ids[i]}`);
            } catch (e) {
              toast(e.message);
            }
            dlg.close();
          },
        },
        'Excluir imagem'
      ),
      counter,
      el('span', { class: 'spacer' }),
      openLink,
      el('button', { class: 'btn primary', type: 'button', onclick: () => dlg.close() }, 'Fechar')
    )
  );
  // No documento, e não na janela: as setas funcionam onde quer que o foco esteja.
  const onKey = (e) => {
    if (!many || (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight')) return;
    e.preventDefault();
    show(i + (e.key === 'ArrowRight' ? 1 : -1));
  };
  document.addEventListener('keydown', onKey);
  dlg.addEventListener('close', () => {
    document.removeEventListener('keydown', onKey);
    dlg.remove();
    refresh(true);
  });
  show(i);
  document.body.append(dlg);
  dlg.showModal();
}

// ---------- texto com menções e links ----------

const WORD = /[\p{L}\p{N}_]/u;

function mentionRanges(text) {
  const users = [...state.users].sort((a, b) => b.name.length - a.name.length);
  const lower = text.toLowerCase();
  const out = [];
  for (let i = lower.indexOf('@'); i >= 0; i = lower.indexOf('@', i + 1)) {
    if (i > 0 && WORD.test(text[i - 1])) continue;
    const u = users.find((c) => lower.startsWith(c.name.toLowerCase(), i + 1) && !WORD.test(text[i + 1 + c.name.length] || ''));
    if (u) {
      out.push({ start: i, end: i + 1 + u.name.length, user: u });
      i += u.name.length;
    }
  }
  return out;
}

function linkify(text) {
  const out = [];
  let last = 0;
  for (const m of text.matchAll(/https?:\/\/[^\s<>"']+/g)) {
    const url = m[0].replace(/[.,;:!?)]+$/, '');
    out.push(text.slice(last, m.index), el('a', { href: url, target: '_blank', rel: 'noopener noreferrer' }, url));
    last = m.index + url.length;
  }
  out.push(text.slice(last));
  return out;
}

function richText(text) {
  const out = [];
  let last = 0;
  for (const r of mentionRanges(text)) {
    out.push(...linkify(text.slice(last, r.start)));
    out.push(el('span', { class: `mention${r.user.id === me.id ? ' me' : ''}` }, `@${r.user.name}`));
    last = r.end;
  }
  out.push(...linkify(text.slice(last)));
  return out;
}

const fmtWhen = (sql) =>
  new Date(`${sql.replace(' ', 'T')}Z`).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

// Sugestões de pessoas ao digitar "@" numa caixa de texto.
function mentionSuggest(textarea) {
  const box = el('ul', { class: 'suggest', hidden: true, role: 'listbox' });
  let items = [];
  let idx = 0;
  let start = -1;
  const pick = (u) => {
    const v = textarea.value;
    const head = `${v.slice(0, start)}@${u.name} `;
    textarea.value = head + v.slice(textarea.selectionStart);
    textarea.setSelectionRange(head.length, head.length);
    box.hidden = true;
    textarea.focus();
  };
  const draw = () => {
    box.replaceChildren(
      ...items.map((u, i) =>
        el(
          'li',
          {
            class: i === idx ? 'on' : '',
            role: 'option',
            'aria-selected': String(i === idx),
            onmousedown: (e) => {
              e.preventDefault();
              pick(u);
            },
          },
          avatar(u.id),
          u.name
        )
      )
    );
  };
  const update = () => {
    const before = textarea.value.slice(0, textarea.selectionStart);
    const m = /(^|[^\p{L}\p{N}_])@([\p{L}\p{N}_]*)$/u.exec(before);
    if (!m) {
      box.hidden = true;
      return;
    }
    start = before.length - m[2].length - 1;
    const query = m[2].toLowerCase();
    items = state.users.filter((u) => u.active && u.id !== me.id && u.name.toLowerCase().split(/\s+/).some((part) => part.startsWith(query)));
    idx = 0;
    box.hidden = items.length === 0;
    draw();
  };
  textarea.addEventListener('input', update);
  textarea.addEventListener('blur', () => {
    box.hidden = true;
  });
  textarea.addEventListener('keydown', (e) => {
    if (box.hidden) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      idx = (idx + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length;
      draw();
    } else if (e.key === 'Enter' || e.key === 'Tab') {
      pick(items[idx]);
    } else if (e.key === 'Escape') {
      box.hidden = true;
    } else {
      return;
    }
    e.preventDefault();
    e.stopImmediatePropagation();
  });
  return box;
}

// ---------- janela do item (leitura + comentários) ----------

function itemDialog({ kind, id, title, details, onEdit, actions }) {
  const list = el('ol', { class: 'thread' });
  let shown = '';
  const load = async () => {
    let comments;
    try {
      comments = await api('GET', `/comments?kind=${kind}&id=${id}`);
    } catch {
      return;
    }
    const json = JSON.stringify(comments);
    if (json === shown) return;
    shown = json;
    list.replaceChildren(
      ...(comments.length
        ? comments.map((c) => {
            const u = userById(c.user_id);
            return el(
              'li',
              { class: 'comment' },
              avatar(c.user_id),
              el(
                'div',
                null,
                el(
                  'p',
                  { class: 'comment-head' },
                  el('strong', null, u ? u.name : 'Alguém'),
                  el('span', { class: 'hint' }, fmtWhen(c.created_at)),
                  (c.user_id === me.id || me.is_admin) &&
                    el(
                      'button',
                      {
                        class: 'linklike',
                        type: 'button',
                        onclick: async () => {
                          if (!confirm('Excluir comentário?')) return;
                          await api('DELETE', `/comments/${c.id}`).catch((e) => toast(e.message));
                          load();
                        },
                      },
                      'excluir'
                    )
                ),
                el('p', { class: 'rich' }, richText(c.body))
              )
            );
          })
        : [el('li', { class: 'hint' }, 'Nenhum comentário ainda.')])
    );
    list.scrollTop = list.scrollHeight;
  };

  const err = el('p', { class: 'form-error', role: 'alert' });
  const input = el('textarea', { rows: 2, placeholder: 'Escreva um comentário. Use @ para marcar alguém.', 'aria-label': 'Novo comentário', maxLength: 5000 });
  const send = el('button', { class: 'btn primary', type: 'submit' }, 'Comentar');
  const suggest = mentionSuggest(input);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) send.click();
  });

  const dlg = el(
    'dialog',
    { class: 'modal item' },
    el(
      'header',
      { class: 'item-head' },
      el('h2', null, title),
      actions && actions(() => dlg.close()),
      el('button', { class: 'btn', type: 'button', onclick: () => { dlg.close(); onEdit(); } }, 'Editar'),
      el('button', { class: 'icon', type: 'button', 'aria-label': 'Fechar', title: 'Fechar', onclick: () => dlg.close() }, '✕')
    ),
    details,
    el('h3', null, 'Comentários'),
    list,
    el(
      'form',
      {
        class: 'composer',
        onsubmit: async (e) => {
          e.preventDefault();
          if (!input.value.trim()) return;
          err.textContent = '';
          send.disabled = true;
          try {
            await api('POST', '/comments', { kind, id, body: input.value });
            input.value = '';
            await load();
          } catch (ex) {
            err.textContent = ex.message;
          }
          send.disabled = false;
          input.focus();
        },
      },
      el('div', { class: 'composer-box' }, input, suggest),
      err,
      el('div', { class: 'modal-actions' }, el('span', { class: 'hint' }, 'Ctrl+Enter envia'), el('span', { class: 'spacer' }), send)
    )
  );
  const timer = setInterval(load, 20000);
  dlg.addEventListener('close', () => {
    clearInterval(timer);
    dlg.remove();
    refresh(true);
  });
  document.body.append(dlg);
  dlg.showModal();
  load();
  api('POST', '/comments/seen', { kind, id }).catch(() => {});
}

function taskView(t) {
  const cat = state.categories.find((c) => c.id === t.category_id);
  const overdue = t.due_date && t.status !== 'done' && t.due_date < today();
  itemDialog({
    kind: 'task',
    id: t.id,
    title: t.title,
    onEdit: () => taskDialog(t),
    actions: (close) =>
      el(
        'button',
        {
          class: `btn${t.status === 'done' ? '' : ' done'}`,
          type: 'button',
          onclick: async () => {
            try {
              await api('PATCH', `/tasks/${t.id}`, { status: t.status === 'done' ? 'todo' : 'done' });
            } catch (e) {
              toast(e.message);
            }
            close();
          },
        },
        t.status === 'done' ? 'Reabrir' : '✓ Concluir'
      ),
    details: el(
      'div',
      { class: 'details' },
      el(
        'p',
        { class: 'chips' },
        cat && el('span', { class: `chip c-${cat.color}` }, cat.name),
        el('span', { class: `pill s-${t.status}` }, STATUS[t.status]),
        t.due_date && el('span', { class: `due${overdue ? ' overdue' : ''}` }, `Prazo: ${fmtDate(t.due_date)}${overdue ? ' (atrasada)' : ''}`)
      ),
      el(
        'p',
        { class: 'chips' },
        t.assignees.length
          ? t.assignees.map((id) => userById(id) && el('span', { class: 'person' }, avatar(id), userById(id).name))
          : el('span', { class: 'hint' }, 'Sem responsável')
      ),
      t.description ? el('p', { class: 'rich' }, richText(t.description)) : el('p', { class: 'hint' }, 'Sem descrição.')
    ),
  });
}

function refView(r) {
  const safe = /^https?:\/\//i.test(r.url);
  const theme = state.themes.find((t) => t.id === r.theme_id);
  itemDialog({
    kind: 'ref',
    id: r.id,
    title: r.title,
    onEdit: () => refDialog(r),
    details: el(
      'div',
      { class: 'details' },
      theme && el('p', { class: 'hint' }, `Tema: ${theme.name}`),
      safe && el('p', { class: 'rich' }, el('a', { href: r.url, target: '_blank', rel: 'noopener noreferrer' }, r.url)),
      r.note && el('p', { class: 'rich' }, richText(r.note))
    ),
  });
}

function mentionsDialog() {
  const open = (m) => {
    const item = (m.kind === 'task' ? state.tasks : state.refs).find((x) => x.id === m.target_id);
    dlg.close();
    if (!item) return toast('Esse item não existe mais.');
    if (m.kind === 'task') taskView(item);
    else refView(item);
  };
  const dlg = el(
    'dialog',
    { class: 'modal item' },
    el(
      'header',
      { class: 'item-head' },
      el('h2', null, 'Menções a você'),
      el('button', { class: 'icon', type: 'button', 'aria-label': 'Fechar', title: 'Fechar', onclick: () => dlg.close() }, '✕')
    ),
    state.mentions.length === 0 && el('p', { class: 'hint' }, 'Nenhuma menção nova.'),
    el(
      'ul',
      { class: 'mention-list' },
      state.mentions.map((m) => {
        const item = (m.kind === 'task' ? state.tasks : state.refs).find((x) => x.id === m.target_id);
        const u = userById(m.user_id);
        return el(
          'li',
          null,
          el(
            'button',
            { type: 'button', onclick: () => open(m) },
            el('strong', null, `${u ? u.name : 'Alguém'} em “${item ? item.title : 'item excluído'}”`),
            el('span', { class: 'hint' }, ` · ${fmtWhen(m.created_at)}`),
            el('span', { class: 'excerpt' }, m.body.length > 160 ? `${m.body.slice(0, 160)}…` : m.body)
          )
        );
      })
    )
  );
  dlg.addEventListener('close', () => dlg.remove());
  document.body.append(dlg);
  dlg.showModal();
}

// ---------- dados ----------

async function refresh(force = false) {
  if (!me) return;
  if (!force) {
    const a = document.activeElement;
    const typing = a && root.contains(a) && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName) && a.value;
    if (document.querySelector('dialog[open]') || dragId != null || typing) return;
  }
  try {
    const [s, p] = await Promise.all([api('GET', '/state'), me.is_admin ? api('GET', '/users') : null]);
    const json = JSON.stringify([s, p]);
    if (json === stateJson && !force) return;
    stateJson = json;
    state = s;
    people = p;
    render();
  } catch (e) {
    if (me) toast(e.message);
  }
}

// ---------- tarefas ----------

function visibleTasks(categoryId) {
  return state.tasks.filter(
    (t) =>
      t.category_id === categoryId &&
      (!filter.hideDone || t.status !== 'done') &&
      (filter.who === 'all' || (filter.who === 'none' ? t.assignees.length === 0 : t.assignees.includes(Number(filter.who))))
  );
}

function taskDialog(task) {
  const activeOrAssigned = state.users.filter((u) => u.active || (task && task.assignees.includes(u.id)));
  formDialog({
    title: task.id ? 'Editar tarefa' : 'Nova tarefa',
    fields: [
      { name: 'title', label: 'Título', value: task.title, required: true },
      { name: 'description', label: 'Descrição', type: 'textarea', value: task.description },
      { name: 'category_id', label: 'Categoria', type: 'select', numeric: true, value: task.category_id, options: state.categories.map((c) => [c.id, c.name]) },
      { name: 'status', label: 'Situação', type: 'select', value: task.status, options: Object.entries(STATUS) },
      { name: 'due_date', label: 'Prazo', type: 'date', value: task.due_date },
      { name: 'assignees', label: 'Responsáveis', type: 'checks', value: task.assignees, options: activeOrAssigned.map((u) => [u.id, u.name]) },
    ],
    onSubmit: (v) => (task.id ? api('PATCH', `/tasks/${task.id}`, v) : api('POST', '/tasks', v)),
    onDelete: task.id ? () => api('DELETE', `/tasks/${task.id}`) : null,
    deleteLabel: 'Excluir tarefa',
  });
}

function categoryDialog(cat) {
  const n = state.categories.length + (cat ? 0 : 1);
  formDialog({
    title: cat ? 'Editar categoria' : 'Nova categoria',
    fields: [
      { name: 'name', label: 'Nome', value: cat && cat.name, required: true },
      { name: 'color', label: 'Cor', type: 'swatch', value: cat ? cat.color : COLORS[state.categories.length % COLORS.length], options: COLORS.map((c) => [c, c]) },
      {
        name: 'position',
        label: 'Posição no quadro',
        type: 'select',
        numeric: true,
        value: cat ? state.categories.indexOf(cat) : n - 1,
        options: Array.from({ length: n }, (_, i) => [i, `${i + 1}ª coluna`]),
      },
    ],
    onSubmit: async (v) => {
      if (cat) return api('PATCH', `/categories/${cat.id}`, v);
      const { id } = await api('POST', '/categories', { name: v.name });
      return api('PATCH', `/categories/${id}`, { color: v.color, position: v.position });
    },
    onDelete: cat ? () => api('DELETE', `/categories/${cat.id}`) : null,
    deleteLabel: 'Excluir categoria',
  });
}

function card(t) {
  const overdue = t.due_date && t.status !== 'done' && t.due_date < today();
  return el(
    'li',
    {
      class: `card s-${t.status}`,
      draggable: true,
      'data-id': t.id,
      ondragstart: (e) => {
        dragId = t.id;
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', String(t.id));
        e.currentTarget.classList.add('dragging');
      },
      ondragend: (e) => {
        dragId = null;
        e.currentTarget.classList.remove('dragging');
        clearDropMarks();
      },
    },
    el(
      'div',
      { class: 'card-top' },
      el(
        'button',
        {
          class: `check-btn${t.status === 'done' ? ' on' : ''}`,
          type: 'button',
          'aria-pressed': String(t.status === 'done'),
          'aria-label': t.status === 'done' ? `Reabrir tarefa ${t.title}` : `Concluir tarefa ${t.title}`,
          title: t.status === 'done' ? 'Reabrir tarefa' : 'Marcar como concluída',
          onclick: () => act(() => api('PATCH', `/tasks/${t.id}`, { status: t.status === 'done' ? 'todo' : 'done' })),
        },
        '✓'
      ),
      el('button', { class: 'card-title', type: 'button', onclick: () => taskView(t) }, t.title)
    ),
    el(
      'div',
      { class: 'card-meta' },
      el(
        'button',
        {
          class: `pill s-${t.status}`,
          type: 'button',
          title: 'Clique para avançar a situação',
          onclick: () => act(() => api('PATCH', `/tasks/${t.id}`, { status: STATUS_NEXT[t.status] })),
        },
        STATUS[t.status]
      ),
      t.due_date && el('span', { class: `due${overdue ? ' overdue' : ''}` }, overdue ? `Atrasada · ${fmtDate(t.due_date)}` : fmtDate(t.due_date)),
      t.comments > 0 && el('span', { class: 'due', title: 'Comentários' }, `💬 ${t.comments}`),
      el('span', { class: 'spacer' }),
      el('span', { class: 'avatars' }, t.assignees.map(avatar))
    )
  );
}

function clearDropMarks() {
  for (const n of document.querySelectorAll('.drop-before, .drop-end')) n.classList.remove('drop-before', 'drop-end');
}

function dropTarget(list, y) {
  for (const c of list.querySelectorAll('.card:not(.dragging)')) {
    const r = c.getBoundingClientRect();
    if (y < r.top + r.height / 2) return c;
  }
  return null;
}

function column(cat) {
  const tasks = visibleTasks(cat.id);
  const total = state.tasks.filter((t) => t.category_id === cat.id).length;
  const quick = el('input', {
    class: 'quick',
    placeholder: '+ Adicionar tarefa',
    'aria-label': `Adicionar tarefa em ${cat.name}`,
    maxLength: 200,
    onkeydown: (e) => {
      if (e.key !== 'Enter' || !quick.value.trim()) return;
      const title = quick.value;
      quick.value = '';
      focusCat = cat.id;
      const mine = filter.who !== 'all' && filter.who !== 'none' ? [Number(filter.who)] : [];
      act(() => api('POST', '/tasks', { category_id: cat.id, title, assignees: mine }));
    },
  });
  const list = el(
    'ul',
    {
      class: 'cards',
      ondragover: (e) => {
        if (dragId == null) return;
        e.preventDefault();
        clearDropMarks();
        const before = dropTarget(list, e.clientY);
        (before || list).classList.add(before ? 'drop-before' : 'drop-end');
      },
      ondrop: (e) => {
        if (dragId == null) return;
        e.preventDefault();
        const before = dropTarget(list, e.clientY);
        const id = dragId;
        dragId = null;
        act(() => api('PATCH', `/tasks/${id}`, { category_id: cat.id, before_id: before ? Number(before.dataset.id) : null }));
      },
    },
    tasks.map(card)
  );
  return el(
    'section',
    { class: `column c-${cat.color}`, 'data-cat': cat.id },
    el(
      'header',
      null,
      el('h2', null, cat.name),
      el('span', { class: 'count' }, tasks.length === total ? String(total) : `${tasks.length}/${total}`),
      el('button', { class: 'icon', type: 'button', title: 'Editar categoria', 'aria-label': `Editar categoria ${cat.name}`, onclick: () => categoryDialog(cat) }, '⋯')
    ),
    list,
    quick
  );
}

function tasksView() {
  const active = state.users.filter((u) => u.active);
  const who = el(
    'select',
    {
      'aria-label': 'Filtrar por responsável',
      onchange: () => {
        filter.who = who.value;
        render();
      },
    },
    el('option', { value: 'all' }, 'Todas as tarefas'),
    el('option', { value: String(me.id), selected: filter.who === String(me.id) }, 'Minhas tarefas'),
    active.filter((u) => u.id !== me.id).map((u) => el('option', { value: String(u.id), selected: filter.who === String(u.id) }, `De ${u.name}`)),
    el('option', { value: 'none', selected: filter.who === 'none' }, 'Sem responsável')
  );
  const hide = el('input', {
    type: 'checkbox',
    checked: filter.hideDone,
    onchange: () => {
      filter.hideDone = hide.checked;
      render();
    },
  });
  return el(
    'main',
    { class: 'tasks' },
    el('div', { class: 'toolbar' }, who, el('label', { class: 'check' }, hide, 'Ocultar concluídas')),
    el(
      'div',
      { class: 'board' },
      state.categories.map(column),
      el(
        'section',
        { class: 'column ghost' },
        el('button', { class: 'btn', type: 'button', onclick: () => categoryDialog(null) }, '+ Nova categoria'),
        state.categories.length === 0 &&
          el('p', { class: 'hint' }, 'Comece criando as categorias do quadro — por exemplo, as frentes de trabalho da abertura. Depois adicione tarefas em cada uma.')
      )
    )
  );
}

// ---------- referências ----------

function refDialog(ref) {
  formDialog({
    title: ref.id ? 'Editar referência' : 'Nova referência',
    fields: [
      { name: 'title', label: 'Título', value: ref.title, required: true },
      { name: 'url', label: 'Link (opcional)', value: ref.url, placeholder: 'https://' },
      { name: 'note', label: 'Anotação', type: 'textarea', value: ref.note },
      { name: 'theme_id', label: 'Tema', type: 'select', numeric: true, value: ref.theme_id, options: state.themes.map((t) => [t.id, t.name]) },
      { name: 'files', label: 'Anexar imagens', type: 'files', hint: 'Escolha arquivos ou arraste imagens para esta janela.' },
    ],
    onSubmit: async ({ files, ...v }) => {
      const id = ref.id || (await api('POST', '/refs', v)).id;
      if (ref.id) await api('PATCH', `/refs/${id}`, v);
      ref.id = id; // se o envio de imagem falhar, salvar de novo não duplica a referência
      await uploadImages(id, files.splice(0));
    },
    onDelete: ref.id ? () => api('DELETE', `/refs/${ref.id}`) : null,
    deleteLabel: 'Excluir referência',
  });
}

function themeDialog(theme) {
  const n = state.themes.length + (theme ? 0 : 1);
  formDialog({
    title: theme ? 'Editar tema' : 'Novo tema',
    fields: [
      { name: 'name', label: 'Nome', value: theme && theme.name, required: true },
      {
        name: 'position',
        label: 'Posição',
        type: 'select',
        numeric: true,
        value: theme ? state.themes.indexOf(theme) : n - 1,
        options: Array.from({ length: n }, (_, i) => [i, `${i + 1}º`]),
      },
    ],
    onSubmit: async (v) => {
      if (theme) return api('PATCH', `/themes/${theme.id}`, v);
      const { id } = await api('POST', '/themes', { name: v.name });
      return api('PATCH', `/themes/${id}`, { position: v.position });
    },
    onDelete: theme ? () => api('DELETE', `/themes/${theme.id}`) : null,
    deleteLabel: 'Excluir tema',
  });
}

function host(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

// Publicações, reels e vídeos públicos do Instagram têm visualização incorporada própria.
function instagramEmbed(url) {
  const m = /^https:\/\/(?:www\.)?instagram\.com\/(?:[\w.]+\/)?(p|reels?|tv)\/([\w-]+)/i.exec(url);
  if (!m) return null;
  const kind = m[1].toLowerCase().startsWith('reel') ? 'reel' : m[1].toLowerCase();
  return `https://www.instagram.com/${kind}/${m[2]}/embed/`;
}

function linkPreview(r) {
  const embed = instagramEmbed(r.url);
  if (embed) {
    const open = openEmbeds.has(r.id);
    return el(
      'div',
      { class: 'embed' },
      el(
        'button',
        {
          class: 'btn quiet',
          type: 'button',
          'aria-expanded': String(open),
          onclick: () => {
            if (open) openEmbeds.delete(r.id);
            else openEmbeds.add(r.id);
            render();
          },
        },
        open ? 'Ocultar publicação' : 'Ver publicação do Instagram'
      ),
      open && el('iframe', { src: embed, title: `Publicação do Instagram: ${r.title}`, loading: 'lazy', referrerPolicy: 'no-referrer' })
    );
  }
  if (!r.preview_title && !r.preview_desc && !r.preview_image) return null;
  const img =
    r.preview_image &&
    el('img', { src: r.preview_image, alt: '', loading: 'lazy', referrerPolicy: 'no-referrer', onerror: (e) => e.currentTarget.remove() });
  return el(
    'a',
    { class: 'preview', href: r.url, target: '_blank', rel: 'noopener noreferrer' },
    img,
    el(
      'span',
      { class: 'preview-text' },
      r.preview_title && r.preview_title !== r.title && el('strong', null, r.preview_title),
      r.preview_desc && el('span', null, r.preview_desc)
    )
  );
}

// Resumo das reações sobre a miniatura: os emojis usados e o total.
function reactionBadge(imageId) {
  const entries = Object.entries(state.reactions[imageId] || {});
  if (!entries.length) return null;
  const total = entries.reduce((n, [, who]) => n + who.length, 0);
  return el('span', { class: 'thumb-reactions' }, `${entries.map(([emoji]) => emoji).slice(0, 3).join('')} ${total}`);
}

function refItem(r) {
  const safe = /^https?:\/\//i.test(r.url);
  const by = userById(r.created_by);
  const picker = el('input', {
    type: 'file',
    accept: IMAGE_TYPES,
    multiple: true,
    hidden: true,
    onchange: () => sendImages(r.id, picker.files),
  });
  return el(
    'li',
    {
      class: 'ref',
      ondragover: (e) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        e.currentTarget.classList.add('drop-here');
      },
      ondragleave: (e) => {
        if (!e.currentTarget.contains(e.relatedTarget)) e.currentTarget.classList.remove('drop-here');
      },
      ondrop: (e) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        e.currentTarget.classList.remove('drop-here');
        sendImages(r.id, e.dataTransfer.files);
      },
    },
    el(
      'div',
      { class: 'ref-head' },
      safe ? el('a', { href: r.url, target: '_blank', rel: 'noopener noreferrer' }, r.title) : el('strong', null, r.title),
      el('button', { class: 'icon', type: 'button', title: 'Editar referência', 'aria-label': `Editar ${r.title}`, onclick: () => refDialog(r) }, '⋯')
    ),
    r.note && el('p', { class: 'note' }, r.note),
    safe && linkPreview(r),
    r.images.length > 0 &&
      el(
        'div',
        { class: 'thumbs' },
        r.images.map((id, n) =>
          el('button', { class: 'thumb', type: 'button', 'aria-label': 'Ampliar imagem', onclick: () => lightbox(r.images, n) }, el('img', { src: `/api/images/${id}`, alt: '', loading: 'lazy' }), reactionBadge(id))
        )
      ),
    el(
      'p',
      { class: 'hint ref-foot' },
      el('span', null, [safe && host(r.url), by && `por ${by.name}`].filter(Boolean).join(' · ')),
      el('span', { class: 'spacer' }),
      picker,
      el('button', { class: 'btn quiet small', type: 'button', onclick: () => refView(r) }, r.comments ? `💬 ${r.comments}` : 'Comentar'),
      el('button', { class: 'btn quiet small', type: 'button', onclick: () => picker.click() }, '+ Imagem')
    )
  );
}

function refsView() {
  return el(
    'main',
    { class: 'refs' },
    el('div', { class: 'toolbar' }, el('button', { class: 'btn', type: 'button', onclick: () => themeDialog(null) }, '+ Novo tema')),
    state.themes.length === 0 &&
      el('p', { class: 'hint empty' }, 'Nenhum tema ainda. Crie temas para agrupar links, documentos e anotações que o grupo precisa ter à mão.'),
    el(
      'div',
      { class: 'themes' },
      state.themes.map((t) => {
        const refs = state.refs.filter((r) => r.theme_id === t.id);
        return el(
          'section',
          { class: 'theme' },
          el(
            'header',
            null,
            el('h2', null, t.name),
            el('span', { class: 'count' }, String(refs.length)),
            el('button', { class: 'icon', type: 'button', title: 'Editar tema', 'aria-label': `Editar tema ${t.name}`, onclick: () => themeDialog(t) }, '⋯')
          ),
          el('ul', null, refs.map(refItem)),
          el('button', { class: 'btn quiet', type: 'button', onclick: () => refDialog({ theme_id: t.id }) }, '+ Adicionar referência')
        );
      })
    )
  );
}

// ---------- pessoas ----------

function personDialog(u) {
  const self = u && u.id === me.id;
  formDialog({
    title: u ? 'Editar pessoa' : 'Nova pessoa',
    fields: [
      { name: 'name', label: 'Nome', value: u && u.name, required: true },
      { name: 'email', label: 'E-mail', type: 'email', value: u && u.email, required: true },
      {
        name: 'password',
        label: u ? 'Nova senha (deixe vazio para manter)' : 'Senha inicial',
        type: 'password',
        required: !u,
        minLength: 10,
        autocomplete: 'new-password',
        hint: 'Mínimo de 10 caracteres. Passe por um canal seguro e peça para a pessoa trocar no primeiro acesso.',
      },
      !self && { name: 'is_admin', label: 'Pode gerenciar pessoas (admin)', type: 'checkbox', value: u && u.is_admin },
      u && !self && { name: 'active', label: 'Acesso ativo', type: 'checkbox', value: u.active },
    ].filter(Boolean),
    onSubmit: (v) => {
      if (!v.password) delete v.password;
      return u ? api('PATCH', `/users/${u.id}`, v) : api('POST', '/users', v);
    },
  });
}

function peopleView() {
  return el(
    'main',
    { class: 'people' },
    el('div', { class: 'toolbar' }, el('button', { class: 'btn', type: 'button', onclick: () => personDialog(null) }, '+ Nova pessoa')),
    el(
      'ul',
      { class: 'people-list' },
      (people || []).map((u) =>
        el(
          'li',
          { class: u.active ? '' : 'inactive' },
          avatar(u.id),
          el('div', null, el('strong', null, u.name), el('p', { class: 'hint' }, u.email)),
          el('span', { class: 'spacer' }),
          u.is_admin ? el('span', { class: 'tag' }, 'admin') : null,
          !u.active && el('span', { class: 'tag' }, 'sem acesso'),
          el('button', { class: 'btn quiet', type: 'button', onclick: () => personDialog(u) }, 'Editar')
        )
      )
    ),
    el('p', { class: 'hint' }, 'Não há cadastro público: só quem está nesta lista, com acesso ativo, consegue entrar. Desativar alguém encerra as sessões dessa pessoa na hora.')
  );
}

// ---------- casca ----------

function passwordDialog() {
  formDialog({
    title: 'Alterar senha',
    fields: [
      { name: 'current', label: 'Senha atual', type: 'password', required: true, autocomplete: 'current-password' },
      { name: 'next', label: 'Nova senha', type: 'password', required: true, minLength: 10, autocomplete: 'new-password', hint: 'Mínimo de 10 caracteres.' },
    ],
    onSubmit: async (v) => {
      await api('POST', '/me/password', v);
      toast('Senha alterada.');
    },
  });
}

function loginView() {
  const err = el('p', { class: 'form-error', role: 'alert' });
  const mail = el('input', { id: 'l-email', type: 'email', required: true, autocomplete: 'username' });
  const pw = el('input', { id: 'l-pw', type: 'password', required: true, autocomplete: 'current-password' });
  const btn = el('button', { class: 'btn primary', type: 'submit' }, 'Entrar');
  return el(
    'main',
    { class: 'login' },
    el(
      'form',
      {
        onsubmit: async (e) => {
          e.preventDefault();
          err.textContent = '';
          btn.disabled = true;
          try {
            me = await api('POST', '/login', { email: mail.value, password: pw.value });
            await refresh(true);
          } catch (ex) {
            err.textContent = ex.message;
            btn.disabled = false;
          }
        },
      },
      el('h1', { class: 'brand' }, 'Obsoleta'),
      el('p', { class: 'hint' }, 'Tarefas e referências dos sócios.'),
      el('div', { class: 'field' }, el('label', { for: 'l-email' }, 'E-mail'), mail),
      el('div', { class: 'field' }, el('label', { for: 'l-pw' }, 'Senha'), pw),
      err,
      btn
    )
  );
}

function render() {
  if (!me) {
    for (const d of document.querySelectorAll('dialog')) d.remove();
    root.replaceChildren(loginView());
    return;
  }
  if (!state) return;
  if (view === 'people' && !me.is_admin) view = 'tasks';
  const boardScroll = root.querySelector('.board');
  const scrollLeft = boardScroll ? boardScroll.scrollLeft : 0;

  const tab = (id, label, hash) =>
    el(
      'button',
      {
        class: `tab${view === id ? ' on' : ''}`,
        type: 'button',
        'aria-current': view === id ? 'page' : null,
        onclick: () => {
          view = id;
          history.replaceState(null, '', hash);
          render();
        },
      },
      label
    );

  root.replaceChildren(
    el(
      'header',
      { class: 'top' },
      el('span', { class: 'brand' }, 'Obsoleta'),
      el('nav', null, tab('tasks', 'Tarefas', '#tarefas'), tab('refs', 'Referências', '#referencias'), me.is_admin && tab('people', 'Pessoas', '#pessoas')),
      el('span', { class: 'spacer' }),
      el(
        'button',
        { class: `btn quiet${state.mentions.length ? ' alert' : ''}`, type: 'button', onclick: mentionsDialog },
        state.mentions.length ? `@ ${state.mentions.length} ${state.mentions.length === 1 ? 'menção' : 'menções'}` : '@'
      ),
      el('span', { class: 'who' }, me.name),
      el('button', { class: 'btn quiet', type: 'button', onclick: passwordDialog }, 'Senha'),
      el(
        'button',
        {
          class: 'btn quiet',
          type: 'button',
          onclick: async () => {
            await api('POST', '/logout').catch(() => {});
            me = null;
            state = null;
            stateJson = '';
            render();
          },
        },
        'Sair'
      )
    ),
    view === 'refs' ? refsView() : view === 'people' ? peopleView() : tasksView()
  );

  const board = root.querySelector('.board');
  if (board) board.scrollLeft = scrollLeft;
  if (focusCat != null) {
    const q = root.querySelector(`.column[data-cat="${focusCat}"] .quick`);
    if (q) q.focus();
    focusCat = null;
  }
}

// Soltar um arquivo fora de uma área de destino não deve fazer o navegador abrir o arquivo.
for (const type of ['dragover', 'drop']) {
  window.addEventListener(type, (e) => {
    if (hasFiles(e) && !e.defaultPrevented) e.preventDefault();
  });
}

(async function start() {
  try {
    me = await api('GET', '/me');
  } catch {
    me = null;
  }
  render();
  await refresh(true);
  setInterval(() => refresh(), 20000);
  window.addEventListener('focus', () => refresh());
})();
