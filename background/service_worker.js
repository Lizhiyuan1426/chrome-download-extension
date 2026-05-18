const BROADCAST_THROTTLE_MS = 500;
const UNSEEN_KEY = 'unseenCount';
const pendingChanges = new Map();
let flushTimer = null;
let badgeQueue = Promise.resolve();

refreshBadge();

function refreshBadge() {
  badgeQueue = badgeQueue.then(async () => {
    const active = await chrome.downloads.search({ state: 'in_progress', limit: 100 });
    if (active.length > 0) {
      await chrome.action.setBadgeBackgroundColor({ color: '#1a73e8' });
      await chrome.action.setBadgeText({ text: String(active.length) });
      return;
    }
    const { [UNSEEN_KEY]: unseen = 0 } = await chrome.storage.local.get(UNSEEN_KEY);
    if (unseen > 0) {
      await chrome.action.setBadgeBackgroundColor({ color: '#d93025' });
      await chrome.action.setBadgeText({ text: String(unseen) });
    } else {
      await chrome.action.setBadgeText({ text: '' });
    }
  });
}

function bumpUnseen() {
  badgeQueue = badgeQueue.then(async () => {
    const { [UNSEEN_KEY]: n = 0 } = await chrome.storage.local.get(UNSEEN_KEY);
    await chrome.storage.local.set({ [UNSEEN_KEY]: n + 1 });
  });
  refreshBadge();
}

function clearUnseen() {
  badgeQueue = badgeQueue.then(async () => {
    await chrome.storage.local.set({ [UNSEEN_KEY]: 0 });
  });
  refreshBadge();
}

function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    const payload = Array.from(pendingChanges.values());
    pendingChanges.clear();
    flushTimer = null;
    if (payload.length) broadcast({ type: 'changed', items: payload });
  }, BROADCAST_THROTTLE_MS);
}

function broadcast(message) {
  chrome.runtime.sendMessage(message).catch(() => {});
}

chrome.downloads.onCreated.addListener((item) => {
  broadcast({ type: 'created', item });
  refreshBadge();
});

chrome.downloads.onChanged.addListener((delta) => {
  if (delta.state?.current === 'complete') bumpUnseen();
  else if (delta.state) refreshBadge();
  const prev = pendingChanges.get(delta.id) || { id: delta.id };
  pendingChanges.set(delta.id, { ...prev, ...delta });
  scheduleFlush();
});

chrome.downloads.onErased.addListener((id) => {
  broadcast({ type: 'erased', id });
  refreshBadge();
});

chrome.commands.onCommand.addListener((command) => {
  if (command === 'open-manager') openManager();
});

const DOWNLOADS_URL_RE = /^chrome:\/\/downloads\/?(\?.*)?$/;

chrome.webNavigation.onBeforeNavigate.addListener((details) => {
  if (details.frameId !== 0) return;
  if (DOWNLOADS_URL_RE.test(details.url)) {
    chrome.tabs.update(details.tabId, { url: chrome.runtime.getURL('pages/manager.html') });
  }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (!changeInfo.url) return;
  if (DOWNLOADS_URL_RE.test(changeInfo.url)) {
    chrome.tabs.update(tabId, { url: chrome.runtime.getURL('pages/manager.html') });
  }
});

function openManager() {
  const url = chrome.runtime.getURL('pages/manager.html');
  chrome.tabs.query({ url }, (tabs) => {
    if (tabs && tabs.length > 0) {
      chrome.tabs.update(tabs[0].id, { active: true });
      if (tabs[0].windowId) chrome.windows.update(tabs[0].windowId, { focused: true });
    } else {
      chrome.tabs.create({ url });
    }
  });
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  switch (msg?.type) {
    case 'delete':
      handleDelete(msg.id, msg.mode).then(sendResponse);
      return true;
    case 'open':
      chrome.downloads.open(msg.id);
      sendResponse({ ok: true });
      return false;
    case 'show':
      chrome.downloads.show(msg.id);
      sendResponse({ ok: true });
      return false;
    case 'pause':
      chrome.downloads.pause(msg.id).then(() => sendResponse({ ok: true }))
        .catch((e) => sendResponse({ ok: false, error: String(e) }));
      return true;
    case 'resume':
      chrome.downloads.resume(msg.id).then(() => sendResponse({ ok: true }))
        .catch((e) => sendResponse({ ok: false, error: String(e) }));
      return true;
    case 'cancel':
      chrome.downloads.cancel(msg.id).then(() => sendResponse({ ok: true }))
        .catch((e) => sendResponse({ ok: false, error: String(e) }));
      return true;
    case 'open-manager':
      openManager();
      sendResponse({ ok: true });
      return false;
    case 'clear-badge':
      clearUnseen();
      sendResponse({ ok: true });
      return false;
    case 'redownload':
      if (!msg.url) { sendResponse({ ok: false, error: 'no_url' }); return false; }
      chrome.downloads.download({ url: msg.url }, (id) => {
        if (chrome.runtime.lastError) sendResponse({ ok: false, error: chrome.runtime.lastError.message });
        else sendResponse({ ok: true, id });
      });
      return true;
  }
  return false;
});

async function handleDelete(id, mode) {
  try {
    const [item] = await chrome.downloads.search({ id });
    if (!item) return { ok: false, error: 'not_found' };

    if (mode === 'record-only') {
      await chrome.downloads.erase({ id });
      return { ok: true, mode: 'record-only' };
    }

    if (item.state === 'in_progress') {
      try { await chrome.downloads.cancel(id); } catch (_) {}
    }

    if (item.exists !== false) {
      try {
        await chrome.downloads.removeFile(id);
      } catch (e) {
        const msg = String(e?.message || e);
        if (!/doesn't exist|File already removed/i.test(msg)) {
          return { ok: false, error: msg, stage: 'removeFile' };
        }
      }
    }

    await chrome.downloads.erase({ id });
    return { ok: true, mode: 'full' };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
}
