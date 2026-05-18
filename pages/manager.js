const state = {
  items: new Map(),
  query: '',
};
const iconCache = new Map();

const els = {
  list: document.getElementById('list'),
  empty: document.getElementById('empty'),
  search: document.getElementById('search'),
  snackbar: document.getElementById('snackbar'),
  snackbarText: document.getElementById('snackbar-text'),
  snackbarAction: document.getElementById('snackbar-action'),
  menuOverlay: document.getElementById('menu-overlay'),
};

let snackbarTimer = null;

init();

async function init() {
  els.search.addEventListener('input', (e) => {
    state.query = e.target.value.trim();
    render();
  });

  chrome.runtime.onMessage.addListener(handleWorkerMessage);

  document.addEventListener('click', () => closeMenu(), true);
  els.menuOverlay.addEventListener('click', () => closeMenu());

  sendMsg({ type: 'clear-badge' });

  await loadAll();

  setInterval(pollActive, 1000);
}

async function pollActive() {
  const active = await chrome.downloads.search({ state: 'in_progress', limit: 50 });
  if (active.length === 0) return;
  let changed = false;
  for (const item of active) {
    const prev = state.items.get(item.id);
    if (!prev || hasProgressChanged(prev, item)) {
      state.items.set(item.id, item);
      changed = true;
    }
  }
  if (changed) render();
}

async function loadAll() {
  const list = await chrome.downloads.search({
    orderBy: ['-startTime'],
    limit: 200,
  });
  state.items.clear();
  for (const item of list) state.items.set(item.id, item);
  render();
}

function handleWorkerMessage(msg) {
  if (msg?.type === 'created') {
    state.items.set(msg.item.id, msg.item);
    render();
  } else if (msg?.type === 'changed') {
    for (const delta of msg.items) {
      const existing = state.items.get(delta.id);
      if (!existing) continue;
      state.items.set(delta.id, mergeDelta(existing, delta));
    }
    render();
  } else if (msg?.type === 'erased') {
    state.items.delete(msg.id);
    render();
  }
}

function render() {
  const items = Array.from(state.items.values())
    .filter((i) => i.filename)
    .filter(filterByQuery)
    .sort((a, b) => new Date(b.startTime) - new Date(a.startTime));

  if (items.length === 0) {
    els.list.innerHTML = '';
    els.empty.classList.remove('hidden');
    return;
  }
  els.empty.classList.add('hidden');

  const groups = groupByDay(items);
  const frag = document.createDocumentFragment();
  for (const [label, group] of groups) {
    const header = document.createElement('div');
    header.className = 'group-header';
    header.textContent = label;
    frag.appendChild(header);
    for (const item of group) frag.appendChild(renderCard(item));
  }
  els.list.replaceChildren(frag);
}

function filterByQuery(item) {
  if (!state.query) return true;
  const q = state.query.toLowerCase();
  return (
    basename(item.filename).toLowerCase().includes(q) ||
    (item.url || '').toLowerCase().includes(q) ||
    (item.referrer || '').toLowerCase().includes(q)
  );
}

function groupByDay(items) {
  const now = new Date();
  const today = startOfDay(now);
  const yesterday = new Date(today.getTime() - 86400000);
  const weekAgo = new Date(today.getTime() - 7 * 86400000);

  const buckets = new Map();
  for (const item of items) {
    const t = new Date(item.startTime);
    let key;
    if (t >= today) key = '今天';
    else if (t >= yesterday) key = '昨天';
    else if (t >= weekAgo) key = '本周';
    else key = formatMonth(t);
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(item);
  }
  return buckets;
}

function startOfDay(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

function renderCard(item) {
  const card = document.createElement('div');
  card.className = 'card';
  card.dataset.id = String(item.id);

  const icon = document.createElement('div');
  icon.className = 'card-icon';
  const cachedIcon = iconCache.get(item.id);
  if (cachedIcon) {
    const img = document.createElement('img');
    img.src = cachedIcon;
    img.alt = '';
    icon.appendChild(img);
  } else {
    icon.textContent = fileEmoji(item);
    chrome.downloads.getFileIcon(item.id, { size: 32 }, (url) => {
      if (!url) return;
      iconCache.set(item.id, url);
      const img = document.createElement('img');
      img.src = url;
      img.alt = '';
      icon.replaceChildren(img);
    });
  }
  card.appendChild(icon);

  const body = document.createElement('div');
  body.className = 'card-body';

  const title = document.createElement('div');
  title.className = 'card-title';
  title.textContent = basename(item.filename) || '(未命名)';
  if (item.state === 'complete' && item.exists !== false) {
    title.addEventListener('click', () => sendMsg({ type: 'open', id: item.id }));
  }
  if (item.exists === false) {
    const tag = document.createElement('span');
    tag.className = 'state-tag';
    tag.textContent = '文件已丢失';
    title.appendChild(tag);
  }
  if (item.danger && item.danger !== 'safe' && item.danger !== 'accepted') {
    const tag = document.createElement('span');
    tag.className = 'state-tag danger';
    tag.textContent = '危险文件';
    title.appendChild(tag);
  }
  body.appendChild(title);

  const meta = document.createElement('div');
  meta.className = 'card-meta';
  meta.textContent = formatMeta(item);
  body.appendChild(meta);

  if (item.state === 'in_progress' && !item.paused) {
    body.appendChild(renderProgress(item));
  } else if (item.state === 'in_progress' && item.paused) {
    body.appendChild(renderPausedBar(item));
  }

  card.appendChild(body);

  const actions = document.createElement('div');
  actions.className = 'card-actions';
  buildActions(item, actions, card);
  card.appendChild(actions);

  return card;
}

function renderProgress(item) {
  const wrap = document.createElement('div');
  wrap.className = 'card-progress';
  const bar = document.createElement('div');
  bar.className = 'progress-bar';
  const fill = document.createElement('div');
  fill.className = 'progress-fill';
  const total = effectiveTotal(item);
  if (total > 0) {
    const pct = Math.min(100, Math.round((item.bytesReceived / total) * 100));
    fill.style.width = `${pct}%`;
  }
  bar.appendChild(fill);
  wrap.appendChild(bar);

  const text = document.createElement('div');
  text.className = 'progress-text';
  text.textContent = formatProgress(item);
  wrap.appendChild(text);
  return wrap;
}

function renderPausedBar(item) {
  const wrap = document.createElement('div');
  wrap.className = 'card-progress';
  const text = document.createElement('div');
  text.className = 'progress-text';
  text.textContent = formatProgress(item);
  wrap.appendChild(text);
  return wrap;
}

function buildActions(item, container, card) {
  if (item.state === 'in_progress') {
    if (item.paused) {
      addTextBtn(container, '恢复', () => sendMsg({ type: 'resume', id: item.id }));
    } else {
      addTextBtn(container, '暂停', () => sendMsg({ type: 'pause', id: item.id }));
    }
    addTextBtn(container, '取消', () => sendMsg({ type: 'cancel', id: item.id }));
    addOverflow(container, item, card);
    return;
  }

  if (item.state === 'complete' && item.exists !== false) {
    addTextBtn(container, '在文件夹中显示', () => sendMsg({ type: 'show', id: item.id }));
  }
  addOverflow(container, item, card);
}

function redownload(item) {
  if (!item.url) {
    showSnackbar('无下载链接');
    return;
  }
  chrome.downloads.download({ url: item.url }, () => {
    if (chrome.runtime.lastError) {
      showSnackbar(`重新下载失败：${chrome.runtime.lastError.message}`);
    } else {
      showSnackbar('已开始重新下载');
    }
  });
}

function addTextBtn(container, label, handler, opts = {}) {
  const btn = document.createElement('button');
  btn.className = 'text-btn' + (opts.danger ? ' danger' : '');
  btn.textContent = label;
  btn.addEventListener('click', handler);
  container.appendChild(btn);
}

function addOverflow(container, item, card) {
  const btn = document.createElement('button');
  btn.className = 'menu-btn';
  btn.title = '更多操作';
  btn.setAttribute('aria-label', '更多操作');
  btn.innerHTML = '<svg viewBox="0 0 24 24"><circle cx="12" cy="5" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="12" cy="19" r="2"/></svg>';
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    openMenu(btn, item, card);
  });
  container.appendChild(btn);
}

function openMenu(anchor, item, card) {
  closeMenu();
  els.menuOverlay.classList.remove('hidden');

  const menu = document.createElement('div');
  menu.className = 'menu';

  const fileExists = item.exists !== false && item.state === 'complete';
  if (fileExists) {
    addMenuItem(menu, '在文件夹中显示', () => sendMsg({ type: 'show', id: item.id }));
    addMenuItem(menu, '打开', () => sendMsg({ type: 'open', id: item.id }));
  }
  if (item.url) {
    addMenuItem(menu, '复制下载链接', async () => {
      await navigator.clipboard.writeText(item.url);
      showSnackbar('已复制链接');
    });
    addMenuItem(menu, '重新下载', () => redownload(item));
  }

  addDivider(menu);

  if (fileExists || item.state === 'in_progress') {
    addMenuItem(menu, '删除文件', () => deleteItem(item, card, 'full'), { danger: true });
  }
  addMenuItem(menu, '从历史记录中移除', () => deleteItem(item, card, 'record-only'));

  document.body.appendChild(menu);
  positionMenu(menu, anchor);
}

function positionMenu(menu, anchor) {
  const rect = anchor.getBoundingClientRect();
  const menuRect = menu.getBoundingClientRect();
  let top = rect.bottom + window.scrollY + 4;
  let left = rect.right + window.scrollX - menuRect.width;
  if (left < 8) left = 8;
  if (top + menuRect.height > window.scrollY + window.innerHeight) {
    top = rect.top + window.scrollY - menuRect.height - 4;
  }
  menu.style.top = `${top}px`;
  menu.style.left = `${left}px`;
}

function addMenuItem(menu, label, handler, opts = {}) {
  const btn = document.createElement('button');
  btn.className = 'menu-item' + (opts.danger ? ' danger' : '');
  btn.textContent = label;
  btn.addEventListener('click', () => {
    closeMenu();
    handler();
  });
  menu.appendChild(btn);
}

function addDivider(menu) {
  const div = document.createElement('div');
  div.className = 'menu-divider';
  menu.appendChild(div);
}

function closeMenu() {
  els.menuOverlay.classList.add('hidden');
  document.querySelectorAll('.menu').forEach((m) => m.remove());
}

async function deleteItem(item, card, mode) {
  card.classList.add('dimmed');
  const res = await sendMsg({ type: 'delete', id: item.id, mode });
  if (res?.ok) {
    state.items.delete(item.id);
    render();
    showSnackbar(
      mode === 'record-only'
        ? `已移除记录：${basename(item.filename)}`
        : `已删除：${basename(item.filename)}`,
    );
  } else {
    card.classList.remove('dimmed');
    showSnackbar(`删除失败：${res?.error || '未知错误'}`);
  }
}

function showSnackbar(text, action) {
  els.snackbarText.textContent = text;
  els.snackbarAction.classList.add('hidden');
  if (action) {
    els.snackbarAction.textContent = action.label;
    els.snackbarAction.onclick = () => {
      hideSnackbar();
      action.handler();
    };
    els.snackbarAction.classList.remove('hidden');
  }
  els.snackbar.classList.remove('hidden');
  clearTimeout(snackbarTimer);
  snackbarTimer = setTimeout(hideSnackbar, 4000);
}

function hideSnackbar() {
  els.snackbar.classList.add('hidden');
}

function formatMeta(item) {
  const parts = [];
  if (item.state === 'complete') {
    if (item.totalBytes > 0) parts.push(formatBytes(item.totalBytes));
  } else if (item.state === 'interrupted') {
    parts.push(`已中断（${item.error || '未知'}）`);
  }
  const host = safeHost(item.url) || item.referrer || '';
  if (host) parts.push(host);
  if (item.state === 'complete' && item.endTime) {
    parts.push(formatTime(new Date(item.endTime)));
  }
  return parts.join(' · ');
}

function formatTime(d) {
  return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
}

function formatMonth(d) {
  return `${d.getFullYear()}年${d.getMonth() + 1}月`;
}
