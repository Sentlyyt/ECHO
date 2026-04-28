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
    if (windowId === null) {
      openPanelWindow();
      return;
    }
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

  if (message.action === 'recorderHeartbeat') {
    // Intentionally empty — receiving this message is enough to keep the SW alive.
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
});

async function startRecording(tabId, options = {}) {
  if (isRecording) {
    return {
      success: true,
      ...getRecordingStatePayload()
    };
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
    await ensureOffscreen();
    activeTabId = tabId;
    currentMeetingId = Date.now();
    recordingStartedAt = Date.now();
    await dbSaveMeeting(buildRecordingMeeting(currentMeetingId));
    chrome.runtime.sendMessage({ action: 'startCapture', streamId, tabId, meetingId: currentMeetingId });
    isRecording = true;
    persistRecordingState();
    emitHistoryUpdated();
    broadcastRecordingStateChanged();
    chrome.runtime.sendMessage({ action: 'recordingStarted', startedAt: recordingStartedAt }).catch(() => {});
    chrome.tabs.sendMessage(tabId, { action: 'recordingStarted', startedAt: recordingStartedAt }).catch(() => {});
    return {
      success: true,
      ...getRecordingStatePayload()
    };
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
        if (chrome.runtime.lastError) {
          resolve(true);
          return;
        }
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

      workingMeeting = {
        ...workingMeeting,
        chunks,
        updatedAt: Date.now()
      };
      await dbSaveMeeting(workingMeeting);
    }

    const fullTranscript = normalizeFinalTranscript(chunks
      .sort((a, b) => Number(a.index) - Number(b.index))
      .map(chunk => chunk.transcript || '')
      .join('\n\n'));

    const prompt = buildMeetingPrompt(fullTranscript);
    const hasMeaningfulTranscript = fullTranscript !== EMPTY_RECORDING_TRANSCRIPT;
    const tags = meeting.tags && meeting.tags.length
      ? meeting.tags
      : hasMeaningfulTranscript
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
      prompt,
      tags,
      status: MEETING_STATUS.DONE,
      lastError: '',
      updatedAt: Date.now()
    };
    await dbSaveMeeting(completedMeeting);
    emitHistoryUpdated();

    await exportMeetingAssets(completedMeeting);
    chrome.runtime.sendMessage({ action: 'transcriptReady', transcript: fullTranscript, prompt, meetingId, tags }).catch(() => {});
    if (tabId && !tabClosed) {
      chrome.tabs.sendMessage(tabId, { action: 'transcriptReady', prompt }).catch(() => {});
    } else {
      chrome.notifications.create({
        type: 'basic',
        iconUrl: 'icons/icon48.png',
        title: 'ECHO',
        message: '✅ Транскрипт готов и сохранён в Downloads/Telemost Recordings/'
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

function buildRecordingMeeting(meetingId) {
  return {
    id: meetingId,
    date: formatDate(meetingId),
    dateDisplay: new Date(meetingId).toLocaleString('ru'),
    chunks: [],
    transcript: '',
    prompt: '',
    tags: [],
    status: MEETING_STATUS.RECORDING,
    lastError: '',
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

async function exportMeetingAssets(meeting) {
  const fileBase = buildMeetingFileBase(meeting);
  const chunks = [...(meeting.chunks || [])].sort((a, b) => Number(a.index) - Number(b.index));

  const audioBase64 = combineAudioChunksBase64(chunks);
  if (audioBase64) {
    chrome.downloads.download({
      url: `data:audio/webm;base64,${audioBase64}`,
      filename: `${fileBase}.webm`,
      saveAs: false
    });
  }

  chrome.downloads.download({
    url: 'data:text/plain;charset=utf-8,' + encodeURIComponent(meeting.transcript || ''),
    filename: `${fileBase}.txt`,
    saveAs: false
  });
}

function combineAudioChunksBase64(chunks) {
  const audioChunks = chunks
    .filter(chunk => chunk && chunk.data)
    .sort((a, b) => Number(a.index) - Number(b.index));

  if (audioChunks.length === 0) return '';
  if (audioChunks.length === 1) return audioChunks[0].data;

  const bytes = audioChunks.map(chunk => base64ToUint8Array(chunk.data));
  const totalLength = bytes.reduce((sum, item) => sum + item.length, 0);
  const combined = new Uint8Array(totalLength);
  let offset = 0;

  for (const item of bytes) {
    combined.set(item, offset);
    offset += item.length;
  }

  return uint8ArrayToBase64(combined);
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

function buildMeetingFileBase(meeting) {
  const baseDate = meeting.date || formatDate(meeting.id || Date.now());
  const meetingName = `${baseDate}_meeting`;
  return `Telemost Recordings/${meetingName}/${meetingName}`;
}

function emitHistoryUpdated() {
  chrome.runtime.sendMessage({ action: 'historyUpdated' }).catch(() => {});
}

async function autoTagMeeting(transcript, apiKey) {
  const presetTags = await new Promise(resolve =>
    chrome.storage.local.get('presetTags', d => resolve(d.presetTags || []))
  );
  if (presetTags.length === 0) return [];

  const tagNames = presetTags.map(t => t.name).join(', ');
  const excerpt = transcript.slice(0, 2000);

  const resp = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'llama-3.1-8b-instant',
      messages: [
        {
          role: 'system',
          content: 'Ты классификатор деловых встреч. Из предложенного списка тегов выбери подходящие (не более 3). Ответь только именами тегов через запятую. Если ни один не подходит — ответь пустой строкой.'
        },
        {
          role: 'user',
          content: `Теги: ${tagNames}\n\nТранскрипт:\n${excerpt}`
        }
      ],
      max_tokens: 60,
      temperature: 0
    })
  });

  if (!resp.ok) return [];
  const data = await resp.json();
  const text = (data.choices?.[0]?.message?.content || '').trim();
  if (!text) return [];
  return text.split(',').map(s => s.trim()).filter(s => presetTags.some(t => t.name === s)).slice(0, 3);
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
        {
          role: 'user',
          content: `Транскрипт встречи:\n${excerpt}`
        }
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
  const normalized = String(transcript || '')
    .replace(/\s+/g, ' ')
    .trim();
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

function buildMeetingPrompt(transcript) {
  return `Вот транскрипт записи встречи. Сделай:
1. Краткое общее саммари созвона
2. Определение ключевых задач и областей ответственности сторон
3. Важные поинты, которые можно и нужно внести в задачи и использовать в дальнейшей проработке — все согласованные моменты

Транскрипт:
${transcript}`;
}

function formatDate(ts) {
  const d = new Date(ts);
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}`;
}

// Known Whisper hallucination patterns for Russian audio — filtered out after transcription.
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

  // If the whole text is a repeated hallucination phrase, return empty string.
  const singlePhrase = normalized.split(/[.,!?…\n]+/).map(s => s.trim()).filter(Boolean);
  if (singlePhrase.length > 0) {
    const unique = new Set(singlePhrase.map(s => s.toLowerCase()));
    // All segments are the same hallucinated phrase → fully hallucinated
    if (unique.size === 1 && WHISPER_HALLUCINATIONS.some(re => re.test(singlePhrase[0]))) {
      return '';
    }
  }
  return normalized;
}

function isKnownEmptyTranscriptHallucination(text) {
  const normalized = String(text || '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/\s+/g, ' ')
    .trim();

  if (/^редактор субтитров(?:\s|$)/.test(normalized) && /(?:^|\s)корректор(?:\s|$)/.test(normalized)) {
    return true;
  }

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
      return await fetch(url, {
        ...options,
        signal: controller.signal
      });
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
  }, {
    timeoutMs: GROQ_FETCH_TIMEOUT_MS,
    retryDelaysMs: GROQ_RETRY_DELAYS_MS
  });

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
