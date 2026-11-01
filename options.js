const defaults = {
  notifications: true,
  sound: true,
  muteAlarmWhenViewingChat: true,
  alertSound: 'classic',
  repeatAlarm: false,
  volume: 0.5,
  prefixes: [],
  activePrefixId: '',
  fontFamily: "'Pretendard Variable', Pretendard, Arial, 'Malgun Gothic', sans-serif",
  pickerSide: 'right',
  extensionTheme: 'auto',
  pickerTheme: 'auto',
  prefixEnabled: true,
  autoInsertOnComposerClick: false,
  showConversationCost: true,
  showConversationStats: false,
  collectConversationStats: true,
  showConversationDuration: true,
  showUserMessageCount: true,
};
let settings = { ...defaults };
let previewContext;
let previewTinglongBuffer;
let selectedPrefixIds = new Set();
let pendingDeleteAction;
let previousFocus;
let confirmCloseTimer;
const $ = id => document.getElementById(id);

function makeId() { return globalThis.crypto?.randomUUID?.() || `prefix-${Date.now()}-${Math.random().toString(36).slice(2)}`; }
chrome.storage.local.get({ settings: defaults, settingsMigration: 0 }, result => {
  settings = { ...defaults, ...result.settings };
  let changed = false;
  if (result.settingsMigration < 1) {
    if (settings.volume === 0.55) { settings.volume = 0.5; changed = true; }
    chrome.storage.local.set({ settingsMigration: 1 });
  }
  if (result.settingsMigration < 2) {
    settings.showConversationStats = false;
    settings.showConversationCost = true;
    settings.showConversationDuration = true;
    settings.showUserMessageCount = true;
    chrome.storage.local.set({ settingsMigration: 2 });
    changed = true;
  }
  if (result.settingsMigration < 3) {
    settings.collectConversationStats = true;
    chrome.storage.local.set({ settingsMigration: 3 });
    changed = true;
  }
  if (settings.fontFamily !== defaults.fontFamily) { settings.fontFamily = defaults.fontFamily; changed = true; }
  if ('repeatInterval' in settings) { delete settings.repeatInterval; changed = true; }
  for (const obsoleteKey of ['autoPrefixOnFirstInput', 'autoPrefixAfterResponse', 'autoInsertEveryNChats']) {
    if (obsoleteKey in settings) { delete settings[obsoleteKey]; changed = true; }
  }
  settings.prefixes = settings.prefixes.map(item => {
    if (item.id) return item;
    changed = true; return { ...item, id: makeId() };
  });
  if (!settings.activePrefixId && settings.prefixes[0]) { settings.activePrefixId = settings.prefixes[0].id; changed = true; }
  if (changed) chrome.storage.local.set({ settings });
  render();
});

function persist() {
  chrome.storage.local.set({ settings }, () => {
    $('saveStatus').textContent = '저장했어요';
    clearTimeout(persist.timer); persist.timer = setTimeout(() => $('saveStatus').textContent = '일반 설정은 자동 저장돼요 · 접두사는 저장 버튼을 눌러주세요', 1400);
  });
}
function applyFont() {
  document.documentElement.style.setProperty('--eden-font', defaults.fontFamily);
  document.body.style.fontFamily = defaults.fontFamily;
}
function applyExtensionTheme() {
  const dark = settings.extensionTheme === 'dark' || (settings.extensionTheme === 'auto' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.body.dataset.theme = dark ? 'dark' : 'light';
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
}function updateVolumeTrack() {
  $('volume').style.setProperty('--volume-progress', `${Number($('volume').value) * 100}%`);
}
function renderChoices() {
  document.querySelectorAll('.choice-picker').forEach(picker => {
    const key = picker.dataset.setting;
    const value = settings[key] ?? defaults[key];
    const option = picker.querySelector(`.choice-option[data-value="${value}"]`) || picker.querySelector('.choice-option');
    orderChoiceOptions(picker, option);
  });
}
function orderChoiceOptions(picker, selected) {
  const menu = picker.querySelector('.choice-menu');
  [...menu.querySelectorAll('.choice-option')]
    .sort((a, b) => a === selected ? -1 : b === selected ? 1 : Number(a.dataset.order || 0) - Number(b.dataset.order || 0))
    .forEach(item => { menu.append(item); item.setAttribute('aria-selected', String(item === selected)); });
  picker.dataset.value = selected.dataset.value;
  picker.querySelector('.choice-current').textContent = selected.querySelector('span').textContent;
}
function render() {
  $('notifications').checked = settings.notifications;
  $('sound').checked = settings.sound;
  $('muteAlarmWhenViewingChat').checked = settings.muteAlarmWhenViewingChat !== false;
  $('repeatAlarm').checked = settings.repeatAlarm;
  $('autoInsertOnComposerClick').checked = !!settings.autoInsertOnComposerClick;
  $('showConversationCost').checked = !!settings.showConversationCost;
  $('showConversationStats').checked = settings.showConversationStats !== false;
  $('collectConversationStats').checked = settings.collectConversationStats !== false;
  $('showConversationDuration').checked = settings.showConversationDuration !== false;
  $('showUserMessageCount').checked = settings.showUserMessageCount !== false;
  updateConversationStatsControls();
  $('volume').value = settings.volume;
  $('volumeValue').value = Math.round(settings.volume * 100);
  updateVolumeTrack();

  applyFont();
  applyExtensionTheme();
  renderChoices();
  renderSavedPresets();
  $('prefixEditor').hidden = true;
  $('emptyState').hidden = settings.prefixes.length > 0;
}
function renderSavedPresets() {
  const list = $('savedPresetList'); list.replaceChildren();
  const savedIds = new Set(settings.prefixes.map(item => item.id));
  selectedPrefixIds = new Set([...selectedPrefixIds].filter(id => savedIds.has(id)));
  settings.prefixes.forEach(item => {
    const row = document.createElement('div'); row.className = 'saved-preset-row';
    const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.className = 'preset-select-checkbox'; checkbox.checked = selectedPrefixIds.has(item.id); checkbox.setAttribute('aria-label', `${item.name || '이름 없는 프리셋'} 선택`);
    checkbox.addEventListener('change', () => {
      if (checkbox.checked) selectedPrefixIds.add(item.id); else selectedPrefixIds.delete(item.id);
      updateBulkControls();
    });
    const select = document.createElement('button'); select.type = 'button'; select.className = 'saved-preset-select';
    const name = document.createElement('strong'); name.textContent = item.name || '이름 없는 프리셋';
    const preview = document.createElement('small'); preview.textContent = item.text || '문구 없음';
    const details = document.createElement('span'); details.className = 'saved-preset-details'; details.append(name, preview);
    select.append(details);
    if (item.id === settings.activePrefixId) { const active = document.createElement('span'); active.className = 'active-tag'; active.textContent = '사용 중'; select.append(active); }
    select.addEventListener('click', () => openPresetEditor(item));
    const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'trash-button'; remove.title = '프리셋 삭제'; remove.setAttribute('aria-label', `${item.name || '이름 없는 프리셋'} 삭제`); remove.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M10 11v6m4-6v6M6 7l1 14h10l1-14M9 7V4h6v3"/></svg>';
    remove.addEventListener('click', () => requestPresetDeletion([item.id]));
    row.append(checkbox, select, remove); list.append(row);
  });
  updateBulkControls();
}
function updateConversationStatsControls() {
  const disabled = !settings.showConversationStats;
  ['showConversationCost', 'showConversationDuration', 'showUserMessageCount'].forEach(id => {
    const input = $(id);
    const row = input.closest('.settings-line');
    input.disabled = disabled;
    row.classList.toggle('is-disabled', disabled);
    row.setAttribute('aria-disabled', String(disabled));
  });
}
function updateBulkControls() {
  const count = selectedPrefixIds.size;
  const all = $('selectAllPresets');
  all.checked = settings.prefixes.length > 0 && count === settings.prefixes.length;
  all.indeterminate = count > 0 && count < settings.prefixes.length;
  all.disabled = settings.prefixes.length === 0;
  $('deleteSelectedPresets').disabled = count === 0;
  $('deleteSelectedPresets').textContent = count ? `선택 삭제 (${count})` : '선택 삭제';
}
function requestPresetDeletion(ids) {
  const presets = settings.prefixes.filter(item => ids.includes(item.id));
  if (!presets.length) return;
  $('confirmTitle').textContent = '정말 삭제하시겠습니까?';
  $('confirmMessage').textContent = ids.length === 1
    ? `“${presets[0].name || '이름 없는 프리셋'}” 프리셋을 삭제합니다.`
    : '선택한 프리셋이 모두 삭제됩니다.';
  pendingDeleteAction = () => deletePresets(presets.map(item => item.id));
  previousFocus = document.activeElement;
  const dialog = $('confirmDialog');
  clearTimeout(confirmCloseTimer);
  dialog.hidden = false; dialog.classList.remove('is-open');
  requestAnimationFrame(() => requestAnimationFrame(() => { if (!dialog.hidden) dialog.classList.add('is-open'); }));
  $('confirmDelete').focus();
}
function closeDeleteConfirmation() {
  const dialog = $('confirmDialog');
  dialog.classList.remove('is-open');
  pendingDeleteAction = undefined;
  clearTimeout(confirmCloseTimer);
  confirmCloseTimer = setTimeout(() => {
    dialog.hidden = true;
    previousFocus?.focus?.(); previousFocus = null;
  }, 190);
}
function deletePresets(ids) {
  const removedIds = new Set(ids);
  settings.prefixes = settings.prefixes.filter(item => !removedIds.has(item.id));
  selectedPrefixIds.clear();
  if (removedIds.has(settings.activePrefixId)) settings.activePrefixId = settings.prefixes[0]?.id || '';
  if (removedIds.has(editingPresetId)) closePresetEditor();
  persist(); renderSavedPresets(); $('emptyState').hidden = settings.prefixes.length > 0;
}
let editingPresetId = null;
function openPresetEditor(item = { id: makeId(), name: '', text: '', shortcut: '', enabled: true }) {
  editingPresetId = item.id;
  $('editorTitle').textContent = settings.prefixes.some(preset => preset.id === item.id) ? '프리셋 편집' : '새 프리셋';
  $('prefixName').value = item.name || ''; $('prefixText').value = item.text || ''; $('prefixShortcut').value = item.shortcut || '';
  $('shortcutHint').textContent = '클릭한 뒤 조합 키를 누르세요';
  $('prefixEditor').hidden = false;
  $('prefixName').focus();
}
function closePresetEditor() {
  editingPresetId = null; $('prefixEditor').hidden = true;
}
function savePreset() {
  const text = $('prefixText').value.trim();
  if (!text) { $('saveStatus').textContent = '접두사 문구를 입력해주세요'; return; }
  const existing = settings.prefixes.find(item => item.id === editingPresetId);
  const item = { id: editingPresetId || makeId(), name: $('prefixName').value.trim(), text, shortcut: $('prefixShortcut').value.replaceAll(' ', '').toLowerCase(), enabled: existing?.enabled !== false };
  if (existing) settings.prefixes = settings.prefixes.map(preset => preset.id === item.id ? item : preset);
  else { settings.prefixes.push(item); settings.activePrefixId = item.id; }
  closePresetEditor(); persist(); renderSavedPresets(); $('emptyState').hidden = settings.prefixes.length > 0;
}

document.querySelectorAll('.nav-item').forEach(button => button.addEventListener('click', () => {
  document.querySelectorAll('.nav-item').forEach(item => item.classList.toggle('active', item === button));
  document.querySelectorAll('.settings-page').forEach(page => { page.hidden = page.id !== `page-${button.dataset.page}`; });
}));
const initialPage = location.hash.replace(/^#/, '');
document.querySelector(`.nav-item[data-page="${initialPage}"]`)?.click();
$('notifications').addEventListener('change', event => { settings.notifications = event.target.checked; persist(); });
$('sound').addEventListener('change', event => { settings.sound = event.target.checked; persist(); });
$('muteAlarmWhenViewingChat').addEventListener('change', event => { settings.muteAlarmWhenViewingChat = event.target.checked; persist(); });
$('repeatAlarm').addEventListener('change', event => { settings.repeatAlarm = event.target.checked; persist(); });
$('autoInsertOnComposerClick').addEventListener('change', event => { settings.autoInsertOnComposerClick = event.target.checked; persist(); });
$('showConversationCost').addEventListener('change', event => { settings.showConversationCost = event.target.checked; persist(); });
$('showConversationStats').addEventListener('change', event => { settings.showConversationStats = event.target.checked; updateConversationStatsControls(); persist(); });
$('collectConversationStats').addEventListener('change', event => { settings.collectConversationStats = event.target.checked; persist(); });
$('showConversationDuration').addEventListener('change', event => { settings.showConversationDuration = event.target.checked; persist(); });
$('showUserMessageCount').addEventListener('change', event => { settings.showUserMessageCount = event.target.checked; persist(); });
$('resetStatsPosition').addEventListener('click', () => {
  chrome.storage.local.set({ pointUsagePosition: null }, () => {
    $('saveStatus').textContent = '통계 창 위치를 기본값으로 되돌렸어요';
    clearTimeout(persist.timer);
    persist.timer = setTimeout(() => $('saveStatus').textContent = '일반 설정은 자동 저장돼요 · 접두사는 저장 버튼을 눌러주세요', 1800);
  });
});
$('volume').addEventListener('keydown', event => {
  const delta = ['ArrowRight', 'ArrowUp'].includes(event.key) ? 0.05 : ['ArrowLeft', 'ArrowDown'].includes(event.key) ? -0.05 : 0;
  if (!delta) return;
  event.preventDefault();
  const slider = event.currentTarget;
  slider.value = Math.max(0, Math.min(1, Math.round((Number(slider.value) + delta) * 100) / 100)).toFixed(2);
  slider.dispatchEvent(new Event('input', { bubbles: true }));
});
$('volume').addEventListener('input', event => { settings.volume = Number(event.target.value); $('volumeValue').value = `${Math.round(settings.volume * 100)}`; updateVolumeTrack(); persist(); });
$('volumeValue').addEventListener('focus', event => event.currentTarget.select());
$('volumeValue').addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.blur(); } });
$('volumeValue').addEventListener('change', event => {
  const entered = Number(event.currentTarget.value);
  const percent = event.currentTarget.value.trim() === '' || !Number.isFinite(entered)
    ? Math.round(Number($('volume').value) * 100)
    : Math.max(0, Math.min(100, Math.round(entered)));
  settings.volume = percent / 100;
  $('volume').value = settings.volume.toFixed(2);
  event.currentTarget.value = percent;
  updateVolumeTrack();
  persist();
});
document.querySelectorAll('.choice-picker').forEach(picker => {
  const trigger = picker.querySelector('.choice-trigger');
  trigger.addEventListener('click', () => {
    document.querySelectorAll('.choice-picker.open').forEach(item => { if (item !== picker) { item.classList.remove('open'); item.querySelector('.choice-trigger').setAttribute('aria-expanded', 'false'); } });
    const open = !picker.classList.contains('open');
    picker.classList.toggle('open', open); trigger.setAttribute('aria-expanded', String(open));
  });
  picker.querySelectorAll('.choice-option').forEach(option => option.addEventListener('click', () => {
    const key = picker.dataset.setting; settings[key] = option.dataset.value;
    orderChoiceOptions(picker, option);
    picker.classList.remove('open'); trigger.setAttribute('aria-expanded', 'false');
    if (key === 'extensionTheme') applyExtensionTheme();
    persist();
  }));
});
document.addEventListener('pointerdown', event => document.querySelectorAll('.choice-picker.open').forEach(picker => {
  if (!picker.contains(event.target)) { picker.classList.remove('open'); picker.querySelector('.choice-trigger').setAttribute('aria-expanded', 'false'); }
}));
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && !$('confirmDialog').hidden) { closeDeleteConfirmation(); return; }
  if (event.key === 'Escape') document.querySelectorAll('.choice-picker.open').forEach(picker => { picker.classList.remove('open'); picker.querySelector('.choice-trigger').setAttribute('aria-expanded', 'false'); });
});
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { if (settings.extensionTheme === 'auto') applyExtensionTheme(); });
$('addPrefix').addEventListener('click', () => {
  openPresetEditor();
});
$('selectAllPresets').addEventListener('change', event => {
  selectedPrefixIds = event.target.checked ? new Set(settings.prefixes.map(item => item.id)) : new Set();
  renderSavedPresets();
});
$('deleteSelectedPresets').addEventListener('click', () => requestPresetDeletion([...selectedPrefixIds]));
$('cancelDelete').addEventListener('click', closeDeleteConfirmation);
$('confirmDelete').addEventListener('click', () => {
  const action = pendingDeleteAction;
  closeDeleteConfirmation();
  action?.();
});
$('confirmDialog').addEventListener('click', event => { if (event.target === $('confirmDialog')) closeDeleteConfirmation(); });
$('savePrefix').addEventListener('click', savePreset);
$('cancelPrefix').addEventListener('click', closePresetEditor);
$('prefixShortcut').addEventListener('keydown', event => {
  event.preventDefault(); event.stopPropagation();
  if (event.key === 'Escape' || event.key === 'Backspace' || event.key === 'Delete') { $('prefixShortcut').value = ''; return; }
  if (['Control','Alt','Shift','Meta'].includes(event.key)) return;
  const mods = []; if (event.ctrlKey) mods.push('Ctrl'); if (event.altKey) mods.push('Alt'); if (event.shiftKey) mods.push('Shift'); if (event.metaKey) mods.push('Meta');
  if (!mods.length) { $('shortcutHint').textContent = 'Ctrl, Alt, Shift 중 하나를 함께 사용해주세요'; setTimeout(() => $('shortcutHint').textContent = '클릭한 뒤 조합 키를 누르세요', 1600); return; }
  $('prefixShortcut').value = [...mods, event.key.length === 1 ? event.key.toUpperCase() : event.key].join(' + ');
});
$('prefixShortcut').addEventListener('focus', () => $('shortcutHint').textContent = '조합 키를 누르세요 · Esc로 지우기');
$('prefixShortcut').addEventListener('blur', () => $('shortcutHint').textContent = '클릭한 뒤 조합 키를 누르세요');
$('previewSound').addEventListener('click', () => playPreview());
async function playPreview() {
  if (settings.volume <= 0) return;
  try {
    previewContext ||= new (window.AudioContext || window.webkitAudioContext)();
    if (previewContext.state === 'suspended') await previewContext.resume();
    if (settings.alertSound === 'tinglong') {
      if (!previewTinglongBuffer) {
        const response = await fetch(chrome.runtime.getURL('sounds/tinglong.wav'));
        previewTinglongBuffer = await previewContext.decodeAudioData(await response.arrayBuffer());
      }
      const source = previewContext.createBufferSource();
      const gain = previewContext.createGain();
      source.buffer = previewTinglongBuffer;
      gain.gain.value = settings.volume;
      source.connect(gain); gain.connect(previewContext.destination); source.start();
      return;
    }
    const start = previewContext.currentTime;
    const notes = [[880, 0, 0.45], [659, 0.38, 0.55]];
    const peak = 0.12 + settings.volume * 0.68;
    notes.forEach(([frequency, offset, duration]) => {
      const oscillator = previewContext.createOscillator(); const gain = previewContext.createGain();
      const at = start + offset;
      oscillator.type = 'sine'; oscillator.frequency.value = frequency;
      gain.gain.setValueAtTime(0.0001, at);
      gain.gain.exponentialRampToValueAtTime(peak, at + 0.03);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + duration);
      oscillator.connect(gain); gain.connect(previewContext.destination); oscillator.start(at); oscillator.stop(at + duration + 0.03);
    });
  } catch (_) {
    $('saveStatus').textContent = '이 브라우저에서 미리 듣기를 시작하지 못했어요';
    setTimeout(() => $('saveStatus').textContent = '일반 설정은 자동 저장돼요 · 접두사는 저장 버튼을 눌러주세요', 2000);
  }
}
