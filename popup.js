const defaults = { notifications: true, sound: true, muteAlarmWhenViewingChat: true, repeatAlarm: false, volume: 0.5, prefixes: [], prefixEnabled: true, autoInsertOnComposerClick: false, showConversationStats: false, fontFamily: "'Pretendard Variable', Pretendard, Arial, 'Malgun Gothic', sans-serif", extensionTheme: 'auto' };
const $ = id => document.getElementById(id);
let lastUsedConversation = null;
chrome.storage.local.get({ settings: defaults, lastUsedConversation: null }, ({ settings, lastUsedConversation: lastUsed }) => {
  const data = { ...defaults, ...settings };
  const font = "'Pretendard Variable', Pretendard, Arial, 'Malgun Gothic', sans-serif";
  document.documentElement.style.setProperty('--eden-font', font);
  document.body.style.fontFamily = font;
  applyTheme(data.extensionTheme);
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { if ((data.extensionTheme || 'auto') === 'auto') applyTheme('auto'); });
  ['notifications', 'sound', 'repeatAlarm', 'muteAlarmWhenViewingChat', 'prefixEnabled', 'autoInsertOnComposerClick', 'showConversationStats'].forEach(key => {
    $(key).checked = key === 'muteAlarmWhenViewingChat' || key === 'prefixEnabled' ? data[key] !== false : !!data[key];
  });
  lastUsedConversation = lastUsed;
  renderLastChat(lastUsed);
  if (!lastUsed) findCurrentChatTab().then(tab => {
    const info = tab && getChatInfo(tab.url, tab.title);
    if (info) { lastUsedConversation = info; renderLastChat(info); chrome.storage.local.set({ lastUsedConversation: info }); }
  }).catch(() => {});
  const list = $('prefixList');
  if (!data.prefixes.length) list.innerHTML = '<div class="empty">아직 등록된 문구가 없어요.<br><b>프리셋 편집</b>에서 첫 문구를 만들어보세요.</div>';
  else list.innerHTML = data.prefixes.slice(0, 3).map(item => `<div class="prefix-item"><span class="prefix-name">${escapeHtml(item.name || '빠른 문구')}</span><kbd>${escapeHtml((item.shortcut || '').toUpperCase().replaceAll('+', ' + '))}</kbd></div>`).join('');
});
function save(key, value) { chrome.storage.local.get({ settings: defaults }, ({ settings }) => chrome.storage.local.set({ settings: { ...defaults, ...settings, [key]: value } })); }
['notifications', 'sound', 'repeatAlarm', 'muteAlarmWhenViewingChat', 'prefixEnabled', 'autoInsertOnComposerClick', 'showConversationStats'].forEach(key => {
  $(key).addEventListener('change', event => save(key, event.target.checked));
});
function openSettings(page) { chrome.tabs.create({ url: chrome.runtime.getURL(`options.html#${page}`) }); }
$('openSettings').addEventListener('click', () => openSettings('general'));
$('openOptions').addEventListener('click', () => openSettings('prefixes'));
$('openLastChat').addEventListener('click', () => { openLastUsedConversation().catch(() => { $('lastChatName').textContent = '채팅방을 여는 중 문제가 생겼어요.'; }); });
function escapeHtml(value) { const div = document.createElement('div'); div.textContent = value; return div.innerHTML; }
function renderLastChat(info) {
  const button = $('openLastChat');
  button.disabled = !info?.url;
  $('lastChatName').textContent = info?.title || 'Eden Chat에서 채팅방을 열면 여기에 표시돼요.';
}
function getChatInfo(rawUrl, title) {
  try {
    const url = new URL(rawUrl);
    if (url.origin !== 'https://www.eden-chat.com' || url.pathname !== '/chat') return null;
    const conversationId = url.searchParams.get('conversation') || url.searchParams.get('conversationId') || url.searchParams.get('conversation_id') || url.searchParams.get('chatId');
    if (!conversationId || ['new', 'null', 'undefined'].includes(conversationId.toLowerCase())) return null;
    return { conversationId, url: url.href, title: String(title || '').trim().slice(0, 180) || 'Eden Chat 대화방', usedAt: Date.now() };
  } catch { return null; }
}
async function findCurrentChatTab() {
  const tabs = await chrome.tabs.query({ url: 'https://www.eden-chat.com/*' });
  return tabs.filter(tab => getChatInfo(tab.url, tab.title)).sort((a, b) => Number(!!b.active) - Number(!!a.active) || (b.lastAccessed || 0) - (a.lastAccessed || 0))[0];
}
async function openLastUsedConversation() {
  if (!lastUsedConversation?.url) return;
  chrome.runtime.sendMessage({ type: 'eden-open-last-chat' }, response => {
    if (chrome.runtime.lastError || !response?.ok) {
      $('lastChatName').textContent = '채팅방을 열 수 없어요. Eden Chat에서 먼저 대화를 열어주세요.';
    }
  });
}
function applyTheme(mode = 'auto') {
  const theme = mode === 'dark' || (mode === 'auto' && window.matchMedia('(prefers-color-scheme: dark)').matches) ? 'dark' : 'light';
  document.body.dataset.theme = theme;
  document.documentElement.dataset.theme = theme;
}
