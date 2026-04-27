// background.js — service worker
importScripts('db.js');

let activeTabId = null;
let isRecording = false;
let currentMeetingId = null;
let recordingStartedAt = null;

let panelWindowId = null;

const MEETING_STATUS = {
  RECORDING: 'Идёт запись',
  RECORDED: 'Запись сохранена',
  TRANSCRIBING: 'Транскрибируется',
  DONE: 'Готово',
  ERROR: 'Ошибка'
};

// Open side panel when user clicks the extension icon
chrome.action.onClicked.addListener((tab) => {
  if (chrome.sidePanel) {
    chrome.sidePanel.setOptions({ path: 'sidepanel.html', enabled: true });
    chrome.sidePanel.open({ tabId: tab.id });
  } else {
    openPanelWindow();
  }
});

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
  if (tabId === activeTabId && isRecording) {
    isRecording = false;
    chrome.runtime.sendMessage({ action: 'stopCapture', tabClosed: true });
    broadcastRecordingStateChanged();
  }
});

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
    startRecording(tabId).then(sendResponse);
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
    chrome.tabs.query({ url: ['https://telemost.yandex.ru/*', 'https://telemost.yandex.com/*'] }, (tabs) => {
      if (!tabs || tabs.length === 0) { sendResponse({ success: false }); return; }
      const targetTab = tabs.find(tab => tab.active) || tabs[0];
      startRecording(targetTab.id).then(sendResponse);
    });
    return true;
  }

  if (message.action === 'startRecordingFromOverlay') {
    const tabId = sender.tab && sender.tab.id;
    if (!tabId) { sendResponse({ success: false, reason: 'no_tab' }); return true; }
    startRecording(tabId).then(sendResponse);
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

  if (message.action === 'audioData') {
    if (message.error || !message.data) {
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
      broadcastRecordingStateChanged();
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

async function startRecording(tabId) {
  if (isRecording) {
    return {
      success: true,
      ...getRecordingStatePayload()
    };
  }

  if (!tabId) return { success: false };
  const key = await getGroqKey();
  if (!key) return { success: false };
  try {
    const streamId = await new Promise((resolve, reject) => {
      chrome.tabCapture.getMediaStreamId({ targetTabId: tabId }, (id) => {
        if (chrome.runtime.lastError) reject(chrome.runtime.lastError);
        else resolve(id);
      });
    });
    await ensureOffscreen();
    await new Promise(r => setTimeout(r, 300));
    activeTabId = tabId;
    currentMeetingId = Date.now();
    recordingStartedAt = Date.now();
    await dbSaveMeeting(buildRecordingMeeting(currentMeetingId));
    chrome.runtime.sendMessage({ action: 'startCapture', streamId, tabId });
    isRecording = true;
    emitHistoryUpdated();
    broadcastRecordingStateChanged();
    chrome.runtime.sendMessage({ action: 'recordingStarted', startedAt: recordingStartedAt }).catch(() => {});
    chrome.tabs.sendMessage(tabId, { action: 'recordingStarted', startedAt: recordingStartedAt }).catch(() => {});
    return {
      success: true,
      ...getRecordingStatePayload()
    };
  } catch (e) {
    console.error('startRecording error:', e);
    activeTabId = null;
    currentMeetingId = null;
    recordingStartedAt = null;
    return { success: false };
  }
}

async function ensureOffscreen() {
  try {
    const existing = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
    if (existing.length === 0) {
      await chrome.offscreen.createDocument({
        url: 'offscreen.html',
        reasons: ['USER_MEDIA'],
        justification: 'Capture tab audio for transcription'
      });
    }
  } catch (e) {
    console.error('ensureOffscreen error:', e);
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
    notifyError(e.message, tabId, tabClosed);
    return;
  }

  if (!isFinal) return;

  isRecording = false;
  activeTabId = null;
  currentMeetingId = null;
  recordingStartedAt = null;
  broadcastRecordingStateChanged();
  await transcribeMeeting(meetingId, { tabId, tabClosed, resume: false });
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

    const fullTranscript = chunks
      .sort((a, b) => Number(a.index) - Number(b.index))
      .map(chunk => chunk.transcript || '')
      .join('\n\n');

    const prompt = buildMeetingPrompt(fullTranscript);
    const tags = meeting.tags && meeting.tags.length
      ? meeting.tags
      : await autoTagMeeting(fullTranscript, apiKey).catch(() => []);
    const title = await generateMeetingTitle(fullTranscript, apiKey).catch(() => fallbackMeetingTitle(fullTranscript));

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

  for (let i = 0; i < chunks.length; i++) {
    if (!chunks[i].data) continue;
    const suffix = chunks.length > 1 ? `_part${i + 1}` : '';
    chrome.downloads.download({
      url: `data:audio/webm;base64,${chunks[i].data}`,
      filename: `${fileBase}${suffix}.webm`,
      saveAs: false
    });
  }

  chrome.downloads.download({
    url: 'data:text/plain;charset=utf-8,' + encodeURIComponent(meeting.transcript || ''),
    filename: `${fileBase}.txt`,
    saveAs: false
  });
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

  const resp = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: formData
  });

  if (!resp.ok) throw new Error(`Groq: ${resp.status} — ${await resp.text()}`);
  return await resp.text();
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
