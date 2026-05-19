const MAX_RECENT = 8;

const state = { items: new Map() };
const iconCache = new Map();

const els = {
  activeSection: document.getElementById('active-section'),
  activeList: document.getElementById('active-list'),
  recentSection: document.getElementById('recent-section'),
  recentList: document.getElementById('recent-list'),
  empty: document.getElementById('empty'),
  openManager: document.getElementById('open-manager'),
  openManagerFooter: document.getElementById('open-manager-footer'),
  menuOverlay: document.getElementById('menu-overlay'),
  snackbar: document.getElementById('snackbar'),
  snackbarText: document.getElementById('snackbar-text'),
};

let snackbarTimer = null;

init();

async function init() {
  els.openManager.addEventListener('click', openManager);
  els.openManagerFooter.addEventListener('click', openManager);

  chrome.runtime.onMessage.addListener(handleWorkerMessage);

  document.addEventListener('click', (e) => {
    if (!document.querySelector('.menu')) return;
    if (e.target.closest('.menu')) return;
    e.stopPropagation();
    closeMenu();
  }, true);
  els.menuOverlay.addEventListener('click', () => closeMenu());

  sendMsg({ type: 'clear-badge' });

  const list = await chrome.downloads.search({
    orderBy: ['-startTime'],
    limit: 50,
  });
  for (const item of list) state.items.set(item.id, item);
  render();

  const pollTimer = setInterval(pollActive, 1000);
  window.addEventListener('unload', () => clearInterval(pollTimer));
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

function openManager() {
  chrome.runtime.sendMessage({ type: 'open-manager' }, () => window.close());
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
  const all = Array.from(state.items.values())
    .filter((i) => i.filename)
    .sort((a, b) => new Date(b.startTime) - new Date(a.startTime));

  const active = all.filter((i) => i.state === 'in_progress');
  const recent = all.filter((i) => i.state !== 'in_progress').slice(0, MAX_RECENT);

  if (active.length === 0 && recent.length === 0) {
    els.activeSection.classList.add('hidden');
    els.recentSection.classList.add('hidden');
    els.empty.classList.remove('hidden');
    return;
  }
  els.empty.classList.add('hidden');

  if (active.length > 0) {
    els.activeSection.classList.remove('hidden');
    els.activeList.replaceChildren(...active.map(renderActiveRow));
  } else {
    els.activeSection.classList.add('hidden');
  }

  if (recent.length > 0) {
    els.recentSection.classList.remove('hidden');
    els.recentList.replaceChildren(...recent.map(renderRecentRow));
  } else {
    els.recentSection.classList.add('hidden');
  }
}

function renderActiveRow(item) {
  const row = document.createElement('div');
  row.className = 'row';
  row.appendChild(renderIcon(item));

  const body = document.createElement('div');
  body.className = 'row-body';

  const title = document.createElement('div');
  title.className = 'row-title';
  title.textContent = basename(item.filename);
  body.appendChild(title);

  const meta = document.createElement('div');
  meta.className = 'row-meta';
  meta.textContent = formatProgress(item);
  body.appendChild(meta);

  const progress = document.createElement('div');
  progress.className = 'row-progress';
  const fill = document.createElement('div');
  fill.className = 'row-progress-fill';
  const total = effectiveTotal(item);
  if (total > 0) {
    const pct = Math.min(100, Math.round((item.bytesReceived / total) * 100));
    fill.style.width = `${pct}%`;
  }
  progress.appendChild(fill);
  body.appendChild(progress);

  row.appendChild(body);

  const actions = document.createElement('div');
  actions.className = 'row-actions';
  if (item.paused) {
    actions.appendChild(iconBtn('恢复', 'M8 5v14l11-7z', () =>
      sendMsg({ type: 'resume', id: item.id }),
    ));
  } else {
    actions.appendChild(iconBtn('暂停', 'M6 19h4V5H6v14zm8-14v14h4V5h-4z', () =>
      sendMsg({ type: 'pause', id: item.id }),
    ));
  }
  actions.appendChild(iconBtn('取消', 'M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z', () =>
    sendMsg({ type: 'cancel', id: item.id }),
  ));
  row.appendChild(actions);

  return row;
}

function renderRecentRow(item) {
  const row = document.createElement('div');
  row.className = 'row';
  const canOpen = item.state === 'complete' && item.exists !== false;
  if (canOpen) {
    row.style.cursor = 'pointer';
    row.addEventListener('click', () => {
      chrome.downloads.open(item.id);
      window.close();
    });
  }
  row.appendChild(renderIcon(item));

  const body = document.createElement('div');
  body.className = 'row-body';

  const title = document.createElement('div');
  title.className = 'row-title';
  title.textContent = basename(item.filename);
  body.appendChild(title);

  const meta = document.createElement('div');
  meta.className = 'row-meta';
  meta.textContent = formatMeta(item);
  body.appendChild(meta);

  row.appendChild(body);

  const actions = document.createElement('div');
  actions.className = 'row-actions';
  const overflow = iconBtn(
    '更多操作',
    'M12 8c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zm0 2c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm0 6c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2z',
    (e) => {
      e.stopPropagation();
      openMenu(overflow, item, row);
    },
  );
  actions.appendChild(overflow);
  row.appendChild(actions);

  return row;
}

function redownload(item) {
  if (!item.url) {
    showSnackbar('无下载链接');
    return;
  }
  sendMsg({ type: 'redownload', url: item.url });
  window.close();
}

function renderIcon(item) {
  const icon = document.createElement('div');
  icon.className = 'row-icon';
  const cached = iconCache.get(item.id);
  if (cached) {
    const img = document.createElement('img');
    img.src = cached;
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
  return icon;
}

function iconBtn(title, svgPath, onClick) {
  const btn = document.createElement('button');
  btn.className = 'mini-btn';
  btn.title = title;
  btn.setAttribute('aria-label', title);
  btn.innerHTML = `<svg viewBox="0 0 24 24"><path d="${svgPath}"/></svg>`;
  btn.addEventListener('click', onClick);
  return btn;
}

function openMenu(anchor, item, row) {
  closeMenu();
  els.menuOverlay.classList.remove('hidden');

  const menu = document.createElement('div');
  menu.className = 'menu';

  const fileExists = item.exists !== false && item.state === 'complete';
  if (fileExists) {
    addMenuItem(menu, '打开', () => {
      chrome.downloads.open(item.id);
      window.close();
    });
    addMenuItem(menu, '在文件夹中显示', () => {
      chrome.downloads.show(item.id);
      window.close();
    });
  }
  if (item.url) {
    addMenuItem(menu, '复制下载链接', async () => {
      await navigator.clipboard.writeText(item.url);
      showSnackbar('已复制链接');
    });
    addMenuItem(menu, '重新下载', () => redownload(item));
  }

  addDivider(menu);

  if (fileExists) {
    addMenuItem(menu, '删除文件', () => deleteItem(item, row, 'full'), { danger: true });
  }
  addMenuItem(menu, '从历史记录中移除', () => deleteItem(item, row, 'record-only'));

  document.body.appendChild(menu);
  positionMenu(menu, anchor);
}

function positionMenu(menu, anchor) {
  const rect = anchor.getBoundingClientRect();
  const menuRect = menu.getBoundingClientRect();
  let top = rect.bottom + 4;
  let left = rect.right - menuRect.width;
  if (left < 4) left = 4;
  if (top + menuRect.height > window.innerHeight - 4) {
    top = rect.top - menuRect.height - 4;
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
  const d = document.createElement('div');
  d.className = 'menu-divider';
  menu.appendChild(d);
}

function closeMenu() {
  els.menuOverlay.classList.add('hidden');
  document.querySelectorAll('.menu').forEach((m) => m.remove());
}

async function deleteItem(item, row, mode) {
  row.style.opacity = '0.5';
  row.style.pointerEvents = 'none';
  const res = await sendMsg({ type: 'delete', id: item.id, mode });
  if (res?.ok) {
    state.items.delete(item.id);
    render();
    showSnackbar(mode === 'record-only' ? '已移除记录' : '已删除');
  } else {
    row.style.opacity = '';
    row.style.pointerEvents = '';
    showSnackbar(`删除失败：${res?.error || '未知错误'}`);
  }
}

function showSnackbar(text) {
  els.snackbarText.textContent = text;
  els.snackbar.classList.remove('hidden');
  clearTimeout(snackbarTimer);
  snackbarTimer = setTimeout(() => els.snackbar.classList.add('hidden'), 2500);
}

function formatMeta(item) {
  const parts = [];
  if (item.state === 'complete' && item.totalBytes > 0) parts.push(formatBytes(item.totalBytes));
  else if (item.state === 'interrupted') parts.push('已中断');
  const host = safeHost(item.url);
  if (host) parts.push(host);
  return parts.join(' · ');
}

