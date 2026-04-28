(function () {
  'use strict';

  if (document.getElementById('tr-btn-wrap')) return;

  // --- UI ---
  const wrap = document.createElement('div');
  wrap.id = 'tr-btn-wrap';
  wrap.style.cssText = `
    position: fixed;
    top: 24px;
    right: 24px;
    z-index: 2147483647;
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: 8px;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  `;

  const btn = document.createElement('button');
  btn.id = 'tr-record-btn';
  btn.textContent = '⏺  Записать встречу';
  btn.style.cssText = `
    background: #d62d20;
    color: #fff;
    border: none;
    border-radius: 24px;
    padding: 12px 22px;
    font-size: 14px;
    font-weight: 600;
    cursor: pointer;
    box-shadow: 0 4px 14px rgba(0,0,0,0.35);
    transition: background 0.2s, transform 0.1s;
    white-space: nowrap;
  `;

  const status = document.createElement('div');
  status.id = 'tr-status';
  status.style.cssText = `
    background: #1c1c1e;
    color: #fff;
    border-radius: 12px;
    padding: 10px 16px;
    font-size: 13px;
    max-width: 300px;
    box-shadow: 0 4px 14px rgba(0,0,0,0.35);
    display: none;
    line-height: 1.4;
  `;

  wrap.appendChild(status);
  wrap.appendChild(btn);
  document.body.appendChild(wrap);

  // --- State ---
  let recording = false;
  let recordingStartedAt = null;
  let overlayTimerInterval = null;
  const START_FROM_ACTION_MESSAGE = 'Сначала откройте расширение ECHO для открытия доступа или запустите запись изнутри';

  function setStatus(msg, autohide = 5000) {
    status.textContent = msg;
    status.style.display = 'block';
    if (autohide) setTimeout(() => { status.style.display = 'none'; }, autohide);
  }

  function formatDuration(totalSeconds) {
    const mins = String(Math.floor(totalSeconds / 60)).padStart(2, '0');
    const secs = String(totalSeconds % 60).padStart(2, '0');
    return `${mins}:${secs}`;
  }

  function stopOverlayTimer() {
    clearInterval(overlayTimerInterval);
    overlayTimerInterval = null;
  }

  function startOverlayTimer(startedAt) {
    stopOverlayTimer();
    recordingStartedAt = startedAt || Date.now();

    const renderTimer = () => {
      const elapsed = Math.max(0, Math.floor((Date.now() - recordingStartedAt) / 1000));
      status.textContent = `🔴 Идёт запись... ${formatDuration(elapsed)}`;
      status.style.display = 'block';
    };

    renderTimer();
    overlayTimerInterval = setInterval(renderTimer, 1000);
  }

  function setRecording(active, startedAt = null) {
    recording = active;
    btn.disabled = false;
    if (active) {
      btn.textContent = '⏹  Остановить запись';
      btn.style.background = '#333';
      startOverlayTimer(startedAt);
    } else {
      stopOverlayTimer();
      recordingStartedAt = null;
      btn.textContent = '⏺  Записать встречу';
      btn.style.background = '#d62d20';
    }
  }

  btn.addEventListener('click', () => {
    if (!recording) {
      chrome.runtime.sendMessage({ action: 'startRecordingFromOverlay' }, (resp) => {
        if (chrome.runtime.lastError) {
          setStatus('❌ Ошибка: ' + chrome.runtime.lastError.message);
          return;
        }
        if (resp && resp.success) {
          setRecording(true, resp.startedAt || Date.now());
        } else {
          setStatus(resp && resp.message ? resp.message : START_FROM_ACTION_MESSAGE);
        }
      });
    } else {
      btn.disabled = true;
      btn.textContent = '⏳ Обрабатываю...';
      chrome.runtime.sendMessage({ action: 'stopRecording' }, () => {
        btn.disabled = false;
      });
    }
  });

  // --- Messages from background ---
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.action === 'recordingStarted') {
      setRecording(true, msg.startedAt || Date.now());
    } else if (msg.action === 'recordingStateChanged') {
      syncRecordingState();
    } else if (msg.action === 'transcribing') {
      setStatus('⏳ Транскрибирую запись...', 0);
      setRecording(false);
    } else if (msg.action === 'confirmShortRecording') {
      const seconds = Number(msg.durationSeconds) || 0;
      const keep = window.confirm(
        `Запись длилась ${formatDuration(seconds)} — меньше минуты.\n\nСохранить и транскрибировать её?`
      );
      sendResponse({ keep });
      return true;
    } else if (msg.action === 'recordingDiscarded') {
      setStatus('Короткая запись удалена.', 4000);
      setRecording(false);
    } else if (msg.action === 'transcriptReady') {
      // Copy to clipboard
      navigator.clipboard.writeText(msg.prompt).catch(() => {
        const ta = document.createElement('textarea');
        ta.value = msg.prompt;
        Object.assign(ta.style, { position: 'fixed', opacity: '0' });
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
      });
      setStatus('✅ Транскрипт готов и скопирован в буфер — вставляй в Клода (Cmd+V)');
      setRecording(false);
    } else if (msg.action === 'error') {
      setStatus('❌ ' + msg.error);
      setRecording(false);
      btn.disabled = false;
    }
  });

  function syncRecordingState() {
    chrome.runtime.sendMessage({ action: 'getRecordingState' }, (resp) => {
      if (chrome.runtime.lastError || !resp) return;
      setRecording(!!resp.isCurrentTabRecording, resp.startedAt || null);
    });
  }

  // --- Detect meeting state (based on YTIROK approach) ---
  function isMeetingActive() {
    if (!window.location.href.includes('/j/')) return false;
    return !!(
      document.querySelector('button[title="Выйти из встречи"]') ||
      document.querySelector('button[class*="endCallButton"]')
    );
  }

  function isUserAlone() {
    return document.body.innerText.includes('Чтобы пригласить других участников');
  }

  let prompted = false;
  let loopStarted = false;

  function startDetectionLoop() {
    if (loopStarted) return;
    loopStarted = true;

    setInterval(() => {
      if (!isMeetingActive()) {
        prompted = false;
        return;
      }
      // When participants join and we haven't prompted yet
      if (!isUserAlone() && !prompted && !recording) {
        prompted = true;
        setStatus('👥 Участники подключились. Начать запись встречи?', 0);

        if (!document.getElementById('tr-yes-btn')) {
          const yes = document.createElement('button');
          yes.id = 'tr-yes-btn';
          yes.textContent = 'Как начать запись';
          yes.style.cssText = `
            display: block; margin-top: 8px; width: 100%;
            background: #d62d20; color: #fff; border: none;
            border-radius: 20px; padding: 8px 18px;
            font-size: 13px; font-weight: 600; cursor: pointer;
          `;
          yes.addEventListener('click', () => {
            yes.remove();
            status.style.display = 'none';
            btn.click();
          });
          status.appendChild(yes);
        }
      }
    }, 1500);
  }

  // Start loop when on a meeting URL
  if (window.location.href.includes('/j/')) {
    syncRecordingState();
    startDetectionLoop();
    setInterval(syncRecordingState, 10000);
  }
})();
