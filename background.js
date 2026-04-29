// background.js — service worker
importScripts('db.js');

let activeTabId = null;
let isRecording = false;
let currentMeetingId = null;
let recordingStartedAt = null;

let panelWindowId = null;
let startRecordingPending = false;
const actionInvokedTabs = new Map();

const TELEMOST_HOSTS = new Set(['telemost.yandex.ru', 'telemost.yandex.com']);
const START_FROM_ACTION_MESSAGE = 'Запись нужно запускать кликом по иконке ECHO на активной вкладке Телемоста.';
const OPEN_MEETING_MESSAGE = 'Открой активную страницу встречи Телемоста: telemost.yandex.ru/j/... или telemost.yandex.com/j/...';
const SHORT_RECORDING_THRESHOLD_MS = 60 * 1000;
const EMPTY_RECORDING_TRANSCRIPT = 'Запись пуста';
const SUMMARY_PROMPT_STORAGE_KEY = 'summaryBasePrompt';
const DEFAULT_SUMMARY_PROMPT = `Сделай саммари деловой встречи на русском языке.

Структура:
1. Краткое резюме на 3-5 предложений.
2. Ключевые решения и договоренности.
3. Задачи: что сделать, кто отвечает, срок, если он есть.
4. Важные риски, вопросы и открытые хвосты.

Пиши конкретно, без воды. Если в транскрипте нет данных для пункта, так и напиши.`;

// ── SW startup: recover any meetings stuck in RECORDING status ──
(async () => {
  await configureSidePanel();
  await recoverStalledMeetings();
})();

function persistRecordingState() {
  chrome.storage.session.set({
    recordingState: { isRecording, currentMeetingId, activeTabId, recordingStartedAt }
  });
}

function clearPersistedRecordingState() {
  chrome.storage.session.remove('recordingState');
}

async function recoverStalledMeetings() {
  try {
    const meetings = await dbGetAllMeetings();
    const stalled = meetings.filter(m => m.status === MEETING_STATUS.RECORDING);
    for (const m of stalled) {
      await dbSaveMeeting({
        ...m,
        status: MEETING_STATUS.ERROR,
        lastError: 'Запись прервалась — браузер или расширение перезапустились.',
        updatedAt: Date.now()
      });
    }
    if (stalled.length > 0) emitHistoryUpdated();
  } catch (e) {
    logError('recoverStalledMeetings', e);
  }
}

function logError(tag, error) {
  const msg = error instanceof Error ? error.message
    : (error && typeof error === 'object' && error.message) ? error.message
    : String(error);
  console.error(`[ECHO/${tag}]`, msg, error);
}

const MEETING_STATUS = {
  RECORDING: 'Идёт запись',
  RECORDED: 'Запись сохранена',
  TRANSCRIBING: 'Транскрибируется',
  DONE: 'Готово',
  ERROR: 'Ошибка'
};

// ── Recording settings ──
async function getRecordingSettings() {
  return new Promise(resolve => {
    chrome.storage.local.get(['saveVideo', 'saveDestination', 'autoTagMeetings'], data => {
      resolve({
        saveVideo: data.saveVideo !== false, // default true
        saveDestination: data.saveDestination || 'local',
        autoTagMeetings: data.autoTagMeetings !== false
      });
    });
  });
}

// ── File naming ──
function sanitizeFileName(value) {
  return String(value || '')
    .replace(/[/\\:*?"<>|]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 100);
}

function buildRecordingFileNames(meeting) {
  // formatDate returns "YYYY-MM-DD_HH-MM", convert to "YYYY-MM-DD HH-MM"
  const rawDate = String(meeting.date || formatDate(meeting.id || Date.now()));
  const datePart = rawDate.replace(/_/g, ' ').slice(0, 16);
  const rawTitle = meeting.title || 'Без названия';
  const titlePart = sanitizeFileName(rawTitle).slice(0, 60);
  const baseName = sanitizeFileName(`${datePart} ${titlePart}`.trim());
  const folderName = `Telemost Recordings/${baseName}`;
  return {
    folderName,
    fileNames: {
      audio:      `AUDIO - ${baseName}`,
      video:      `VIDEO - ${baseName}`,
      transcript: `TRANSCRIPT - ${baseName}`,
      summary:    `SUMMARY - ${baseName}`
    }
  };
}

chrome.action.onClicked.addListener((tab) => {
  const tabId = tab && tab.id;
  if (tabId && isAllowedTelemostMeetingUrl(tab.url)) {
    markActionInvoked(tabId, tab.url);
    openOptionalPanel(tab);
    return;
  }
  openOptionalPanel(tab || null);
});

async function configureSidePanel() {
  if (!hasSidePanelApi()) return false;
  try {
    if (typeof chrome.sidePanel.setOptions === 'function') {
      await chrome.sidePanel.setOptions({ path: 'sidepanel.html', enabled: true });
    }
    if (typeof chrome.sidePanel.setPanelBehavior === 'function') {
      await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
    }
    return true;
  } catch (e) {
    logError('configureSidePanel', e);
    return false;
  }
}

function hasSidePanelApi() {
  return !!(
    chrome.sidePanel &&
    typeof chrome.sidePanel.setOptions === 'function' &&
    typeof chrome.sidePanel.open === 'function'
  );
}

async function openOptionalPanel(tab = null) {
  if (!hasSidePanelApi()) {
    openPanelWindow();
    return;
  }
  try {
    await chrome.sidePanel.setOptions({ path: 'sidepanel.html', enabled: true });
    const windowId = tab && typeof tab.windowId === 'number' ? tab.windowId : null;
    if (windowId === null) { openPanelWindow(); return; }
    await chrome.sidePanel.open({ windowId });
  } catch (e) {
    logError('openOptionalPanel/sidePanelFallback', e);
    openPanelWindow();
  }
}

function openPanelWindow() {
  if (panelWindowId !== null) {
    chrome.windows.get(panelWindowId, {}, (win) => {
      if (chrome.runtime.lastError || !win) {
        panelWindowId = null;
        createPanelWindow();
      } else {
        chrome.windows.update(panelWindowId, { focused: true });
      }
    });
    return;
  }
  createPanelWindow();
}

function createPanelWindow() {
  chrome.windows.getCurrent({}, (currentWin) => {
    const panelWidth = 380;
    const left = (currentWin.left || 0) + (currentWin.width || 1200) - panelWidth;
    const top = currentWin.top || 0;
    const height = currentWin.height || 900;
    chrome.windows.create({
      url: chrome.runtime.getURL('sidepanel.html'),
      type: 'popup',
      width: panelWidth,
      height: height,
      left: left,
      top: top
    }, (win) => { panelWindowId = win.id; });
  });
}

chrome.windows.onRemoved.addListener((windowId) => {
  if (windowId === panelWindowId) panelWindowId = null;
});

chrome.tabs.onRemoved.addListener((tabId) => {
  actionInvokedTabs.delete(tabId);
  if (tabId === activeTabId && isRecording) {
    isRecording = false;
    chrome.runtime.sendMessage({ action: 'stopCapture', tabClosed: true });
    broadcastRecordingStateChanged();
  }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.url) actionInvokedTabs.delete(tabId);
});

function isAllowedTelemostMeetingUrl(url) {
  try {
    const parsed = new URL(url || '');
    return parsed.protocol === 'https:' &&
      TELEMOST_HOSTS.has(parsed.hostname) &&
      /^\/j\/[^/]+/.test(parsed.pathname);
  } catch (e) {
    return false;
  }
}

function markActionInvoked(tabId, url) {
  actionInvokedTabs.set(tabId, { url, at: Date.now() });
}

function hasActionInvocation(tabId) {
  return actionInvokedTabs.has(tabId);
}

function startFailure(reason, message, extra = {}) {
  return { success: false, reason, message, ...extra };
}

function getTab(tabId) {
  return new Promise((resolve, reject) => {
    chrome.tabs.get(tabId, (tab) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(tab);
    });
  });
}

function getActiveTab() {
  return new Promise((resolve) => {
    chrome.windows.getLastFocused({ windowTypes: ['normal'] }, (win) => {
      if (chrome.runtime.lastError || !win) {
        chrome.tabs.query({ active: true, lastFocusedWindow: true }, (tabs) => {
          resolve(tabs && tabs[0] ? tabs[0] : null);
        });
        return;
      }
      chrome.tabs.query({ active: true, windowId: win.id }, (tabs) => {
        resolve(tabs && tabs[0] ? tabs[0] : null);
      });
    });
  });
}

function getTabCaptureStreamId(tabId) {
  return new Promise((resolve, reject) => {
    chrome.tabCapture.getMediaStreamId({ targetTabId: tabId }, (id) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(id);
    });
  });
}

function normalizeStartRecordingError(error) {
  if (error && error.echoStartFailure) return error.echoStartFailure;
  const rawMessage = error instanceof Error ? error.message : String(error || '');
  const needsAction = /not been invoked|activeTab|active tab|permission|not allowed|Cannot access/i.test(rawMessage);
  if (needsAction) {
    return startFailure('action_required', START_FROM_ACTION_MESSAGE, { tabCaptureMessage: rawMessage });
  }
  return startFailure('tab_capture_failed', `Не удалось получить аудио вкладки: ${rawMessage}`, { tabCaptureMessage: rawMessage });
}

function getRecordingStatePayload(senderTabId = null) {
  return {
    recording: isRecording,
    startedAt: recordingStartedAt,
    activeTabId,
    meetingId: currentMeetingId,
    isCurrentTabRecording: senderTabId ? senderTabId === activeTabId && isRecording : false
  };
}

function broadcastRecordingStateChanged() {
  const payload = { action: 'recordingStateChanged', ...getRecordingStatePayload() };
  chrome.runtime.sendMessage(payload).catch(() => {});
  if (activeTabId) {
    chrome.tabs.sendMessage(activeTabId, payload).catch(() => {});
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'startRecording') {
    const tabId = sender.tab ? sender.tab.id : activeTabId;
    startRecording(tabId, {
      source: 'generic',
      tab: sender.tab,
      requireActionInvocation: true
    }).then(sendResponse);
    return true;
  }

  if (message.action === 'stopRecording') {
    ensureOffscreen().then(() => {
      chrome.runtime.sendMessage({ action: 'stopCapture' });
      sendResponse({});
    });
    return true;
  }

  if (message.action === 'startRecordingFromPanel') {
    getActiveTab().then((targetTab) => {
      if (!targetTab || !isAllowedTelemostMeetingUrl(targetTab.url)) {
        sendResponse(startFailure('not_telemost_meeting', OPEN_MEETING_MESSAGE));
        return;
      }
      startRecording(targetTab.id, {
        source: 'panel',
        tab: targetTab
      }).then(sendResponse);
    });
    return true;
  }

  if (message.action === 'startRecordingFromOverlay') {
    const tabId = sender.tab && sender.tab.id;
    if (!tabId) {
      sendResponse(startFailure('no_tab', 'Не найдена вкладка Телемоста для записи.'));
      return true;
    }
    if (!hasActionInvocation(tabId)) {
      sendResponse(startFailure('action_required', START_FROM_ACTION_MESSAGE));
      return true;
    }
    startRecording(tabId, {
      source: 'overlay',
      tab: sender.tab,
      requireActionInvocation: true
    }).then(sendResponse);
    return true;
  }

  if (message.action === 'retranscribe') {
    transcribeMeeting(message.meetingId, { resume: true });
    sendResponse({});
    return true;
  }

  if (message.action === 'getMeetings') {
    dbGetAllMeetings().then(meetings => sendResponse({ meetings }));
    return true;
  }

  if (message.action === 'getRecordingState') {
    const senderTabId = sender.tab && sender.tab.id;
    sendResponse(getRecordingStatePayload(senderTabId));
    return true;
  }

  if (message.action === 'openRecordings') {
    chrome.downloads.showDefaultFolder();
    sendResponse({});
    return true;
  }

  if (message.action === 'saveTranscript') {
    dbSaveMeeting(message.meeting).then(() => sendResponse({}));
    return true;
  }

  // ── Tag management ──
  if (message.action === 'getPresetTags') {
    chrome.storage.local.get('presetTags', d => sendResponse({ tags: d.presetTags || [] }));
    return true;
  }

  if (message.action === 'savePresetTags') {
    chrome.storage.local.set({ presetTags: message.tags }, () => sendResponse({}));
    return true;
  }

  if (message.action === 'updateMeetingTags') {
    dbGetMeeting(message.meetingId).then(meeting => {
      if (!meeting) { sendResponse({}); return; }
      dbSaveMeeting({ ...meeting, tags: message.tags }).then(() => {
        emitHistoryUpdated();
        sendResponse({});
      });
    });
    return true;
  }

  // ── Google Drive messages ──
  if (message.action === 'checkDriveStatus') {
    checkDriveConnected().then(connected => sendResponse({ connected }));
    return true;
  }

  if (message.action === 'connectDrive') {
    connectDriveInteractive().then(result => sendResponse(result));
    return true;
  }

  if (message.action === 'disconnectDrive') {
    disconnectDrive().then(() => sendResponse({ ok: true }));
    return true;
  }

  if (message.action === 'resetDriveAuth') {
    resetDriveAuth().then(() => sendResponse({ ok: true }));
    return true;
  }

  if (message.action === 'retryDriveUpload') {
    const retryId = message.meetingId;
    dbGetMeeting(retryId).then(meeting => {
      if (!meeting) { sendResponse({ ok: false, error: 'Запись не найдена' }); return; }
      uploadMeetingAssetsToDrive(meeting).catch(async (e) => {
        logError('retryDriveUpload', e);
        const errorMsg = e.message || 'Ошибка загрузки в Google Drive';
        emitDriveProgress(retryId, `❌ ${errorMsg}`);
        const current = await dbGetMeeting(retryId).catch(() => null);
        if (current) {
          await dbSaveMeeting({
            ...current,
            driveUploadStatus: 'error',
            driveUploadError: errorMsg,
            updatedAt: Date.now()
          }).catch(() => {});
          emitHistoryUpdated();
        }
      });
      sendResponse({ ok: true });
    });
    return true;
  }

  if (message.action === 'recorderHeartbeat') {
    return;
  }

  if (message.action === 'audioData') {
    if (message.meetingId && message.meetingId !== currentMeetingId) {
      console.warn(`[ECHO/audioData] stale chunk ignored`, { received: message.meetingId, current: currentMeetingId });
      return;
    }
    if (message.error || !message.data) {
      logError('audioData', message.error || 'no audio data received');
      isRecording = false;
      activeTabId = null;
      if (currentMeetingId) {
        dbGetMeeting(currentMeetingId)
          .then(meeting => meeting ? dbSaveMeeting({
            ...meeting,
            status: MEETING_STATUS.ERROR,
            lastError: message.error || 'Не удалось захватить аудио встречи.',
            updatedAt: Date.now()
          }) : null)
          .then(() => emitHistoryUpdated())
          .catch(() => {});
      }
      currentMeetingId = null;
      recordingStartedAt = null;
      clearPersistedRecordingState();
      broadcastRecordingStateChanged();
      closeOffscreen();
      notifyError(message.error || 'Не удалось захватить аудио встречи.', message.tabId, message.tabClosed || false);
      return;
    }
    handleAudioData(
      message.data,
      message.tabId,
      message.tabClosed || false,
      message.chunkIndex || 0,
      message.isFinal !== false,
      message.sizeBytes || 0
    );
  }

  // ── Video data from offscreen ──
  if (message.action === 'videoData') {
    handleVideoData(message);
    return;
  }
});

async function startRecording(tabId, options = {}) {
  if (isRecording) {
    return { success: true, ...getRecordingStatePayload() };
  }

  if (startRecordingPending) {
    return startFailure('start_pending', 'Запись уже запускается.');
  }

  if (!tabId) return startFailure('no_tab', 'Не найдена активная вкладка для записи.');

  const tab = options.tab || await getTab(tabId).catch(() => null);
  if (!tab || !isAllowedTelemostMeetingUrl(tab.url)) {
    return startFailure('not_telemost_meeting', OPEN_MEETING_MESSAGE);
  }

  if (options.requireActionInvocation && !hasActionInvocation(tabId)) {
    return startFailure('action_required', START_FROM_ACTION_MESSAGE);
  }

  startRecordingPending = true;
  try {
    const streamId = await getTabCaptureStreamId(tabId);
    const key = await getGroqKey();
    if (!key) return startFailure('missing_api_key', 'Groq API ключ не настроен. Открой ECHO и добавь ключ Groq.');

    const settings = await getRecordingSettings();

    await ensureOffscreen();
    activeTabId = tabId;
    currentMeetingId = Date.now();
    recordingStartedAt = Date.now();

    await dbSaveMeeting(buildRecordingMeeting(currentMeetingId, settings));

    chrome.runtime.sendMessage({
      action: 'startCapture',
      streamId,
      tabId,
      meetingId: currentMeetingId,
      enableVideo: settings.saveVideo
    });

    isRecording = true;
    persistRecordingState();
    emitHistoryUpdated();
    broadcastRecordingStateChanged();
    chrome.runtime.sendMessage({ action: 'recordingStarted', startedAt: recordingStartedAt, settings }).catch(() => {});
    chrome.tabs.sendMessage(tabId, { action: 'recordingStarted', startedAt: recordingStartedAt }).catch(() => {});
    return { success: true, ...getRecordingStatePayload(), settings };
  } catch (e) {
    logError('startRecording', e);
    activeTabId = null;
    currentMeetingId = null;
    recordingStartedAt = null;
    return normalizeStartRecordingError(e);
  } finally {
    startRecordingPending = false;
  }
}

async function closeOffscreen() {
  try {
    const existing = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
    if (existing.length > 0) await chrome.offscreen.closeDocument();
  } catch (e) {
    logError('closeOffscreen', e);
  }
}

async function ensureOffscreen() {
  try {
    const existing = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
    if (existing.length > 0) return;

    await new Promise((resolve, reject) => {
      const listener = (message) => {
        if (message.action !== 'offscreenReady') return;
        chrome.runtime.onMessage.removeListener(listener);
        resolve();
      };
      chrome.runtime.onMessage.addListener(listener);
      chrome.offscreen.createDocument({
        url: 'offscreen.html',
        reasons: ['USER_MEDIA'],
        justification: 'Capture tab audio for transcription'
      }).catch((e) => {
        chrome.runtime.onMessage.removeListener(listener);
        reject(e);
      });
    });
  } catch (e) {
    logError('ensureOffscreen', e);
  }
}

async function handleAudioData(base64Data, tabId, tabClosed = false, chunkIndex = 0, isFinal = true, sizeBytes = 0) {
  if (!base64Data) {
    notifyError('Не удалось получить аудиоданные для транскрибации.', tabId, tabClosed);
    return;
  }

  const meetingId = currentMeetingId;
  if (!meetingId) {
    notifyError('Не найдена активная запись для сохранения чанка.', tabId, tabClosed);
    return;
  }

  try {
    const meeting = await dbGetMeeting(meetingId);
    if (!meeting) throw new Error('Не удалось прочитать запись из локального хранилища.');

    if (isFinal && isShortRecording(meeting)) {
      const shouldKeep = await confirmShortRecording(tabId, tabClosed, meeting);
      if (!shouldKeep) {
        await discardMeeting(meetingId);
        isRecording = false;
        activeTabId = null;
        currentMeetingId = null;
        recordingStartedAt = null;
        clearPersistedRecordingState();
        broadcastRecordingStateChanged();
        await closeOffscreen();
        emitHistoryUpdated();
        chrome.runtime.sendMessage({ action: 'recordingDiscarded', meetingId }).catch(() => {});
        if (tabId && !tabClosed) {
          chrome.tabs.sendMessage(tabId, { action: 'recordingDiscarded' }).catch(() => {});
        }
        return;
      }
    }

    const chunkEntry = {
      index: Number(chunkIndex),
      data: base64Data,
      sizeBytes: sizeBytes || estimateBase64Size(base64Data)
    };
    const chunks = upsertChunk(meeting.chunks || [], chunkEntry);
    const nextStatus = isFinal ? MEETING_STATUS.RECORDED : MEETING_STATUS.RECORDING;

    await dbSaveMeeting({
      ...meeting,
      chunks,
      status: nextStatus,
      updatedAt: Date.now(),
      lastError: ''
    });
    emitHistoryUpdated();
  } catch (e) {
    logError('handleAudioData', e);
    if (isFinal) {
      isRecording = false;
      activeTabId = null;
      currentMeetingId = null;
      recordingStartedAt = null;
      clearPersistedRecordingState();
      broadcastRecordingStateChanged();
      closeOffscreen();
    }
    notifyError(e.message, tabId, tabClosed);
    return;
  }

  if (!isFinal) return;

  isRecording = false;
  activeTabId = null;
  currentMeetingId = null;
  recordingStartedAt = null;
  clearPersistedRecordingState();
  broadcastRecordingStateChanged();
  await closeOffscreen();
  await transcribeMeeting(meetingId, { tabId, tabClosed, resume: false });
}

async function handleVideoData(message) {
  const meetingId = message.meetingId;
  if (!meetingId) return;

  try {
    const meeting = await dbGetMeeting(meetingId);
    if (!meeting) return;

    const hasData = !!message.data;
    const videoError = hasData ? '' : (message.error || '');
    const videoChunks = hasData
      ? [{ index: 0, data: message.data, sizeBytes: message.sizeBytes || 0 }]
      : [];

    const updatedMeeting = { ...meeting, videoChunks, videoError, updatedAt: Date.now() };
    await dbSaveMeeting(updatedMeeting);
    emitHistoryUpdated();

    // If meeting already finished transcription, export video now
    if (hasData && meeting.status === MEETING_STATUS.DONE) {
      const settings = await getRecordingSettings();
      if (settings.saveVideo) {
        exportVideoFile(updatedMeeting);
      }
    }
  } catch (e) {
    logError('handleVideoData', e);
  }
}

function isShortRecording(meeting) {
  const startedAt = Number(meeting && meeting.createdAt ? meeting.createdAt : recordingStartedAt);
  if (!startedAt) return false;
  return Date.now() - startedAt < SHORT_RECORDING_THRESHOLD_MS;
}

function confirmShortRecording(tabId, tabClosed, meeting) {
  if (!tabId || tabClosed) return Promise.resolve(true);
  const durationSeconds = Math.max(0, Math.round((Date.now() - Number(meeting.createdAt || Date.now())) / 1000));
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(
      tabId,
      {
        action: 'confirmShortRecording',
        durationSeconds,
        thresholdSeconds: Math.round(SHORT_RECORDING_THRESHOLD_MS / 1000)
      },
      (resp) => {
        if (chrome.runtime.lastError) { resolve(true); return; }
        resolve(resp && resp.keep !== false);
      }
    );
  });
}

async function discardMeeting(meetingId) {
  try {
    await dbDeleteMeeting(meetingId);
  } catch (e) {
    logError('discardMeeting', e);
  }
}

async function transcribeMeeting(meetingId, { tabId = null, tabClosed = false, resume = false } = {}) {
  const meeting = await dbGetMeeting(meetingId);
  if (!meeting) {
    broadcastRecordingStateChanged();
    chrome.runtime.sendMessage({ action: 'error', error: 'Запись не найдена.' }).catch(() => {});
    return;
  }
  if (!meeting.chunks || meeting.chunks.length === 0) {
    const error = 'В записи нет сохранённых аудиочанков.';
    await dbSaveMeeting({ ...meeting, status: MEETING_STATUS.ERROR, lastError: error, updatedAt: Date.now() });
    emitHistoryUpdated();
    broadcastRecordingStateChanged();
    chrome.runtime.sendMessage({ action: 'error', error }).catch(() => {});
    return;
  }

  const startAction = resume ? 'retranscribing' : 'transcribing';
  chrome.runtime.sendMessage({ action: startAction, meetingId }).catch(() => {});
  if (tabId && !tabClosed && !resume) {
    chrome.tabs.sendMessage(tabId, { action: 'transcribing' }).catch(() => {});
  }

  try {
    const apiKey = await getGroqKey();
    if (!apiKey) throw new Error('Groq API ключ не настроен.');

    const chunks = [...(meeting.chunks || [])].sort((a, b) => Number(a.index) - Number(b.index));
    let workingMeeting = {
      ...meeting,
      status: MEETING_STATUS.TRANSCRIBING,
      lastError: '',
      updatedAt: Date.now()
    };
    await dbSaveMeeting(workingMeeting);
    emitHistoryUpdated();

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      if (chunk.transcript && !chunk.error) continue;

      chrome.runtime.sendMessage({
        action: 'chunkProgress',
        current: i + 1,
        total: chunks.length
      }).catch(() => {});

      try {
        const transcript = await transcribeBase64(chunk.data, apiKey);
        chunk.transcript = transcript;
        delete chunk.error;
      } catch (e) {
        logError(`transcribeMeeting/chunk[${i}]`, e);
        chunk.error = e.message;
        workingMeeting = {
          ...workingMeeting,
          chunks,
          status: MEETING_STATUS.ERROR,
          lastError: e.message,
          updatedAt: Date.now()
        };
        await dbSaveMeeting(workingMeeting);
        emitHistoryUpdated();
        broadcastRecordingStateChanged();
        notifyError(e.message, tabId, tabClosed);
        return;
      }

      workingMeeting = { ...workingMeeting, chunks, updatedAt: Date.now() };
      await dbSaveMeeting(workingMeeting);
    }

    const fullTranscript = normalizeFinalTranscript(chunks
      .sort((a, b) => Number(a.index) - Number(b.index))
      .map(chunk => chunk.transcript || '')
      .join('\n\n'));

    let summary = '';
    let summaryError = '';
    let summaryPrompt = '';
    if (hasSummarizableTranscript(fullTranscript)) {
      try {
        const result = await summarizeTranscriptSafe(fullTranscript, apiKey, meetingId, tabId, tabClosed);
        summary = result.summary;
        summaryPrompt = result.summaryPrompt;
      } catch (e) {
        summaryError = e.message || 'Не удалось сгенерировать саммари.';
        logError('summarizeTranscript', e);
      }
    }
    const settings = await getRecordingSettings();
    const hasMeaningfulTranscript = fullTranscript !== EMPTY_RECORDING_TRANSCRIPT;
    const tags = meeting.tags && meeting.tags.length
      ? meeting.tags
      : hasMeaningfulTranscript && settings.autoTagMeetings
        ? await autoTagMeeting(fullTranscript, apiKey).catch((e) => { logError('autoTagMeeting', e); return []; })
        : [];
    const title = hasMeaningfulTranscript
      ? await generateMeetingTitle(fullTranscript, apiKey).catch((e) => { logError('generateMeetingTitle', e); return fallbackMeetingTitle(fullTranscript); })
      : EMPTY_RECORDING_TRANSCRIPT;

    const completedMeeting = {
      ...workingMeeting,
      chunks,
      title,
      transcript: fullTranscript,
      prompt: summaryPrompt,
      summary,
      summaryPrompt,
      summaryError,
      tags,
      status: MEETING_STATUS.DONE,
      lastError: '',
      updatedAt: Date.now()
    };
    await dbSaveMeeting(completedMeeting);
    emitHistoryUpdated();

    await exportMeetingAssets(completedMeeting);
    chrome.runtime.sendMessage({ action: 'transcriptReady', transcript: fullTranscript, summary, summaryPrompt, summaryError, prompt: summaryPrompt, meetingId, tags }).catch(() => {});
    if (tabId && !tabClosed) {
      chrome.tabs.sendMessage(tabId, { action: 'transcriptReady', summary, prompt: summaryPrompt, summaryError }).catch(() => {});
    } else {
      const videoNote = completedMeeting.videoChunks && completedMeeting.videoChunks.length > 0
        ? ' Аудио, видео и транскрипт'
        : ' Аудио и транскрипт';
      chrome.notifications.create({
        type: 'basic',
        iconUrl: 'icons/icon48.png',
        title: 'ECHO',
        message: `✅ Транскрипт готов.${videoNote} сохранены в Downloads/Telemost Recordings/`
      });
    }
  } catch (e) {
    logError('transcribeMeeting', e);
    await dbSaveMeeting({
      ...meeting,
      status: MEETING_STATUS.ERROR,
      lastError: e.message,
      updatedAt: Date.now()
    });
    emitHistoryUpdated();
    broadcastRecordingStateChanged();
    chrome.runtime.sendMessage({ action: 'error', error: e.message }).catch(() => {});
  }
}

function buildRecordingMeeting(meetingId, settings = {}) {
  return {
    id: meetingId,
    date: formatDate(meetingId),
    dateDisplay: new Date(meetingId).toLocaleString('ru'),
    chunks: [],
    videoChunks: [],
    videoError: '',
    transcript: '',
    prompt: '',
    summary: '',
    summaryPrompt: '',
    summaryError: '',
    tags: [],
    status: MEETING_STATUS.RECORDING,
    lastError: '',
    saveDestination: settings.saveDestination || 'local',
    driveFolderId: '',
    driveFolderUrl: '',
    driveUploadStatus: settings.saveDestination === 'google_drive' ? 'pending' : 'not_configured',
    driveUploadError: '',
    createdAt: meetingId,
    updatedAt: meetingId
  };
}

function upsertChunk(chunks, incomingChunk) {
  const nextChunks = [...chunks];
  const existingIndex = nextChunks.findIndex(chunk => Number(chunk.index) === Number(incomingChunk.index));
  if (existingIndex >= 0) {
    nextChunks[existingIndex] = { ...nextChunks[existingIndex], ...incomingChunk };
  } else {
    nextChunks.push(incomingChunk);
  }
  return nextChunks.sort((a, b) => Number(a.index) - Number(b.index));
}

function estimateBase64Size(base64Data) {
  const padding = base64Data.endsWith('==') ? 2 : base64Data.endsWith('=') ? 1 : 0;
  return Math.floor((base64Data.length * 3) / 4) - padding;
}

// ── Export ──

async function exportMeetingAssets(meeting) {
  const destination = meeting.saveDestination || 'local';

  if (destination === 'google_drive') {
    uploadMeetingAssetsToDrive(meeting).catch(async (e) => {
      logError('exportMeetingAssets/drive', e);
      const errorMsg = e.message || 'Ошибка загрузки в Google Drive';
      emitDriveProgress(meeting.id, `❌ ${errorMsg}`);
      try {
        const current = await dbGetMeeting(meeting.id);
        if (current) {
          await dbSaveMeeting({
            ...current,
            driveUploadStatus: 'error',
            driveUploadError: errorMsg,
            updatedAt: Date.now()
          });
          emitHistoryUpdated();
        }
      } catch (dbErr) {
        logError('exportMeetingAssets/drive/dbSave', dbErr);
      }
    });
    return;
  }

  // Local downloads
  const settings = await getRecordingSettings();
  const { folderName, fileNames } = buildRecordingFileNames(meeting);

  const audioChunks = [...(meeting.chunks || [])].sort((a, b) => Number(a.index) - Number(b.index));
  const audioBase64 = combineBase64Chunks(audioChunks);
  if (audioBase64) {
    chrome.downloads.download({
      url: `data:audio/webm;base64,${audioBase64}`,
      filename: `${folderName}/${fileNames.audio}.webm`,
      saveAs: false
    });
  }

  const videoChunks = [...(meeting.videoChunks || [])].sort((a, b) => Number(a.index) - Number(b.index));
  if (settings.saveVideo && videoChunks.length > 0) {
    const videoBase64 = combineBase64Chunks(videoChunks);
    if (videoBase64) {
      chrome.downloads.download({
        url: `data:video/webm;base64,${videoBase64}`,
        filename: `${folderName}/${fileNames.video}.webm`,
        saveAs: false
      });
    }
  }

  if (meeting.transcript) {
    chrome.downloads.download({
      url: 'data:text/plain;charset=utf-8,' + encodeURIComponent(meeting.transcript),
      filename: `${folderName}/${fileNames.transcript}.txt`,
      saveAs: false
    });
  }

  if (meeting.summary || meeting.summaryError) {
    const summaryText = meeting.summary || `Саммари не сгенерировалось: ${meeting.summaryError}`;
    chrome.downloads.download({
      url: 'data:text/plain;charset=utf-8,' + encodeURIComponent(summaryText),
      filename: `${folderName}/${fileNames.summary}.txt`,
      saveAs: false
    });
  }
}

// Called when video data arrives after meeting is already DONE
async function exportVideoFile(meeting) {
  const destination = meeting.saveDestination || 'local';
  const videoChunks = [...(meeting.videoChunks || [])].sort((a, b) => Number(a.index) - Number(b.index));

  if (destination === 'google_drive') {
    if (!meeting.driveFolderId) return;
    try {
      const token = await getDriveToken(false);
      if (!token) return;
      const settings = await getRecordingSettings();
      if (!settings.saveVideo) return;
      const videoBase64 = combineBase64Chunks(videoChunks);
      if (!videoBase64) return;
      const { fileNames } = buildRecordingFileNames(meeting);
      emitDriveProgress(meeting.id, 'Загружаю видео...');
      await uploadBinaryToDrive(
        `${fileNames.video}.webm`, 'video/webm',
        base64ToUint8Array(videoBase64), meeting.driveFolderId, token,
        (pct) => emitDriveProgress(meeting.id, `Загружаю видео: ${pct}%...`)
      );
      emitDriveProgress(meeting.id, 'Видео загружено в Google Drive.');
    } catch (e) {
      logError('exportVideoFile/drive', e);
    }
    return;
  }

  const { folderName, fileNames } = buildRecordingFileNames(meeting);
  const videoBase64 = combineBase64Chunks(videoChunks);
  if (videoBase64) {
    chrome.downloads.download({
      url: `data:video/webm;base64,${videoBase64}`,
      filename: `${folderName}/${fileNames.video}.webm`,
      saveAs: false
    });
  }
}

function combineBase64Chunks(chunks) {
  const valid = chunks.filter(c => c && c.data).sort((a, b) => Number(a.index) - Number(b.index));
  if (valid.length === 0) return '';
  if (valid.length === 1) return valid[0].data;

  const bytes = valid.map(c => base64ToUint8Array(c.data));
  const totalLength = bytes.reduce((sum, arr) => sum + arr.length, 0);
  const combined = new Uint8Array(totalLength);
  let offset = 0;
  for (const arr of bytes) {
    combined.set(arr, offset);
    offset += arr.length;
  }
  return uint8ArrayToBase64(combined);
}

// Keep old name as alias (used nowhere else but defensive)
function combineAudioChunksBase64(chunks) {
  return combineBase64Chunks(chunks);
}

function base64ToUint8Array(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function uint8ArrayToBase64(bytes) {
  const batchSize = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += batchSize) {
    const batch = bytes.subarray(i, i + batchSize);
    binary += String.fromCharCode(...batch);
  }
  return btoa(binary);
}

function emitHistoryUpdated() {
  chrome.runtime.sendMessage({ action: 'historyUpdated' }).catch(() => {});
}

// ── Google Drive integration ──

const DRIVE_FALLBACK_TOKEN_KEY = 'driveFallbackOAuthToken';
const DRIVE_FALLBACK_NOTICE = 'Похоже, вы используете не Google Chrome. Откроем альтернативную авторизацию Google Drive.';
const DRIVE_FALLBACK_ERROR = 'В этом браузере Google Drive OAuth может не поддерживаться. Попробуйте Google Chrome или подключите Drive через Chrome.';

function getDriveAuthDebugInfo() {
  const manifest = chrome.runtime.getManifest ? chrome.runtime.getManifest() : {};
  return {
    userAgent: navigator.userAgent,
    extensionId: chrome.runtime.id,
    clientId: manifest.oauth2?.client_id || '',
    scopes: manifest.oauth2?.scopes || [],
    redirectUrl: chrome.identity.getRedirectURL()
  };
}

function logDriveAuthDiagnostic(context, lastErrorMessage = '') {
  const info = getDriveAuthDebugInfo();
  console.warn(`[ECHO/GoogleDriveOAuth] ${context}`, {
    userAgent: info.userAgent,
    extensionId: info.extensionId,
    oauthClientId: info.clientId,
    oauthScopes: info.scopes,
    redirectUrl: info.redirectUrl,
    lastErrorMessage
  });
}

function isCanceledDriveAuthError(message) {
  const lower = String(message || '').toLowerCase();
  return lower.includes('canceled') || lower.includes('cancelled');
}

function formatDriveAuthError(message) {
  const raw = String(message || '').trim();
  const lower = raw.toLowerCase();

  if (lower.includes('invalid_client')) {
    return 'OAuth Client ID не совпадает с ID расширения.';
  }
  if (lower.includes('oauth2 not granted') || lower.includes('bad client id')) {
    return 'Проверьте client_id в manifest.json.';
  }
  if (lower.includes('access_denied')) {
    return 'Доступ не был разрешён.';
  }
  if (lower.includes('canceled') || lower.includes('cancelled')) {
    return 'Авторизация Google Drive была отменена или окно входа не завершилось. Попробуйте ещё раз.';
  }

  return raw || 'Не удалось подключить Google Drive.';
}

async function getDriveToken(interactive) {
  const fallbackToken = await getStoredDriveFallbackToken();
  if (fallbackToken) {
    logDriveAuthDiagnostic('using stored launchWebAuthFlow token');
    return fallbackToken;
  }

  return new Promise((resolve, reject) => {
    logDriveAuthDiagnostic(`getAuthToken start, interactive=${interactive}`);
    chrome.identity.getAuthToken({ interactive }, (token) => {
      if (chrome.runtime.lastError) {
        const lastErrorMessage = chrome.runtime.lastError.message || '';
        logDriveAuthDiagnostic(`getAuthToken failed, interactive=${interactive}`, lastErrorMessage);
        if (interactive && isCanceledDriveAuthError(lastErrorMessage)) {
          launchDriveWebAuthFlow()
            .then(resolve)
            .catch(reject);
          return;
        }
        const error = new Error(formatDriveAuthError(lastErrorMessage));
        error.rawMessage = lastErrorMessage;
        reject(error);
      } else {
        logDriveAuthDiagnostic(`getAuthToken ok, interactive=${interactive}`);
        if (token) {
          resolve(token);
          return;
        }
        if (interactive) {
          launchDriveWebAuthFlow()
            .then(resolve)
            .catch(reject);
          return;
        }
        resolve(null);
      }
    });
  });
}

async function getStoredDriveFallbackToken() {
  const stored = await new Promise(resolve =>
    chrome.storage.local.get(DRIVE_FALLBACK_TOKEN_KEY, data => resolve(data[DRIVE_FALLBACK_TOKEN_KEY] || null))
  );
  if (!stored || !stored.accessToken || !stored.expiresAt) return null;
  if (Date.now() > Number(stored.expiresAt) - 60000) {
    await clearStoredDriveFallbackToken();
    return null;
  }
  return stored.accessToken;
}

function saveDriveFallbackToken(accessToken, expiresIn) {
  const ttlMs = Math.max(1, Number(expiresIn) || 3600) * 1000;
  return chrome.storage.local.set({
    [DRIVE_FALLBACK_TOKEN_KEY]: {
      accessToken,
      expiresAt: Date.now() + ttlMs
    }
  });
}

function clearStoredDriveFallbackToken() {
  return chrome.storage.local.remove(DRIVE_FALLBACK_TOKEN_KEY);
}

async function launchDriveWebAuthFlow() {
  logDriveAuthDiagnostic('launchWebAuthFlow fallback start');
  chrome.runtime.sendMessage({ action: 'driveAuthFallbackStarted', message: DRIVE_FALLBACK_NOTICE }).catch(() => {});

  const info = getDriveAuthDebugInfo();
  if (!info.clientId || !info.clientId.endsWith('.apps.googleusercontent.com')) {
    throw new Error('Проверьте client_id в manifest.json.');
  }

  const state = Math.random().toString(36).slice(2);
  const params = new URLSearchParams({
    client_id: info.clientId,
    response_type: 'token',
    redirect_uri: info.redirectUrl,
    scope: info.scopes.join(' '),
    include_granted_scopes: 'true',
    prompt: 'consent',
    state
  });
  const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;

  return new Promise((resolve, reject) => {
    chrome.identity.launchWebAuthFlow({ url: authUrl, interactive: true }, async (redirectedTo) => {
      if (chrome.runtime.lastError) {
        const lastErrorMessage = chrome.runtime.lastError.message || '';
        logDriveAuthDiagnostic('launchWebAuthFlow failed', lastErrorMessage);
        const error = new Error(DRIVE_FALLBACK_ERROR);
        error.rawMessage = lastErrorMessage;
        reject(error);
        return;
      }
      if (!redirectedTo) {
        logDriveAuthDiagnostic('launchWebAuthFlow returned empty redirect URL');
        reject(new Error(DRIVE_FALLBACK_ERROR));
        return;
      }

      try {
        const tokenData = parseDriveWebAuthRedirect(redirectedTo, state);
        await saveDriveFallbackToken(tokenData.accessToken, tokenData.expiresIn);
        logDriveAuthDiagnostic('launchWebAuthFlow token received');
        resolve(tokenData.accessToken);
      } catch (e) {
        logDriveAuthDiagnostic('launchWebAuthFlow token parse failed', e.rawMessage || e.message);
        reject(e);
      }
    });
  });
}

function parseDriveWebAuthRedirect(redirectedTo, expectedState) {
  const url = new URL(redirectedTo);
  const params = new URLSearchParams(url.hash ? url.hash.slice(1) : url.search.slice(1));
  const error = params.get('error');
  if (error) {
    const err = new Error(error === 'access_denied' ? 'Доступ не был разрешён.' : DRIVE_FALLBACK_ERROR);
    err.rawMessage = error;
    throw err;
  }
  if (params.get('state') !== expectedState) {
    const err = new Error(DRIVE_FALLBACK_ERROR);
    err.rawMessage = 'OAuth state mismatch';
    throw err;
  }

  const accessToken = params.get('access_token');
  if (!accessToken) {
    const err = new Error(DRIVE_FALLBACK_ERROR);
    err.rawMessage = 'No access_token in launchWebAuthFlow redirect';
    throw err;
  }

  return {
    accessToken,
    expiresIn: params.get('expires_in') || 3600
  };
}

async function checkDriveConnected() {
  try {
    const token = await getDriveToken(false);
    return !!token;
  } catch {
    return false;
  }
}

async function connectDriveInteractive() {
  try {
    const token = await getDriveToken(true);
    if (!token) {
      return {
        ok: false,
        error: 'Авторизация Google Drive была отменена или окно входа не завершилось. Попробуйте ещё раз.'
      };
    }
    await verifyDriveToken(token);
    return { ok: true };
  } catch (e) {
    logDriveAuthDiagnostic('connectDriveInteractive failed', e.rawMessage || e.message);
    return { ok: false, error: e.message };
  }
}

async function verifyDriveToken(token) {
  const aboutResp = await fetch('https://www.googleapis.com/drive/v3/about?fields=user', {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (aboutResp.ok) return true;

  const aboutError = await aboutResp.text().catch(() => '');
  console.warn('[ECHO/GoogleDriveOAuth] Drive about.get failed, trying ECHO Recordings folder check', {
    status: aboutResp.status,
    body: aboutError
  });

  await ensureEchoRecordingsFolder(token);
  return true;
}

async function ensureEchoRecordingsFolder(token) {
  const query = encodeURIComponent("name = 'ECHO Recordings' and mimeType = 'application/vnd.google-apps.folder' and trashed = false");
  const listResp = await fetch(`https://www.googleapis.com/drive/v3/files?q=${query}&fields=files(id,name)&pageSize=1`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (listResp.ok) {
    const data = await listResp.json().catch(() => ({}));
    if (Array.isArray(data.files) && data.files.length > 0) return data.files[0];
  } else {
    console.warn('[ECHO/GoogleDriveOAuth] Drive folder lookup failed', {
      status: listResp.status,
      body: await listResp.text().catch(() => '')
    });
  }

  return await createDriveFolder('ECHO Recordings', token);
}

async function disconnectDrive() {
  return new Promise((resolve) => {
    logDriveAuthDiagnostic('disconnectDrive getAuthToken start, interactive=false');
    chrome.identity.getAuthToken({ interactive: false }, (token) => {
      if (chrome.runtime.lastError || !token) {
        if (chrome.runtime.lastError) {
          logDriveAuthDiagnostic('disconnectDrive getAuthToken failed', chrome.runtime.lastError.message || '');
        }
        clearStoredDriveFallbackToken().finally(resolve);
        return;
      }
      logDriveAuthDiagnostic('disconnectDrive getAuthToken ok');
      chrome.identity.removeCachedAuthToken({ token }, () => {
        fetch(`https://accounts.google.com/o/oauth2/revoke?token=${token}`)
          .catch(() => {}).finally(() => clearStoredDriveFallbackToken().finally(resolve));
      });
    });
  });
}

async function resetDriveAuth() {
  logDriveAuthDiagnostic('clearAllCachedAuthTokens requested');
  return new Promise((resolve) => {
    chrome.identity.clearAllCachedAuthTokens(() => {
      if (chrome.runtime.lastError) {
        logDriveAuthDiagnostic('clearAllCachedAuthTokens failed', chrome.runtime.lastError.message || '');
      } else {
        logDriveAuthDiagnostic('clearAllCachedAuthTokens ok');
      }
      clearStoredDriveFallbackToken().finally(resolve);
    });
  });
}

function buildDriveFolderName(meeting) {
  const rawDate = String(meeting.date || formatDate(meeting.id || Date.now()));
  const datePart = rawDate.replace(/_/g, ' ').slice(0, 10); // YYYY-MM-DD
  const rawTitle = meeting.title || 'Без названия';
  return sanitizeFileName(`${datePart} - ${sanitizeFileName(rawTitle).slice(0, 80)}`.trim());
}

function emitDriveProgress(meetingId, status) {
  chrome.runtime.sendMessage({ action: 'driveUploadProgress', meetingId, status }).catch(() => {});
}

async function createDriveFolder(name, token) {
  const resp = await fetch('https://www.googleapis.com/drive/v3/files', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ name, mimeType: 'application/vnd.google-apps.folder' })
  });
  if (!resp.ok) throw new Error(`Drive: ошибка создания папки (${resp.status})`);
  const data = await resp.json();
  return { id: data.id, url: `https://drive.google.com/drive/folders/${data.id}` };
}

async function uploadTextToDrive(fileName, text, folderId, token) {
  const boundary = 'echo_mp_' + Date.now();
  const metadata = JSON.stringify({ name: fileName, parents: [folderId] });
  const enc = new TextEncoder();
  const parts = [
    enc.encode(`--${boundary}\r\nContent-Type: application/json; charset=utf-8\r\n\r\n${metadata}\r\n`),
    enc.encode(`--${boundary}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n`),
    enc.encode(text),
    enc.encode(`\r\n--${boundary}--`)
  ];
  const total = parts.reduce((s, p) => s + p.length, 0);
  const body = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { body.set(p, off); off += p.length; }

  const resp = await fetch(
    'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': `multipart/related; boundary=${boundary}`
      },
      body
    }
  );
  if (!resp.ok) throw new Error(`Drive: ошибка загрузки текста (${resp.status})`);
}

async function uploadBinaryToDrive(fileName, mimeType, bytes, folderId, token, onProgress) {
  const initResp = await fetch(
    'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'X-Upload-Content-Type': mimeType,
        'X-Upload-Content-Length': String(bytes.length)
      },
      body: JSON.stringify({ name: fileName, parents: [folderId] })
    }
  );
  if (!initResp.ok) throw new Error(`Drive: ошибка инициализации загрузки (${initResp.status})`);
  const uploadUrl = initResp.headers.get('Location');
  if (!uploadUrl) throw new Error('Drive: не получен URL загрузки');

  const CHUNK = 5 * 1024 * 1024;
  let sent = 0;

  while (sent < bytes.length) {
    const end = Math.min(sent + CHUNK, bytes.length);
    const chunk = bytes.slice(sent, end);

    const putResp = await fetch(uploadUrl, {
      method: 'PUT',
      headers: {
        'Content-Range': `bytes ${sent}-${end - 1}/${bytes.length}`,
        'Content-Type': mimeType
      },
      body: chunk
    });

    if (putResp.status !== 200 && putResp.status !== 201 && putResp.status !== 308) {
      throw new Error(`Drive: ошибка при загрузке фрагмента (${putResp.status})`);
    }

    sent = end;
    if (onProgress) onProgress(Math.round((sent / bytes.length) * 100));
  }
}

async function uploadMeetingAssetsToDrive(meeting) {
  const meetingId = meeting.id;
  const settings = await getRecordingSettings();
  const { fileNames } = buildRecordingFileNames(meeting);
  const folderName = buildDriveFolderName(meeting);

  let token;
  try {
    token = await getDriveToken(false);
  } catch (e) {
    throw new Error(`Drive auth: ${e.message}`);
  }
  if (!token) throw new Error('Google Drive не подключён. Подключи его в настройках ECHO.');

  emitDriveProgress(meetingId, 'Создаю папку на Google Drive...');
  const folder = await createDriveFolder(folderName, token);

  const withFolder = {
    ...meeting,
    driveFolderId: folder.id,
    driveFolderUrl: folder.url,
    driveUploadStatus: 'uploading',
    driveUploadError: '',
    updatedAt: Date.now()
  };
  await dbSaveMeeting(withFolder);
  emitHistoryUpdated();

  if (meeting.transcript) {
    emitDriveProgress(meetingId, 'Загружаю транскрипт...');
    await uploadTextToDrive(`${fileNames.transcript}.txt`, meeting.transcript, folder.id, token);
  }

  if (meeting.summary || meeting.summaryError) {
    emitDriveProgress(meetingId, 'Загружаю саммари...');
    const summaryText = meeting.summary || `Саммари не сгенерировалось: ${meeting.summaryError}`;
    await uploadTextToDrive(`${fileNames.summary}.txt`, summaryText, folder.id, token);
  }

  const audioChunks = [...(meeting.chunks || [])].sort((a, b) => Number(a.index) - Number(b.index));
  const audioBase64 = combineBase64Chunks(audioChunks);
  if (audioBase64) {
    emitDriveProgress(meetingId, 'Загружаю аудио...');
    await uploadBinaryToDrive(
      `${fileNames.audio}.webm`, 'audio/webm',
      base64ToUint8Array(audioBase64), folder.id, token, null
    );
  }

  const videoChunks = [...(meeting.videoChunks || [])].sort((a, b) => Number(a.index) - Number(b.index));
  if (settings.saveVideo && videoChunks.length > 0) {
    const videoBase64 = combineBase64Chunks(videoChunks);
    if (videoBase64) {
      const videoBytes = base64ToUint8Array(videoBase64);
      await uploadBinaryToDrive(
        `${fileNames.video}.webm`, 'video/webm',
        videoBytes, folder.id, token,
        (pct) => emitDriveProgress(meetingId, `Загружаю видео: ${pct}%...`)
      );
    }
  }

  emitDriveProgress(meetingId, 'Готово. Файлы загружены на Google Drive.');
  const finalMeeting = {
    ...withFolder,
    driveUploadStatus: 'done',
    updatedAt: Date.now()
  };
  await dbSaveMeeting(finalMeeting);
  emitHistoryUpdated();
}

async function autoTagMeeting(transcript, apiKey) {
  const presetTags = await new Promise(resolve =>
    chrome.storage.local.get('presetTags', d => resolve(d.presetTags || []))
  );
  if (presetTags.length === 0) return [];
  if (!hasEnoughSignalForAutoTags(transcript)) return [];

  const allowedTags = presetTags.map(t => String(t.name || '').trim()).filter(Boolean);
  if (allowedTags.length === 0) return [];
  const excerpt = transcript.slice(0, 3500);

  const resp = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'llama-3.1-8b-instant',
      messages: [
        {
          role: 'system',
          content: [
            'Ты строгий классификатор встреч.',
            'Выбирай только те теги, которые явно и напрямую соответствуют содержанию транскрипта.',
            'Не угадывай.',
            'Не выбирай общие теги только потому, что встреча деловая.',
            'Если тег подходит слабо или косвенно, не выбирай его.',
            'Запрещено выбирать теги на всякий случай.',
            'Лучше не поставить тег, чем поставить неправильный.',
            'Если уверенность низкая или прямого соответствия нет, верни пустой список.',
            'Выбери максимум 2 тега.',
            'Ответь только валидным JSON в формате {"tags":["..."]}. Если тегов нет: {"tags":[]}.'
          ].join(' ')
        },
        {
          role: 'user',
          content: `Доступные теги, выбирать можно только из этого списка:\n${JSON.stringify(allowedTags)}\n\nТранскрипт:\n${excerpt}`
        }
      ],
      max_tokens: 120,
      temperature: 0
    })
  });

  if (!resp.ok) return [];
  const data = await resp.json();
  const text = (data.choices?.[0]?.message?.content || '').trim();
  return normalizeAutoTags(text, allowedTags);
}

function hasEnoughSignalForAutoTags(transcript) {
  const text = String(transcript || '').replace(/\s+/g, ' ').trim();
  if (!text || text === EMPTY_RECORDING_TRANSCRIPT) return false;
  if (text.length < 400) return false;

  const words = text.toLowerCase().match(/[a-zа-яё0-9-]{3,}/gi) || [];
  if (words.length < 40) return false;
  if (new Set(words).size < 20) return false;

  return true;
}

function normalizeAutoTags(rawText, allowedTags) {
  const cleaned = String(rawText || '')
    .trim()
    .replace(/^```(?:json)?/i, '')
    .replace(/```$/i, '')
    .trim();
  if (!cleaned) return [];

  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    return [];
  }

  if (!parsed || !Array.isArray(parsed.tags)) return [];
  const allowed = new Set(allowedTags);
  const result = [];
  for (const tag of parsed.tags) {
    const name = String(tag || '').trim();
    if (!allowed.has(name) || result.includes(name)) continue;
    result.push(name);
    if (result.length >= 2) break;
  }
  return result;
}

async function generateMeetingTitle(transcript, apiKey) {
  const excerpt = transcript.slice(0, 3000);
  const resp = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'llama-3.1-8b-instant',
      messages: [
        {
          role: 'system',
          content: 'Ты помогаешь назвать деловую встречу по транскрипту. Верни только короткий заголовок на русском, 2-6 слов, без кавычек, без точки в конце.'
        },
        { role: 'user', content: `Транскрипт встречи:\n${excerpt}` }
      ],
      max_tokens: 24,
      temperature: 0.2
    })
  });

  if (!resp.ok) throw new Error('Не удалось сгенерировать название встречи.');
  const data = await resp.json();
  const title = sanitizeMeetingTitle(data.choices?.[0]?.message?.content || '');
  if (!title) throw new Error('Пустой заголовок встречи.');
  return title;
}

function fallbackMeetingTitle(transcript) {
  const normalized = String(transcript || '').replace(/\s+/g, ' ').trim();
  if (!normalized) return 'Встреча без названия';
  const firstSentence = normalized.split(/[.!?\n]/)[0].trim();
  const source = firstSentence || normalized;
  const words = source.split(' ').filter(Boolean).slice(0, 6);
  const title = words.join(' ').trim();
  return sanitizeMeetingTitle(title) || 'Встреча без названия';
}

function sanitizeMeetingTitle(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .replace(/^["«]+|["»]+$/g, '')
    .replace(/[.]+$/g, '')
    .trim()
    .slice(0, 80);
}

async function getSummaryBasePrompt() {
  return new Promise(resolve => {
    chrome.storage.local.get(SUMMARY_PROMPT_STORAGE_KEY, (data) => {
      resolve(String(data[SUMMARY_PROMPT_STORAGE_KEY] || DEFAULT_SUMMARY_PROMPT).trim() || DEFAULT_SUMMARY_PROMPT);
    });
  });
}

function hasSummarizableTranscript(transcript) {
  const normalized = String(transcript || '').trim();
  return normalized && normalized !== EMPTY_RECORDING_TRANSCRIPT;
}

const SUMMARY_MAX_INPUT_CHARS_PER_CHUNK = 7000;
const SUMMARY_REQUEST_DELAY_MS = 13000;

function parseGroqRetryAfterMs(text) {
  const match = String(text || '').match(/try again in ([\d.]+)s/i);
  if (match) return Math.ceil(parseFloat(match[1]) + 2) * 1000;
  return null;
}

function splitTranscriptIntoChunks(text, maxChars) {
  if (text.length <= maxChars) return [text];
  const chunks = [];
  let remaining = text.trim();
  while (remaining.length > maxChars) {
    let splitAt = -1;
    const paraIdx = remaining.lastIndexOf('\n\n', maxChars);
    if (paraIdx > maxChars * 0.4) { splitAt = paraIdx + 2; }
    if (splitAt === -1) {
      const sentIdx = remaining.lastIndexOf('. ', maxChars);
      if (sentIdx > maxChars * 0.4) splitAt = sentIdx + 2;
    }
    if (splitAt === -1) {
      const nlIdx = remaining.lastIndexOf('\n', maxChars);
      if (nlIdx > maxChars * 0.4) splitAt = nlIdx + 1;
    }
    if (splitAt === -1) splitAt = maxChars;
    chunks.push(remaining.slice(0, splitAt).trim());
    remaining = remaining.slice(splitAt).trim();
  }
  if (remaining.length > 0) chunks.push(remaining);
  return chunks;
}

function sendSummaryProgress(status, meetingId, tabId, tabClosed) {
  chrome.runtime.sendMessage({ action: 'summaryProgress', status, meetingId }).catch(() => {});
  if (tabId && !tabClosed) {
    chrome.tabs.sendMessage(tabId, { action: 'summaryProgress', status }).catch(() => {});
  }
}

async function groqChatCompletionWithRateLimit(payload, apiKey, onStatus, maxRetries = 3) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const resp = await fetchWithRetry('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    }, { timeoutMs: GROQ_FETCH_TIMEOUT_MS });
    if (resp.status !== 429) return resp;
    const text = await resp.text();
    if (attempt >= maxRetries) throw new Error(`Groq rate limit exceeded: ${text}`);
    const waitMs = parseGroqRetryAfterMs(text) || 15000;
    const waitSec = Math.round(waitMs / 1000);
    if (onStatus) onStatus(`Жду лимит Groq, повтор через ${waitSec} сек...`);
    await sleep(waitMs);
  }
}

async function summarizeTranscriptSafe(fullTranscript, apiKey, meetingId, tabId, tabClosed) {
  const onStatus = (status) => sendSummaryProgress(status, meetingId, tabId, tabClosed);
  const basePrompt = await getSummaryBasePrompt();

  if (fullTranscript.length <= SUMMARY_MAX_INPUT_CHARS_PER_CHUNK) {
    onStatus('Формирую саммари...');
    const summaryPrompt = `${basePrompt}\n\nТранскрипт:\n${fullTranscript}`;
    const resp = await groqChatCompletionWithRateLimit({
      model: 'llama-3.1-8b-instant',
      messages: [
        { role: 'system', content: 'Ты аккуратный редактор деловых встреч. Возвращай только готовое саммари без вступлений и без упоминания промпта.' },
        { role: 'user', content: summaryPrompt }
      ],
      max_tokens: 1400,
      temperature: 0.2
    }, apiKey, onStatus);
    if (!resp.ok) throw new Error(`Groq summary: ${resp.status} — ${await resp.text()}`);
    const data = await resp.json();
    const summary = String(data.choices?.[0]?.message?.content || '').trim();
    if (!summary) throw new Error('Groq вернул пустое саммари.');
    return { summary, summaryPrompt };
  }

  const chunks = splitTranscriptIntoChunks(fullTranscript, SUMMARY_MAX_INPUT_CHARS_PER_CHUNK);
  const partials = [];
  for (let i = 0; i < chunks.length; i++) {
    onStatus(`Формирую саммари: часть ${i + 1} из ${chunks.length}...`);
    const resp = await groqChatCompletionWithRateLimit({
      model: 'llama-3.1-8b-instant',
      messages: [
        { role: 'system', content: 'Ты аккуратный редактор деловых встреч. Возвращай только готовое саммари без вступлений и без упоминания промпта.' },
        { role: 'user', content: `Выдели ключевые темы, решения, задачи, договорённости и важные факты только из этого фрагмента встречи. Будь краток.\n\nФрагмент:\n${chunks[i]}` }
      ],
      max_tokens: 600,
      temperature: 0.2
    }, apiKey, onStatus);
    if (!resp.ok) throw new Error(`Groq summary: ${resp.status} — ${await resp.text()}`);
    const data = await resp.json();
    partials.push(String(data.choices?.[0]?.message?.content || '').trim());
    if (i < chunks.length - 1) await sleep(SUMMARY_REQUEST_DELAY_MS);
  }

  await sleep(SUMMARY_REQUEST_DELAY_MS);
  onStatus('Формирую итоговое саммари...');
  const combined = partials.join('\n\n---\n\n');
  const summaryPrompt = `[map-reduce из ${chunks.length} фрагментов]\n\n${basePrompt}`;
  const resp = await groqChatCompletionWithRateLimit({
    model: 'llama-3.1-8b-instant',
    messages: [
      { role: 'system', content: 'Ты аккуратный редактор деловых встреч. Возвращай только готовое саммари без вступлений и без упоминания промпта.' },
      { role: 'user', content: `${basePrompt}\n\nЧастичные саммари фрагментов встречи:\n${combined}` }
    ],
    max_tokens: 1400,
    temperature: 0.2
  }, apiKey, onStatus);
  if (!resp.ok) throw new Error(`Groq summary: ${resp.status} — ${await resp.text()}`);
  const data = await resp.json();
  const summary = String(data.choices?.[0]?.message?.content || '').trim();
  if (!summary) throw new Error('Groq вернул пустое саммари.');
  return { summary, summaryPrompt };
}

function formatDate(ts) {
  const d = new Date(ts);
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}`;
}

const WHISPER_HALLUCINATIONS = [
  /^продолжение следует[.\s…]*/i,
  /^субтитры\s+(сделаны|добавлены|создаются)[.\s…]*/i,
  /^субтитры\s+\S+[.\s…]*/i,
  /^редактор\s+субтитров[.\s…]*/i,
  /^перевод\s+субтитров[.\s…]*/i,
  /^корректор[.\s…]*/i,
];

const GROQ_NETWORK_ERROR_MESSAGE = 'Не удалось подключиться к Groq. Проверь VPN/сеть/доступ к api.groq.com и нажми повторить транскрибацию';
const GROQ_FETCH_TIMEOUT_MS = 120000;
const GROQ_RETRY_DELAYS_MS = [1000, 3000, 7000];

function filterWhisperHallucinations(text) {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) return '';
  if (isKnownEmptyTranscriptHallucination(normalized)) return '';
  const singlePhrase = normalized.split(/[.,!?…\n]+/).map(s => s.trim()).filter(Boolean);
  if (singlePhrase.length > 0) {
    const unique = new Set(singlePhrase.map(s => s.toLowerCase()));
    if (unique.size === 1 && WHISPER_HALLUCINATIONS.some(re => re.test(singlePhrase[0]))) return '';
  }
  return normalized;
}

function isKnownEmptyTranscriptHallucination(text) {
  const normalized = String(text || '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/\s+/g, ' ')
    .trim();
  if (/^редактор субтитров(?:\s|$)/.test(normalized) && /(?:^|\s)корректор(?:\s|$)/.test(normalized)) return true;
  return false;
}

function normalizeFinalTranscript(transcript) {
  const filtered = filterWhisperHallucinations(String(transcript || ''));
  return filtered || EMPTY_RECORDING_TRANSCRIPT;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isRetriableGroqError(error) {
  if (!error) return false;
  if (error.name === 'AbortError') return true;
  if (error instanceof TypeError) return true;
  const message = String(error.message || error);
  return /Failed to fetch|NetworkError|network|timed out|timeout/i.test(message);
}

function normalizeGroqFetchError(error) {
  if (error && error.name === 'AbortError') {
    return new Error('Groq не ответил вовремя. Подожди пару минут и нажми повторить транскрибацию.');
  }
  if (error instanceof TypeError && /Failed to fetch/i.test(error.message || '')) {
    return new Error(GROQ_NETWORK_ERROR_MESSAGE);
  }
  return error instanceof Error ? error : new Error(String(error || 'Неизвестная ошибка сети'));
}

async function fetchWithRetry(url, options = {}, retryOptions = {}) {
  const timeoutMs = retryOptions.timeoutMs || GROQ_FETCH_TIMEOUT_MS;
  const retryDelaysMs = retryOptions.retryDelaysMs || GROQ_RETRY_DELAYS_MS;
  const maxAttempts = retryOptions.maxAttempts || (retryDelaysMs.length + 1);

  let lastError = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const controller = new AbortController();
    const timerId = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(url, { ...options, signal: controller.signal });
    } catch (error) {
      lastError = error;
      const canRetry = attempt < maxAttempts && isRetriableGroqError(error);
      if (!canRetry) break;
      await sleep(retryDelaysMs[Math.min(attempt - 1, retryDelaysMs.length - 1)]);
    } finally {
      clearTimeout(timerId);
    }
  }
  throw normalizeGroqFetchError(lastError);
}

async function transcribeBase64(base64Data, apiKey) {
  const binary = atob(base64Data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  const blob = new Blob([bytes], { type: 'audio/webm' });

  const formData = new FormData();
  formData.append('file', blob, 'chunk.webm');
  formData.append('model', 'whisper-large-v3');
  formData.append('language', 'ru');
  formData.append('response_format', 'text');
  formData.append('temperature', '0');
  formData.append('prompt', 'Деловая встреча. Запись разговора на русском языке.');

  const resp = await fetchWithRetry('https://api.groq.com/openai/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: formData
  }, { timeoutMs: GROQ_FETCH_TIMEOUT_MS, retryDelaysMs: GROQ_RETRY_DELAYS_MS });

  if (!resp.ok) throw new Error(`Groq: ${resp.status} — ${await resp.text()}`);
  const raw = await resp.text();
  return filterWhisperHallucinations(raw);
}

function notifyError(message, tabId, tabClosed) {
  chrome.notifications.create({
    type: 'basic',
    iconUrl: 'icons/icon48.png',
    title: 'ECHO — Ошибка',
    message
  });
  chrome.runtime.sendMessage({ action: 'error', error: message }).catch(() => {});
  if (!tabClosed) chrome.tabs.sendMessage(tabId, { action: 'error', error: message }).catch(() => {});
}

async function getGroqKey() {
  return new Promise(resolve => {
    chrome.storage.local.get('groqApiKey', (data) => resolve(data.groqApiKey || ''));
  });
}
