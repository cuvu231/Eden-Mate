const DEFAULT_SETTINGS = { notifications: true, sound: true, muteAlarmWhenViewingChat: true, alertSound: 'classic', repeatAlarm: false, volume: 0.5 };
const OFFSCREEN_URL = chrome.runtime.getURL('offscreen.html');
let creatingOffscreen;

async function getOffscreenContexts() {
  if (chrome.runtime.getContexts) return chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'], documentUrls: [OFFSCREEN_URL] });
  const contexts = await self.clients.matchAll();
  return contexts.filter(context => context.url === OFFSCREEN_URL);
}
async function ensureOffscreen() {
  if ((await getOffscreenContexts()).length) return;
  if (!creatingOffscreen) creatingOffscreen = chrome.offscreen.createDocument({
    url: 'offscreen.html', reasons: ['AUDIO_PLAYBACK'],
    justification: 'Play response-complete audio reliably while Eden Chat is in a background tab.'
  }).finally(() => { creatingOffscreen = undefined; });
  await creatingOffscreen;
}
async function sendOffscreen(message) {
  if (!(await getOffscreenContexts()).length) return;
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      const reply = await chrome.runtime.sendMessage({ type: 'ping', target: 'eden-offscreen' });
      if (reply?.ready) break;
    } catch (_) {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  return chrome.runtime.sendMessage({ ...message, target: 'eden-offscreen' });
}
async function getRepeatingTabs() {
  const { repeatingTabs = [] } = await chrome.storage.session.get({ repeatingTabs: [] });
  return [...new Set(repeatingTabs.filter(Number.isInteger))];
}
async function setRepeatingTabs(tabIds) {
  const unique = [...new Set(tabIds.filter(Number.isInteger))];
  await chrome.storage.session.set({ repeatingTabs: unique });
  if (!unique.length) {
    await sendOffscreen({ type: 'stop-repeat' });
    if ((await getOffscreenContexts()).length) await chrome.offscreen.closeDocument();
  }
}
async function startRepeat(tabId, volume, soundType) {
  const tabs = await getRepeatingTabs();
  await chrome.storage.session.set({ repeatingTabs: [...new Set([...tabs, tabId])] });
  await ensureOffscreen();
  await sendOffscreen({ type: 'start-repeat', volume, soundType });
}
async function playOnce(volume, soundType) {
  await ensureOffscreen();
  await sendOffscreen({ type: 'play-once', volume, soundType });
}
function showNotification(id, title, message) {
  chrome.notifications.create(id, { type: 'basic', iconUrl: 'icon.png', title, message, priority: 1 }, () => { void chrome.runtime.lastError; });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const tabId = sender.tab?.id;
  if (message?.type === 'eden-open-last-chat') {
    (async () => {
      const { lastUsedConversation: recent } = await chrome.storage.local.get({ lastUsedConversation: null });
      if (!recent?.url || !recent?.conversationId) { sendResponse({ ok: false }); return; }
      const targetUrl = new URL(recent.url);
      if (targetUrl.origin !== 'https://www.eden-chat.com' || targetUrl.pathname !== '/chat') { sendResponse({ ok: false }); return; }
      const tabs = await chrome.tabs.query({ url: 'https://www.eden-chat.com/*' });
      const existing = tabs.find(tab => {
        try {
          const url = new URL(tab.url);
          const id = url.searchParams.get('conversation') || url.searchParams.get('conversationId') || url.searchParams.get('conversation_id') || url.searchParams.get('chatId');
          return id === recent.conversationId;
        } catch (_) { return false; }
      });
      if (existing?.id !== undefined) {
        try { await chrome.windows.update(existing.windowId, { focused: true }); } catch (_) {}
        await chrome.tabs.update(existing.id, { active: true });
      } else {
        await chrome.tabs.create({ url: targetUrl.href, active: true });
      }
      sendResponse({ ok: true });
    })().catch(() => sendResponse({ ok: false }));
    return true;
  }
  if (message?.type === 'eden-chat-active-conversation') {
    try {
      const url = new URL(message.url || sender.tab?.url || '');
      const conversationId = String(message.conversationId || '').trim();
      if (url.origin !== 'https://www.eden-chat.com' || url.pathname !== '/chat' || !conversationId) return;
      const title = String(message.title || '').trim().slice(0, 180) || 'Eden Chat 대화방';
      chrome.storage.local.set({ lastUsedConversation: { conversationId, url: url.href, title, usedAt: Number(message.usedAt) || Date.now() } });
    } catch (_) {}
    return;
  }
  if (message?.type === 'eden-chat-repeat-stop') {
    if (Number.isInteger(tabId)) getRepeatingTabs().then(tabs => setRepeatingTabs(tabs.filter(id => id !== tabId))).catch(() => {});
    return;
  }
  if (message?.type !== 'eden-chat-complete') return;
  chrome.storage.local.get({ settings: DEFAULT_SETTINGS }, ({ settings }) => {
    const current = { ...DEFAULT_SETTINGS, ...settings };
    if (current.notifications) showNotification(`eden-${tabId ?? 'tab'}-${Date.now()}`, 'Eden Chat 응답 완료', message.preview || '새 응답이 도착했어요.');
    const volume = Math.max(0, Math.min(1, Number(message.volume ?? current.volume) || 0));
    const soundType = message.soundType === 'tinglong' ? 'tinglong' : current.alertSound;
    const soundEnabled = !!current.sound && message.sound !== false;
    const shouldRepeat = Number.isInteger(tabId) && !!message.repeat && !!current.repeatAlarm && soundEnabled && volume > 0;
    if (shouldRepeat) startRepeat(tabId, volume, soundType).catch(() => {});
    else if (soundEnabled && volume > 0) playOnce(volume, soundType).catch(() => {});
  });
});

chrome.tabs.onRemoved.addListener(tabId => getRepeatingTabs().then(tabs => setRepeatingTabs(tabs.filter(id => id !== tabId))).catch(() => {}));
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes.settings) return;
  const settings = { ...DEFAULT_SETTINGS, ...changes.settings.newValue };
  if (!settings.repeatAlarm || !settings.sound || Number(settings.volume) <= 0) setRepeatingTabs([]);
  else sendOffscreen({ type: 'set-volume', volume: Number(settings.volume), soundType: settings.alertSound }).catch(() => {});
});
