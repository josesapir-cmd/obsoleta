'use strict';

const STATUS = { todo: 'A fazer', doing: 'Em andamento', done: 'Concluída' };
const REACTIONS = ['👍', '❤️', '😂', '😮', '🤔', '👎'];
const COLORS = ['vinho', 'ambar', 'oliva', 'petroleo', 'azul', 'ameixa', 'grafite'];

const root = document.getElementById('app');
let me = null;
let state = null;
let stateJson = '';
let people = null; // lista completa, só para admin
let view = { '#referencias': 'refs', '#arquivos': 'files', '#conta': 'ledger', '#cardapio': 'market', '#catalogo': 'books' }[location.hash] || 'tasks';
let market = null; // dados da aba Cardápio, carregados só quando ela é aberta
const marketUi = { tipo: 'todas', onlyA: true, selected: null, highlight: null, focus: null };
let showSettled = false;
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
    else if (k === 'style') for (const [prop, value] of Object.entries(v)) n.style.setProperty(prop, value);
    else if (k in n && k !== 'list' && k !== 'form') n[k] = v;
    else n.setAttribute(k, v === true ? '' : v);
  }
  n.append(...kids.flat().filter((k) => k != null && k !== false));
  return n;
}

// Ícone de traço fino (SVG), desenhado a partir de um ou mais caminhos numa grade 24×24.
function lineIcon(...paths) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  for (const [k, v] of Object.entries({ viewBox: '0 0 24 24', width: 20, height: 20, fill: 'none', stroke: 'currentColor', 'stroke-width': 1.5, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' })) {
    svg.setAttribute(k, v);
  }
  for (const d of paths) {
    const path = document.createElementNS(ns, 'path');
    path.setAttribute('d', d);
    svg.append(path);
  }
  return svg;
}

async function api(method, url, body) {
  const res = await fetch(`/api${url}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'obsoleta' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && !url.endsWith('/login') && !url.includes('/login/')) {
    me = null;
    state = null;
    render();
  }
  if (!res.ok) throw new Error(data.error || 'Algo deu errado. Tente de novo.');
  return data;
}

let toastTimer;
// Aviso no rodapé. Com `action` ({ label, run }), ganha um botão e fica mais tempo na tela.
function toast(msg, action) {
  const t = document.getElementById('toast');
  const hide = () => t.classList.remove('show', 'has-action');
  t.replaceChildren(
    msg,
    action
      ? el(
          'button',
          {
            type: 'button',
            onclick: () => {
              hide();
              action.run();
            },
          },
          action.label
        )
      : ''
  );
  t.classList.add('show');
  t.classList.toggle('has-action', !!action);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hide, action ? 8000 : 4000);
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
    } else if (f.type === 'picker') {
      // Escolha por busca: digita, aparecem sugestões, o escolhido vira uma etiqueta removível.
      const chosen = [...f.value];
      const label = (id) => (f.options.find(([v]) => v === id) || [])[1];
      const chips = el('div', { class: 'picked' });
      const box = el('ul', { class: 'suggest', hidden: true, role: 'listbox', id: `${id}-list` });
      let matches = [];
      let idx = 0;
      const drawChips = () => {
        chips.replaceChildren(
          ...chosen
            .filter((v) => label(v))
            .map((v) =>
              el(
                'span',
                { class: 'picked-item' },
                label(v),
                el(
                  'button',
                  {
                    type: 'button',
                    'aria-label': `Remover ${label(v)}`,
                    title: 'Remover',
                    onclick: () => {
                      chosen.splice(chosen.indexOf(v), 1);
                      dlg.dataset.dirty = '1';
                      drawChips();
                    },
                  },
                  '✕'
                )
              )
            )
        );
      };
      const pick = (v) => {
        chosen.push(v);
        input.value = '';
        box.hidden = true;
        drawChips();
        input.focus();
      };
      const drawBox = () => {
        box.replaceChildren(
          ...matches.map(([v, text], i) =>
            el(
              'li',
              {
                class: i === idx ? 'on' : '',
                role: 'option',
                'aria-selected': String(i === idx),
                onmousedown: (e) => {
                  e.preventDefault();
                  pick(v);
                },
              },
              text
            )
          )
        );
        const on = box.querySelector('.on');
        if (on) on.scrollIntoView({ block: 'nearest' });
      };
      const update = () => {
        const terms = fold(input.value).split(/\s+/).filter(Boolean);
        matches = terms.length ? f.options.filter(([v, text]) => !chosen.includes(v) && terms.every((t) => fold(text).includes(t))).slice(0, 8) : [];
        idx = 0;
        box.hidden = matches.length === 0;
        drawBox();
      };
      input = el('input', { id, type: 'text', placeholder: f.placeholder, autocomplete: 'off', role: 'combobox', 'aria-controls': `${id}-list`, 'aria-autocomplete': 'list' });
      input.addEventListener('input', update);
      input.addEventListener('blur', () => {
        box.hidden = true;
      });
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault(); // Enter aqui escolhe a sugestão; não salva o formulário
          if (!box.hidden) pick(matches[idx][0]);
        } else if (!box.hidden && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
          e.preventDefault();
          idx = (idx + (e.key === 'ArrowDown' ? 1 : matches.length - 1)) % matches.length;
          drawBox();
        } else if (!box.hidden && e.key === 'Escape') {
          e.preventDefault();
          box.hidden = true;
        }
      });
      drawChips();
      getters[f.name] = () => chosen.filter((v) => label(v));
      return el('div', { class: 'field' }, el('label', { for: id }, f.label), chips, el('div', { class: 'composer-box' }, input, box), f.hint && el('p', { class: 'hint' }, f.hint));
    } else if (f.type === 'files') {
      const info = el('p', { class: 'hint' }, f.hint);
      const show = () => {
        info.textContent = picked.length ? `${picked.length} ${f.any ? 'arquivo(s)' : 'imagem(ns)'} para enviar ao salvar.` : f.hint;
      };
      addFiles = (list) => {
        picked.push(...(f.any ? [...list] : imagesOnly(list)));
        show();
      };
      input = el('input', { id, type: 'file', accept: f.any ? null : IMAGE_TYPES, multiple: true, onchange: () => { addFiles(input.files); input.value = ''; } });
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
        inputMode: f.inputMode,
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
  let paletteFor = null; // comentário com a paleta de emojis aberta
  const load = async (keepScroll = false) => {
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
                el('p', { class: 'rich' }, richText(c.body)),
                commentReactions(c)
              )
            );
          })
        : [el('li', { class: 'hint' }, 'Nenhum comentário ainda.')])
    );
    if (keepScroll !== true) list.scrollTop = list.scrollHeight;
  };

  const react = async (commentId, emoji) => {
    paletteFor = null;
    await api('POST', `/comments/${commentId}/reactions`, { emoji }).catch((e) => toast(e.message));
    shown = '';
    load(true);
  };
  function commentReactions(c) {
    const chip = (emoji, who) => {
      const on = who.includes(me.id);
      return el(
        'button',
        {
          class: `react small${on ? ' on' : ''}`,
          type: 'button',
          'aria-pressed': String(on),
          title: who.map((id) => (userById(id) || {}).name).filter(Boolean).join(', ') || 'Reagir',
          onclick: () => react(c.id, emoji),
        },
        emoji,
        who.length > 0 && el('span', null, String(who.length))
      );
    };
    const open = paletteFor === c.id;
    return el(
      'div',
      { class: 'c-reactions' },
      open ? REACTIONS.map((emoji) => chip(emoji, c.reactions[emoji] || [])) : Object.entries(c.reactions).map(([emoji, who]) => chip(emoji, who)),
      el(
        'button',
        {
          class: 'react small add',
          type: 'button',
          'aria-label': open ? 'Fechar emojis' : 'Reagir a este comentário',
          title: open ? 'Fechar' : 'Reagir',
          'aria-expanded': String(open),
          onclick: () => {
            paletteFor = open ? null : c.id;
            shown = '';
            load(true);
          },
        },
        open ? '✕' : '☺+'
      )
    );
  }

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
    typeof details === 'function' ? details(() => dlg.close()) : details,
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
  const liveLoad = () => load(true);
  liveListeners.add(liveLoad);
  dlg.addEventListener('close', () => {
    clearInterval(timer);
    liveListeners.delete(liveLoad);
    dlg.remove();
    refresh(true);
  });
  document.body.append(dlg);
  dlg.showModal();
  load();
  api('POST', '/comments/seen', { kind, id }).catch(() => {});
}

function depList(label, tasks, close) {
  if (!tasks.length) return null;
  return el(
    'div',
    { class: 'deps' },
    el('h3', null, label),
    el(
      'ul',
      null,
      tasks.map((d) =>
        el(
          'li',
          null,
          el(
            'button',
            {
              type: 'button',
              class: d.status === 'done' ? 'done' : '',
              onclick: () => {
                close();
                taskView(d);
              },
            },
            el('span', { class: 'mark', 'aria-hidden': 'true' }, d.status === 'done' ? '✓' : '○'),
            el('span', { class: 'dep-title' }, d.title),
            el('span', { class: 'hint' }, STATUS[d.status])
          )
        )
      )
    )
  );
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
              if (!(await setStatus(t, t.status === 'done' ? 'todo' : 'done'))) return;
            } catch (e) {
              toast(e.message);
            }
            close();
          },
        },
        t.status === 'done' ? 'Reabrir' : '✓ Concluir'
      ),
    details: (close) => el(
      'div',
      { class: 'details' },
      el(
        'p',
        { class: 'chips' },
        cat && el('span', { class: `chip c-${cat.color}` }, cat.name),
        el('span', { class: `pill s-${t.status}` }, STATUS[t.status]),
        t.due_date && el('span', { class: `due${overdue ? ' overdue' : ''}` }, `Prazo: ${fmtDate(t.due_date)}${overdue ? ' (atrasada)' : ''}`),
        t.status !== 'done' && blockers(t).length > 0 && el('span', { class: 'blocked' }, '🔒 Bloqueada')
      ),
      el(
        'p',
        { class: 'chips' },
        t.assignees.length
          ? t.assignees.map((id) => userById(id) && el('span', { class: 'person' }, avatar(id), userById(id).name))
          : el('span', { class: 'hint' }, 'Sem responsável')
      ),
      t.description ? el('p', { class: 'rich' }, richText(t.description)) : el('p', { class: 'hint' }, 'Sem descrição.'),
      depList('Depende de', t.depends_on.map(taskById).filter(Boolean), close),
      depList('Libera ao ser concluída', dependents(t), close)
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
      r.note && el('p', { class: 'rich' }, richText(r.note)),
      r.images.length > 0 &&
        el(
          'div',
          { class: 'thumbs big' },
          r.images.map((id, n) =>
            el('button', { class: 'thumb', type: 'button', 'aria-label': 'Ampliar imagem', onclick: () => lightbox(r.images, n) }, el('img', { src: `/api/images/${id}`, alt: '', loading: 'lazy' }), reactionBadge(id))
          )
        )
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

// ---------- busca (Ctrl+K) ----------

const fold = (v) => (v || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

function searchLocal(query) {
  const terms = fold(query).split(/\s+/).filter(Boolean);
  if (!terms.length) return [];
  const has = (...fields) => {
    const hay = fold(fields.filter(Boolean).join('\n'));
    return terms.every((t) => hay.includes(t));
  };
  const name = (list, id) => (list.find((x) => x.id === id) || {}).name || '';
  const out = [];
  for (const t of state.tasks) {
    const cat = name(state.categories, t.category_id);
    const people = t.assignees.map((id) => (userById(id) || {}).name);
    const inTitle = has(t.title);
    if (!inTitle && !has(t.title, t.description, cat, ...people)) continue;
    out.push({ type: 'Tarefa', title: t.title, sub: [cat, STATUS[t.status], people.join(', ')].filter(Boolean).join(' · '), rank: inTitle ? 0 : 1, open: () => taskView(t) });
  }
  for (const r of state.refs) {
    const theme = name(state.themes, r.theme_id);
    const inTitle = has(r.title);
    if (!inTitle && !has(r.title, r.note, r.url, r.preview_title, r.preview_desc, theme)) continue;
    out.push({ type: 'Referência', title: r.title, sub: [theme, r.note.slice(0, 80)].filter(Boolean).join(' · '), rank: inTitle ? 0 : 1, open: () => refView(r) });
  }
  for (const e of state.expenses) {
    const payer = (userById(e.paid_by) || {}).name;
    const inTitle = has(e.description);
    if (!inTitle && !has(e.description, e.note, payer, ...e.files.map((f) => f.name))) continue;
    out.push({
      type: 'Gasto',
      title: e.description,
      sub: `${money(e.amount_cents)} · ${payer} · ${fmtDate(e.date)}`,
      rank: inTitle ? 0 : 1,
      open: () => {
        view = 'ledger';
        if (e.settled_at) showSettled = true;
        history.replaceState(null, '', '#conta');
        render();
      },
    });
  }
  for (const f of state.files) {
    const folder = name(state.folders, f.folder_id);
    const inTitle = has(f.name);
    if (!inTitle && !has(f.name, folder)) continue;
    out.push({ type: 'Arquivo', title: f.name, sub: `${folder} · ${fmtSize(f.size)}`, rank: inTitle ? 0 : 1, open: () => window.open(`/api/files/${f.id}`, '_blank', 'noopener') });
  }
  return out.sort((a, b) => a.rank - b.rank).slice(0, 30);
}

function spotlight() {
  if (!me || !state || document.querySelector('dialog.spotlight')) return;
  let results = [];
  let idx = 0;
  let seq = 0;
  let timer;
  const list = el('ul', { class: 'spot-results', role: 'listbox', id: 'spot-results' });
  const status = el('p', { class: 'hint spot-status' }, 'Busca em tarefas, referências, arquivos, gastos e comentários.');
  const input = el('input', {
    type: 'search',
    placeholder: 'Buscar…',
    'aria-label': 'Buscar',
    'aria-controls': 'spot-results',
    autocomplete: 'off',
    spellcheck: false,
  });
  const choose = (r) => {
    dlg.close();
    r.open();
  };
  const draw = () => {
    list.replaceChildren(
      ...results.map((r, i) =>
        el(
          'li',
          { role: 'option', 'aria-selected': String(i === idx), class: i === idx ? 'on' : '', onclick: () => choose(r), onmousemove: () => { if (idx !== i) { idx = i; draw(); } } },
          el('span', { class: 'spot-type' }, r.type),
          el('span', { class: 'spot-main' }, el('strong', null, r.title), r.sub && el('span', { class: 'hint' }, r.sub))
        )
      )
    );
    const on = list.querySelector('.on');
    if (on) on.scrollIntoView({ block: 'nearest' });
    status.hidden = results.length > 0;
    if (!results.length) status.textContent = input.value.trim() ? 'Nada encontrado.' : 'Busca em tarefas, referências, arquivos, gastos e comentários.';
  };
  const run = () => {
    const query = input.value;
    const local = searchLocal(query);
    results = local;
    idx = 0;
    draw();
    clearTimeout(timer);
    const mine = ++seq;
    if (query.trim().length < 2) return;
    timer = setTimeout(async () => {
      const comments = await api('GET', `/search?q=${encodeURIComponent(query)}`).catch(() => []);
      if (mine !== seq) return; // a pessoa já digitou outra coisa
      const extra = comments
        .map((c) => {
          const item = (c.kind === 'task' ? state.tasks : state.refs).find((x) => x.id === c.target_id);
          const u = userById(c.user_id);
          return item && { type: 'Comentário', title: c.body, sub: `${u ? u.name : 'Alguém'} em “${item.title}”`, open: () => (c.kind === 'task' ? taskView(item) : refView(item)) };
        })
        .filter(Boolean);
      results = [...local, ...extra];
      draw();
    }, 200);
  };
  input.addEventListener('input', run);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (results.length) idx = (idx + (e.key === 'ArrowDown' ? 1 : results.length - 1)) % results.length;
      draw();
    } else if (e.key === 'Enter') {
      if (results[idx]) choose(results[idx]);
    } else if (e.key === 'Escape') {
      dlg.close(); // sem isto, o primeiro Esc só limpa o campo
    } else {
      return;
    }
    e.preventDefault();
  });
  const dlg = el('dialog', { class: 'modal spotlight' }, el('div', { class: 'spot-input' }, lineIcon('M11 4a7 7 0 1 0 0 14a7 7 0 0 0 0-14z', 'M20 20l-4-4'), input), status, list);
  dlg.addEventListener('close', () => {
    clearTimeout(timer);
    seq += 1;
    dlg.remove();
  });
  document.body.append(dlg);
  dlg.showModal();
  input.focus();
}

document.addEventListener('keydown', (e) => {
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test((document.activeElement || {}).tagName || '');
  const shortcut = ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') || (e.key === '/' && !typing);
  if (!shortcut || e.altKey) return;
  if (document.querySelector('dialog[open]')) return;
  e.preventDefault();
  spotlight();
});

// ---------- novidades (sininho) ----------

function openActivityTarget(a) {
  const go = (v, hash) => {
    view = v;
    history.replaceState(null, '', hash);
    render();
  };
  if (a.target_id == null) return toast('Esse item foi excluído.');
  if (a.kind === 'tasks') {
    const t = state.tasks.find((x) => x.id === a.target_id);
    if (!t) return toast('Essa tarefa não existe mais.');
    go('tasks', '#tarefas');
    return taskView(t);
  }
  if (a.kind === 'refs') {
    const r = state.refs.find((x) => x.id === a.target_id);
    if (!r) return toast('Essa referência não existe mais.');
    go('refs', '#referencias');
    return refView(r);
  }
  if (a.kind === 'files' || a.kind === 'folders') return go('files', '#arquivos');
  if (a.kind === 'expenses') return go('ledger', '#conta');
  if (a.kind === 'books') {
    go('books', '#catalogo');
    return a.target_id ? bookDialog(a.target_id) : undefined;
  }
  if (a.kind === 'market') {
    go('market', '#cardapio');
    return refresh(true);
  }
  if (a.kind === 'themes') return go('refs', '#referencias');
  if (a.kind === 'categories') return go('tasks', '#tarefas');
  if (a.kind === 'users' && me.is_admin) return go('people', '#pessoas');
}

async function activityDialog() {
  let items;
  try {
    items = await api('GET', '/activity');
  } catch (e) {
    return toast(e.message);
  }
  const day = (sql) => {
    const d = new Date(`${sql.replace(' ', 'T')}Z`);
    const key = d.toDateString();
    if (key === new Date().toDateString()) return 'Hoje';
    if (key === new Date(Date.now() - 86400000).toDateString()) return 'Ontem';
    return d.toLocaleDateString('pt-BR', { day: '2-digit', month: 'long' });
  };
  const time = (sql) => new Date(`${sql.replace(' ', 'T')}Z`).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  const rows = [];
  let lastDay = null;
  for (const a of items) {
    const d = day(a.created_at);
    if (d !== lastDay) rows.push(el('li', { class: 'day' }, d));
    lastDay = d;
    const u = userById(a.user_id);
    rows.push(
      el(
        'li',
        null,
        el(
          'button',
          {
            class: a.unread ? 'unread' : '',
            type: 'button',
            onclick: () => {
              dlg.close();
              openActivityTarget(a);
            },
          },
          avatar(a.user_id),
          el(
            'span',
            { class: 'act-text' },
            el('strong', null, u ? u.name : 'Alguém'),
            ` ${a.text} `,
            el('em', null, a.title),
            a.detail && el('span', { class: 'excerpt' }, a.detail)
          ),
          el('span', { class: 'hint' }, time(a.created_at)),
          a.unread && el('span', { class: 'dot', title: 'Novo' }, el('span', { class: 'sr' }, 'novo'))
        )
      )
    );
  }
  const unread = items.filter((a) => a.unread).length;
  const dlg = el(
    'dialog',
    { class: 'modal item' },
    el(
      'header',
      { class: 'item-head' },
      el('h2', null, 'Novidades'),
      el('button', { class: 'icon', type: 'button', 'aria-label': 'Fechar', title: 'Fechar', onclick: () => dlg.close() }, '✕')
    ),
    el('p', { class: 'hint' }, items.length === 0 ? 'Nada por aqui ainda. O que os outros fizerem no sistema aparece nesta lista.' : unread ? `${unread} desde a sua última visita.` : 'Nada novo desde a sua última visita.'),
    el('ul', { class: 'activity' }, rows)
  );
  dlg.addEventListener('close', () => {
    dlg.remove();
    refresh(true);
  });
  document.body.append(dlg);
  dlg.showModal();
  if (items.length) api('POST', '/activity/seen', { id: items[0].id }).catch(() => {});
}

// ---------- dados ----------

// ---------- atualização ao vivo ----------

let live = null;
let liveVersion = null;
let wantReload = false;
const liveListeners = new Set(); // janelas abertas que também querem recarregar (conversas)

// Não mexe na tela enquanto a pessoa arrasta algo ou digita num campo da página.
function busy() {
  const a = document.activeElement;
  const typing = a && root.contains(a) && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName) && a.value;
  return dragId != null || !!typing;
}

// Depois de um deploy, recarrega a página sozinho — só quando não atrapalha, e uma vez por versão.
function maybeReload() {
  if (!wantReload || busy() || document.querySelector('dialog[open]')) return;
  try {
    if (sessionStorage.getItem('recarregou') === wantReload) return;
    sessionStorage.setItem('recarregou', wantReload);
  } catch {
    return;
  }
  location.reload();
}

function connectLive() {
  if (live || !me || !window.EventSource) return;
  const source = new EventSource('/api/events');
  live = source;
  source.addEventListener('hello', (e) => {
    if (liveVersion && e.data !== liveVersion) wantReload = e.data;
    liveVersion = liveVersion || e.data;
    maybeReload();
    refresh(); // pode ter perdido avisos enquanto estava desconectado
  });
  source.addEventListener('change', () => {
    refresh();
    for (const fn of liveListeners) fn();
  });
  source.onerror = () => {
    // Queda de rede: o navegador reconecta sozinho. Recusa do servidor (deploy, sessão): tentamos de novo.
    if (source.readyState !== EventSource.CLOSED) return;
    if (live === source) live = null;
    setTimeout(connectLive, 5000);
  };
}

function disconnectLive() {
  if (live) live.close();
  live = null;
}

async function refresh(force = false) {
  if (!me) return;
  connectLive();
  if (!force && busy()) return;
  try {
    const [s, p, m] = await Promise.all([api('GET', '/state'), me.is_admin ? api('GET', '/users') : null, view === 'market' ? api('GET', '/market') : null]);
    const json = JSON.stringify([s, p, m]);
    if (json === stateJson && !force) return;
    stateJson = json;
    state = s;
    people = p;
    if (m) market = m;
    render();
  } catch (e) {
    if (me) toast(e.message);
  }
}

// ---------- tarefas ----------

const taskById = (id) => state.tasks.find((t) => t.id === id);
// Dependências ainda não concluídas: enquanto houver alguma, a tarefa está bloqueada.
const blockers = (t) => t.depends_on.map(taskById).filter((d) => d && d.status !== 'done');
const dependents = (t) => state.tasks.filter((o) => o.depends_on.includes(t.id));

// Muda a situação; ao concluir uma tarefa bloqueada, avisa antes (não impede).
async function setStatus(t, next) {
  const open = blockers(t);
  if (next === 'done' && open.length) {
    const names = open.map((d) => `“${d.title}”`).join(', ');
    if (!confirm(`Esta tarefa depende de ${names}, que ainda não ${open.length > 1 ? 'foram concluídas' : 'foi concluída'}. Concluir mesmo assim?`)) return false;
  }
  await api('PATCH', `/tasks/${t.id}`, { status: next });
  return true;
}

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
      state.tasks.length > 1 && {
        name: 'depends_on',
        label: 'Depende de (precisa estar concluída antes)',
        type: 'picker',
        placeholder: 'Digite para buscar uma tarefa…',
        value: task.depends_on,
        options: state.categories.flatMap((c) =>
          state.tasks.filter((o) => o.category_id === c.id && o.id !== task.id).map((o) => [o.id, `${o.title} · ${c.name}${o.status === 'done' ? ' ✓' : ''}`])
        ),
      },
    ].filter(Boolean),
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
  const waiting = t.status === 'done' ? [] : blockers(t);
  const overdue = t.due_date && t.status !== 'done' && t.due_date < today();
  return el(
    'li',
    {
      class: `card s-${t.status}${waiting.length ? ' is-blocked' : ''}`,
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
          onclick: async () => {
            // Reabrir é raro e costuma ser engano: pede confirmação. Concluir é direto, com "Desfazer".
            if (t.status === 'done') {
              if (!confirm(`Reabrir a tarefa “${t.title}”? Ela volta para “A fazer”.`)) return;
              return act(() => setStatus(t, 'todo'));
            }
            const previous = t.status;
            let done = false;
            await act(async () => {
              done = await setStatus(t, 'done');
            });
            if (done) {
              toast(`Concluída: ${t.title}`, { label: 'Desfazer', run: () => act(() => api('PATCH', `/tasks/${t.id}`, { status: previous })) });
            }
          },
        },
        '✓'
      ),
      el('button', { class: 'card-title', type: 'button', onclick: () => taskView(t) }, t.title)
    ),
    waiting.length > 0 &&
      el('p', { class: 'blocked', title: waiting.map((d) => d.title).join(', ') }, `🔒 Depende de: ${waiting[0].title}${waiting.length > 1 ? ` e mais ${waiting.length - 1}` : ''}`),
    el(
      'div',
      { class: 'card-meta' },
      el(
        'button',
        {
          class: `pill s-${t.status}`,
          type: 'button',
          // A etiqueta só alterna entre "A fazer" e "Em andamento"; concluir e reabrir são pelo círculo.
          disabled: t.status === 'done',
          title: t.status === 'done' ? null : t.status === 'todo' ? 'Marcar como em andamento' : 'Voltar para a fazer',
          onclick: () => act(() => setStatus(t, t.status === 'todo' ? 'doing' : 'todo')),
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

// ---------- arquivos ----------

const MAX_FILE_BYTES = 50 * 1024 * 1024;

function fmtSize(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(1).replace('.', ',')} MB`;
}

function uploadFile(url, file, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/api${url}`);
    xhr.setRequestHeader('X-Requested-With', 'obsoleta');
    xhr.setRequestHeader('X-File-Name', encodeURIComponent(file.name));
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) return resolve();
      let msg = 'Não foi possível enviar o arquivo.';
      try {
        msg = JSON.parse(xhr.responseText).error || msg;
      } catch {}
      reject(new Error(msg));
    };
    xhr.onerror = () => reject(new Error('O envio falhou. Verifique a conexão e tente de novo.'));
    xhr.send(file);
  });
}

async function sendFiles(url, list) {
  const files = [...list];
  if (!files.length) return;
  dragId = -1; // segura a atualização automática da tela durante o envio
  try {
    let n = 0;
    for (const f of files) {
      n += 1;
      if (f.size > MAX_FILE_BYTES) throw new Error(`"${f.name}" passa do limite de 50 MB.`);
      if (!f.size) throw new Error(`"${f.name}" está vazio (ou é uma pasta — envie os arquivos de dentro dela).`);
      const label = files.length > 1 ? `Enviando ${n} de ${files.length}` : 'Enviando';
      toast(`${label}: ${f.name}…`);
      await uploadFile(url, f, (frac) => toast(`${label}: ${f.name} (${Math.round(frac * 100)}%)`));
    }
    toast(n === 1 ? 'Arquivo enviado.' : `${n} arquivos enviados.`);
  } catch (e) {
    toast(e.message);
  }
  dragId = null;
  await refresh(true);
}

function fileDialog(f) {
  formDialog({
    title: 'Editar arquivo',
    fields: [
      { name: 'name', label: 'Nome', value: f.name, required: true, hint: 'Mantenha a extensão (.pdf, .docx…) para o arquivo abrir corretamente.' },
      { name: 'folder_id', label: 'Pasta', type: 'select', numeric: true, value: f.folder_id, options: state.folders.map((d) => [d.id, d.name]) },
    ],
    onSubmit: (v) => api('PATCH', `/files/${f.id}`, v),
    onDelete: () => api('DELETE', `/files/${f.id}`),
    deleteLabel: 'Excluir arquivo',
  });
}

function folderDialog(folder) {
  const n = state.folders.length + (folder ? 0 : 1);
  formDialog({
    title: folder ? 'Editar pasta' : 'Nova pasta',
    fields: [
      { name: 'name', label: 'Nome', value: folder && folder.name, required: true },
      {
        name: 'position',
        label: 'Posição',
        type: 'select',
        numeric: true,
        value: folder ? state.folders.indexOf(folder) : n - 1,
        options: Array.from({ length: n }, (_, i) => [i, `${i + 1}ª`]),
      },
    ],
    onSubmit: async (v) => {
      if (folder) return api('PATCH', `/folders/${folder.id}`, v);
      const { id } = await api('POST', '/folders', { name: v.name });
      return api('PATCH', `/folders/${id}`, { position: v.position });
    },
    onDelete: folder ? () => api('DELETE', `/folders/${folder.id}`) : null,
    deleteLabel: 'Excluir pasta',
  });
}

function fileRow(f) {
  const ext = f.name.includes('.') ? f.name.split('.').pop().slice(0, 4).toUpperCase() : '—';
  const by = userById(f.uploaded_by);
  return el(
    'li',
    { class: 'file' },
    el('span', { class: 'ext', 'aria-hidden': 'true' }, ext),
    el(
      'div',
      { class: 'file-main' },
      el('a', { href: `/api/files/${f.id}`, target: '_blank', rel: 'noopener' }, f.name),
      el('p', { class: 'hint' }, [fmtSize(f.size), fmtWhen(f.created_at).slice(0, 5), by && `por ${by.name}`].filter(Boolean).join(' · '))
    ),
    el('a', { class: 'icon', href: `/api/files/${f.id}?download`, title: 'Baixar', 'aria-label': `Baixar ${f.name}` }, '↓'),
    el('button', { class: 'icon', type: 'button', title: 'Editar arquivo', 'aria-label': `Editar ${f.name}`, onclick: () => fileDialog(f) }, '⋯')
  );
}

function filesView() {
  return el(
    'main',
    { class: 'refs files' },
    el('div', { class: 'toolbar' }, el('button', { class: 'btn', type: 'button', onclick: () => folderDialog(null) }, '+ Nova pasta')),
    state.folders.length === 0 &&
      el('p', { class: 'hint empty' }, 'Nenhuma pasta ainda. Crie pastas para guardar contratos, documentos dos sócios e outros arquivos da livraria.'),
    el(
      'div',
      { class: 'themes' },
      state.folders.map((d) => {
        const files = state.files.filter((f) => f.folder_id === d.id);
        const picker = el('input', { type: 'file', multiple: true, hidden: true, onchange: () => sendFiles(`/folders/${d.id}/files`, picker.files) });
        return el(
          'section',
          {
            class: 'theme',
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
              sendFiles(`/folders/${d.id}/files`, e.dataTransfer.files);
            },
          },
          el(
            'header',
            null,
            el('h2', null, d.name),
            el('span', { class: 'count' }, String(files.length)),
            el('button', { class: 'icon', type: 'button', title: 'Editar pasta', 'aria-label': `Editar pasta ${d.name}`, onclick: () => folderDialog(d) }, '⋯')
          ),
          el('ul', null, files.map(fileRow)),
          picker,
          el('button', { class: 'btn quiet', type: 'button', onclick: () => picker.click() }, '+ Enviar arquivo')
        );
      })
    ),
    state.folders.length > 0 && el('p', { class: 'hint empty' }, 'No computador, arraste arquivos para cima de uma pasta. Limite de 50 MB por arquivo.')
  );
}

// ---------- conta corrente dos sócios ----------

const money = (cents) => (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

// Aceita "1.234,56", "1234,5", "1234.56", "R$ 80". Devolve centavos ou lança erro.
function parseMoney(input) {
  let v = String(input).trim().replace(/^R\$\s*/i, '').replace(/\s/g, '');
  if (/^\d{1,3}(\.\d{3})+(,\d{1,2})?$/.test(v) || /^\d+,\d{1,2}$/.test(v)) v = v.replace(/\./g, '').replace(',', '.');
  if (!/^\d+(\.\d{1,2})?$/.test(v)) throw new Error('Valor inválido. Use o formato 1.234,56.');
  const cents = Math.round(parseFloat(v) * 100);
  if (cents <= 0) throw new Error('O valor precisa ser maior que zero.');
  return cents;
}

const canEditExpense = (e) => me.is_admin || (!e.settled_at && (e.created_by === me.id || e.paid_by === me.id));

function expenseDialog(e) {
  const people = state.users.filter((u) => u.active || (e && e.paid_by === u.id));
  formDialog({
    title: e ? 'Editar gasto' : 'Lançar gasto',
    fields: [
      { name: 'description', label: 'O que foi', value: e && e.description, required: true, placeholder: 'Ex.: taxa da junta comercial' },
      { name: 'amount', label: 'Valor (R$)', value: e ? (e.amount_cents / 100).toLocaleString('pt-BR', { minimumFractionDigits: 2 }) : '', required: true, placeholder: '0,00', inputMode: 'decimal' },
      { name: 'date', label: 'Data do gasto', type: 'date', value: e ? e.date : today(), required: true },
      { name: 'paid_by', label: 'Quem pagou', type: 'select', numeric: true, value: e ? e.paid_by : me.id, options: people.map((u) => [u.id, u.name]) },
      { name: 'note', label: 'Observação', type: 'textarea', value: e && e.note },
      { name: 'files', label: 'Comprovantes', type: 'files', any: true, hint: 'Nota, recibo, comprovante de pagamento. Escolha arquivos ou arraste para esta janela.' },
      e && me.is_admin && { name: 'settled', label: 'Já acertado', type: 'checkbox', value: !!e.settled_at },
    ].filter(Boolean),
    onSubmit: async ({ files, amount, ...v }) => {
      v.amount_cents = parseMoney(amount);
      const id = e ? e.id : (await api('POST', '/expenses', v)).id;
      if (e) await api('PATCH', `/expenses/${id}`, v);
      e = e || { id }; // se o anexo falhar, salvar de novo não duplica o lançamento
      for (const f of files.splice(0)) {
        if (f.size > MAX_FILE_BYTES) throw new Error(`"${f.name}" passa do limite de 50 MB.`);
        await uploadFile(`/expenses/${id}/files`, f, (frac) => toast(`Enviando ${f.name} (${Math.round(frac * 100)}%)`));
      }
    },
    onDelete: e ? () => api('DELETE', `/expenses/${e.id}`) : null,
    deleteLabel: 'Excluir gasto',
  });
}

function exportExpenses(list) {
  const cell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const rows = [['Data', 'Descrição', 'Valor', 'Quem pagou', 'Observação', 'Situação', 'Anexos']];
  for (const e of [...list].reverse()) {
    rows.push([
      e.date.split('-').reverse().join('/'),
      e.description,
      (e.amount_cents / 100).toFixed(2).replace('.', ','),
      (userById(e.paid_by) || {}).name,
      e.note,
      e.settled_at ? 'Acertado' : 'Em aberto',
      e.files.length,
    ]);
  }
  const csv = `\ufeff${rows.map((r) => r.map(cell).join(';')).join('\r\n')}`;
  const a = el('a', { href: URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' })), download: `conta-corrente-${today()}.csv` });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function expenseRow(e) {
  const payer = userById(e.paid_by);
  const editable = canEditExpense(e);
  const picker = el('input', { type: 'file', multiple: true, hidden: true, onchange: () => sendFiles(`/expenses/${e.id}/files`, picker.files) });
  return el(
    'li',
    {
      class: `expense${e.settled_at ? ' settled' : ''}`,
      ondragover: (ev) => {
        if (!editable || !hasFiles(ev)) return;
        ev.preventDefault();
        ev.currentTarget.classList.add('drop-here');
      },
      ondragleave: (ev) => {
        if (!ev.currentTarget.contains(ev.relatedTarget)) ev.currentTarget.classList.remove('drop-here');
      },
      ondrop: (ev) => {
        if (!editable || !hasFiles(ev)) return;
        ev.preventDefault();
        ev.currentTarget.classList.remove('drop-here');
        sendFiles(`/expenses/${e.id}/files`, ev.dataTransfer.files);
      },
    },
    el('span', { class: 'exp-date' }, fmtDate(e.date)),
    el(
      'div',
      { class: 'exp-main' },
      el('strong', null, e.description),
      e.note && el('p', { class: 'note' }, e.note),
      el(
        'p',
        { class: 'exp-meta hint' },
        payer && el('span', { class: 'person' }, avatar(e.paid_by), payer.name),
        e.settled_at && el('span', { class: 'tag' }, 'acertado'),
        e.files.map((f) =>
          el(
            'span',
            { class: 'attach' },
            el('a', { href: `/api/expense-files/${f.id}`, target: '_blank', rel: 'noopener', title: fmtSize(f.size) }, `📎 ${f.name}`),
            editable &&
              el(
                'button',
                {
                  class: 'linklike',
                  type: 'button',
                  'aria-label': `Remover anexo ${f.name}`,
                  title: 'Remover anexo',
                  onclick: () => confirm(`Remover o anexo "${f.name}"?`) && act(() => api('DELETE', `/expense-files/${f.id}`)),
                },
                '✕'
              )
          )
        ),
        editable && picker,
        editable && el('button', { class: 'btn quiet small', type: 'button', onclick: () => picker.click() }, '+ Anexo')
      )
    ),
    el('span', { class: 'exp-amount' }, money(e.amount_cents)),
    editable
      ? el('button', { class: 'icon', type: 'button', title: 'Editar gasto', 'aria-label': `Editar gasto ${e.description}`, onclick: () => expenseDialog(e) }, '⋯')
      : el('span', { class: 'icon', 'aria-hidden': 'true' })
  );
}

function ledgerView() {
  const open = state.expenses.filter((e) => !e.settled_at);
  const shown = showSettled ? state.expenses : open;
  const total = open.reduce((n, e) => n + e.amount_cents, 0);
  const byPerson = state.users
    .map((u) => ({ u, sum: open.filter((e) => e.paid_by === u.id).reduce((n, e) => n + e.amount_cents, 0) }))
    .filter((x) => x.u.active || x.sum > 0);
  const settledCount = state.expenses.length - open.length;
  const toggle = el('input', {
    type: 'checkbox',
    checked: showSettled,
    onchange: () => {
      showSettled = toggle.checked;
      render();
    },
  });
  return el(
    'main',
    { class: 'ledger' },
    el(
      'div',
      { class: 'toolbar' },
      el('button', { class: 'btn primary', type: 'button', onclick: () => expenseDialog(null) }, '+ Lançar gasto'),
      settledCount > 0 && el('label', { class: 'check' }, toggle, `Mostrar acertados (${settledCount})`),
      el('span', { class: 'spacer' }),
      state.expenses.length > 0 && el('button', { class: 'btn', type: 'button', onclick: () => exportExpenses(shown) }, 'Exportar planilha'),
      me.is_admin &&
        open.length > 0 &&
        el(
          'button',
          {
            class: 'btn',
            type: 'button',
            onclick: () => {
              if (!confirm(`Fechar o acerto de ${open.length} gasto(s), total de ${money(total)}?\n\nEles passam a constar como acertados e os saldos voltam a zero. Dá para reabrir um gasto depois, um por um.`)) return;
              act(() => api('POST', '/expenses/settle', {}));
            },
          },
          'Fechar acerto'
        )
    ),
    el(
      'section',
      { class: 'balances', 'aria-label': 'Gastos em aberto por pessoa' },
      byPerson.map(({ u, sum }) =>
        el(
          'div',
          { class: 'balance' },
          el('span', { class: 'person' }, avatar(u.id), u.name),
          el('strong', null, money(sum)),
          el('span', { class: 'hint' }, total ? `${Math.round((sum / total) * 100)}% do total` : 'nada em aberto')
        )
      ),
      el('div', { class: 'balance total' }, el('span', null, 'Total em aberto'), el('strong', null, money(total)), el('span', { class: 'hint' }, `${open.length} gasto(s)`))
    ),
    shown.length === 0
      ? el('p', { class: 'hint empty' }, 'Nenhum gasto em aberto. Lance aqui o que cada sócio pagou do próprio bolso nesta fase, com o comprovante, para o acerto na hora dos aportes.')
      : el('ul', { class: 'expenses' }, shown.map(expenseRow))
  );
}

// ---------- cardápio: nosso rascunho contra os preços da região ----------

const HOUSE_TYPE = { cafe: 'café especial', padaria: 'padaria artesanal', brunch: 'café-restaurante', livraria: 'livraria com café' };
const reais = (c) => (c / 100).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const monthLabel = (ym) => (ym ? `${ym.slice(5)}/${ym.slice(0, 4)}` : 'sem data');

function quantile(sorted, q) {
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

const marketHouse = (id) => market.houses.find((h) => h.id === id);
const marketVisible = (anchor) =>
  (market.points[anchor] || []).filter((p) => {
    const h = marketHouse(p.house);
    return h && (marketUi.tipo === 'todas' || h.tipo === marketUi.tipo) && (!marketUi.onlyA || p.q === 'A');
  });

// Eixo de preço de uma seção: cobre todos os preços (e os nossos), com marcas em números redondos.
function marketAxis(section) {
  const values = section.items.flatMap((a) => [...(market.points[a] || []).map((p) => p.cents), (market.draft[a] || {}).price_cents].filter(Boolean));
  if (!values.length) return { min: 0, max: 2000, ticks: [0, 500, 1000, 1500, 2000] };
  const step = [200, 400, 500, 800, 1000, 2000, 5000].find((st) => (Math.max(...values) - Math.min(...values)) / st <= 7) || 10000;
  const min = Math.max(0, Math.floor(Math.min(...values) / step) * step - (Math.min(...values) % step === 0 ? step : 0));
  const max = Math.ceil(Math.max(...values) / step) * step + (Math.max(...values) % step === 0 ? step : 0);
  const ticks = [];
  for (let v = min; v <= max; v += step) ticks.push(v);
  return { min, max, ticks };
}

function saveDraft(anchor, change) {
  return act(() => api('PATCH', '/market/draft', { anchor, ...change }));
}

function houseDialog(h) {
  formDialog({
    title: h.name,
    fields: [
      { name: 'tipo', label: 'Tipo de casa', type: 'select', value: h.tipo, options: Object.entries(HOUSE_TYPE).map(([v, label]) => [v, label[0].toUpperCase() + label.slice(1)]) },
      { name: 'instagram', label: 'Instagram', value: h.instagram ? h.instagram.replace(/^https:\/\/www\.instagram\.com\//, '@').replace(/\/$/, '') : '', placeholder: '@perfil' },
      { name: 'is_ref', label: 'É uma referência nossa (já abre em destaque)', type: 'checkbox', value: !!h.is_ref },
    ],
    onSubmit: async (v) => {
      await api('PATCH', `/market/houses/${h.id}`, v);
      if (v.is_ref) marketUi.highlight.add(h.id);
      else if (h.is_ref) marketUi.highlight.delete(h.id);
    },
    onDelete: () => api('DELETE', `/market/houses/${h.id}`),
    deleteLabel: 'Remover casa da pesquisa',
  });
}

// Ficha da casa clicada: dados do Google e os links para ver avaliações, fotos e o Instagram.
function marketHouseCard(h) {
  const facts = [
    HOUSE_TYPE[h.tipo],
    h.distance_km != null && `a ${String(h.distance_km).replace('.', ',')} km`,
    h.rating != null && `nota ${String(h.rating).replace('.', ',')}${h.reviews ? ` em ${h.reviews.toLocaleString('pt-BR')} avaliações` : ''}`,
    h.price_range && `faixa ${h.price_range}`,
    `${h.items} itens de cardápio`,
  ].filter(Boolean);
  return el(
    'div',
    { class: 'mk-card' },
    el('div', null, el('strong', null, h.name), el('p', { class: 'hint' }, facts.join(' · ')), h.address && el('p', { class: 'hint' }, h.address)),
    el(
      'div',
      { class: 'mk-card-links' },
      h.maps_url && el('a', { class: 'btn', href: h.maps_url, target: '_blank', rel: 'noopener noreferrer' }, 'Google: avaliações e fotos'),
      h.instagram
        ? el('a', { class: 'btn', href: h.instagram, target: '_blank', rel: 'noopener noreferrer' }, 'Instagram')
        : el('button', { class: 'btn quiet', type: 'button', onclick: () => houseDialog(h) }, '+ Adicionar Instagram'),
      el('button', { class: 'icon', type: 'button', title: 'Editar casa', 'aria-label': `Editar ${h.name}`, onclick: () => houseDialog(h) }, '⋯')
    )
  );
}

function marketImportButton(primary) {
  const picker = el('input', {
    type: 'file',
    accept: '.csv,text/csv',
    hidden: true,
    onchange: async () => {
      const file = picker.files[0];
      picker.value = '';
      if (!file) return;
      toast('Importando planilha…');
      try {
        const res = await fetch('/api/market/import', { method: 'POST', headers: { 'Content-Type': 'text/csv', 'X-Requested-With': 'obsoleta' }, body: await file.text() });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || 'Não foi possível importar a planilha.');
        toast(`Importado: ${data.houses} casa(s), ${data.items} itens, ${data.anchors} comparáveis.`);
      } catch (e) {
        toast(e.message);
      }
      refresh(true);
    },
  });
  return el('span', null, picker, el('button', { class: `btn${primary ? ' primary' : ''}`, type: 'button', onclick: () => picker.click() }, 'Importar planilha'));
}

function marketRow(anchor, axis, houseCount) {
  const points = marketVisible(anchor);
  const prices = points.map((p) => p.cents);
  const n = prices.length;
  const median = n ? quantile(prices, 0.5) : null;
  const draft = market.draft[anchor] || { included: false, price_cents: null };
  const selected = marketUi.selected === anchor;
  const pct = (c) => `${Math.max(0, Math.min(100, ((c - axis.min) / (axis.max - axis.min)) * 100))}%`;
  const select = () => {
    marketUi.selected = anchor;
    render();
  };

  // Pontos de preço igual ou muito próximo são empilhados para nenhum esconder o outro.
  const near = (axis.max - axis.min) * (12 / 300);
  const levels = [];
  const tip = el('div', { class: 'mk-tip', role: 'status', hidden: true });
  const shows = [];
  const dots = points.map((p) => {
    let level = 0;
    while (levels[level] !== undefined && p.cents - levels[level] < near) level += 1;
    levels[level] = p.cents;
    const h = marketHouse(p.house);
    const show = () => {
      const left = parseFloat(pct(p.cents));
      tip.replaceChildren(
        el('strong', null, `R$ ${reais(p.cents)}`),
        el('span', null, h.distance_km == null ? h.name : `${h.name} · a ${String(h.distance_km).replace('.', ',')} km`),
        el('span', { class: 'mk-tip-item' }, `${p.label} · foto de ${monthLabel(p.month)}`)
      );
      tip.style.setProperty('left', `${left}%`);
      tip.style.setProperty('transform', `translateX(${left > 70 ? '-100%' : left < 30 ? '0' : '-50%'})`);
      tip.hidden = false;
    };
    shows.push(show);
    // O mouse é tratado na faixa inteira (ponto mais próximo); o botão existe para teclado e leitor de tela.
    return el(
      'button',
      {
        class: `mk-dot${marketUi.highlight.has(h.id) ? ' mk-ref' : ''}${p.q === 'A' ? '' : ' weak'}`,
        type: 'button',
        'aria-label': `${h.name}: R$ ${reais(p.cents)}`,
        style: { left: pct(p.cents), bottom: `${3 + Math.min(level, 5) * 11}px` },
        onfocus: show,
        onblur: () => {
          tip.hidden = true;
        },
        onclick: select,
      },
      el('span', { 'aria-hidden': 'true' })
    );
  });
  // Pontos vizinhos ficam a poucos pixels: em vez de exigir mira, vale o mais próximo do cursor.
  let hot = -1;
  const track = (e) => {
    let best = -1;
    let bestDist = 28 * 28;
    dots.forEach((d, i) => {
      const r = d.getBoundingClientRect();
      const dx = e.clientX - (r.left + r.width / 2);
      const dy = e.clientY - (r.top + r.height / 2);
      if (dx * dx + dy * dy < bestDist) {
        bestDist = dx * dx + dy * dy;
        best = i;
      }
    });
    if (best === hot) return;
    if (hot >= 0) dots[hot].classList.remove('hot');
    hot = best;
    if (hot < 0) {
      tip.hidden = true;
      return;
    }
    dots[hot].classList.add('hot');
    shows[hot]();
  };
  const untrack = () => {
    if (hot >= 0) dots[hot].classList.remove('hot');
    hot = -1;
    tip.hidden = true;
  };

  const ours = el('span', { class: 'mk-ours', 'aria-hidden': 'true', hidden: !(draft.included && draft.price_cents), style: { left: pct(draft.price_cents || 0) } });
  const parse = (text) => {
    if (!text.trim()) return null;
    try {
      return parseMoney(text);
    } catch {
      return undefined;
    }
  };
  const input = el('input', {
    type: 'text',
    inputMode: 'decimal',
    value: draft.price_cents ? reais(draft.price_cents) : '',
    placeholder: '—',
    'aria-label': `Nosso preço para ${anchor}, em reais`,
    // A marca na faixa acompanha a digitação; o valor só é gravado ao sair do campo ou com Enter.
    oninput: () => {
      const c = parse(input.value);
      ours.hidden = !c;
      if (c) ours.style.setProperty('left', pct(c));
    },
    onkeydown: (e) => e.key === 'Enter' && input.blur(),
    onchange: () => {
      const c = parse(input.value);
      if (c === undefined) return toast('Valor inválido. Use o formato 12,50.');
      if (c === draft.price_cents) return;
      // Dar preço a um item fora do rascunho também o inclui.
      saveDraft(anchor, c && !draft.included ? { price_cents: c, included: true } : { price_cents: c });
    },
  });

  let pos1 = draft.included ? 'Sem preço definido' : 'Fora do rascunho';
  let pos2 = draft.included ? 'digite um valor para comparar' : 'marque para incluir';
  if (draft.included && draft.price_cents && !n) {
    pos1 = 'Sem comparação';
    pos2 = 'nenhuma casa neste filtro';
  } else if (draft.included && draft.price_cents) {
    const diff = draft.price_cents - median;
    const below = prices.filter((c) => c < draft.price_cents).length;
    const above = prices.filter((c) => c > draft.price_cents).length;
    pos1 = Math.abs(diff) < 1 ? 'Na mediana' : `R$ ${reais(Math.abs(diff))} ${diff > 0 ? 'acima' : 'abaixo'} da mediana`;
    pos2 = !above && below ? `o mais caro entre ${n} casas` : !below && above ? `o mais barato entre ${n} casas` : `mais caro que ${below} de ${n} casas`;
  }
  const check = el('input', {
    type: 'checkbox',
    checked: draft.included,
    'aria-label': `Incluir ${anchor} no nosso cardápio`,
    onchange: () => saveDraft(anchor, { included: check.checked }),
  });

  return el(
    'div',
    { class: `mk-row${selected ? ' on' : ''}${draft.included ? '' : ' out'}` },
    el(
      'div',
      { class: 'mk-name' },
      check,
      el(
        'div',
        null,
        el('button', { class: 'mk-item', type: 'button', 'aria-pressed': String(selected), onclick: select }, anchor),
        el(
          'div',
          { class: 'mk-presence' },
          el('span', { class: 'mk-bar', 'aria-hidden': 'true' }, el('span', { style: { width: `${houseCount ? Math.round((n / houseCount) * 100) : 0}%` } })),
          el('span', { class: 'hint' }, `${n} de ${houseCount} casas${n > 0 && n < 5 ? ' · amostra pequena' : ''}`)
        )
      )
    ),
    el(
      'div',
      {
        class: 'mk-strip',
        role: 'img',
        onmousemove: track,
        onmouseleave: untrack,
        onclick: select,
        'aria-label': n ? `${anchor}: ${n} casas, de R$ ${reais(prices[0])} a R$ ${reais(prices[n - 1])}, mediana R$ ${reais(median)}` : `${anchor}: nenhuma casa neste filtro`,
      },
      axis.ticks.map((t) => el('span', { class: 'mk-grid', 'aria-hidden': 'true', style: { left: pct(t) } })),
      el('span', { class: 'mk-base', 'aria-hidden': 'true' }),
      n >= 4 && el('span', { class: 'mk-band', 'aria-hidden': 'true', style: { left: pct(quantile(prices, 0.25)), width: `${parseFloat(pct(quantile(prices, 0.75))) - parseFloat(pct(quantile(prices, 0.25)))}%` } }),
      n >= 1 && el('span', { class: 'mk-median', 'aria-hidden': 'true', style: { left: pct(median) } }),
      dots,
      ours,
      tip
    ),
    el('span', { class: 'mk-num' }, n ? reais(median) : '—'),
    el('label', { class: 'mk-price' }, el('span', { 'aria-hidden': 'true' }, 'R$'), input),
    el('div', { class: 'mk-pos' }, el('strong', null, pos1), el('span', { class: 'hint' }, pos2))
  );
}

function marketDetail() {
  const anchor = marketUi.selected;
  const points = marketVisible(anchor);
  const prices = points.map((p) => p.cents);
  const draft = market.draft[anchor] || {};
  const rows = points.map((p) => {
    const h = marketHouse(p.house);
    return {
      sort: p.cents,
      node: el(
        'li',
        null,
        el('span', { class: `mk-mark${marketUi.highlight.has(h.id) ? ' mk-ref' : ''}${p.q === 'A' ? '' : ' weak'}`, 'aria-hidden': 'true' }),
        el(
          'div',
          null,
          el('button', { class: `mk-house${marketUi.highlight.has(h.id) ? ' mk-ref' : ''}`, type: 'button', title: 'Ajustar tipo e referência', onclick: () => houseDialog(h) }, h.name),
          el('span', { class: 'hint' }, p.label),
          el(
            'span',
            { class: 'hint' },
            [HOUSE_TYPE[h.tipo], h.distance_km != null && `a ${String(h.distance_km).replace('.', ',')} km`, `foto de ${monthLabel(p.month)}`, p.q === 'B' && 'foto antiga', p.q === 'C' && 'leitura incerta'].filter(Boolean).join(' · '),
            p.url && ' · ',
            p.url && el('a', { href: p.url, target: '_blank', rel: 'noopener noreferrer' }, 'ver foto')
          )
        ),
        el('span', { class: 'mk-num' }, `R$ ${reais(p.cents)}`)
      ),
    };
  });
  if (draft.included && draft.price_cents) {
    rows.push({
      sort: draft.price_cents - 0.5,
      node: el('li', { class: 'ours' }, el('span', { class: 'mk-mark ours', 'aria-hidden': 'true' }), el('div', null, el('strong', null, 'Nosso preço'), el('span', { class: 'hint' }, 'rascunho')), el('strong', { class: 'mk-num' }, `R$ ${reais(draft.price_cents)}`)),
    });
  }
  rows.sort((a, b) => a.sort - b.sort);
  return el(
    'aside',
    { class: 'mk-detail', 'aria-label': 'Detalhe do item' },
    el('span', { class: 'mk-eyebrow' }, 'Casa por casa'),
    el('h2', null, anchor),
    el('p', { class: 'hint' }, prices.length ? `${prices.length} casas · de R$ ${reais(prices[0])} a R$ ${reais(prices[prices.length - 1])} · mediana R$ ${reais(quantile(prices, 0.5))}` : 'Nenhuma casa neste filtro.'),
    el('ul', null, rows.map((r) => r.node)),
    el('p', { class: 'hint' }, 'Preço lido de foto de cardápio, não confirmado no local. Volumes e porções variam: o texto abaixo do nome é o item como está escrito no cardápio. Clique no nome da casa para ajustar o tipo, o Instagram ou marcá-la como referência.')
  );
}

function marketView() {
  if (!market) return el('main', { class: 'market' }, el('p', { class: 'hint empty' }, 'Carregando…'));
  if (!market.houses.length) {
    return el(
      'main',
      { class: 'market' },
      el('div', { class: 'mk-head' }, el('div', null, el('h1', null, 'Cardápio'), el('p', { class: 'hint' }, 'Compare o nosso cardápio com os preços das casas da região.'))),
      el(
        'div',
        { class: 'backup' },
        el('h2', null, 'Ainda não há pesquisa importada'),
        el('p', { class: 'hint' }, 'Importe a planilha da coleta de cardápios (arquivo .csv separado por ponto e vírgula, com as colunas cafe, item, preco, categoria, variacao, data_foto e leitura). O sistema reconhece sozinho os itens comparáveis, como espresso, cappuccino e croissant.'),
        marketImportButton(true)
      )
    );
  }
  // Casas em destaque (azul): começam pelas marcadas como referência; clicar no badge liga e desliga.
  if (!marketUi.highlight) marketUi.highlight = new Set(market.houses.filter((h) => h.is_ref).map((h) => h.id));
  for (const id of [...marketUi.highlight]) if (!marketHouse(id)) marketUi.highlight.delete(id);
  if (marketUi.focus && !marketHouse(marketUi.focus)) marketUi.focus = null;
  const anchors = market.sections.flatMap((sec) => sec.items);
  if (!anchors.includes(marketUi.selected)) marketUi.selected = anchors.find((a) => (market.points[a] || []).length) || anchors[0];
  const houseCount = market.houses.filter((h) => marketUi.tipo === 'todas' || h.tipo === marketUi.tipo).length;

  // Resumo do rascunho: quantos itens, e em média quanto acima ou abaixo da mediana de cada um.
  let included = 0;
  let priced = 0;
  let diffSum = 0;
  let diffCount = 0;
  for (const a of anchors) {
    const d = market.draft[a];
    if (!d || !d.included) continue;
    included += 1;
    if (!d.price_cents) continue;
    priced += 1;
    const prices = marketVisible(a).map((p) => p.cents);
    if (!prices.length) continue;
    const median = quantile(prices, 0.5);
    diffSum += (d.price_cents - median) / median;
    diffCount += 1;
  }
  const avg = diffCount ? diffSum / diffCount : null;
  const tile = (label, value, note) => el('div', { class: 'balance' }, el('span', { class: 'hint' }, label), el('strong', null, value), el('span', { class: 'hint' }, note));
  const onlyA = el('input', {
    type: 'checkbox',
    checked: marketUi.onlyA,
    onchange: () => {
      marketUi.onlyA = onlyA.checked;
      render();
    },
  });
  const usedTypes = ['todas', ...Object.keys(HOUSE_TYPE).filter((t) => market.houses.some((h) => h.tipo === t))];
  const legend = (cls, label) => el('span', null, el('span', { class: cls, 'aria-hidden': 'true' }), label);

  return el(
    'main',
    { class: 'market' },
    el(
      'div',
      { class: 'mk-head' },
      el('div', null, el('h1', null, 'Cardápio'), el('p', { class: 'hint' }, 'Marque o que entra no nosso cardápio e teste um preço. Cada ponto é o preço de uma casa da região para o mesmo item.')),
      el(
        'div',
        { class: 'mk-tiles' },
        tile('No nosso rascunho', `${included} ${included === 1 ? 'item' : 'itens'}`, `${priced} com preço definido`),
        tile('Nosso nível de preço', avg === null ? '—' : Math.abs(avg) < 0.005 ? 'Na mediana' : `${Math.round(Math.abs(avg) * 100)}% ${avg > 0 ? 'acima' : 'abaixo'}`, avg === null ? 'defina preços para calcular' : 'média dos itens, contra a mediana de cada um'),
        tile('Base de comparação', `${houseCount} ${houseCount === 1 ? 'casa' : 'casas'}`, `${market.houses.reduce((n, h) => n + h.items, 0)} itens de cardápio importados`)
      )
    ),
    el(
      'div',
      { class: 'toolbar mk-filters' },
      el(
        'div',
        { class: 'mk-chips', role: 'group', 'aria-label': 'Tipo de casa' },
        usedTypes.map((t) =>
          el(
            'button',
            {
              class: `mk-chip${marketUi.tipo === t ? ' on' : ''}`,
              type: 'button',
              'aria-pressed': String(marketUi.tipo === t),
              onclick: () => {
                marketUi.tipo = t;
                render();
              },
            },
            t === 'todas' ? 'Todas as casas' : HOUSE_TYPE[t][0].toUpperCase() + HOUSE_TYPE[t].slice(1)
          )
        )
      ),
      el('label', { class: 'check', title: 'Esconde preços de fotos com mais de 12 meses e de leitura incerta' }, onlyA, 'Só preços confiáveis'),
      el('span', { class: 'spacer' }),
      marketImportButton(false)
    ),
    el(
      'div',
      { class: 'mk-legend', 'aria-label': 'Legenda' },
      legend('mk-mark', 'casa'),
      legend('mk-mark mk-ref', 'casa em destaque'),
      legend('mk-mark weak', 'foto antiga ou leitura incerta'),
      legend('mk-key-band', 'metade central'),
      legend('mk-key-median', 'mediana'),
      legend('mk-key-ours', 'nosso preço')
    ),
    el(
      'div',
      { class: 'mk-houses', role: 'group', 'aria-label': 'Casas monitoradas' },
      market.houses
        .filter((h) => marketUi.tipo === 'todas' || h.tipo === marketUi.tipo)
        .map((h) => {
          const on = marketUi.highlight.has(h.id);
          return el(
            'button',
            {
              class: `mk-badge${on ? ' on' : ''}${marketUi.focus === h.id ? ' focus' : ''}`,
              type: 'button',
              'aria-pressed': String(on),
              title: on ? 'Tirar do destaque' : 'Destacar no gráfico',
              onclick: () => {
                // Clicar destaca e mostra a ficha; clicar de novo na casa da ficha tira o destaque.
                if (on && marketUi.focus === h.id) {
                  marketUi.highlight.delete(h.id);
                  marketUi.focus = null;
                } else {
                  marketUi.highlight.add(h.id);
                  marketUi.focus = h.id;
                }
                render();
              },
            },
            el('span', { class: 'mk-badge-dot', 'aria-hidden': 'true' }),
            h.name
          );
        })
    ),
    marketUi.focus && marketHouseCard(marketHouse(marketUi.focus)),
    el(
      'div',
      { class: 'mk-body' },
      el(
        'div',
        { class: 'mk-table' },
        el(
          'div',
          { class: 'mk-inner' },
          market.sections.map((sec) => {
            const axis = marketAxis(sec);
            const pct = (c) => `${((c - axis.min) / (axis.max - axis.min)) * 100}%`;
            return el(
              'section',
              { 'aria-label': sec.title },
              el(
                'div',
                { class: 'mk-row mk-sec' },
                el('h2', null, sec.title),
                el('div', { class: 'mk-ticks', 'aria-hidden': 'true' }, axis.ticks.map((t) => el('span', { style: { left: pct(t) } }, `R$ ${t / 100}`))),
                el('span', { class: 'hint mk-num' }, 'Mediana'),
                el('span', { class: 'hint' }, 'Nosso preço'),
                el('span', { class: 'hint' }, 'Onde ficamos')
              ),
              sec.items.map((a) => marketRow(a, axis, houseCount))
            );
          })
        )
      ),
      marketDetail()
    )
  );
}

// ---------- catálogo de livros ----------

let books = null; // última resposta do servidor (totais e opções de filtro)
let bookItems = []; // livros já carregados para os filtros atuais
let bookSeq = 0;
let bookTimer;
let bookGrid = null;
let bookCount = null;
const bookUi = { q: '', selo: '', genero: '', disp: '', picked: '', sort: 'recentes' };

function bookQuery(extra) {
  const [grupo, selo] = bookUi.selo.split('|');
  const params = { q: bookUi.q, grupo, selo, genero: bookUi.genero, disponibilidade: bookUi.disp, picked: bookUi.picked, sort: bookUi.sort, ...extra };
  return Object.entries(params)
    .filter(([, v]) => v !== '' && v != null)
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join('&');
}

// reset = filtros mudaram (recomeça do início); senão, busca a página seguinte.
async function loadBooks(reset) {
  const mine = ++bookSeq;
  try {
    const res = await api('GET', `/books?${bookQuery({ offset: reset ? 0 : bookItems.length })}`);
    if (mine !== bookSeq) return; // já há uma busca mais nova a caminho
    const first = !books;
    books = res;
    bookItems = reset ? res.items : [...bookItems, ...res.items];
    if (first || !bookGrid || !document.contains(bookGrid)) render();
    else drawBooks();
  } catch (e) {
    if (me) toast(e.message);
  }
}

function bookCover(b, large) {
  const blank = () => el('span', { class: 'book-blank' }, b.titulo);
  if (!b.capa_url) return blank();
  return el('img', { src: b.capa_url, alt: large ? `Capa de ${b.titulo}` : '', loading: 'lazy', referrerPolicy: 'no-referrer', onerror: (e) => e.currentTarget.replaceWith(blank()) });
}

async function togglePick(b) {
  try {
    const { on } = await api('POST', `/books/${b.id}/pick`, {});
    b.picks = on ? [...b.picks, me.id] : b.picks.filter((id) => id !== me.id);
    const item = bookItems.find((x) => x.id === b.id);
    if (item) item.picks = b.picks;
    if (books) books.picked += on && b.picks.length === 1 ? 1 : !on && b.picks.length === 0 ? -1 : 0;
  } catch (e) {
    toast(e.message);
  }
  drawBooks();
}

function pickButton(b, withLabel) {
  const mine = b.picks.includes(me.id);
  const names = b.picks.map((id) => (userById(id) || {}).name).filter(Boolean).join(', ');
  return el(
    'button',
    {
      class: `book-pick${mine ? ' on' : ''}${b.picks.length ? ' some' : ''}`,
      type: 'button',
      'aria-pressed': String(mine),
      'aria-label': mine ? `Tirar ${b.titulo} da minha seleção` : `Selecionar ${b.titulo}`,
      title: names ? `Selecionado por ${names}` : 'Selecionar para o acervo',
      onclick: () => togglePick(b),
    },
    mine ? '★' : '☆',
    b.picks.length > 0 && el('span', null, String(b.picks.length)),
    withLabel && el('span', null, mine ? 'Na minha seleção' : 'Selecionar')
  );
}

function bookCard(b) {
  const out = b.disponibilidade && b.disponibilidade !== 'Disponível';
  return el(
    'li',
    { class: `book${out ? ' out' : ''}` },
    el(
      'button',
      { class: 'book-open', type: 'button', onclick: () => bookDialog(b.id) },
      el('span', { class: 'book-cover' }, bookCover(b), out && el('span', { class: 'tag' }, b.disponibilidade)),
      el('strong', null, b.titulo),
      el('span', { class: 'hint' }, b.autores || '—'),
      el('span', { class: 'hint' }, [b.selo, b.ano_publicacao].filter(Boolean).join(' · ')),
      b.preco_cents && el('span', { class: 'book-price' }, `R$ ${reais(b.preco_cents)}`)
    ),
    pickButton(b)
  );
}

function drawBooks() {
  if (!bookGrid || !books) return;
  if (bookCount) bookCount.textContent = `${books.total.toLocaleString('pt-BR')} ${books.total === 1 ? 'livro' : 'livros'}${books.total < books.catalog ? ` de ${books.catalog.toLocaleString('pt-BR')}` : ''} · ${books.picked} selecionado(s)`;
  const rest = books.total - bookItems.length;
  bookGrid.replaceChildren(
    bookItems.length ? el('ul', { class: 'books' }, bookItems.map(bookCard)) : el('p', { class: 'hint empty' }, 'Nenhum livro com esses filtros.'),
    rest > 0 && el('div', { class: 'book-more' }, el('button', { class: 'btn', type: 'button', onclick: () => loadBooks(false) }, `Carregar mais (${rest.toLocaleString('pt-BR')} restantes)`))
  );
}

async function bookDialog(id) {
  let b;
  try {
    b = await api('GET', `/books/${id}`);
  } catch (e) {
    return toast(e.message);
  }
  const row = (label, value) => value && el('div', { class: 'book-fact' }, el('dt', null, label), el('dd', null, value));
  const rating = (site, nota, n, extra) =>
    (nota || n) && el('div', { class: 'balance' }, el('span', { class: 'hint' }, site), el('strong', null, nota || '—'), el('span', { class: 'hint' }, [n && `${Number(n).toLocaleString('pt-BR')} avaliações`, extra].filter(Boolean).join(' · ')));
  const ratings = [
    rating('Amazon', b.amazon_nota, b.amazon_avaliacoes, b.amazon_ranking && `ranking ${b.amazon_ranking}`),
    rating('Goodreads', b.goodreads_nota, b.goodreads_avaliacoes, b.goodreads_resenhas && `${b.goodreads_resenhas} resenhas`),
    rating('Skoob', b.skoob_nota, b.skoob_avaliacoes, b.skoob_leram && `${b.skoob_leram} leram`),
  ].filter(Boolean);
  const pickSlot = el('span', null, pickButton(b, true));
  const dlg = el(
    'dialog',
    { class: 'modal item book-modal' },
    el(
      'header',
      { class: 'item-head' },
      el('div', null, el('h2', null, b.titulo), b.subtitulo && el('p', { class: 'hint' }, b.subtitulo), el('p', null, b.autores)),
      el('button', { class: 'icon', type: 'button', 'aria-label': 'Fechar', title: 'Fechar', onclick: () => dlg.close() }, '✕')
    ),
    el(
      'div',
      { class: 'book-detail' },
      el('div', { class: 'book-side' }, el('span', { class: 'book-cover' }, bookCover(b, true)), pickSlot, b.url && el('a', { class: 'btn', href: b.url, target: '_blank', rel: 'noopener noreferrer' }, 'Página na editora'), b.link_amazon && el('a', { class: 'btn', href: b.link_amazon, target: '_blank', rel: 'noopener noreferrer' }, 'Ver na Amazon')),
      el(
        'div',
        { class: 'book-main' },
        el(
          'dl',
          { class: 'book-facts' },
          row('Editora', b.selo === b.grupo ? b.selo : `${b.selo} (${b.grupo})`),
          row('Lançamento', b.data_lancamento ? b.data_lancamento.split('-').reverse().join('/') : b.ano_publicacao),
          row('Edição', [b.edicao_numero && `${b.edicao_numero}ª`, b.edicao_obs].filter(Boolean).join(' · ')),
          row('Preço de capa', b.preco_cents && `R$ ${reais(b.preco_cents)}`),
          row('Situação', b.disponibilidade),
          row('Formato', [b.formato, b.paginas && `${b.paginas} páginas`, b.dimensoes].filter(Boolean).join(' · ')),
          row('Gênero', [b.genero, b.classificacao].filter(Boolean).join(' · ')),
          row('Série', b.serie),
          row('Título original', b.titulo_original),
          row('Tradução', b.tradutor),
          row('Origem do autor', b.origem_autor),
          row('Prêmios', b.premios),
          row('Tiragem', b.tiragem),
          row('ISBN', [b.isbn, b.isbn_ebook && `e-book ${b.isbn_ebook}`, b.isbn_audiolivro && `audiolivro ${b.isbn_audiolivro}`].filter(Boolean).join(' · '))
        ),
        ratings.length > 0 && el('div', { class: 'book-ratings' }, ratings),
        ratings.length > 0 && b.data_consulta && el('p', { class: 'hint' }, `Notas consultadas em ${b.data_consulta.split('-').reverse().join('/')}.`),
        b.sinopse && el('h3', null, 'Sinopse'),
        b.sinopse && el('p', { class: 'rich' }, b.sinopse),
        b.sobre_autor && el('h3', null, 'Sobre o autor'),
        b.sobre_autor && el('p', { class: 'rich' }, b.sobre_autor),
        b.temas && el('p', { class: 'hint' }, `Temas: ${b.temas}`)
      )
    )
  );
  // Selecionar dentro da janela atualiza o botão aqui e o cartão na grade.
  pickSlot.addEventListener('click', () => setTimeout(() => pickSlot.replaceChildren(pickButton(b, true)), 400));
  dlg.addEventListener('close', () => dlg.remove());
  document.body.append(dlg);
  dlg.showModal();
}

// Lista dos selecionados no formato que o prompt de notas (Amazon, Goodreads, Skoob) espera.
async function exportPicks() {
  try {
    const res = await api('GET', '/books?picked=todos&limit=2000&sort=autor');
    if (!res.items.length) return toast('Ninguém selecionou livros ainda.');
    const cell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const rows = [['isbn', 'titulo', 'autores', 'selo', 'link_amazon', 'selecionado_por'], ...res.items.map((b) => [b.isbn, b.titulo, b.autores, b.selo, b.link_amazon, b.picks.map((id) => (userById(id) || {}).name).filter(Boolean).join(', ')])];
    const a = el('a', { href: URL.createObjectURL(new Blob([`\ufeff${rows.map((r) => r.map(cell).join(';')).join('\r\n')}`], { type: 'text/csv;charset=utf-8' })), download: `livros-selecionados-${today()}.csv` });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  } catch (e) {
    toast(e.message);
  }
}

function bookImportButton(primary) {
  const picker = el('input', {
    type: 'file',
    accept: '.csv,text/csv',
    hidden: true,
    onchange: async () => {
      const file = picker.files[0];
      picker.value = '';
      if (!file) return;
      toast('Importando catálogo… pode levar alguns segundos.');
      try {
        const res = await fetch('/api/books/import', { method: 'POST', headers: { 'Content-Type': 'text/csv', 'X-Requested-With': 'obsoleta' }, body: file });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || 'Não foi possível importar a planilha.');
        toast(`Importado: ${data.added} novos, ${data.updated} atualizados${data.skipped ? `, ${data.skipped} linhas ignoradas` : ''}.`);
      } catch (e) {
        toast(e.message);
      }
      books = null;
      loadBooks(true);
    },
  });
  return el('span', null, picker, el('button', { class: `btn${primary ? ' primary' : ''}`, type: 'button', onclick: () => picker.click() }, 'Importar planilha'));
}

function booksView() {
  if (!books) {
    if (!bookSeq) loadBooks(true);
    return el('main', { class: 'catalog' }, el('p', { class: 'hint empty' }, 'Carregando…'));
  }
  if (!books.catalog) {
    return el(
      'main',
      { class: 'catalog' },
      el('div', { class: 'mk-head' }, el('div', null, el('h1', null, 'Catálogo'), el('p', { class: 'hint' }, 'Os livros das editoras, para montar a seleção do acervo.'))),
      el(
        'div',
        { class: 'backup' },
        el('h2', null, 'Ainda não há catálogo importado'),
        el('p', { class: 'hint' }, me.is_admin ? 'Importe o arquivo catalogo_editoras.csv. Depois, planilhas parciais (só ISBN e notas, ou o catálogo de outra editora) podem ser importadas por cima: cada livro é casado pelo ISBN.' : 'Peça a um admin para importar a planilha do catálogo.'),
        me.is_admin && bookImportButton(true)
      )
    );
  }
  const reload = () => loadBooks(true);
  const select = (key, label, options) => {
    const node = el(
      'select',
      {
        'aria-label': label,
        onchange: () => {
          bookUi[key] = node.value;
          reload();
        },
      },
      options
    );
    return node;
  };
  const opt = (value, label) => el('option', { value, selected: value === undefined ? false : null }, label);
  const pick = (key, value, label) => el('option', { value, selected: bookUi[key] === value }, label);
  const groups = [...new Set(books.selos.map((x) => x.grupo))];
  const search = el('input', {
    id: 'book-q',
    type: 'search',
    value: bookUi.q,
    placeholder: 'Buscar por título, autor, tema, ISBN…',
    'aria-label': 'Buscar no catálogo',
    autocomplete: 'off',
    oninput: () => {
      bookUi.q = search.value;
      clearTimeout(bookTimer);
      bookTimer = setTimeout(reload, 250);
    },
  });
  bookGrid = el('div', { class: 'book-grid' });
  bookCount = el('span', { id: 'book-count', class: 'hint', 'aria-live': 'polite' });
  const view = el(
    'main',
    { class: 'catalog' },
    el('div', { class: 'mk-head' }, el('div', null, el('h1', null, 'Catálogo'), el('p', { class: 'hint' }, 'Os livros das editoras, para montar a seleção do acervo. A estrela marca um livro como candidato; todos veem quem marcou.'))),
    el(
      'div',
      { class: 'toolbar book-filters' },
      search,
      select('selo', 'Editora ou selo', [
        pick('selo', '', 'Todas as editoras'),
        ...groups.map((g) => {
          const selos = books.selos.filter((x) => x.grupo === g);
          return el('optgroup', { label: g }, selos.length > 1 && pick('selo', `${g}|`, `Todo o grupo (${selos.reduce((n, x) => n + x.n, 0).toLocaleString('pt-BR')})`), selos.map((x) => pick('selo', `${g}|${x.selo}`, `${x.selo} (${x.n.toLocaleString('pt-BR')})`)));
        }),
      ]),
      select('genero', 'Gênero', [pick('genero', '', 'Todos os gêneros'), ...books.generos.map((x) => pick('genero', x.name, `${x.name} (${x.n.toLocaleString('pt-BR')})`))]),
      select('disp', 'Situação', [pick('disp', '', 'Qualquer situação'), ...['Disponível', 'Pré Venda', 'Sob Demanda', 'Esgotado'].map((d) => pick('disp', d, d))]),
      select('picked', 'Seleção', [pick('picked', '', 'Todos os livros'), pick('picked', 'todos', 'Selecionados por alguém'), pick('picked', 'meus', 'Minha seleção')]),
      select('sort', 'Ordem', [
        pick('sort', 'recentes', 'Mais recentes'),
        pick('sort', 'antigos', 'Mais antigos'),
        pick('sort', 'titulo', 'Título'),
        pick('sort', 'autor', 'Autor'),
        pick('sort', 'preco_menor', 'Menor preço'),
        pick('sort', 'preco_maior', 'Maior preço'),
      ])
    ),
    el(
      'div',
      { class: 'toolbar book-bar' },
      bookCount,
      el('span', { class: 'spacer' }),
      el('button', { class: 'btn', type: 'button', onclick: exportPicks }, 'Exportar selecionados'),
      me.is_admin && bookImportButton(false)
    ),
    bookGrid
  );
  drawBooks();
  return view;
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
      u && u.passkeys > 0 && { name: 'clear_passkeys', label: `Remover as ${u.passkeys} passkey(s) desta pessoa (aparelho perdido)`, type: 'checkbox', value: false },
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
    el(
      'div',
      { class: 'backup' },
      el('h2', null, 'Backup'),
      el('p', { class: 'hint' }, 'Baixa um arquivo com tudo: tarefas, referências, comentários, contas, imagens e arquivos. Guarde fora do servidor, em lugar seguro — ele contém os documentos dos sócios.'),
      el('a', { class: 'btn', href: '/api/backup' }, 'Baixar backup agora')
    ),
    el('p', { class: 'hint' }, 'Não há cadastro público: só quem está nesta lista, com acesso ativo, consegue entrar. Desativar alguém encerra as sessões dessa pessoa na hora.')
  );
}

// ---------- passkeys ----------

const b64uToBuf = (str) => Uint8Array.from(atob(str.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
const bufToB64u = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const passkeysSupported = () => !!(window.PublicKeyCredential && navigator.credentials);

// Cancelar o aviso do sistema não é erro: devolve null.
async function askAuthenticator(fn) {
  try {
    return await fn();
  } catch (e) {
    if (e.name === 'NotAllowedError' || e.name === 'AbortError') return null;
    if (e.name === 'InvalidStateError') throw new Error('Este aparelho já tem uma passkey cadastrada para a sua conta.');
    throw new Error('O aparelho não conseguiu usar a passkey.');
  }
}

function deviceName() {
  const ua = navigator.userAgent;
  const names = [[/iPhone/, 'iPhone'], [/iPad/, 'iPad'], [/Android/, 'Android'], [/Mac OS X|Macintosh/, 'Mac'], [/Windows/, 'Windows'], [/Linux/, 'Linux']];
  return (names.find(([re]) => re.test(ua)) || [null, 'Passkey'])[1];
}

async function registerPasskey() {
  const { flow, options } = await api('POST', '/passkeys/register/options', {});
  const cred = await askAuthenticator(() =>
    navigator.credentials.create({
      publicKey: {
        ...options,
        challenge: b64uToBuf(options.challenge),
        user: { ...options.user, id: b64uToBuf(options.user.id) },
        excludeCredentials: (options.excludeCredentials || []).map((c) => ({ ...c, id: b64uToBuf(c.id) })),
      },
    })
  );
  if (!cred) return false;
  await api('POST', '/passkeys/register/verify', {
    flow,
    name: deviceName(),
    response: {
      id: cred.id,
      rawId: bufToB64u(cred.rawId),
      type: cred.type,
      authenticatorAttachment: cred.authenticatorAttachment || undefined,
      clientExtensionResults: cred.getClientExtensionResults(),
      response: {
        clientDataJSON: bufToB64u(cred.response.clientDataJSON),
        attestationObject: bufToB64u(cred.response.attestationObject),
        transports: cred.response.getTransports ? cred.response.getTransports() : undefined,
      },
    },
  });
  return true;
}

async function loginWithPasskey() {
  const { flow, options } = await api('POST', '/passkeys/login/options', {});
  const cred = await askAuthenticator(() =>
    navigator.credentials.get({ publicKey: { ...options, challenge: b64uToBuf(options.challenge), allowCredentials: [] } })
  );
  if (!cred) return null;
  return api('POST', '/passkeys/login/verify', {
    flow,
    response: {
      id: cred.id,
      rawId: bufToB64u(cred.rawId),
      type: cred.type,
      authenticatorAttachment: cred.authenticatorAttachment || undefined,
      clientExtensionResults: cred.getClientExtensionResults(),
      response: {
        clientDataJSON: bufToB64u(cred.response.clientDataJSON),
        authenticatorData: bufToB64u(cred.response.authenticatorData),
        signature: bufToB64u(cred.response.signature),
        userHandle: cred.response.userHandle ? bufToB64u(cred.response.userHandle) : undefined,
      },
    },
  });
}

// Depois de entrar com senha, convida a cadastrar uma passkey — a menos que a pessoa
// já tenha uma para este endereço ou tenha dispensado o convite neste aparelho.
async function offerPasskey() {
  const dismissedKey = `passkey-dispensada-${me.id}`;
  try {
    if (!passkeysSupported() || localStorage.getItem(dismissedKey)) return;
  } catch {
    return;
  }
  const keys = await api('GET', '/passkeys').catch(() => null);
  if (!keys || keys.some((k) => k.rp_id === location.hostname) || document.querySelector('dialog[open]')) return;

  const err = el('p', { class: 'form-error', role: 'alert' });
  const add = el(
    'button',
    {
      class: 'btn primary',
      type: 'button',
      onclick: async () => {
        err.textContent = '';
        add.disabled = true;
        try {
          if (await registerPasskey()) {
            toast('Passkey cadastrada. Da próxima vez, use "Entrar com passkey".');
            dlg.close();
            return;
          }
        } catch (e) {
          err.textContent = e.message;
        }
        add.disabled = false;
      },
    },
    'Cadastrar passkey'
  );
  const dlg = el(
    'dialog',
    { class: 'modal' },
    el('h2', null, 'Entrar sem senha neste aparelho?'),
    el('p', null, 'Cadastre uma passkey para entrar com a digital, o rosto ou o PIN do aparelho. Leva alguns segundos e a senha continua valendo.'),
    err,
    el(
      'div',
      { class: 'modal-actions' },
      el('span', { class: 'spacer' }),
      el(
        'button',
        {
          class: 'btn',
          type: 'button',
          onclick: () => {
            try {
              localStorage.setItem(dismissedKey, '1');
            } catch {}
            dlg.close();
          },
        },
        'Agora não'
      ),
      add
    ),
    el('p', { class: 'hint' }, 'Dá para cadastrar ou remover depois em "Conta".')
  );
  dlg.addEventListener('close', () => dlg.remove());
  document.body.append(dlg);
  dlg.showModal();
}

function accountDialog() {
  const list = el('ul', { class: 'passkey-list' });
  const err = el('p', { class: 'form-error', role: 'alert' });
  const load = async () => {
    const keys = await api('GET', '/passkeys').catch(() => []);
    list.replaceChildren(
      ...(keys.length
        ? keys.map((k) =>
            el(
              'li',
              null,
              el(
                'div',
                null,
                el('strong', null, k.name),
                el(
                  'p',
                  { class: 'hint' },
                  `Criada em ${fmtWhen(k.created_at)} · ${k.last_used_at ? `último uso em ${fmtWhen(k.last_used_at)}` : 'nunca usada'}`,
                  k.rp_id !== location.hostname && ` · vale só em ${k.rp_id}`
                )
              ),
              el('span', { class: 'spacer' }),
              el(
                'button',
                {
                  class: 'btn danger',
                  type: 'button',
                  onclick: async () => {
                    if (!confirm(`Remover a passkey "${k.name}"? Esse aparelho deixa de entrar sem senha.`)) return;
                    await api('DELETE', `/passkeys/${k.id}`).catch((e) => toast(e.message));
                    load();
                  },
                },
                'Remover'
              )
            )
          )
        : [el('li', { class: 'hint' }, 'Nenhuma passkey cadastrada. Você entra com e-mail e senha.')])
    );
  };
  const add = el(
    'button',
    {
      class: 'btn primary',
      type: 'button',
      onclick: async () => {
        err.textContent = '';
        add.disabled = true;
        try {
          if (await registerPasskey()) toast('Passkey cadastrada.');
          await load();
        } catch (e) {
          err.textContent = e.message;
        }
        add.disabled = false;
      },
    },
    'Cadastrar passkey neste aparelho'
  );
  const dlg = el(
    'dialog',
    { class: 'modal item' },
    el(
      'header',
      { class: 'item-head' },
      el('h2', null, 'Minha conta'),
      el('button', { class: 'icon', type: 'button', 'aria-label': 'Fechar', title: 'Fechar', onclick: () => dlg.close() }, '✕')
    ),
    el('p', { class: 'hint' }, `${me.name} · ${me.email}`),
    el('h3', null, 'Passkeys'),
    el('p', { class: 'hint' }, 'Entre com a digital, o rosto ou o PIN do aparelho, sem digitar senha. A senha continua valendo como alternativa.'),
    list,
    err,
    passkeysSupported() ? el('div', null, add) : el('p', { class: 'hint' }, 'Este navegador não oferece passkeys.'),
    el('h3', null, 'Senha'),
    el('div', null, el('button', { class: 'btn', type: 'button', onclick: () => { dlg.close(); passwordDialog(); } }, 'Alterar senha'))
  );
  dlg.addEventListener('close', () => dlg.remove());
  document.body.append(dlg);
  dlg.showModal();
  load();
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

// A tela de entrada mostra só a passkey; e-mail e senha ficam atrás de um link.
// Navegadores sem passkey vão direto para e-mail e senha.
let loginWithPassword = false;

function loginView() {
  const usePassword = loginWithPassword || !passkeysSupported();
  const err = el('p', { class: 'form-error', role: 'alert' });
  const switchTo = (password) =>
    el(
      'button',
      {
        class: 'linklike login-switch',
        type: 'button',
        onclick: () => {
          loginWithPassword = password;
          render();
          const first = document.getElementById('l-email');
          if (first) first.focus();
        },
      },
      password ? 'Entrar com e-mail e senha' : 'Entrar com passkey'
    );
  const header = [el('h1', { class: 'brand' }, 'Obsoleta'), el('p', { class: 'hint' }, 'Área dos sócios.')];

  if (!usePassword) {
    const btn = el(
      'button',
      {
        class: 'btn primary',
        type: 'button',
        onclick: async () => {
          err.textContent = '';
          btn.disabled = true;
          try {
            const user = await loginWithPasskey();
            if (user) {
              me = user;
              await refresh(true);
              return;
            }
          } catch (ex) {
            err.textContent = `${ex.message} Se for o seu primeiro acesso neste aparelho, entre com e-mail e senha.`;
          }
          btn.disabled = false;
        },
      },
      'Entrar com passkey'
    );
    return el('main', { class: 'login' }, el('form', { onsubmit: (e) => e.preventDefault() }, header, err, btn, switchTo(true)));
  }

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
            loginWithPassword = false;
            await refresh(true);
            offerPasskey();
          } catch (ex) {
            err.textContent = ex.message;
            btn.disabled = false;
          }
        },
      },
      header,
      el('div', { class: 'field' }, el('label', { for: 'l-email' }, 'E-mail'), mail),
      el('div', { class: 'field' }, el('label', { for: 'l-pw' }, 'Senha'), pw),
      err,
      btn,
      passkeysSupported() && switchTo(false)
    )
  );
}

function render() {
  if (!me) {
    disconnectLive();
    for (const d of document.querySelectorAll('dialog')) d.remove();
    root.replaceChildren(loginView());
    return;
  }
  if (!state) return;
  if (view === 'people' && !me.is_admin) view = 'tasks';
  const boardScroll = root.querySelector('.board');
  const scrollLeft = boardScroll ? boardScroll.scrollLeft : 0;
  // Se a pessoa está digitando uma nova tarefa, o texto sobrevive ao redesenho da tela.
  const typed = document.activeElement;
  const searching = typed && typed.id === 'book-q' ? { at: typed.selectionStart } : null;
  const draft =
    typed && typed.classList.contains('quick') && root.contains(typed)
      ? { cat: typed.closest('.column').dataset.cat, value: typed.value, at: typed.selectionStart }
      : null;

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
          if (id === 'market') refresh(true); // esta aba tem dados próprios, buscados ao abrir
        },
      },
      label
    );

  root.replaceChildren(
    el(
      'header',
      { class: 'top' },
      el('span', { class: 'brand' }, 'Obsoleta'),
      el('nav', null, tab('tasks', 'Tarefas', '#tarefas'), tab('refs', 'Referências', '#referencias'), tab('files', 'Arquivos', '#arquivos'), tab('ledger', 'Conta corrente', '#conta'), tab('market', 'Cardápio', '#cardapio'), tab('books', 'Catálogo', '#catalogo'), me.is_admin && tab('people', 'Pessoas', '#pessoas')),
      el('span', { class: 'spacer' }),
      el(
        'button',
        { class: `btn quiet${state.mentions.length ? ' alert' : ''}`, type: 'button', onclick: mentionsDialog },
        state.mentions.length ? `@ ${state.mentions.length} ${state.mentions.length === 1 ? 'menção' : 'menções'}` : '@'
      ),
      el(
        'button',
        { class: 'btn quiet bell', type: 'button', 'aria-label': 'Buscar', title: 'Buscar (Ctrl+K)', onclick: spotlight },
        lineIcon('M11 4a7 7 0 1 0 0 14a7 7 0 0 0 0-14z', 'M20 20l-4-4')
      ),
      el(
        'button',
        {
          class: `btn quiet bell${state.activity_unread ? ' has' : ''}`,
          type: 'button',
          'aria-label': state.activity_unread ? `Novidades: ${state.activity_unread} não vistas` : 'Novidades',
          title: 'Novidades',
          onclick: activityDialog,
        },
        lineIcon('M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9', 'M13.73 21a2 2 0 0 1-3.46 0'),
        state.activity_unread > 0 && el('span', { class: 'badge' }, state.activity_unread > 99 ? '99+' : String(state.activity_unread))
      ),
      el('span', { class: 'who' }, me.name),
      el('button', { class: 'btn quiet', type: 'button', onclick: accountDialog }, 'Conta'),
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
    view === 'refs' ? refsView() : view === 'files' ? filesView() : view === 'ledger' ? ledgerView() : view === 'market' ? marketView() : view === 'books' ? booksView() : view === 'people' ? peopleView() : tasksView()
  );

  const board = root.querySelector('.board');
  if (board) board.scrollLeft = scrollLeft;
  // No celular as abas rolam para o lado: garante que a aba atual esteja à vista.
  const current = root.querySelector('.tab.on');
  if (current && current.scrollIntoView) current.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  if (focusCat != null) {
    const q = root.querySelector(`.column[data-cat="${focusCat}"] .quick`);
    if (q) q.focus();
    focusCat = null;
  } else if (searching && !document.querySelector('dialog[open]')) {
    const box = document.getElementById('book-q');
    if (box) {
      box.focus();
      box.setSelectionRange(searching.at, searching.at);
    }
  } else if (draft && !document.querySelector('dialog[open]')) {
    const q = root.querySelector(`.column[data-cat="${draft.cat}"] .quick`);
    if (q) {
      q.value = draft.value;
      q.focus();
      q.setSelectionRange(draft.at, draft.at);
    }
  }
}

// Clicar fora de uma janela (no fundo escurecido) fecha a janela. O clique precisa começar e
// terminar fora, para que selecionar um texto e soltar o mouse do lado de fora não feche nada.
// Se houver algo digitado e não salvo, pede confirmação antes de descartar.
{
  const outside = (dlg, e) => {
    const r = dlg.getBoundingClientRect();
    return e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom;
  };
  const unsaved = (dlg) =>
    dlg.classList.contains('spotlight')
      ? false
      : dlg.classList.contains('item') ? [...dlg.querySelectorAll('.composer textarea')].some((t) => t.value.trim()) : dlg.dataset.dirty === '1';
  let downOutside = false;
  document.addEventListener('input', (e) => {
    const dlg = e.target.closest && e.target.closest('dialog');
    if (dlg) dlg.dataset.dirty = '1';
  });
  document.addEventListener('pointerdown', (e) => {
    downOutside = e.target instanceof HTMLDialogElement && outside(e.target, e);
  });
  document.addEventListener('click', (e) => {
    const dlg = e.target;
    if (!downOutside || !(dlg instanceof HTMLDialogElement) || !outside(dlg, e)) return;
    downOutside = false;
    if (unsaved(dlg) && !confirm('Fechar e descartar o que você digitou?')) return;
    dlg.close();
  });
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
  // Rede de segurança caso a conexão ao vivo esteja indisponível.
  setInterval(() => {
    refresh();
    maybeReload();
  }, 20000);
  window.addEventListener('focus', () => refresh());
})();
