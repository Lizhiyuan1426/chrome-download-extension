function basename(path) {
  if (!path) return '';
  return path.replace(/\\/g, '/').split('/').pop();
}

function fileEmoji(item) {
  const name = basename(item.filename).toLowerCase();
  const mime = item.mime || '';
  if (mime.startsWith('image/') || /\.(png|jpe?g|gif|webp|svg|bmp)$/.test(name)) return '🖼';
  if (mime.startsWith('video/') || /\.(mp4|mov|mkv|avi|webm)$/.test(name)) return '🎬';
  if (mime.startsWith('audio/') || /\.(mp3|wav|flac|aac|m4a)$/.test(name)) return '🎵';
  if (/\.(zip|tar|gz|7z|rar|bz2)$/.test(name)) return '📦';
  if (/\.pdf$/.test(name)) return '📕';
  if (/\.(doc|docx)$/.test(name)) return '📄';
  if (/\.(xls|xlsx|csv)$/.test(name)) return '📊';
  if (/\.(ppt|pptx)$/.test(name)) return '📈';
  if (/\.(exe|dmg|pkg|deb|rpm|msi)$/.test(name)) return '⚙';
  return '📄';
}

function formatBytes(n) {
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(n >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}

function formatETA(item) {
  if (!item.estimatedEndTime) return '';
  const remain = (new Date(item.estimatedEndTime).getTime() - Date.now()) / 1000;
  if (remain <= 0 || !Number.isFinite(remain)) return '';
  if (remain < 60) return ` · 剩余 ${Math.ceil(remain)}秒`;
  if (remain < 3600) return ` · 剩余 ${Math.ceil(remain / 60)}分钟`;
  return ` · 剩余 ${Math.ceil(remain / 3600)}小时`;
}

function effectiveTotal(item) {
  if (item.totalBytes > 0) return item.totalBytes;
  if (item.fileSize > 0) return item.fileSize;
  return 0;
}

function formatProgress(item) {
  const received = formatBytes(item.bytesReceived);
  const total = effectiveTotal(item);
  if (item.paused) {
    return total > 0
      ? `已暂停 · ${received} / ${formatBytes(total)}`
      : `已暂停 · 已下载 ${received}`;
  }
  if (total > 0) {
    const pct = Math.min(100, Math.round((item.bytesReceived / total) * 100));
    return `${pct}% · ${received} / ${formatBytes(total)}${formatETA(item)}`;
  }
  return `已下载 ${received}${formatETA(item)}`;
}

function safeHost(url) {
  if (!url) return '';
  try { return new URL(url).host; } catch { return ''; }
}

function sendMsg(msg) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(msg, (res) => {
      if (chrome.runtime.lastError) resolve({ ok: false, error: chrome.runtime.lastError.message });
      else resolve(res);
    });
  });
}

function hasProgressChanged(a, b) {
  return a.bytesReceived !== b.bytesReceived ||
         a.totalBytes !== b.totalBytes ||
         a.fileSize !== b.fileSize ||
         a.paused !== b.paused ||
         a.state !== b.state ||
         a.estimatedEndTime !== b.estimatedEndTime;
}

function mergeDelta(existing, delta) {
  const merged = { ...existing };
  for (const [k, v] of Object.entries(delta)) {
    if (k === 'id') continue;
    if (v && typeof v === 'object' && 'current' in v) merged[k] = v.current;
  }
  return merged;
}
