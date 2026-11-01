(() => {
  let observer, themeObserver, watchTimer, layoutTimer, activityTimer;
  let contextCleaned = false;
  function extensionContextAlive() { try { return !!chrome?.runtime?.id; } catch { return false; } }
  function isInvalidExtensionError(error) { return /extension context invalidated|context invalidated|receiving end does not exist/i.test(String(error?.message || error || '')); }
  function handleExtensionError(error) {
    if (isInvalidExtensionError(error)) { cleanupInvalidContext(true); return true; }
    return false;
  }
  function safeExtensionCall(callback, fallback) {
    if (contextCleaned || !extensionContextAlive()) { cleanupInvalidContext(true); return fallback; }
    try {
      const result = callback();
      if (result && typeof result.then === 'function') result.catch(error => { handleExtensionError(error); });
      return result;
    } catch (error) {
      if (handleExtensionError(error)) return fallback;
      throw error;
    }
  }
  function storageGet(query, callback) {
    return safeExtensionCall(() => chrome.storage.local.get(query, result => {
      try { if (chrome.runtime.lastError) { handleExtensionError(chrome.runtime.lastError); return; } } catch (error) { if (handleExtensionError(error)) return; }
      if (cleanupInvalidContext()) return;
      try { callback(result || {}); } catch (error) { if (!handleExtensionError(error)) throw error; }
    }));
  }
  function storageSet(values) { return safeExtensionCall(() => chrome.storage.local.set(values)); }
  function sendRuntimeMessage(message) {
    return safeExtensionCall(() => chrome.runtime.sendMessage(message, () => {
      // Reading lastError consumes expected errors when the background worker was reloaded.
      try { void chrome.runtime.lastError; } catch (error) { handleExtensionError(error); }
    }));
  }
  function extensionUrl(path) { return safeExtensionCall(() => chrome.runtime.getURL(path), ''); }
  function cleanupInvalidContext(force = false) {
    if (!force && extensionContextAlive()) return false;
    if (!contextCleaned) {
      contextCleaned = true;
      observer?.disconnect(); themeObserver?.disconnect();
      clearInterval(watchTimer); clearInterval(layoutTimer); clearInterval(activityTimer);
      clearTimeout(quietTimer);
      prefixHost?.remove(); usageHost?.remove();
      document.getElementById('eden-companion-toast')?.remove();
    }
    return true;
  }
  if (!extensionContextAlive()) return;
  const DEFAULTS = {
    settings: { notifications: true, sound: true, muteAlarmWhenViewingChat: true, alertSound: 'classic', repeatAlarm: false, volume: 0.5, prefixes: [], activePrefixId: '', prefixEnabled: true, autoInsertOnComposerClick: false, showConversationStats: false, collectConversationStats: true, showConversationCost: true, showConversationDuration: true, showUserMessageCount: true, fontFamily: "'Pretendard Variable', Pretendard, Arial, 'Malgun Gothic', sans-serif", pickerSide: 'right', pickerTheme: 'auto' }
  };
  const FONT_STACK = "'Pretendard Variable', Pretendard, Arial, 'Malgun Gothic', sans-serif";
  try {
    const edenFontFace = new FontFace('Pretendard Variable', `url("${extensionUrl('fonts/PretendardVariable.woff2')}") format("woff2")`, { weight: '100 900', style: 'normal' });
    edenFontFace.load().then(face => document.fonts.add(face)).catch(() => {});
  } catch {}
  let config = DEFAULTS.settings;
  let wasGenerating = false;
  let lastText = '';
  let textBaselineReady = false;
  let quietTimer;
  let repeatPending = false;
  let usageHost, usageRoot;
  let usageByConversation = {};
  let pointUsagePosition = null;
  let usageDrag = null;
  let displayedUsageConversation = '';
  let displayedUsageTotal = 0;
  let displayedUsageActiveMs = 0;
  let displayedUserMessageCount = 0;
  let pendingSpendStart, responseSpendStart;
  let activityTickAt = Date.now();
  let activityMsBuffer = 0;
  let activityBufferConversation = '';
  let lastMessageCountCheckAt = 0;
  let lastTrackedSend = { id: '', text: '', at: 0 };
  let lastAnnouncedConversationId = '';
  let lastAnnouncedConversationAt = 0;

  storageGet({ ...DEFAULTS, settingsMigration: 0 }, result => {
    if (cleanupInvalidContext()) return;
    const settings = result.settings;
    config = { ...DEFAULTS.settings, ...settings };
    let settingsCleaned = false;
    if (result.settingsMigration < 2) {
      config.showConversationStats = false;
      config.showConversationCost = true;
      config.showConversationDuration = true;
      config.showUserMessageCount = true;
      settingsCleaned = true;
    }
    if (result.settingsMigration < 3) {
      config.collectConversationStats = true;
      storageSet({ settingsMigration: 3 });
      settingsCleaned = true;
    }
    for (const obsoleteKey of ['autoPrefixAfterResponse', 'autoPrefixOnFirstInput', 'autoInsertEveryNChats']) {
      if (obsoleteKey in config) { delete config[obsoleteKey]; settingsCleaned = true; }
    }
    if (settingsCleaned) storageSet({ settings: config });
    normalizePrefixes(); refreshPrefixUi();
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (cleanupInvalidContext()) return;
    if (area === 'local' && changes.settings) {
      config = { ...DEFAULTS.settings, ...changes.settings.newValue };
      normalizePrefixes(); refreshPrefixUi();
      updatePointUsageUiPosition();
      updateUsageMetricsVisibility();
      if (!config.collectConversationStats) flushActivityTime();
      if ((!config.repeatAlarm || !config.sound || Number(config.volume) <= 0) && repeatPending) stopRepeatAlarm();
    }
    if (area === 'local' && changes.pointUsageByConversation) {
      usageByConversation = changes.pointUsageByConversation.newValue || {};
      loadConversationUsage(currentConversationId());
    }
    if (area === 'local' && changes.pointUsagePosition) {
      pointUsagePosition = changes.pointUsagePosition.newValue || null;
      updatePointUsageUiPosition();
    }
  });

  storageGet({ pointUsageByConversation: {}, pointUsagePosition: null }, result => {
    if (cleanupInvalidContext()) return;
    usageByConversation = result.pointUsageByConversation || {};
    pointUsagePosition = result.pointUsagePosition || null;
    loadConversationUsage(currentConversationId()); updatePointUsageUiPosition();
  });

  function createPrefixId() { return globalThis.crypto?.randomUUID?.() || `prefix-${Date.now()}-${Math.random().toString(36).slice(2)}`; }
  function normalizePrefixes() {
    let changed = false;
    config.prefixes = (config.prefixes || []).map(item => {
      if (item.id) return item;
      changed = true; return { ...item, id: createPrefixId() };
    });
    if (!config.prefixes.some(item => item.id === config.activePrefixId)) {
      const next = config.prefixes[0]?.id || '';
      if (next !== config.activePrefixId) changed = true;
      config.activePrefixId = next;
    }
    if (changed) storageSet({ settings: config });
  }

  const visible = (el) => !!el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
  function generatingNow() {
    const composer = findComposer();
    if (composer && (composer.disabled || composer.getAttribute('aria-disabled') === 'true' || composer.readOnly)) return true;
    const labels = [...document.querySelectorAll('button,[role="button"]')]
      .filter(visible).map(el => `${el.getAttribute('aria-label') || ''} ${el.getAttribute('title') || ''} ${el.innerText || ''}`.toLowerCase());
    if (labels.some(s => /stop generating|stop response|응답 중지|생성 중지|중지/.test(s))) return true;
    if (document.querySelector('[aria-busy="true"], [data-is-streaming="true"], .typing-indicator, [class*="streaming" i]')) return true;
    return false;
  }
  function latestAssistantText() {
    const candidates = [...document.querySelectorAll('[data-message-author-role="assistant"], [data-role="assistant"], [class*="assistant-message" i], [class*="message-assistant" i]')].filter(visible);
    return (candidates.at(-1)?.innerText || '').trim().slice(-180);
  }
  // Let Eden Chat hydrate its existing transcript before using text changes as a fallback signal.
  setTimeout(() => { lastText = latestAssistantText(); textBaselineReady = true; }, 900);
  function complete() {
    if (cleanupInvalidContext()) return;
    const preview = latestAssistantText().replace(/\s+/g, ' ').slice(0, 140);
    const chatIsFocused = document.visibilityState === 'visible' && document.hasFocus();
    const shouldPlaySound = !config.muteAlarmWhenViewingChat || !chatIsFocused;
    const shouldRepeat = !chatIsFocused && !!config.repeatAlarm && !!config.sound && Number(config.volume) > 0;
    repeatPending = shouldRepeat;
    sendRuntimeMessage({ type: 'eden-chat-complete', preview, repeat: shouldRepeat, volume: Number(config.volume), sound: !!config.sound && shouldPlaySound, soundType: config.alertSound });
    finishPointUsageTracking();
    showToast('응답이 완료됐어요');
  }
  function stopRepeatAlarm() {
    if (cleanupInvalidContext()) return;
    if (!repeatPending) return;
    repeatPending = false;
    sendRuntimeMessage({ type: 'eden-chat-repeat-stop' });
  }
  function stopRepeatWhenSeen() {
    if (document.visibilityState === 'visible' && document.hasFocus()) stopRepeatAlarm();
  }
  document.addEventListener('visibilitychange', stopRepeatWhenSeen);
  window.addEventListener('focus', stopRepeatWhenSeen);
  if (document.visibilityState === 'visible' && document.hasFocus() && !cleanupInvalidContext()) sendRuntimeMessage({ type: 'eden-chat-repeat-stop' });
  function watch() {
    announceLastUsedConversation();
    updatePrefixUiPosition();
    updatePointUsageUiPosition();
    refreshUserMessageCount();
    const active = generatingNow();
    const nextText = latestAssistantText();
    const textChanged = textBaselineReady && !!nextText && nextText !== lastText;
    if (active || textChanged) {
      if (!wasGenerating) beginPointUsageTracking();
      wasGenerating = true; lastText = nextText; clearTimeout(quietTimer); quietTimer = undefined;
    } else if (wasGenerating) {
      // Require a short quiet period so brief gaps in streamed output do not trigger an alert.
      if (!quietTimer) quietTimer = setTimeout(() => {
        if (cleanupInvalidContext()) return;
        quietTimer = undefined;
        if (!generatingNow() && wasGenerating) { wasGenerating = false; complete(); }
      }, 1700);
    }
  }
  observer = new MutationObserver(() => { if (!cleanupInvalidContext()) watch(); });
  observer.observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['aria-busy', 'data-is-streaming', 'class', 'data-theme', 'data-color-scheme'] });
  themeObserver = new MutationObserver(() => { if (!cleanupInvalidContext() && prefixHost) prefixHost.setAttribute('theme', selectedPickerTheme()); });
  for (const root of themeRoots()) themeObserver.observe(root, { attributes: true, attributeFilter: ['class', 'data-theme', 'data-color-scheme', 'style'] });
  watchTimer = setInterval(() => { if (!cleanupInvalidContext()) watch(); }, 1000);

  let toastTimer;
  function showToast(message) {
    let toast = document.getElementById('eden-companion-toast');
    if (!toast) {
      toast = document.createElement('div'); toast.id = 'eden-companion-toast';
      Object.assign(toast.style, { position: 'fixed', zIndex: '2147483647', right: '24px', bottom: '24px', padding: '12px 16px', borderRadius: '14px', background: '#171923', color: '#fff', font: `400 13px ${FONT_STACK}`, boxShadow: '0 10px 30px #0004', opacity: '0', transform: 'translateY(8px)', transition: 'all .2s ease', pointerEvents: 'none' });
      document.documentElement.append(toast);
    }
    toast.textContent = `✦  ${message}`; clearTimeout(toastTimer);
    requestAnimationFrame(() => { toast.style.opacity = '1'; toast.style.transform = 'translateY(0)'; });
    toastTimer = setTimeout(() => { toast.style.opacity = '0'; toast.style.transform = 'translateY(8px)'; }, 2400);
  }

  let prefixHost, prefixRoot, prefixButton, prefixMenu, prefixSettingsButton, prefixSettingsMenu;
  window.addEventListener('error', event => {
    if (!String(event.message || '').includes('Extension context invalidated')) return;
    cleanupInvalidContext(true);
    event.preventDefault();
  });
  function activePrefix() { return config.prefixes?.find(item => item.id === config.activePrefixId) || config.prefixes?.[0]; }
  function initPrefixUi() {
    if (cleanupInvalidContext()) return;
    if (prefixHost) return;
    prefixHost = document.createElement('div'); prefixHost.id = 'eden-companion-prefix-picker';
    prefixRoot = prefixHost.attachShadow({ mode: 'open' });
    prefixRoot.innerHTML = `<style>
      @font-face{font-family:'Pretendard Variable';src:url('${extensionUrl('fonts/PretendardVariable.woff2')}') format('woff2');font-style:normal;font-weight:100 900;font-display:swap}
      :host{all:initial;position:fixed;z-index:2147483646;width:max-content;font-family:var(--eden-font,'Pretendard Variable',Pretendard,Arial,'Malgun Gothic',sans-serif);pointer-events:none}
      :host([hidden]){display:none!important}
      :host([theme="dark"]){--surface:#211f29;--surface-raised:#292631;--ink:#f0edf5;--muted:#aaa4b4;--line:#403b4c;--accent:#c0a8ff;--selected:#393149;--hover:#322d3c;--shadow:#0008;color-scheme:dark}
      *{box-sizing:border-box}
      .picker{position:relative;pointer-events:auto}
      .picker button,.item{ -webkit-tap-highlight-color:transparent;transition:transform 220ms cubic-bezier(.2,.8,.25,1.15),box-shadow 220ms ease,background-color 180ms ease,border-color 180ms ease,color 180ms ease}
      .picker button:active:not(:disabled),.item:active:not(:disabled){transform:scale(.975);transition-duration:90ms}
      .toolbar{display:flex;align-items:stretch;width:max-content;max-width:min(320px,calc(100vw - 16px));border:1px solid var(--line,#e8e0fb);border-radius:13px;background:var(--surface,#fff);box-shadow:0 6px 22px var(--shadow,#32255020);overflow:visible}
      .trigger{display:flex;align-items:center;gap:8px;min-width:0;max-width:260px;padding:10px 12px;border:0;border-radius:12px 0 0 12px;background:transparent;color:var(--ink,#553d91);font:500 13px var(--eden-font,Arial,'Malgun Gothic',sans-serif);cursor:pointer}
      .trigger:hover,.settings-trigger:hover{background:var(--hover,#f7f3ff)}
      .star{font-size:16px;color:#8d6cf5}.current{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:205px}.chevron{color:var(--muted,#9e91bc);font-size:11px}
      .divider{width:1px;align-self:center;height:24px;background:var(--line,#e8e0fb)}
      .settings-trigger{display:grid;place-items:center;flex:none;width:42px;padding:0;border:0;border-radius:0 12px 12px 0;background:transparent;color:var(--muted,#84799a);font:400 17px var(--eden-font,Arial,'Malgun Gothic',sans-serif);cursor:pointer}
      .menu{position:absolute;z-index:2;left:0;bottom:calc(100% + 9px);display:none;flex-direction:column;width:280px;max-height:min(320px,65vh);overflow:hidden;overscroll-behavior:none;scroll-behavior:smooth;-webkit-overflow-scrolling:touch;padding:7px;border:1px solid var(--line,#eee9f6);border-radius:15px;background-color:var(--surface,#fff);color:var(--ink,#393342);color-scheme:light;box-shadow:0 14px 38px var(--shadow,#2c21432b)}
      :host([open]) .preset-menu{display:flex}:host([quick-open]) .quick-menu{display:block}:host([menu-below]) .menu{top:calc(100% + 9px);bottom:auto}
      :host([theme="dark"]) .menu,:host([theme="dark"]) .items{background-color:#211f29;color:#f0edf5;color-scheme:dark}
      .items{flex:0 1 auto;min-height:0;max-height:min(250px,calc(65vh - 52px));overflow-y:auto;overscroll-behavior:none;scroll-behavior:smooth;-webkit-overflow-scrolling:touch;background-color:var(--surface,#fff);color:var(--ink,#393342);scrollbar-width:thin;scrollbar-color:var(--muted,#a895d5) transparent}
      .items::-webkit-scrollbar{width:6px;background:transparent}.items::-webkit-scrollbar-button{display:none;width:0;height:0}.items::-webkit-scrollbar-track,.items::-webkit-scrollbar-track-piece{background:transparent}.items::-webkit-scrollbar-thumb{border-radius:99px;background:var(--muted,#a895d5)}
      .quick-menu{right:0;left:auto;width:290px;overflow-y:auto;overscroll-behavior:none}
      .menu-title{flex:none;padding:8px 10px 7px;color:var(--muted,#9a8abb);font-size:10px;font-weight:600;letter-spacing:1px;text-transform:uppercase}
      .item{width:100%;display:flex;align-items:center;gap:9px;padding:10px;border:0;border-radius:10px;background:transparent;text-align:left;color:var(--ink,#393342);font:400 13px var(--eden-font,Arial,'Malgun Gothic',sans-serif);cursor:pointer}
      .item:hover{background:var(--hover,#f7f3ff)}.item[aria-current="true"]{background:var(--selected,#f1ebff);color:var(--accent,#6346a7)}
      .check{width:16px;color:#896be0;font-weight:600}.name{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.shortcut{padding:4px 6px;border:1px solid var(--line,#ece8f1);border-radius:6px;background:var(--surface-raised,#fff);color:var(--muted,#8d8795);font-size:10px;white-space:nowrap}
      .quick-option{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:10px;border-radius:10px;color:var(--ink,#393342);font-size:13px;line-height:1.4;cursor:pointer}.quick-option:hover{background:var(--hover,#f7f3ff)}
      .quick-option input{width:17px;height:17px;margin:0;accent-color:#896be0;flex:none}
      .quick-position{padding:9px 10px 10px;border-top:1px solid var(--line,#eee9f6)}.quick-position-label{display:block;margin-bottom:8px;color:var(--ink,#393342);font-size:12px;font-weight:500}
      .quick-position-options{display:grid;grid-template-columns:1fr 1fr;gap:6px}.quick-position-option{min-height:34px;padding:7px 8px;border:1px solid var(--line,#eee9f6);border-radius:9px;background:var(--surface-raised,#fff);color:var(--muted,#84799a);font:400 12px var(--eden-font,Arial,'Malgun Gothic',sans-serif);cursor:pointer}
      .quick-position-option:hover{background:var(--hover,#f7f3ff);color:var(--ink,#393342)}.quick-position-option[aria-pressed="true"]{border-color:#9879e8;background:var(--selected,#f1ebff);color:var(--accent,#6346a7)}
      
      .empty{padding:14px 10px;color:var(--muted,#8c8795);font-size:12px;line-height:1.5}
      @media(prefers-reduced-motion:reduce){.picker button,.item,.menu{transition:none!important;scroll-behavior:auto;animation:none!important;transform:none!important}}
    </style><div class="picker"><div class="toolbar"><button class="trigger" type="button" aria-expanded="false"><span class="star">✦</span><span class="current">접두사 프리셋</span><span class="chevron">▾</span></button><span class="divider"></span><button class="settings-trigger" type="button" aria-label="자동 접두사 설정" title="자동 접두사 설정" aria-expanded="false">⚙</button></div><div class="menu preset-menu" role="menu"><div class="menu-title">접두사 프리셋</div><div class="items"></div></div><div class="menu quick-menu" role="group"><div class="menu-title">자동 접두사</div><label class="quick-option"><span>입력칸 클릭 시 입력</span><input class="auto-click-setting" type="checkbox"></label><div class="quick-position"><span class="quick-position-label">채팅 버튼 위치</span><div class="quick-position-options" role="group" aria-label="채팅 버튼 위치"><button class="quick-position-option" type="button" data-side="above-left">왼쪽 위</button><button class="quick-position-option" type="button" data-side="left">왼쪽</button><button class="quick-position-option" type="button" data-side="above-right">오른쪽 위</button><button class="quick-position-option" type="button" data-side="right">오른쪽</button></div></div></div></div>`;
    prefixButton = prefixRoot.querySelector('.trigger'); prefixMenu = prefixRoot.querySelector('.preset-menu');
    prefixSettingsButton = prefixRoot.querySelector('.settings-trigger'); prefixSettingsMenu = prefixRoot.querySelector('.quick-menu');
    prefixButton.addEventListener('click', () => {
      const open = !prefixHost.hasAttribute('open');
      prefixHost.removeAttribute('quick-open'); prefixSettingsButton.setAttribute('aria-expanded', 'false');
      prefixHost.toggleAttribute('open', open); prefixButton.setAttribute('aria-expanded', String(open));
      if (open) renderPrefixMenu();
    });
    prefixSettingsButton.addEventListener('click', () => {
      const open = !prefixHost.hasAttribute('quick-open');
      closePrefixMenu(); prefixHost.toggleAttribute('quick-open', open); prefixSettingsButton.setAttribute('aria-expanded', String(open));
      if (open) renderQuickSettings();
    });
    prefixRoot.querySelector('.auto-click-setting').addEventListener('change', event => setAutomaticSetting('autoInsertOnComposerClick', event.target.checked));
    prefixRoot.querySelectorAll('.quick-position-option').forEach(button => button.addEventListener('click', () => setAutomaticSetting('pickerSide', button.dataset.side)));
    prefixRoot.addEventListener('keydown', event => { if (event.key === 'Escape') { closePrefixMenu(); closeQuickSettings(); } });
    document.addEventListener('pointerdown', event => { if (event.target !== prefixHost) { closePrefixMenu(); closeQuickSettings(); } });
    document.documentElement.append(prefixHost);
    refreshPrefixUi(); updatePrefixUiPosition();
  }
  function closePrefixMenu() { if (!prefixHost) return; prefixHost.removeAttribute('open'); prefixButton?.setAttribute('aria-expanded', 'false'); }
  function closeQuickSettings() { if (!prefixHost) return; prefixHost.removeAttribute('quick-open'); prefixSettingsButton?.setAttribute('aria-expanded', 'false'); }
  function renderQuickSettings() {
    if (!prefixRoot) return;
    prefixRoot.querySelector('.auto-click-setting').checked = !!config.autoInsertOnComposerClick;
    prefixRoot.querySelectorAll('.quick-position-option').forEach(button => {
      const selected = (config.pickerSide || 'right') === button.dataset.side;
      button.setAttribute('aria-pressed', String(selected));
    });
  }
  function setAutomaticSetting(key, value) {
    if (cleanupInvalidContext()) return;
    config[key] = value; renderQuickSettings();
    if (key === 'prefixEnabled') refreshPrefixUi();
    if (key === 'pickerSide') updatePrefixUiPosition();
    storageGet(DEFAULTS, ({ settings }) => { if (!cleanupInvalidContext()) storageSet({ settings: { ...DEFAULTS.settings, ...settings, [key]: value } }); });
  }
  function setActivePrefix(id, announce = true) {
    if (cleanupInvalidContext()) return;
    if (!config.prefixes?.some(item => item.id === id)) return;
    config.activePrefixId = id;
    config.prefixEnabled = true;
    const chosen = activePrefix(); refreshPrefixUi(); closePrefixMenu();
    storageGet(DEFAULTS, ({ settings }) => { if (!cleanupInvalidContext()) storageSet({ settings: { ...DEFAULTS.settings, ...settings, activePrefixId: id, prefixEnabled: true } }); });
    if (announce) showToast(`프리셋 변경 · ${chosen?.name || '접두사'}`);
  }
  function renderPrefixMenu() {
    if (!prefixRoot) return;
    const container = prefixRoot.querySelector('.items'); container.replaceChildren();
    if (config.prefixEnabled !== false) {
      const toggleRow = document.createElement('button'); toggleRow.type = 'button'; toggleRow.className = 'item'; toggleRow.setAttribute('role', 'menuitem');
      const toggleCheck = document.createElement('span'); toggleCheck.className = 'check'; toggleCheck.textContent = '⏻';
      const toggleName = document.createElement('span'); toggleName.className = 'name'; toggleName.textContent = '접두사 끄기';
      toggleRow.append(toggleCheck, toggleName);
      toggleRow.addEventListener('click', () => { setAutomaticSetting('prefixEnabled', false); closePrefixMenu(); });
      container.append(toggleRow);
    }
    if (!config.prefixes?.length) { const empty = document.createElement('div'); empty.className = 'empty'; empty.textContent = '설정에서 접두사 프리셋을 추가해보세요.'; container.append(empty); return; }
    config.prefixes.forEach(item => {
      const row = document.createElement('button'); row.type = 'button'; row.className = 'item'; row.setAttribute('role', 'menuitemradio'); row.setAttribute('aria-current', String(item.id === activePrefix()?.id));
      const check = document.createElement('span'); check.className = 'check'; check.textContent = item.id === activePrefix()?.id ? '✓' : '';
      const name = document.createElement('span'); name.className = 'name'; name.textContent = item.name || '이름 없는 프리셋';
      row.append(check, name);
      if (item.shortcut) { const shortcut = document.createElement('span'); shortcut.className = 'shortcut'; shortcut.textContent = item.shortcut.toUpperCase().replaceAll('+', ' + '); row.append(shortcut); }
      row.addEventListener('click', () => setActivePrefix(item.id)); container.append(row);
    });
  }
  function refreshPrefixUi() {
    if (!prefixHost) return;
    const selected = activePrefix();
    prefixHost.hidden = !selected;
    prefixHost.style.setProperty('--eden-font', FONT_STACK);
    prefixHost.setAttribute('theme', selectedPickerTheme());
    const current = prefixRoot.querySelector('.current'); current.textContent = config.prefixEnabled === false ? '접두사 꺼짐' : selected?.name || '접두사 프리셋';
    prefixButton.title = config.prefixEnabled === false ? '접두사가 꺼져 있어요 · 프리셋을 선택하면 다시 켜져요' : selected ? `현재 프리셋: ${selected.name || '이름 없는 프리셋'} · 눌러서 변경` : '접두사 프리셋이 없습니다';
    renderQuickSettings();
    if (prefixHost.hasAttribute('open')) renderPrefixMenu();
    updatePrefixUiPosition();
  }
  function detectSiteTheme() {
    const roots = themeRoots();
    const hints = roots.map(el => `${el.className || ''} ${el.getAttribute('data-theme') || ''} ${el.getAttribute('data-color-scheme') || ''}`).join(' ').toLowerCase();
    if (/\bdark\b|theme-dark|dark-mode/.test(hints)) return 'dark';
    if (/\blight\b|theme-light|light-mode/.test(hints)) return 'light';
    for (const el of roots) {
      if (!el) continue;
      const match = getComputedStyle(el).backgroundColor.match(/rgba?\((\d+)[, ]+\s*(\d+)[, ]+\s*(\d+)(?:[, /]+\s*([\d.]+))?/i);
      if (!match || (match[4] !== undefined && Number(match[4]) < 0.15)) continue;
      const [r, g, b] = match.slice(1, 4).map(Number);
      const luminance = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
      return luminance < 0.48 ? 'dark' : 'light';
    }
    return 'light';
  }
  function selectedPickerTheme() { return config.pickerTheme === 'dark' || config.pickerTheme === 'light' ? config.pickerTheme : detectSiteTheme(); }
  function themeRoots() { return [document.documentElement, document.body, document.querySelector('#root'), document.querySelector('#__next'), document.querySelector('main')].filter(Boolean); }
  function currentConversationId() {
    const params = new URLSearchParams(location.search);
    const conversationId = params.get('conversation') || params.get('conversationId') || params.get('conversation_id') || params.get('chatId');
    const id = conversationId?.trim() || '';
    return id && !['new', 'null', 'undefined'].includes(id.toLowerCase()) ? id : '';
  }
  function announceLastUsedConversation() {
    if (document.visibilityState !== 'visible' || !document.hasFocus()) return;
    const conversationId = currentConversationId();
    if (!conversationId) return;
    const now = Date.now();
    if (conversationId === lastAnnouncedConversationId && now - lastAnnouncedConversationAt < 15000) return;
    lastAnnouncedConversationId = conversationId; lastAnnouncedConversationAt = now;
    sendRuntimeMessage({ type: 'eden-chat-active-conversation', conversationId, url: location.href, title: currentConversationTitle(), usedAt: now });
  }
  function currentConversationTitle() {
    const nodes = [document.querySelector('[data-testid*="conversation-title" i]'), document.querySelector('header h1'), document.querySelector('main h1')].filter(Boolean);
    const heading = nodes.map(node => (node.innerText || node.textContent || '').trim()).find(text => text && text.length < 180);
    return heading || document.title || 'Eden Chat 대화방';
  }
  function hasActiveConversation() { return !!currentConversationId(); }
  function findComposer() {
    const all = [...document.querySelectorAll('textarea,[contenteditable="true"],[role="textbox"],input[type="text"]')].filter(el => visible(el) && !prefixHost?.contains(el));
    const preferred = all.filter(el => el.matches('textarea,[contenteditable="true"],[role="textbox"]'));
    const candidates = preferred.length ? preferred : all;
    return candidates.sort((a, b) => b.getBoundingClientRect().bottom - a.getBoundingClientRect().bottom)[0];
  }
  function findComposerPanelRect(composer) {
    const composerRect = composer.getBoundingClientRect();
    const candidates = [];
    let node = composer;
    while (node && node !== document.body && node !== document.documentElement) {
      const rect = node.getBoundingClientRect();
      const style = getComputedStyle(node);
      const hasBorder = ['Top', 'Right', 'Bottom', 'Left'].some(side => Number.parseFloat(style[`border${side}Width`]) > 0 && style[`border${side}Style`] !== 'none' && style[`border${side}Color`] !== 'transparent');
      const hasEdge = hasBorder || style.boxShadow !== 'none';
      const radius = Math.max(...['borderTopLeftRadius', 'borderTopRightRadius', 'borderBottomLeftRadius', 'borderBottomRightRadius'].map(property => Number.parseFloat(style[property]) || 0));
      const panelFits = rect.width >= composerRect.width - 2 && rect.height >= composerRect.height + 10;
      const composerIsBorderedPanel = node === composer && rect.width >= 180 && radius >= 18 && hasEdge;
      if (hasEdge && radius >= 12 && (panelFits || composerIsBorderedPanel)) candidates.push({ rect, area: rect.width * rect.height, radius });
      node = node.parentElement;
    }
    if (!candidates.length) return null;
    candidates.sort((a, b) => b.radius - a.radius || a.area - b.area);
    return candidates[0].rect;
  }
  function updatePrefixUiPosition() {
    if (!prefixHost) return;
    if (!hasActiveConversation()) { prefixHost.hidden = true; return; }
    const composer = findComposer();
    if (!composer || !activePrefix()) { prefixHost.hidden = true; return; }
    prefixHost.hidden = false;
    const rect = findComposerPanelRect(composer);
    if (!rect) { prefixHost.hidden = true; return; }
    const width = prefixHost.getBoundingClientRect().width || 270;
    const height = prefixHost.getBoundingClientRect().height || 40;
    const gap = 12, side = config.pickerSide || 'right';
    const centerY = rect.top + (rect.height - height) / 2;
    const spots = {
      left: { x: rect.left - width - gap, y: centerY },
      right: { x: rect.right + gap, y: centerY },
      'above-left': { x: rect.left, y: rect.top - height - gap },
      'above-right': { x: rect.right - width, y: rect.top - height - gap },
      'below-left': { x: rect.left, y: rect.bottom + gap },
      'below-right': { x: rect.right - width, y: rect.bottom + gap }
    };
    const preferences = {
      left: ['left', 'above-left', 'above-right', 'right', 'below-left', 'below-right'],
      right: ['right', 'above-right', 'above-left', 'left', 'below-right', 'below-left'],
      'above-left': ['above-left', 'left', 'right', 'above-right', 'below-left', 'below-right'],
      'above-right': ['above-right', 'right', 'left', 'above-left', 'below-right', 'below-left']
    }[side] || ['right', 'above-right', 'above-left', 'left', 'below-right', 'below-left'];
    const fitsWithoutOverlap = ({ x, y }) => {
      const inViewport = x >= 8 && y >= 8 && x + width <= window.innerWidth - 8 && y + height <= window.innerHeight - 8;
      const separated = x + width <= rect.left - gap || x >= rect.right + gap || y + height <= rect.top - gap || y >= rect.bottom + gap;
      return inViewport && separated;
    };
    const spot = preferences.map(name => spots[name]).find(fitsWithoutOverlap);
    if (!spot) { prefixHost.hidden = true; return; }
    const { x, y } = spot;
    const menuBelow = y < 330;
    prefixHost.style.left = `${x}px`; prefixHost.style.top = `${y}px`;
    prefixHost.toggleAttribute('menu-below', menuBelow);
  }
  function initPointUsageUi() {
    if (cleanupInvalidContext()) return;
    if (usageHost) return;
    usageHost = document.createElement('div'); usageHost.id = 'eden-companion-point-usage'; usageHost.hidden = true;
    usageRoot = usageHost.attachShadow({ mode: 'open' });
    usageRoot.innerHTML = `<style>
      @font-face{font-family:'Pretendard Variable';src:url('${extensionUrl('fonts/PretendardVariable.woff2')}') format('woff2');font-style:normal;font-weight:100 900;font-display:swap}
      :host{all:initial;position:fixed;z-index:2147483644;width:260px;font-family:'Pretendard Variable',Pretendard,Arial,'Malgun Gothic',sans-serif;color-scheme:light}
      :host([hidden]){display:none!important}:host([theme="dark"]){color-scheme:dark}
      .card{padding:16px 17px;border:1px solid #e8e1f2;border-radius:17px;background:#fff;color:#302b3a;box-shadow:0 10px 30px #17102018;cursor:grab;user-select:none;-webkit-user-select:none;touch-action:none;transition:box-shadow .2s ease,transform .2s ease}
      .card:active,:host([dragging]) .card{cursor:grabbing;box-shadow:0 16px 36px #17102030;transform:scale(1.015)}
      .title{display:flex;align-items:center;gap:9px;color:#8a6cda;font-size:15px;font-weight:600;letter-spacing:.1px}
      .dot{width:7px;height:7px;border-radius:50%;background:#8a6cda;box-shadow:0 0 0 4px #8a6cda18}
      .metrics{display:grid;gap:11px;margin-top:16px}.metric{display:flex;justify-content:space-between;align-items:baseline;gap:14px}.metric[hidden]{display:none!important}
      .label{color:#8d8796;font-size:14px}.value{font-size:16px;font-weight:700;line-height:1.15;letter-spacing:-.2px;font-variant-numeric:tabular-nums}
      .caption{display:block;margin-top:13px;color:#8d8796;font-size:13px;line-height:1.5}
      :host([theme="dark"]) .card{border-color:#3c3747;background:#211f29;color:#f1edf5;box-shadow:0 10px 30px #0005}
      :host([theme="dark"]) .caption,:host([theme="dark"]) .label{color:#aaa4b4}
      @media(prefers-reduced-motion:reduce){*{scroll-behavior:auto!important;animation:none!important;transition:none!important}}
    </style><div class="card"><div class="title"><i class="dot"></i><span>현재 채팅 통계</span></div><div class="metrics"><div class="metric" data-metric="cost"><span class="label">포인트 사용</span><strong class="value cost-value">0 P</strong></div><div class="metric" data-metric="duration"><span class="label">채팅 시간</span><strong class="value duration-value">0초</strong></div><div class="metric" data-metric="messages"><span class="label">보낸 채팅</span><strong class="value messages-value">0회</strong></div></div><small class="caption">대화별로 저장됩니다.</small></div>`;
    const card = usageRoot.querySelector('.card');
    card.addEventListener('pointerdown', event => {
      if (event.button !== 0) return;
      const rect = usageHost.getBoundingClientRect();
      usageDrag = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, left: rect.left, top: rect.top };
      card.setPointerCapture(event.pointerId);
      event.preventDefault();
    });
    card.addEventListener('pointermove', event => {
      if (!usageDrag || event.pointerId !== usageDrag.pointerId) return;
      const position = clampPointUsagePosition(usageDrag.left + event.clientX - usageDrag.startX, usageDrag.top + event.clientY - usageDrag.startY);
      pointUsagePosition = position;
      usageHost.style.left = `${position.left}px`; usageHost.style.top = `${position.top}px`;
      usageHost.setAttribute('dragging', '');
    });
    const finishDrag = event => {
      if (!usageDrag || event.pointerId !== usageDrag.pointerId) return;
      usageDrag = null; usageHost.removeAttribute('dragging');
      if (pointUsagePosition && !cleanupInvalidContext()) storageSet({ pointUsagePosition });
    };
    card.addEventListener('pointerup', finishDrag);
    card.addEventListener('pointercancel', finishDrag);
    document.documentElement.append(usageHost);
  }
  function clampPointUsagePosition(left, top) {
    const width = usageHost?.getBoundingClientRect().width || 260;
    const height = usageHost?.getBoundingClientRect().height || 100;
    return {
      left: Math.round(Math.max(8, Math.min(window.innerWidth - width - 8, left))),
      top: Math.round(Math.max(8, Math.min(window.innerHeight - height - 8, top)))
    };
  }
  function readAvailablePoints() {
    if (window !== window.top || !document.body) return null;
    const matches = [...document.querySelectorAll('body *')].filter(el => el.children.length <= 3 && visible(el)).map(el => {
      const text = (el.innerText || el.textContent || '').trim().replace(/\s+/g, ' ');
      const match = text.match(/^([\d,]+)\s*포인트$/i);
      if (!match) return null;
      const rect = el.getBoundingClientRect();
      return { value: Number(match[1].replaceAll(',', '')), score: (rect.top < 220 ? 0 : 1000) + (rect.right > window.innerWidth * 0.55 ? 0 : 100) + Math.abs(window.innerWidth - rect.right) / 100 };
    }).filter(Boolean).sort((a, b) => a.score - b.score);
    return matches[0]?.value ?? null;
  }
  function loadConversationUsage(id) {
    if (!usageRoot) return;
    displayedUsageConversation = id || '';
    const record = usageByConversation[id] || {};
    displayedUsageTotal = Number(record.spent) || 0;
    displayedUsageActiveMs = Number(record.activeMs) || 0;
    displayedUserMessageCount = Math.max(Number(record.userMessages) || 0, config.collectConversationStats ? countUserMessages() : 0);
    updateUsageMetricsVisibility(); updateUsageCard();
    if (config.collectConversationStats && displayedUserMessageCount > (Number(record.userMessages) || 0)) persistUsageUpdate(id, value => { value.userMessages = displayedUserMessageCount; });
  }
  function formatDuration(milliseconds) {
    const totalSeconds = Math.floor(milliseconds / 1000);
    const hours = Math.floor(totalSeconds / 3600), minutes = Math.floor((totalSeconds % 3600) / 60), seconds = totalSeconds % 60;
    const twoDigits = value => String(value).padStart(2, '0');
    if (hours) return `${hours}:${twoDigits(minutes)}:${twoDigits(seconds)}`;
    return `${twoDigits(Math.floor(totalSeconds / 60))}:${twoDigits(seconds)}`;
  }
  function updateUsageCard() {
    if (!usageRoot) return;
    usageRoot.querySelector('.cost-value').textContent = `${displayedUsageTotal.toLocaleString('ko-KR')} P`;
    usageRoot.querySelector('.duration-value').textContent = formatDuration(displayedUsageActiveMs);
    usageRoot.querySelector('.messages-value').textContent = `${displayedUserMessageCount.toLocaleString('ko-KR')}회`;
  }
  function updateUsageMetricsVisibility() {
    if (!usageRoot) return;
    usageRoot.querySelector('[data-metric="cost"]').hidden = !config.showConversationCost;
    usageRoot.querySelector('[data-metric="duration"]').hidden = !config.showConversationDuration;
    usageRoot.querySelector('[data-metric="messages"]').hidden = !config.showUserMessageCount;
  }
  function countUserMessages() {
    if (window !== window.top) return 0;
    const roleNodes = [...document.querySelectorAll('[data-message-author-role="user"],[data-role="user"]')].filter(visible);
    if (roleNodes.length) return roleNodes.length;
    const fallbackNodes = [...document.querySelectorAll('[class*="user-message" i],[class*="message-user" i]')].filter(visible);
    return fallbackNodes.filter(node => !node.parentElement?.matches('[class*="user-message" i],[class*="message-user" i]')).length;
  }
  function persistUsageUpdate(id, update) {
    if (!id || cleanupInvalidContext()) return;
    storageGet({ pointUsageByConversation: {} }, result => {
      if (cleanupInvalidContext()) return;
      const data = result.pointUsageByConversation || {};
      const entry = { spent: 0, activeMs: 0, userMessages: 0, ...(data[id] || {}) };
      update(entry);
      entry.updatedAt = Date.now(); data[id] = entry;
      const keep = Object.entries(data).sort((a, b) => (b[1]?.updatedAt || 0) - (a[1]?.updatedAt || 0)).slice(0, 100);
      usageByConversation = Object.fromEntries(keep);
      storageSet({ pointUsageByConversation: usageByConversation });
      if (displayedUsageConversation === id) {
        displayedUsageTotal = Number(entry.spent) || 0;
        displayedUsageActiveMs = Number(entry.activeMs) || 0;
        displayedUserMessageCount = Number(entry.userMessages) || 0;
        updateUsageCard();
      }
    });
  }
  function flushActivityTime() {
    if (!activityMsBuffer || !activityBufferConversation) return;
    const id = activityBufferConversation, elapsed = activityMsBuffer;
    activityMsBuffer = 0;
    persistUsageUpdate(id, record => { record.activeMs = (Number(record.activeMs) || 0) + elapsed; });
  }
  function refreshUserMessageCount(force = false) {
    if (!config.collectConversationStats || window !== window.top) return;
    const now = Date.now();
    if (!force && now - lastMessageCountCheckAt < 900) return;
    lastMessageCountCheckAt = now;
    const id = currentConversationId();
    if (!id) return;
    const count = countUserMessages();
    if (id === displayedUsageConversation && count > displayedUserMessageCount) {
      displayedUserMessageCount = count; updateUsageCard();
    }
    if (count > (Number(usageByConversation[id]?.userMessages) || 0)) {
      persistUsageUpdate(id, record => { record.userMessages = Math.max(Number(record.userMessages) || 0, count); });
    }
  }
  function trackSentMessage(text) {
    if (!config.collectConversationStats || window !== window.top) return;
    const id = currentConversationId(), normalizedText = String(text || '').trim();
    if (!id || !normalizedText) return;
    const now = Date.now();
    if (lastTrackedSend.id === id && lastTrackedSend.text === normalizedText && now - lastTrackedSend.at < 800) return;
    lastTrackedSend = { id, text: normalizedText, at: now };
    const baseline = Math.max(
      id === displayedUsageConversation ? displayedUserMessageCount : 0,
      Number(usageByConversation[id]?.userMessages) || 0,
      countUserMessages()
    );
    const nextCount = baseline + 1;
    if (id === displayedUsageConversation) { displayedUserMessageCount = nextCount; updateUsageCard(); }
    persistUsageUpdate(id, record => { record.userMessages = Math.max(Number(record.userMessages) || 0, nextCount); });
  }
  function updateConversationActivity() {
    const now = Date.now(), elapsed = now - activityTickAt;
    activityTickAt = now;
    const id = currentConversationId();
    if (activityBufferConversation && activityBufferConversation !== id) flushActivityTime();
    if (config.collectConversationStats && id && window === window.top && !document.hidden && document.hasFocus() && elapsed > 0 && elapsed < 5000) {
      if (activityBufferConversation !== id) { activityBufferConversation = id; activityMsBuffer = 0; }
      activityMsBuffer += elapsed;
      if (displayedUsageConversation === id) { displayedUsageActiveMs += elapsed; updateUsageCard(); }
      if (activityMsBuffer >= 5000) flushActivityTime();
    }
    refreshUserMessageCount();
  }
  function resetActivityClock() { activityTickAt = Date.now(); flushActivityTime(); }
  function updatePointUsageUiPosition() {
    if (!usageHost) initPointUsageUi();
    const hasMetric = config.showConversationCost || config.showConversationDuration || config.showUserMessageCount;
    if (!config.showConversationStats || !hasMetric || !hasActiveConversation() || window !== window.top) { usageHost.hidden = true; return; }
    const composer = findComposer();
    const rect = composer && findComposerPanelRect(composer);
    if (!rect || window.innerWidth < 1180) { usageHost.hidden = true; return; }
    const width = 260, gap = 22, left = Math.round(rect.left - width - gap);
    if (!pointUsagePosition && left < 370) { usageHost.hidden = true; return; }
    const top = Math.max(138, Math.min(238, window.innerHeight - 180));
    usageHost.hidden = false;
    const position = pointUsagePosition ? clampPointUsagePosition(pointUsagePosition.left, pointUsagePosition.top) : { left, top };
    usageHost.style.left = `${position.left}px`; usageHost.style.top = `${position.top}px`;
    usageHost.setAttribute('theme', selectedPickerTheme());
    if (displayedUsageConversation !== currentConversationId()) loadConversationUsage(currentConversationId());
  }
  function capturePointBalanceBeforeSend() {
    if (!config.collectConversationStats || window !== window.top) return;
    const id = currentConversationId(), balance = readAvailablePoints();
    if (id && balance !== null) pendingSpendStart = { id, balance, at: Date.now() };
  }
  function beginPointUsageTracking() {
    if (!config.collectConversationStats || window !== window.top) return;
    const id = currentConversationId();
    if (!id) return;
    const pending = pendingSpendStart;
    const balance = pending?.id === id && Date.now() - pending.at < 180000 ? pending.balance : readAvailablePoints();
    pendingSpendStart = null;
    if (balance !== null) responseSpendStart = { id, balance };
  }
  function finishPointUsageTracking() {
    const start = responseSpendStart; responseSpendStart = null; pendingSpendStart = null;
    if (!config.collectConversationStats || !start || start.id !== currentConversationId()) return;
    const beganAt = Date.now(); let lastBalance = null, lastChange = beganAt;
    const poll = setInterval(() => {
      if (cleanupInvalidContext()) { clearInterval(poll); return; }
      const now = Date.now(), current = readAvailablePoints();
      if (current === null) { if (now - beganAt > 6000) clearInterval(poll); return; }
      if (current !== lastBalance) { lastBalance = current; lastChange = now; }
      const elapsed = now - beganAt;
      if (elapsed < 900 || (current === start.balance && elapsed < 2500) || now - lastChange < 700) {
        if (elapsed < 6000) return;
      }
      clearInterval(poll);
      const spent = Math.max(0, start.balance - current);
      if (!spent) return;
      persistUsageUpdate(start.id, record => { record.spent = (Number(record.spent) || 0) + spent; });
    }, 250);
  }
  initPrefixUi();
  initPointUsageUi();
  window.addEventListener('resize', updatePrefixUiPosition);
  window.addEventListener('scroll', updatePrefixUiPosition, true);
  layoutTimer = setInterval(() => { if (cleanupInvalidContext()) return; updatePrefixUiPosition(); if (prefixHost) prefixHost.setAttribute('theme', selectedPickerTheme()); }, 1200);
  activityTimer = setInterval(() => { if (!cleanupInvalidContext()) updateConversationActivity(); }, 1000);
  document.addEventListener('visibilitychange', resetActivityClock);
  window.addEventListener('blur', resetActivityClock);
  window.addEventListener('focus', resetActivityClock);
  window.addEventListener('pagehide', flushActivityTime);

  const isEditable = el => el instanceof HTMLElement && (el.matches('textarea,input:not([type]),input[type="text"],input[type="search"],[contenteditable="true"],[role="textbox"]') || el.isContentEditable);
  function insertText(el, text) {
    el.focus();
    el.style.fontFamily = FONT_STACK;
    el.style.fontWeight = '400';
    el.style.fontSynthesis = 'none';
    if (el.isContentEditable || el.getAttribute('contenteditable') === 'true' || el.getAttribute('role') === 'textbox') {
      // Use the editor's native plain-text insertion path so the preset follows Eden Chat's own typography.
      if (document.execCommand?.('insertText', false, text)) return;
      const selection = window.getSelection();
      if (selection?.rangeCount && el.contains(selection.getRangeAt(0).commonAncestorContainer)) {
        const range = selection.getRangeAt(0); range.deleteContents();
        const node = document.createTextNode(text); range.insertNode(node); range.setStartAfter(node); range.collapse(true);
        selection.removeAllRanges(); selection.addRange(range);
      } else {
        const range = document.createRange(); range.selectNodeContents(el); range.collapse(false);
        const node = document.createTextNode(text); range.insertNode(node); range.setStartAfter(node); range.collapse(true);
        selection?.removeAllRanges(); selection?.addRange(range);
      }
      el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
      return;
    }
    const start = el.selectionStart ?? el.value.length, end = el.selectionEnd ?? start;
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')?.set;
    if (setter) setter.call(el, el.value.slice(0, start) + text + el.value.slice(end)); else el.value += text;
    el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
    el.setSelectionRange(start + text.length, start + text.length);
  }
  function withPrefixLineBreak(text) { return text.endsWith('\n') ? text : `${text}\n`; }
  function composerText(el) { return el.matches('textarea,input') ? el.value : (el.innerText || el.textContent || ''); }
  function editableTarget(target) {
    if (!(target instanceof Element)) return null;
    return target.closest('textarea,input[type="text"],[contenteditable="true"],[role="textbox"]');
  }
  function isEmptyComposer(target) { return target && target === findComposer() && !composerText(target).trim(); }
  document.addEventListener('click', event => {
    if (cleanupInvalidContext()) return;
    if (!hasActiveConversation() || config.prefixEnabled === false || !config.autoInsertOnComposerClick) return;
    const target = editableTarget(event.target);
    const preset = activePrefix();
    if (!target || !visible(target) || !isEmptyComposer(target) || !preset?.text?.trim()) return;
    setTimeout(() => {
      const current = activePrefix();
      if (config.prefixEnabled === false || !config.autoInsertOnComposerClick || !visible(target) || !isEmptyComposer(target) || (document.activeElement !== target && !target.contains(document.activeElement)) || !current?.text?.trim()) return;
      insertText(target, withPrefixLineBreak(current.text));
      showToast(`접두사 입력 · ${current.name || '빠른 문구'}`);
    }, 100);
  }, true);
  function matchesShortcut(event, shortcut) {
    const parts = (shortcut || '').toLowerCase().split('+').map(x => x.trim());
    if (!parts.length || !parts.at(-1)) return false;
    const key = parts.at(-1);
    return event.key.toLowerCase() === key && event.ctrlKey === parts.includes('ctrl') && event.altKey === parts.includes('alt') && event.shiftKey === parts.includes('shift') && event.metaKey === parts.includes('meta');
  }
  document.addEventListener('keydown', event => {
    if (cleanupInvalidContext()) return;
    if (!hasActiveConversation() || event.isComposing || !(event.target instanceof HTMLElement) || prefixHost?.contains(event.target)) return;
    const composer = findComposer();
    if (event.key === 'Enter' && !event.shiftKey && event.target === composer && isEditable(event.target) && composerText(event.target).trim()) {
      capturePointBalanceBeforeSend();
      trackSentMessage(composerText(event.target));
    }
    const prefix = config.prefixEnabled === false ? null : (config.prefixes || []).find(item => item.enabled !== false && item.shortcut && matchesShortcut(event, item.shortcut));
    if (!prefix) return;
    const target = isEditable(event.target) ? event.target : [...document.querySelectorAll('textarea,input,[contenteditable="true"],[role="textbox"]')].find(visible);
    if (!target || !visible(target)) return;
    setActivePrefix(prefix.id, false);
    event.preventDefault(); event.stopPropagation(); insertText(target, withPrefixLineBreak(prefix.text || ''));
    showToast(`접두사 입력 · ${prefix.name || '빠른 문구'}`);
  }, true);
  document.addEventListener('pointerdown', event => {
    if (cleanupInvalidContext()) return;
    if (!config.collectConversationStats || !hasActiveConversation() || !(event.target instanceof Element)) return;
    const button = event.target.closest('button,[role="button"],input[type="submit"]');
    const composer = findComposer(), panel = composer && findComposerPanelRect(composer);
    if (!button || !panel) return;
    const rect = button.getBoundingClientRect();
    if (rect.left >= panel.left && rect.right <= panel.right && rect.top >= panel.top && rect.bottom <= panel.bottom) {
      capturePointBalanceBeforeSend();
      const text = composerText(composer);
      const label = `${button.getAttribute('aria-label') || ''} ${button.getAttribute('title') || ''} ${button.innerText || ''}`.toLowerCase();
      const sendLike = /send|submit|보내기|전송|전달/.test(label) || (rect.right > panel.right - 68 && rect.bottom > panel.bottom - 58);
      if (sendLike && text.trim()) trackSentMessage(text);
    }
  }, true);
  document.addEventListener('submit', event => {
    if (cleanupInvalidContext() || !config.collectConversationStats || !hasActiveConversation()) return;
    const composer = findComposer();
    if (composer && event.target instanceof HTMLFormElement && event.target.contains(composer) && composerText(composer).trim()) {
      capturePointBalanceBeforeSend();
      trackSentMessage(composerText(composer));
    }
  }, true);

})();
