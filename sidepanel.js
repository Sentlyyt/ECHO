// sidepanel.js

let recording = false;
let timerInterval = null;
let seconds = 0;
let currentTranscript = '';
let currentSummary = '';
let currentSummaryPrompt = '';
let currentSummaryError = '';
let currentMeetingId = null;
let viewingHistoryTranscript = false;

const DEFAULT_TRANSCRIPT_PLACEHOLDER = 'Появится после остановки записи...';
const DEFAULT_SUMMARY_PLACEHOLDER = 'Появится вместе с транскриптом...';
const SUMMARY_PREVIEW_LIMIT = 900;
const SUMMARY_PROMPT_STORAGE_KEY = 'summaryBasePrompt';
const DEFAULT_SUMMARY_PROMPT = `Сделай саммари деловой встречи на русском языке.

Структура:
1. Краткое резюме на 3-5 предложений.
2. Ключевые решения и договоренности.
3. Задачи: что сделать, кто отвечает, срок, если он есть.
4. Важные риски, вопросы и открытые хвосты.

Пиши конкретно, без воды. Если в транскрипте нет данных для пункта, так и напиши.`;
const MEETING_STATUS = {
  RECORDING: 'Идёт запись',
  RECORDED: 'Запись сохранена',
  TRANSCRIBING: 'Транскрибируется',
  DONE: 'Готово',
  ERROR: 'Ошибка'
};

// ── Screens ──
const setupScreen = document.getElementById('setup-screen');
const mainScreen  = document.getElementById('main-screen');

// ── Main UI ──
const btnRecord         = document.getElementById('btn-record');
const btnOpenRecordings = document.getElementById('btn-open-recordings');
const statusBadge       = document.getElementById('status-badge');
const recDot            = document.getElementById('rec-dot');
const timerEl           = document.getElementById('timer');
const transcriptCard    = document.getElementById('transcript-card');
const summaryCard       = document.getElementById('summary-card');
const transcriptEl      = document.getElementById('transcript-text');
const summaryEl         = document.getElementById('summary-text');
const summaryErrorEl    = document.getElementById('summary-error');
const btnShowSummaryFull = document.getElementById('btn-show-summary-full');
const btnBackFromHistory = document.getElementById('btn-back-from-history');
const pendingRecordingsCard = document.getElementById('pending-recordings-card');
const pendingRecordingsList = document.getElementById('pending-recordings-list');
const copiedToast       = document.getElementById('copied-toast');
const fileTranscriptCard = document.getElementById('file-transcript-card');
const fileSummaryCard    = document.getElementById('file-summary-card');
const fileTranscriptEl   = document.getElementById('file-transcript-text');
const fileSummaryEl      = document.getElementById('file-summary-text');
const fileSummaryErrorEl = document.getElementById('file-summary-error');
const btnShowFileSummaryFull = document.getElementById('btn-show-file-summary-full');
const historyViews = [
  {
    id: 'meetings',
    list: document.getElementById('history-list-meetings'),
    tagFilter: document.getElementById('history-tag-filter-meetings'),
    search: document.getElementById('history-search-meetings'),
    exportBtn: document.getElementById('btn-export-history-meetings'),
    importBtn: document.getElementById('btn-import-history-meetings'),
    importInput: document.getElementById('import-file-input-meetings'),
    importStatus: document.getElementById('import-status-meetings'),
    toggleBtn: document.getElementById('btn-history-toggle-meetings'),
    expanded: false
  },
  {
    id: 'files',
    list: document.getElementById('history-list-files'),
    tagFilter: document.getElementById('history-tag-filter-files'),
    search: document.getElementById('history-search-files'),
    exportBtn: document.getElementById('btn-export-history-files'),
    importBtn: document.getElementById('btn-import-history-files'),
    importInput: document.getElementById('import-file-input-files'),
    importStatus: document.getElementById('import-status-files'),
    toggleBtn: document.getElementById('btn-history-toggle-files'),
    expanded: false
  }
].filter(view => view.list && view.tagFilter && view.search);

// ── API key (setup screen) ──
const setupKeyInput = document.getElementById('setup-key');
const btnSetupSave  = document.getElementById('btn-setup-save');
const setupErr      = document.getElementById('setup-err');

// ── API key (settings panel) ──
const btnApiToggle = document.getElementById('btn-api-toggle');
const apiPanel     = document.getElementById('api-panel');
const apiKeyInput  = document.getElementById('api-key-input');
const btnApiSave   = document.getElementById('btn-api-save');
const apiSaved     = document.getElementById('api-saved');
const summaryPromptInput = document.getElementById('summary-prompt-input');
const btnSummaryPromptSave = document.getElementById('btn-summary-prompt-save');
const btnSummaryPromptReset = document.getElementById('btn-summary-prompt-reset');
const summaryPromptSaved = document.getElementById('summary-prompt-saved');

// ── Init ──
chrome.storage.local.get('groqApiKey', (data) => {
  if (data.groqApiKey) showMain();
  else showSetup();
});

function showSetup() {
  setupScreen.style.display = 'flex';
  mainScreen.style.display  = 'none';
  setupKeyInput.focus();
}

function showMain() {
  setupScreen.style.display = 'none';
  mainScreen.style.display  = 'flex';
  ensureSummaryPromptStored();
  renderTagFilter();
  renderHistory();
  syncRecordingState();
  loadRecordingSettings();
}

// ── Setup screen ──
btnSetupSave.addEventListener('click', () => {
  const key = setupKeyInput.value.trim();
  if (!key.startsWith('gsk_') || key.length < 20) {
    setupErr.textContent = 'Похоже, это не Groq ключ. Он начинается с gsk_...';
    return;
  }
  setupErr.textContent = '';
  btnSetupSave.disabled = true;
  btnSetupSave.textContent = 'Сохраняю...';
  chrome.storage.local.set({ groqApiKey: key }, () => {
    showMain();
    btnSetupSave.disabled = false;
    btnSetupSave.textContent = 'Сохранить и начать';
  });
});
setupKeyInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') btnSetupSave.click(); });

// ── Recording settings ──

const settingSaveVideo   = document.getElementById('setting-save-video');
const settingAutoTagMeetings = document.getElementById('setting-auto-tag-meetings');
const destLocalRadio     = document.getElementById('dest-local');
const destDriveRadio     = document.getElementById('dest-drive');
const driveWarning       = document.getElementById('drive-warning');
const recordingWhatEl    = document.getElementById('recording-what');

function getRecordingSettingsLocal() {
  return new Promise(resolve => {
    chrome.storage.local.get(['saveVideo', 'saveDestination', 'autoTagMeetings'], data => {
      resolve({
        saveVideo: data.saveVideo !== false,
        saveDestination: data.saveDestination || 'local',
        autoTagMeetings: data.autoTagMeetings !== false
      });
    });
  });
}

function saveRecordingSettingsLocal(settings) {
  chrome.storage.local.set({
    saveVideo: settings.saveVideo,
    saveDestination: settings.saveDestination,
    autoTagMeetings: settings.autoTagMeetings !== false
  });
}

async function loadRecordingSettings() {
  const settings = await getRecordingSettingsLocal();
  if (settingSaveVideo)  settingSaveVideo.checked = settings.saveVideo;
  if (settingAutoTagMeetings) settingAutoTagMeetings.checked = settings.autoTagMeetings;
  if (destLocalRadio)    destLocalRadio.checked  = settings.saveDestination === 'local';
  if (destDriveRadio)    destDriveRadio.checked  = settings.saveDestination === 'google_drive';
  applyDriveWarning(settings.saveDestination);
  updateRecordingWhatText(settings);
}

function updateRecordingWhatTextWithDrive(settings, driveConnected) {
  if (!recordingWhatEl) return;
  if (!settings) { recordingWhatEl.textContent = ''; return; }
  const videoLabel = settings.saveVideo ? ', видео' : '';
  let destLabel;
  if (settings.saveDestination === 'google_drive') {
    destLabel = driveConnected ? ' → Google Drive' : ' → Google Drive (не подключён)';
  } else {
    destLabel = ' → компьютер';
  }
  recordingWhatEl.textContent = `Сохраняем: аудио${videoLabel} и транскрипт${destLabel}`;
}

// ── Drive connection UI ──
const driveConnectBlock   = document.getElementById('drive-connect-block');
const driveStatusDot      = document.getElementById('drive-status-dot');
const driveStatusText     = document.getElementById('drive-status-text');
const driveErrText        = document.getElementById('drive-err-text');
const btnDriveConnect     = document.getElementById('btn-drive-connect');
const btnDriveDisconnect  = document.getElementById('btn-drive-disconnect');
const driveProgressBanner = document.getElementById('drive-progress-banner');
const driveNotConfigured  = document.getElementById('drive-not-configured');
const driveConfiguredBlock = document.getElementById('drive-configured-block');
const driveOnboarding     = document.getElementById('drive-onboarding');

let driveProgressTimer = null;

function isDriveConfiguredInManifest() {
  const manifest = chrome.runtime.getManifest ? chrome.runtime.getManifest() : {};
  const clientId = manifest.oauth2?.client_id || '';
  return clientId.endsWith('.apps.googleusercontent.com')
    && !clientId.includes('REPLACE_WITH')
    && !clientId.includes('YOUR_GOOGLE_CLIENT_ID')
    && !clientId.includes('TODO');
}

function setDriveSetupState(configured) {
  if (driveNotConfigured) driveNotConfigured.style.display = configured ? 'none' : '';
  if (driveConfiguredBlock) driveConfiguredBlock.style.display = configured ? '' : 'none';
  if (driveOnboarding) driveOnboarding.style.display = configured ? '' : 'none';
}

function applyDriveWarning(destination) {
  if (!driveConnectBlock) return;
  if (destination === 'google_drive') {
    driveConnectBlock.style.display = '';
    const configured = isDriveConfiguredInManifest();
    setDriveSetupState(configured);
    if (configured) loadDriveStatus();
  } else {
    driveConnectBlock.style.display = 'none';
  }
}

function setDriveStatusUI(connected, loading = false) {
  if (!driveStatusDot || !driveStatusText) return;
  driveStatusDot.className = 'drive-status-dot ' + (
    loading ? 'drive-status-dot--loading' :
    connected ? 'drive-status-dot--connected' : 'drive-status-dot--disconnected'
  );
  driveStatusText.textContent = loading ? 'Проверяю...' :
    connected ? 'Google Drive подключён' : 'Google Drive не подключён';
  if (btnDriveConnect) btnDriveConnect.style.display = (!loading && !connected) ? '' : 'none';
  if (btnDriveDisconnect) btnDriveDisconnect.style.display = (!loading && connected) ? '' : 'none';
  if (driveErrText) driveErrText.textContent = '';
}

async function loadDriveStatus() {
  setDriveStatusUI(false, true);
  chrome.runtime.sendMessage({ action: 'checkDriveStatus' }, (resp) => {
    if (chrome.runtime.lastError) { setDriveStatusUI(false); return; }
    setDriveStatusUI(!!(resp && resp.connected));
  });
}

btnDriveConnect?.addEventListener('click', () => {
  if (btnDriveConnect.disabled) return;
  btnDriveConnect.disabled = true;
  btnDriveConnect.textContent = 'Подключаю...';
  chrome.runtime.sendMessage({ action: 'connectDrive' }, (resp) => {
    btnDriveConnect.disabled = false;
    btnDriveConnect.textContent = 'Подключить Google Drive';
    if (chrome.runtime.lastError || !resp || !resp.ok) {
      const err = (resp && resp.error) || (chrome.runtime.lastError && chrome.runtime.lastError.message) || 'Не удалось подключить';
      setDriveStatusUI(false);
      if (driveErrText) driveErrText.textContent = '❌ ' + err;
    } else {
      setDriveStatusUI(true);
    }
  });
});

btnDriveDisconnect?.addEventListener('click', () => {
  chrome.runtime.sendMessage({ action: 'disconnectDrive' }, () => {
    setDriveStatusUI(false);
  });
});

function showDriveProgress(status) {
  if (!driveProgressBanner) return;
  driveProgressBanner.textContent = status;
  driveProgressBanner.classList.add('visible');
  clearTimeout(driveProgressTimer);
  const isDone = /^(Готово|Видео загружено|❌)/i.test(status);
  if (isDone) {
    driveProgressTimer = setTimeout(() => {
      driveProgressBanner.classList.remove('visible');
    }, 5000);
  }
}

function updateRecordingWhatText(settings) {
  if (!recordingWhatEl) return;
  if (!settings) { recordingWhatEl.textContent = ''; return; }
  const videoLabel = settings.saveVideo ? ', видео' : '';
  const destLabel  = settings.saveDestination === 'google_drive'
    ? ' → Google Drive*'
    : ' → компьютер';
  recordingWhatEl.textContent = `Сохраняем: аудио${videoLabel} и транскрипт${destLabel}`;
}

settingSaveVideo?.addEventListener('change', async () => {
  const settings = await getRecordingSettingsLocal();
  settings.saveVideo = settingSaveVideo.checked;
  saveRecordingSettingsLocal(settings);
  updateRecordingWhatText(settings);
});

settingAutoTagMeetings?.addEventListener('change', async () => {
  const settings = await getRecordingSettingsLocal();
  settings.autoTagMeetings = settingAutoTagMeetings.checked;
  saveRecordingSettingsLocal(settings);
});

destLocalRadio?.addEventListener('change', async () => {
  if (!destLocalRadio.checked) return;
  const settings = await getRecordingSettingsLocal();
  settings.saveDestination = 'local';
  saveRecordingSettingsLocal(settings);
  applyDriveWarning('local');
  updateRecordingWhatText(settings);
});

destDriveRadio?.addEventListener('change', async () => {
  if (!destDriveRadio.checked) return;
  const settings = await getRecordingSettingsLocal();
  settings.saveDestination = 'google_drive';
  saveRecordingSettingsLocal(settings);
  applyDriveWarning('google_drive');
  updateRecordingWhatText(settings);
});

// ── API key settings ──
btnApiToggle.addEventListener('click', () => {
  const open = apiPanel.classList.toggle('open');
  if (open) {
    chrome.storage.local.get('groqApiKey', (data) => { apiKeyInput.value = data.groqApiKey || ''; });
    apiKeyInput.focus();
  }
  apiSaved.style.display = 'none';
});

btnApiSave.addEventListener('click', () => {
  const key = apiKeyInput.value.trim();
  chrome.storage.local.set({ groqApiKey: key }, () => {
    apiSaved.style.display = 'block';
    setTimeout(() => { apiSaved.style.display = 'none'; apiPanel.classList.remove('open'); }, 1500);
  });
});
apiKeyInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') btnApiSave.click(); });

// ── Tabs ──
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const tab = btn.dataset.tab;
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
    document.querySelectorAll('.tab-content').forEach(c => c.classList.toggle('active', c.id === `tab-${tab}`));
    if (tab === 'settings') {
      loadSummaryPromptSettings();
      renderPresetTags();
      loadRecordingSettings();
    }
  });
});

function setActiveTab(tab) {
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  document.querySelectorAll('.tab-content').forEach(c => c.classList.toggle('active', c.id === `tab-${tab}`));
  if (tab === 'settings') {
    loadSummaryPromptSettings();
    renderPresetTags();
    loadRecordingSettings();
  }
}

function getSummaryBasePrompt() {
  return new Promise(resolve => chrome.storage.local.get(SUMMARY_PROMPT_STORAGE_KEY, data => {
    resolve(String(data[SUMMARY_PROMPT_STORAGE_KEY] || DEFAULT_SUMMARY_PROMPT).trim() || DEFAULT_SUMMARY_PROMPT);
  }));
}

function saveSummaryBasePrompt(value) {
  return new Promise(resolve => chrome.storage.local.set({ [SUMMARY_PROMPT_STORAGE_KEY]: value }, resolve));
}

function ensureSummaryPromptStored() {
  chrome.storage.local.get(SUMMARY_PROMPT_STORAGE_KEY, data => {
    if (!data[SUMMARY_PROMPT_STORAGE_KEY]) {
      chrome.storage.local.set({ [SUMMARY_PROMPT_STORAGE_KEY]: DEFAULT_SUMMARY_PROMPT });
    }
  });
}

async function loadSummaryPromptSettings() {
  if (!summaryPromptInput) return;
  summaryPromptInput.value = await getSummaryBasePrompt();
  if (summaryPromptSaved) summaryPromptSaved.textContent = '';
}

btnSummaryPromptSave?.addEventListener('click', async () => {
  const value = summaryPromptInput.value.trim() || DEFAULT_SUMMARY_PROMPT;
  await saveSummaryBasePrompt(value);
  summaryPromptInput.value = value;
  summaryPromptSaved.textContent = 'Промпт сохранён';
  setTimeout(() => { summaryPromptSaved.textContent = ''; }, 2000);
});

btnSummaryPromptReset?.addEventListener('click', async () => {
  await saveSummaryBasePrompt(DEFAULT_SUMMARY_PROMPT);
  summaryPromptInput.value = DEFAULT_SUMMARY_PROMPT;
  summaryPromptSaved.textContent = 'Сброшено к дефолту';
  setTimeout(() => { summaryPromptSaved.textContent = ''; }, 2000);
});

// ── Timer ──
function startTimer() {
  startTimerFrom(0);
}

function startTimerFrom(initialSeconds = 0) {
  clearInterval(timerInterval);
  seconds = Math.max(0, Number(initialSeconds) || 0);
  timerEl.style.display = 'block';
  const m0 = String(Math.floor(seconds / 60)).padStart(2, '0');
  const s0 = String(seconds % 60).padStart(2, '0');
  timerEl.textContent = `${m0}:${s0}`;
  timerInterval = setInterval(() => {
    seconds++;
    const m = String(Math.floor(seconds / 60)).padStart(2, '0');
    const s = String(seconds % 60).padStart(2, '0');
    timerEl.textContent = `${m}:${s}`;
  }, 1000);
}

function stopTimer() {
  clearInterval(timerInterval);
  timerInterval = null;
  timerEl.style.display = 'none';
}

// ── Status ──
function setStatus(text, type = '') {
  statusBadge.textContent = text;
  statusBadge.className = type;
}

function normalizeMeetingSummary(meeting) {
  const summary = meeting.summary || '';
  const summaryPrompt = meeting.summaryPrompt || meeting.prompt || '';
  const summaryError = meeting.summaryError || '';
  return { summary, summaryPrompt, summaryError };
}

function setSummaryOutput(summary, options = {}) {
  const isEmpty = !!options.isEmpty || !summary;
  const isPreview = !!options.preview && String(summary || '').length > SUMMARY_PREVIEW_LIMIT;
  const text = isPreview ? `${String(summary).slice(0, SUMMARY_PREVIEW_LIMIT).trim()}...` : (summary || DEFAULT_SUMMARY_PLACEHOLDER);

  if (summaryCard) summaryCard.style.display = '';
  summaryEl.textContent = text;
  summaryEl.className = isEmpty ? 'empty' : (isPreview ? 'summary-preview' : '');
  if (summaryErrorEl) {
    summaryErrorEl.style.display = options.error ? 'block' : 'none';
    summaryErrorEl.textContent = options.error ? `Саммари не сгенерировалось: ${options.error}` : '';
  }
  if (btnShowSummaryFull) {
    btnShowSummaryFull.style.display = options.showFull && !viewingHistoryTranscript ? 'block' : 'none';
  }
}

function setFileResultOutput(transcript, summary, options = {}) {
  if (!fileTranscriptCard || !fileSummaryCard) return;
  fileSummaryCard.style.display = '';
  fileTranscriptCard.style.display = '';
  const isEmpty = !!options.isEmpty || !summary;
  const isPreview = !!options.preview && String(summary || '').length > SUMMARY_PREVIEW_LIMIT;
  const summaryText = isPreview ? `${String(summary).slice(0, SUMMARY_PREVIEW_LIMIT).trim()}...` : (summary || DEFAULT_SUMMARY_PLACEHOLDER);
  fileTranscriptEl.textContent = transcript || DEFAULT_TRANSCRIPT_PLACEHOLDER;
  fileTranscriptEl.className = !transcript ? 'empty' : '';
  fileSummaryEl.textContent = summaryText;
  fileSummaryEl.className = isEmpty ? 'empty' : (isPreview ? 'summary-preview' : '');
  if (fileSummaryErrorEl) {
    fileSummaryErrorEl.style.display = options.error ? 'block' : 'none';
    fileSummaryErrorEl.textContent = options.error ? `Саммари не сгенерировалось: ${options.error}` : '';
  }
  if (btnShowFileSummaryFull) {
    btnShowFileSummaryFull.style.display = options.showFull ? 'block' : 'none';
  }
}

function applyRecordingState(state = {}) {
  const active = !!state.recording;
  const startedAt = state.startedAt || null;

  recording = active;
  btnRecord.disabled = false;
  if (active) {
    hideHistoryTranscriptView();
    getRecordingSettingsLocal().then(updateRecordingWhatText);
    btnRecord.textContent = '⏹ Остановить';
    btnRecord.className = 'btn-secondary';
    recDot.style.display = 'inline-block';
    recDot.classList.add('active');
    setStatus('Запись', 'recording');
    const elapsed = startedAt ? Math.floor((Date.now() - startedAt) / 1000) : 0;
    startTimerFrom(elapsed);
    transcriptCard.style.display = '';
    summaryCard.style.display = '';
    currentTranscript = '';
    currentSummary = '';
    currentSummaryPrompt = '';
    currentSummaryError = '';
    currentMeetingId = null;
    transcriptEl.textContent = 'Запись идёт...';
    transcriptEl.className = 'empty';
    setSummaryOutput(DEFAULT_SUMMARY_PLACEHOLDER, { isEmpty: true });
  } else {
    btnRecord.textContent = '⏺ Начать запись';
    btnRecord.className = 'btn-primary';
    recDot.classList.remove('active');
    recDot.style.display = 'none';
    stopTimer();
    if (statusBadge.textContent === 'Запись') {
      setStatus('Ожидание', '');
    }
    if (!viewingHistoryTranscript && transcriptEl.textContent === 'Запись идёт...' && !currentTranscript && !currentSummary) {
      resetTranscriptView();
    }
  }
}

function syncRecordingState() {
  chrome.runtime.sendMessage({ action: 'getRecordingState' }, (resp) => {
    if (chrome.runtime.lastError || !resp) return;
    applyRecordingState(resp);
  });
}

function resetTranscriptView() {
  currentTranscript = '';
  currentSummary = '';
  currentSummaryPrompt = '';
  currentSummaryError = '';
  currentMeetingId = null;
  transcriptCard.style.display = 'none';
  summaryCard.style.display = 'none';
  transcriptEl.textContent = DEFAULT_TRANSCRIPT_PLACEHOLDER;
  transcriptEl.className = 'empty';
  setSummaryOutput(DEFAULT_SUMMARY_PLACEHOLDER, { isEmpty: true });
  summaryCard.style.display = 'none';
}

function hideHistoryTranscriptView() {
  viewingHistoryTranscript = false;
  btnBackFromHistory.style.display = 'none';
}

function enterHistoryTranscriptView(meeting) {
  viewingHistoryTranscript = true;
  setActiveTab('meetings');
  summaryCard.style.display = '';
  transcriptCard.style.display = '';
  btnBackFromHistory.style.display = 'inline-flex';
  currentMeetingId = meeting.id || null;
  currentTranscript = meeting.transcript || '';
  const summaryData = normalizeMeetingSummary(meeting);
  currentSummary = summaryData.summary;
  currentSummaryPrompt = summaryData.summaryPrompt;
  currentSummaryError = summaryData.summaryError;
  transcriptEl.textContent = currentTranscript || DEFAULT_TRANSCRIPT_PLACEHOLDER;
  transcriptEl.className = currentTranscript ? '' : 'empty';
  setSummaryOutput(currentSummary, { isEmpty: !currentSummary, error: currentSummaryError, preview: false, showFull: false });
  setFileResultOutput(currentTranscript, currentSummary, { isEmpty: !currentTranscript && !currentSummary, error: currentSummaryError, preview: false, showFull: false });
  setStatus('Из истории', 'done');

  // Show video error notice if video recording failed
  renderVideoErrorNotice(meeting);
}

function renderVideoErrorNotice(meeting) {
  // Remove any existing notice
  const existing = document.getElementById('video-error-notice');
  if (existing) existing.remove();

  const hasVideo = Array.isArray(meeting.videoChunks) && meeting.videoChunks.length > 0;
  const videoErr = meeting.videoError || '';
  if (!hasVideo && videoErr && transcriptCard) {
    const notice = document.createElement('div');
    notice.id = 'video-error-notice';
    notice.className = 'video-error-notice';
    notice.textContent = `Транскрипт готов, но видео не удалось сохранить: ${videoErr}`;
    transcriptCard.after(notice);
  }
}

function exitHistoryTranscriptView() {
  hideHistoryTranscriptView();
  resetTranscriptView();
  setStatus('Ожидание', '');
  const notice = document.getElementById('video-error-notice');
  if (notice) notice.remove();
}

// ── Copy toast ──
function showCopied() {
  copiedToast.classList.add('show');
  setTimeout(() => copiedToast.classList.remove('show'), 2000);
}

function copyText(text) {
  navigator.clipboard.writeText(text).then(showCopied).catch(() => {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
    showCopied();
  });
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[char]));
}

function escapeAttr(value) {
  return escapeHtml(value);
}

function parseMeetingId(value) {
  const normalized = String(value ?? '').trim();
  return /^\d+$/.test(normalized) ? Number(normalized) : normalized;
}

function sanitizeMeetingTitle(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .replace(/^["«]+|["»]+$/g, '')
    .replace(/[.]+$/g, '')
    .trim()
    .slice(0, 80);
}

function fallbackMeetingTitle(transcript) {
  const normalized = String(transcript || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!normalized) return 'Встреча без названия';

  const firstSentence = normalized.split(/[.!?\n]/)[0].trim();
  const source = firstSentence || normalized;
  const title = source.split(' ').filter(Boolean).slice(0, 6).join(' ');
  return sanitizeMeetingTitle(title) || 'Встреча без названия';
}

async function generateMeetingTitle(transcript, apiKey) {
  const excerpt = String(transcript || '').slice(0, 3000);
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

function getMeetingTitle(meeting) {
  return sanitizeMeetingTitle(meeting.title) || fallbackMeetingTitle(meeting.transcript);
}

function getMeetingDayKey(meeting) {
  if (meeting.date) return String(meeting.date).slice(0, 10);
  const raw = String(meeting.dateDisplay || '').trim();
  const match = raw.match(/^(\d{2})\.(\d{2})\.(\d{4})/);
  if (match) return `${match[3]}-${match[2]}-${match[1]}`;
  return 'unknown';
}

function formatMeetingDayLabel(dayKey) {
  if (dayKey === 'unknown') return 'Без даты';
  const [year, month, day] = dayKey.split('-').map(Number);
  const date = new Date(year, (month || 1) - 1, day || 1);
  return date.toLocaleDateString('ru-RU', {
    day: 'numeric',
    month: 'long',
    weekday: 'long'
  });
}

function groupMeetingsByDay(meetings) {
  const groups = [];
  let currentGroup = null;

  for (const meeting of meetings) {
    const dayKey = getMeetingDayKey(meeting);
    if (!currentGroup || currentGroup.dayKey !== dayKey) {
      currentGroup = {
        dayKey,
        dayLabel: formatMeetingDayLabel(dayKey),
        meetings: []
      };
      groups.push(currentGroup);
    }
    currentGroup.meetings.push(meeting);
  }

  return groups;
}

// ── Record button ──
btnRecord.addEventListener('click', () => {
  if (!recording) {
    chrome.runtime.sendMessage({ action: 'startRecordingFromPanel' }, (resp) => {
      if (chrome.runtime.lastError || !resp || !resp.success) {
        setStatus('Ошибка', '');
        currentTranscript = '';
        currentSummary = '';
        currentSummaryPrompt = '';
        currentSummaryError = '';
        setSummaryOutput(resp && resp.message
          ? resp.message
          : 'Запись нужно запускать кликом по иконке ECHO на активной вкладке Телемоста.', { isEmpty: true });
        return;
      }
      applyRecordingState(resp);
    });
  } else {
    btnRecord.disabled = true;
    btnRecord.textContent = '⏳ Обрабатываю...';
    chrome.runtime.sendMessage({ action: 'stopRecording' });
  }
});

btnOpenRecordings.addEventListener('click', () => chrome.runtime.sendMessage({ action: 'openRecordings' }));

document.getElementById('btn-copy-transcript').addEventListener('click', () => {
  if (currentTranscript) copyText(currentTranscript);
});
document.getElementById('btn-copy-prompt').addEventListener('click', () => {
  if (currentSummary) copyText(currentSummary);
});
document.getElementById('btn-copy-file-transcript').addEventListener('click', () => {
  if (currentTranscript) copyText(currentTranscript);
});
document.getElementById('btn-copy-file-prompt').addEventListener('click', () => {
  if (currentSummary) copyText(currentSummary);
});
btnBackFromHistory.addEventListener('click', () => {
  if (viewingHistoryTranscript) exitHistoryTranscriptView();
});

btnShowSummaryFull?.addEventListener('click', () => openCurrentMeetingFromHistory());
btnShowFileSummaryFull?.addEventListener('click', () => openCurrentMeetingFromHistory());

async function openCurrentMeetingFromHistory() {
  if (!currentMeetingId) return;
  const meeting = allMeetings.find(x => x.id == currentMeetingId) || await dbGetMeeting(currentMeetingId);
  if (meeting) enterHistoryTranscriptView(meeting);
}

// ── Messages from background ──
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.action === 'historyUpdated') {
    renderHistory();
  }

  if (msg.action === 'recordingStateChanged') {
    syncRecordingState();
  }

  if (msg.action === 'recordingStarted') {
    applyRecordingState({ recording: true, startedAt: msg.startedAt || Date.now() });
  }

  if (msg.action === 'transcribing') {
    hideHistoryTranscriptView();
    applyRecordingState({ recording: false });
    setStatus('Обработка', 'processing');
    summaryCard.style.display = '';
    transcriptCard.style.display = '';
    transcriptEl.textContent = '⏳ Транскрибирую...';
    transcriptEl.className = 'empty';
    setSummaryOutput('⏳ Транскрибирую и готовлю саммари...', { isEmpty: true });
    meetingTimer.start(EST_CHUNK_TRANSCRIPTION_MS * 3 + EST_FINAL_SUMMARY_MS);
    meetingTimer.setStage('Транскрибирую запись...');
  }

  if (msg.action === 'chunkProgress') {
    hideHistoryTranscriptView();
    summaryCard.style.display = '';
    transcriptCard.style.display = '';
    const knownTotal = msg.total && msg.total !== '?';
    const totalLabel = knownTotal ? ` из ${msg.total}` : '';
    transcriptEl.textContent = `⏳ Транскрибирую часть ${msg.current}${totalLabel}...`;
    transcriptEl.className = 'empty';
    setSummaryOutput(`⏳ Обрабатываю часть ${msg.current}${totalLabel}...`, { isEmpty: true });
    if (knownTotal) {
      const left = msg.total - msg.current + 1;
      meetingTimer.setStage(`Транскрибирую часть ${msg.current} из ${msg.total}...`);
      meetingTimer.setProgress(
        ((msg.current - 1) / msg.total) * 78,
        left * EST_CHUNK_TRANSCRIPTION_MS + EST_FINAL_SUMMARY_MS
      );
    }
  }

  if (msg.action === 'recordingDiscarded') {
    hideHistoryTranscriptView();
    applyRecordingState({ recording: false });
    resetTranscriptView();
    transcriptCard.style.display = '';
    transcriptEl.textContent = 'Короткая запись удалена.';
    transcriptEl.className = 'empty';
    setStatus('Удалено', '');
    setSummaryOutput('Короткая запись удалена.', { isEmpty: true });
    renderHistory();
  }

  if (msg.action === 'retranscribing') {
    hideHistoryTranscriptView();
    setStatus('Обработка', 'processing');
    summaryCard.style.display = '';
    transcriptCard.style.display = '';
    transcriptEl.textContent = '⏳ Повторная транскрипция...';
    transcriptEl.className = 'empty';
    setSummaryOutput('⏳ Повторно формирую транскрипт и саммари...', { isEmpty: true });
    meetingTimer.start(EST_CHUNK_TRANSCRIPTION_MS * 3 + EST_FINAL_SUMMARY_MS);
    meetingTimer.setStage('Повторная транскрипция...');
  }

  if (msg.action === 'summaryProgress') {
    setSummaryOutput(`⏳ ${msg.status}`, { isEmpty: true });
    parseSummaryStatusForTimer(msg.status, meetingTimer);
  }

  if (msg.action === 'transcriptReady') {
    hideHistoryTranscriptView();
    applyRecordingState({ recording: false });
    summaryCard.style.display = '';
    transcriptCard.style.display = '';
    currentMeetingId = msg.meetingId || null;
    currentTranscript = msg.transcript || '';
    currentSummary = msg.summary || '';
    currentSummaryPrompt = msg.summaryPrompt || msg.prompt || '';
    currentSummaryError = msg.summaryError || '';
    setStatus('Готово', 'done');
    transcriptEl.textContent = currentTranscript;
    transcriptEl.className = '';
    setSummaryOutput(currentSummary, { isEmpty: !currentSummary, error: currentSummaryError, preview: true, showFull: !!currentMeetingId && !!currentSummary });
    meetingTimer.stop();
    renderHistory();
  }

  if (msg.action === 'error') {
    hideHistoryTranscriptView();
    applyRecordingState({ recording: false });
    setStatus('Ошибка', '');
    currentTranscript = '';
    currentSummary = '';
    currentSummaryPrompt = '';
    currentSummaryError = '';
    currentMeetingId = null;
    summaryCard.style.display = '';
    transcriptCard.style.display = '';
    setSummaryOutput('❌ ' + msg.error, { isEmpty: true });
    meetingTimer.stop();
  }

  if (msg.action === 'driveUploadProgress') {
    showDriveProgress(msg.status);
    if (/готово|загружено/i.test(msg.status)) renderHistory();
  }
});

window.addEventListener('focus', syncRecordingState);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) syncRecordingState();
});

// ── File transcription pipeline ──

const FILE_TRANSCRIPTION_MAX = 24 * 1024 * 1024; // 24 MB
const WAV_SAMPLE_RATE = 16000;                    // Whisper-optimal, mono

function isVideoFile(file) {
  return file.type.startsWith('video/');
}

async function decodeAudioBuffer(fileOrBlob) {
  const arrayBuffer = await fileOrBlob.arrayBuffer();
  const ctx = new AudioContext();
  try {
    return await ctx.decodeAudioData(arrayBuffer);
  } finally {
    ctx.close();
  }
}

// Encodes a range [startSample, endSample) of an AudioBuffer as 16kHz mono 16-bit WAV
function audioBufferRangeToWav(audioBuffer, startSample, endSample) {
  const originalRate = audioBuffer.sampleRate;
  const len = endSample - startSample;

  // Mix down to mono
  const mono = new Float32Array(len);
  for (let ch = 0; ch < audioBuffer.numberOfChannels; ch++) {
    const src = audioBuffer.getChannelData(ch);
    for (let i = 0; i < len; i++) {
      mono[i] += src[startSample + i] / audioBuffer.numberOfChannels;
    }
  }

  // Resample to WAV_SAMPLE_RATE via linear interpolation
  const ratio = originalRate / WAV_SAMPLE_RATE;
  const newLen = Math.round(len / ratio);
  const resampled = new Float32Array(newLen);
  for (let i = 0; i < newLen; i++) {
    const src = i * ratio;
    const lo = Math.floor(src);
    const hi = Math.min(lo + 1, len - 1);
    resampled[i] = mono[lo] + (mono[hi] - mono[lo]) * (src - lo);
  }

  // Convert to Int16 PCM
  const pcm = new Int16Array(newLen);
  for (let i = 0; i < newLen; i++) {
    const s = Math.max(-1, Math.min(1, resampled[i]));
    pcm[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
  }

  // Build WAV container
  const buf = new ArrayBuffer(44 + pcm.byteLength);
  const v = new DataView(buf);
  const w = (off, str) => { for (let i = 0; i < str.length; i++) v.setUint8(off + i, str.charCodeAt(i)); };
  w(0, 'RIFF');
  v.setUint32(4, 36 + pcm.byteLength, true);
  w(8, 'WAVE');
  w(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);           // PCM
  v.setUint16(22, 1, true);           // mono
  v.setUint32(24, WAV_SAMPLE_RATE, true);
  v.setUint32(28, WAV_SAMPLE_RATE * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  w(36, 'data');
  v.setUint32(40, pcm.byteLength, true);
  new Uint8Array(buf, 44).set(new Uint8Array(pcm.buffer));

  return new Blob([buf], { type: 'audio/wav' });
}

// Split an AudioBuffer into WAV Blob chunks each ≤ maxBytes
function splitAudioBufferToWavChunks(audioBuffer, maxBytes = FILE_TRANSCRIPTION_MAX) {
  const bytesPerSec = WAV_SAMPLE_RATE * 2; // mono 16-bit
  const maxSecs = Math.floor((maxBytes - 44) / bytesPerSec);
  const totalSamples = audioBuffer.length;
  const samplesPerChunk = Math.floor(maxSecs * audioBuffer.sampleRate);
  const count = Math.ceil(totalSamples / samplesPerChunk);
  const chunks = [];
  for (let i = 0; i < count; i++) {
    const start = i * samplesPerChunk;
    const end = Math.min(start + samplesPerChunk, totalSamples);
    chunks.push(audioBufferRangeToWav(audioBuffer, start, end));
  }
  return chunks;
}

async function transcribeBlob(blob, filename, apiKey) {
  const fd = new FormData();
  fd.append('file', blob, filename);
  fd.append('model', 'whisper-large-v3');
  fd.append('language', 'ru');
  fd.append('response_format', 'text');
  const resp = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: fd
  });
  if (!resp.ok) throw new Error(`Groq ${resp.status}: ${await resp.text()}`);
  return (await resp.text()).trim();
}

async function transcribeChunks(chunks, apiKey, onStatus, timer = null, estimate = null) {
  const total       = chunks.length;
  const summaryMs   = estimate?.summaryMs   ?? EST_FINAL_SUMMARY_MS;
  const totalMs     = estimate?.totalMs     ?? null;
  const videoMs     = estimate?.videoExtractMs ?? 0;
  const transcMs    = estimate?.transcriptionMs ?? total * EST_CHUNK_TRANSCRIPTION_MS;

  const startPct = totalMs ? (videoMs / totalMs) * 100 : 1;
  const endPct   = totalMs ? ((videoMs + transcMs) / totalMs) * 100 : 78;

  const parts = [];
  for (let i = 0; i < total; i++) {
    const stageText = `Транскрибирую часть ${i + 1} из ${total}...`;
    onStatus(stageText);
    timer?.setStage(stageText);
    timer?.setProgress(
      startPct + (i / total) * (endPct - startPct),
      (total - i) * EST_CHUNK_TRANSCRIPTION_MS + summaryMs
    );
    parts.push(await transcribeBlob(chunks[i], `chunk_${i + 1}.wav`, apiKey));
  }
  const joinText = 'Объединяю транскрипт...';
  onStatus(joinText);
  timer?.setStage(joinText);
  timer?.setProgress(endPct, summaryMs);
  return parts.join('\n\n');
}

async function processFileForTranscription(file, apiKey, onStatus, timer = null, estimate = null) {
  onStatus('Проверяю файл...');
  timer?.setStage('Проверяю файл...');

  if (file.size <= FILE_TRANSCRIPTION_MAX) {
    const stageText = 'Отправляю файл в Groq...';
    onStatus(stageText);
    timer?.setStage(stageText);
    timer?.setProgress(5, estimate?.transcriptionMs ?? EST_DIRECT_TRANSCRIPTION_MS);
    return await transcribeBlob(file, file.name, apiKey);
  }

  if (isVideoFile(file)) {
    const extractText = 'Извлекаю аудио из видео...';
    onStatus(extractText);
    timer?.setStage(extractText);
    timer?.setProgress(1, estimate?.totalMs ?? null);

    const audioBuf = await decodeAudioBuffer(file);
    const audioWav = audioBufferRangeToWav(audioBuf, 0, audioBuf.length);

    const postMs  = (estimate?.transcriptionMs ?? EST_DIRECT_TRANSCRIPTION_MS) + (estimate?.summaryMs ?? EST_FINAL_SUMMARY_MS);
    const postPct = estimate ? Math.max(15, (estimate.videoExtractMs / estimate.totalMs) * 100) : 20;
    timer?.setProgress(postPct, postMs);

    if (audioWav.size <= FILE_TRANSCRIPTION_MAX) {
      const groqText = 'Отправляю аудио в Groq...';
      onStatus(groqText);
      timer?.setStage(groqText);
      return await transcribeBlob(audioWav, 'audio.wav', apiKey);
    }
    onStatus('Делю аудио на части...');
    timer?.setStage('Делю аудио на части...');
    const chunks = splitAudioBufferToWavChunks(audioBuf);
    return await transcribeChunks(chunks, apiKey, onStatus, timer, estimate);
  }

  // Large audio
  onStatus('Делю аудио на части...');
  timer?.setStage('Делю аудио на части...');
  const audioBuf = await decodeAudioBuffer(file);
  const chunks = splitAudioBufferToWavChunks(audioBuf);
  return await transcribeChunks(chunks, apiKey, onStatus, timer, estimate);
}

// ── File upload ──
const fileInput         = document.getElementById('file-input');
const fileDropArea      = document.getElementById('file-drop-area');
const fileChosenName    = document.getElementById('file-chosen-name');
const fileActions       = document.getElementById('file-actions');
const btnTranscribeFile = document.getElementById('btn-transcribe-file');
const btnCancelFile     = document.getElementById('btn-cancel-file');
const uploadStatus      = document.getElementById('upload-status');

let selectedFile = null;

function getStoredApiKey() {
  return new Promise(resolve => chrome.storage.local.get('groqApiKey', d => resolve(d.groqApiKey || '')));
}

async function buildPrompt(transcript) {
  const basePrompt = await getSummaryBasePrompt();
  return `${basePrompt}\n\nТранскрипт:\n${transcript}`;
}

// ── Safe summarization with map-reduce for long transcripts ──

const SUMMARY_MAX_INPUT_CHARS_PER_CHUNK = 7000;
const SUMMARY_REQUEST_DELAY_MS = 13000;

// ── Processing time estimate constants ──
const EST_DIRECT_TRANSCRIPTION_MS  = 45000;  // 30–60 s, single direct upload
const EST_CHUNK_TRANSCRIPTION_MS   = 67500;  // 45–90 s per audio chunk
const EST_VIDEO_EXTRACT_MS_PER_MB  = 2500;   // per MB for browser AudioContext decode
const EST_VIDEO_EXTRACT_MIN_MS     = 20000;  // minimum video decode time
const EST_SUMMARY_CHUNK_MS         = 22500;  // 15–30 s per summary chunk
const EST_FINAL_SUMMARY_MS         = 22500;  // 15–30 s for final summary

function formatRemainingTime(ms) {
  const sec = Math.max(0, Math.round(ms / 1000));
  return String(Math.floor(sec / 60)).padStart(2, '0') + ':' + String(sec % 60).padStart(2, '0');
}

function estimateTranscriptionTime(partsCount) {
  return partsCount <= 1 ? EST_DIRECT_TRANSCRIPTION_MS : partsCount * EST_CHUNK_TRANSCRIPTION_MS;
}

function estimateSummaryChunksCount(transcriptLength) {
  return Math.max(1, Math.ceil(transcriptLength / SUMMARY_MAX_INPUT_CHARS_PER_CHUNK));
}

function estimateSummaryTime(summaryChunks) {
  if (summaryChunks <= 1) return EST_SUMMARY_CHUNK_MS;
  return summaryChunks * EST_SUMMARY_CHUNK_MS
    + summaryChunks * SUMMARY_REQUEST_DELAY_MS
    + EST_FINAL_SUMMARY_MS;
}

function estimateFileProcessingTime(file) {
  const isVideo = isVideoFile(file);
  const sizeMB  = file.size / (1024 * 1024);

  if (file.size <= FILE_TRANSCRIPTION_MAX) {
    return {
      totalMs: EST_DIRECT_TRANSCRIPTION_MS + EST_SUMMARY_CHUNK_MS,
      partsCount: 1, videoExtractMs: 0,
      transcriptionMs: EST_DIRECT_TRANSCRIPTION_MS,
      summaryChunks: 1, summaryMs: EST_SUMMARY_CHUNK_MS
    };
  }

  const videoExtractMs = isVideo
    ? Math.max(EST_VIDEO_EXTRACT_MIN_MS, sizeMB * EST_VIDEO_EXTRACT_MS_PER_MB)
    : 0;

  // 1 audio chunk ≈ 12 MB of source (16 kHz mono WAV ~32 KB/s = 750 s = ~12 min;
  // typical audio at 128 kbps ≈ 1 MB/min → 12 min per 12 MB of source)
  const estimatedPartsCount = Math.max(2, Math.ceil(sizeMB / 12));
  const transcriptionMs = estimateTranscriptionTime(estimatedPartsCount);
  const summaryChunks   = estimateSummaryChunksCount(estimatedPartsCount * 10000);
  const summaryMs       = estimateSummaryTime(summaryChunks);

  return {
    totalMs: videoExtractMs + transcriptionMs + summaryMs,
    partsCount: estimatedPartsCount, videoExtractMs,
    transcriptionMs, summaryChunks, summaryMs
  };
}

// ── ProcessingTimer ──
class ProcessingTimer {
  constructor({ blockEl, stageEl, barEl, percentEl, timeEl }) {
    this._blockEl   = blockEl;
    this._stageEl   = stageEl;
    this._barEl     = barEl;
    this._percentEl = percentEl;
    this._timeEl    = timeEl;
    this._tickerId  = null;
    this._remainingMs = 0;
    this._progressPct = 0;
  }

  start(totalMs) {
    clearInterval(this._tickerId);
    this._remainingMs = Math.max(0, totalMs);
    this._progressPct = 0;
    if (this._blockEl) this._blockEl.style.display = '';
    this._render();
    this._tickerId = setInterval(() => {
      if (this._remainingMs > 1000) this._remainingMs -= 1000;
      this._render();
    }, 1000);
  }

  setStage(text) {
    if (this._stageEl) this._stageEl.textContent = text;
  }

  // pct and remainingMs are both optional
  setProgress(pct, remainingMs) {
    if (pct != null) this._progressPct = Math.min(99, Math.max(0, pct));
    if (remainingMs != null) this._remainingMs = Math.max(0, remainingMs);
    this._render();
  }

  addDelay(ms) {
    this._remainingMs += Math.max(0, ms);
    this._render();
  }

  stop() {
    clearInterval(this._tickerId);
    this._tickerId = null;
    if (this._blockEl) this._blockEl.style.display = 'none';
  }

  _render() {
    if (this._barEl)     this._barEl.style.width = this._progressPct + '%';
    if (this._percentEl) this._percentEl.textContent = Math.round(this._progressPct) + '%';
    if (this._timeEl) {
      this._timeEl.textContent = this._remainingMs <= 5000
        ? 'Осталось примерно: почти готово'
        : 'Осталось примерно: ' + formatRemainingTime(this._remainingMs);
    }
  }
}

// ── Progress timer instances (after class definition) ──
const fileProgressBlock   = document.getElementById('file-progress-block');
const fileProgressStage   = document.getElementById('file-progress-stage');
const fileProgressBar     = document.getElementById('file-progress-bar');
const fileProgressPercent = document.getElementById('file-progress-percent');
const fileProgressTime    = document.getElementById('file-progress-time');

const meetingProgressBlock   = document.getElementById('meeting-progress-block');
const meetingProgressStage   = document.getElementById('meeting-progress-stage');
const meetingProgressBar     = document.getElementById('meeting-progress-bar');
const meetingProgressPercent = document.getElementById('meeting-progress-percent');
const meetingProgressTime    = document.getElementById('meeting-progress-time');

const fileTimer = new ProcessingTimer({
  blockEl: fileProgressBlock, stageEl: fileProgressStage,
  barEl: fileProgressBar, percentEl: fileProgressPercent, timeEl: fileProgressTime
});
const meetingTimer = new ProcessingTimer({
  blockEl: meetingProgressBlock, stageEl: meetingProgressStage,
  barEl: meetingProgressBar, percentEl: meetingProgressPercent, timeEl: meetingProgressTime
});

// Parse summary status text from background.js and update meeting timer
function parseSummaryStatusForTimer(status, timer) {
  const chunkMatch = status.match(/часть (\d+) из (\d+)/);
  if (chunkMatch) {
    const current = parseInt(chunkMatch[1], 10);
    const total   = parseInt(chunkMatch[2], 10);
    const left    = total - current + 1;
    const remaining = left * EST_SUMMARY_CHUNK_MS + SUMMARY_REQUEST_DELAY_MS + EST_FINAL_SUMMARY_MS;
    timer.setStage(status);
    timer.setProgress(80 + ((current - 1) / total) * 15, remaining);
    return;
  }
  const waitMatch = status.match(/через (\d+) сек/);
  if (waitMatch) {
    timer.addDelay(parseInt(waitMatch[1], 10) * 1000);
    timer.setStage(status);
    return;
  }
  if (/итоговое/i.test(status)) {
    timer.setStage(status);
    timer.setProgress(96, EST_FINAL_SUMMARY_MS);
    return;
  }
  timer.setStage(status);
  if (/саммари/i.test(status)) timer.setProgress(80, EST_SUMMARY_CHUNK_MS);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function parseGroqRetryAfterMs(text) {
  const match = String(text || '').match(/try again in ([\d.]+)s/i);
  if (match) return Math.ceil(parseFloat(match[1]) + 2) * 1000;
  return null;
}

async function groqChatCompletionWithRateLimit(payload, apiKey, onStatus, maxRetries = 3, onRateLimit = null) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const resp = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (resp.status !== 429) return resp;
    const text = await resp.text();
    if (attempt >= maxRetries) throw new Error(`Groq rate limit exceeded: ${text}`);
    const waitMs = parseGroqRetryAfterMs(text) || 15000;
    const waitSec = Math.round(waitMs / 1000);
    if (onRateLimit) {
      onRateLimit(waitMs);
    } else if (onStatus) {
      onStatus(`Жду лимит Groq, продолжу через ${waitSec} сек...`);
    }
    await sleep(waitMs);
  }
}

function splitTextIntoChunks(text, maxChars) {
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

async function summarizeTranscript(summaryPrompt, apiKey, onStatus, onRateLimit = null) {
  const resp = await groqChatCompletionWithRateLimit({
    model: 'llama-3.1-8b-instant',
    messages: [
      { role: 'system', content: 'Ты аккуратный редактор деловых встреч. Возвращай только готовое саммари без вступлений и без упоминания промпта.' },
      { role: 'user', content: summaryPrompt }
    ],
    max_tokens: 1400,
    temperature: 0.2
  }, apiKey, onStatus, 3, onRateLimit);
  if (!resp.ok) throw new Error(`Groq summary ${resp.status}: ${await resp.text()}`);
  const data = await resp.json();
  const summary = String(data.choices?.[0]?.message?.content || '').trim();
  if (!summary) throw new Error('Groq вернул пустое саммари.');
  return summary;
}

async function summarizeChunk(chunkText, apiKey, onStatus, onRateLimit = null) {
  const resp = await groqChatCompletionWithRateLimit({
    model: 'llama-3.1-8b-instant',
    messages: [
      { role: 'system', content: 'Ты аккуратный редактор деловых встреч. Возвращай только готовое саммари без вступлений и без упоминания промпта.' },
      { role: 'user', content: `Выдели ключевые темы, решения, задачи, договорённости и важные факты только из этого фрагмента встречи. Будь краток.\n\nФрагмент:\n${chunkText}` }
    ],
    max_tokens: 600,
    temperature: 0.2
  }, apiKey, onStatus, 3, onRateLimit);
  if (!resp.ok) throw new Error(`Groq summary ${resp.status}: ${await resp.text()}`);
  const data = await resp.json();
  return String(data.choices?.[0]?.message?.content || '').trim();
}

async function summarizeFinal(partials, basePrompt, apiKey, onStatus, onRateLimit = null) {
  const combined = partials.join('\n\n---\n\n');
  const resp = await groqChatCompletionWithRateLimit({
    model: 'llama-3.1-8b-instant',
    messages: [
      { role: 'system', content: 'Ты аккуратный редактор деловых встреч. Возвращай только готовое саммари без вступлений и без упоминания промпта.' },
      { role: 'user', content: `${basePrompt}\n\nЧастичные саммари фрагментов встречи:\n${combined}` }
    ],
    max_tokens: 1400,
    temperature: 0.2
  }, apiKey, onStatus, 3, onRateLimit);
  if (!resp.ok) throw new Error(`Groq summary ${resp.status}: ${await resp.text()}`);
  const data = await resp.json();
  const summary = String(data.choices?.[0]?.message?.content || '').trim();
  if (!summary) throw new Error('Groq вернул пустое саммари.');
  return summary;
}

async function summarizeTranscriptSafe(transcript, apiKey, onStatus, timer = null) {
  const basePrompt = await getSummaryBasePrompt();

  const onRateLimit = (waitMs) => {
    const sec = Math.round(waitMs / 1000);
    const text = `Жду лимит Groq, продолжу через ${sec} сек...`;
    onStatus(text);
    timer?.setStage(text);
    timer?.addDelay(waitMs);
  };

  if (transcript.length <= SUMMARY_MAX_INPUT_CHARS_PER_CHUNK) {
    const stageText = 'Формирую саммари...';
    onStatus(stageText);
    timer?.setStage(stageText);
    timer?.setProgress(80, EST_SUMMARY_CHUNK_MS);
    const summaryPrompt = `${basePrompt}\n\nТранскрипт:\n${transcript}`;
    const summary = await summarizeTranscript(summaryPrompt, apiKey, onStatus, onRateLimit);
    return { summary, summaryPrompt };
  }

  const chunks = splitTextIntoChunks(transcript, SUMMARY_MAX_INPUT_CHARS_PER_CHUNK);
  const total = chunks.length;
  const partials = [];

  for (let i = 0; i < total; i++) {
    const stageText = `Формирую саммари: часть ${i + 1} из ${total}...`;
    onStatus(stageText);
    timer?.setStage(stageText);
    const left = total - i;
    timer?.setProgress(
      80 + (i / total) * 15,
      left * EST_SUMMARY_CHUNK_MS + left * SUMMARY_REQUEST_DELAY_MS + EST_FINAL_SUMMARY_MS
    );
    partials.push(await summarizeChunk(chunks[i], apiKey, onStatus, onRateLimit));
    if (i < total - 1) await sleep(SUMMARY_REQUEST_DELAY_MS);
  }

  await sleep(SUMMARY_REQUEST_DELAY_MS);
  const finalText = 'Формирую итоговое саммари...';
  onStatus(finalText);
  timer?.setStage(finalText);
  timer?.setProgress(96, EST_FINAL_SUMMARY_MS);

  const summary = await summarizeFinal(partials, basePrompt, apiKey, onStatus, onRateLimit);
  return {
    summary,
    summaryPrompt: `[map-reduce из ${total} фрагментов]\n\n${basePrompt}`
  };
}

function formatDateLocal(ts) {
  const d = new Date(ts);
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}`;
}

async function getMeetingsLocal() {
  return dbGetAllMeetings();
}

async function saveMeetingLocal(meeting) {
  return dbSaveMeeting(meeting);
}

async function updateMeetingTagsLocal(meetingId, tags) {
  const meeting = await dbGetMeeting(meetingId);
  if (!meeting) return false;
  await dbSaveMeeting({ ...meeting, tags });
  return true;
}

function setFileSelected(file) {
  selectedFile = file;
  fileChosenName.textContent = file.name;
  fileChosenName.style.display = 'block';
  fileActions.style.display = 'flex';
  uploadStatus.textContent = '';
  fileDropArea.querySelector('.file-drop-label').innerHTML = '<strong>Файл выбран</strong> · нажми «Транскрибировать»';
}

function resetFileUI() {
  selectedFile = null;
  fileInput.value = '';
  fileChosenName.style.display = 'none';
  fileActions.style.display = 'none';
  uploadStatus.textContent = '';
  fileDropArea.querySelector('.file-drop-label').innerHTML = 'Нажми или перетащи файл<br><strong>Аудио или видео</strong>';
}

fileDropArea.addEventListener('click', () => fileInput.click());
fileDropArea.addEventListener('dragover', (e) => { e.preventDefault(); fileDropArea.classList.add('dragover'); });
fileDropArea.addEventListener('dragleave', () => fileDropArea.classList.remove('dragover'));
fileDropArea.addEventListener('drop', (e) => {
  e.preventDefault();
  fileDropArea.classList.remove('dragover');
  if (e.dataTransfer.files[0]) setFileSelected(e.dataTransfer.files[0]);
});
fileInput.addEventListener('change', () => { if (fileInput.files[0]) setFileSelected(fileInput.files[0]); });
btnCancelFile.addEventListener('click', resetFileUI);

btnTranscribeFile.addEventListener('click', async () => {
  if (!selectedFile) return;
  const apiKey = await getStoredApiKey();
  if (!apiKey) { uploadStatus.textContent = '❌ Groq API ключ не настроен.'; return; }

  const estimate = estimateFileProcessingTime(selectedFile);
  fileTimer.start(estimate.totalMs);
  fileTimer.setStage('Проверяю файл...');

  btnTranscribeFile.disabled = true;
  btnCancelFile.disabled = true;
  setStatus('Обработка', 'processing');
  currentTranscript = '';
  currentSummary = '';
  currentSummaryPrompt = '';
  currentSummaryError = '';
  currentMeetingId = null;
  setFileResultOutput('⏳ Транскрибирую файл...', '⏳ Готовлю саммари...', { isEmpty: true });

  try {
    const transcript = await processFileForTranscription(
      selectedFile, apiKey,
      (status) => { uploadStatus.textContent = '⏳ ' + status; },
      fileTimer, estimate
    );

    // After transcription: recalculate summary estimate from actual transcript length
    const actualSummaryChunks = estimateSummaryChunksCount(transcript.length);
    const actualSummaryMs     = estimateSummaryTime(actualSummaryChunks);
    fileTimer.setProgress(78, actualSummaryMs);

    let summary = '';
    let summaryError = '';
    let summaryPrompt = '';
    try {
      const result = await summarizeTranscriptSafe(
        transcript, apiKey,
        (status) => { uploadStatus.textContent = '⏳ ' + status; },
        fileTimer
      );
      summary = result.summary;
      summaryPrompt = result.summaryPrompt;
    } catch (e) {
      summaryError = e.message || 'Не удалось сгенерировать саммари.';
      console.error('[ECHO/summarizeFile]', e.message, e);
    }

    const title = await generateMeetingTitle(transcript, apiKey).catch(() => fallbackMeetingTitle(transcript));
    const meetingId = Date.now();
    currentTranscript = transcript;
    currentSummary = summary;
    currentSummaryPrompt = summaryPrompt;
    currentSummaryError = summaryError;
    currentMeetingId = meetingId;
    summaryCard.style.display = '';
    transcriptCard.style.display = '';
    transcriptEl.textContent = transcript;
    transcriptEl.className = '';
    setSummaryOutput(summary, { isEmpty: !summary, error: summaryError, preview: true, showFull: !!summary });
    setFileResultOutput(transcript, summary, { isEmpty: !summary, error: summaryError, preview: true, showFull: !!summary });
    setStatus('Готово', 'done');

    await saveMeetingLocal({
      id: meetingId,
      date: formatDateLocal(meetingId),
      dateDisplay: new Date(meetingId).toLocaleString('ru') + ' · ' + selectedFile.name,
      title,
      chunks: [],
      transcript,
      prompt: summaryPrompt,
      summary,
      summaryPrompt,
      summaryError,
      tags: [],
      status: MEETING_STATUS.DONE,
      lastError: '',
      createdAt: meetingId,
      updatedAt: meetingId
    });
    renderHistory();

    fileTimer.stop();
    resetFileUI();
    uploadStatus.textContent = '✅ Готово. Сохранено в историю.';
  } catch (e) {
    fileTimer.stop();
    console.error('[ECHO/transcribeFile]', e.message, e);
    uploadStatus.textContent = '❌ ' + e.message;
    setStatus('Ошибка', '');
    setSummaryOutput('❌ ' + e.message, { isEmpty: true });
    setFileResultOutput('❌ ' + e.message, '❌ ' + e.message, { isEmpty: true });
  } finally {
    btnTranscribeFile.disabled = false;
    btnCancelFile.disabled = false;
  }
});

// ── History export / import ──
function setImportStatus(text) {
  historyViews.forEach(view => {
    if (view.importStatus) view.importStatus.textContent = text;
  });
}

function clearImportStatusSoon() {
  setTimeout(() => setImportStatus(''), 3000);
}

async function exportHistory() {
  try {
    const meetings = await getMeetingsLocal();
    if (meetings.length === 0) {
      setImportStatus('Нечего экспортировать — история пуста.');
      clearImportStatusSoon();
      return;
    }
    const exportData = meetings.map(({ id, date, dateDisplay, title, transcript, prompt, summary, summaryPrompt, summaryError, tags, status, lastError, createdAt, updatedAt }) =>
      ({ id, date, dateDisplay, title: sanitizeMeetingTitle(title) || getMeetingTitle({ id, date, dateDisplay, title, transcript, prompt, summary, summaryPrompt, summaryError, tags }), transcript, prompt: summaryPrompt || prompt || '', summary: summary || '', summaryPrompt: summaryPrompt || prompt || '', summaryError: summaryError || '', tags: tags || [], status: status || MEETING_STATUS.DONE, lastError: lastError || '', createdAt: createdAt || id, updatedAt: updatedAt || id })
    );
    const url = 'data:application/json;charset=utf-8,' + encodeURIComponent(JSON.stringify(exportData, null, 2));
    const a = document.createElement('a');
    a.href = url;
    a.download = `telemost-history-${formatDateLocal(Date.now())}.json`;
    a.click();
    setImportStatus(`✅ Экспортировано ${meetings.length} встреч`);
    clearImportStatusSoon();
  } catch (e) {
    console.error('[ECHO/exportHistory]', e.message, e);
    setImportStatus('❌ Не удалось экспортировать историю');
    clearImportStatusSoon();
  }
}

async function importHistoryFromInput(importInput) {
  const file = importInput.files[0];
  if (!file) return;
  importInput.value = '';
  let meetings;
  try {
    meetings = JSON.parse(await file.text());
    if (!Array.isArray(meetings)) throw new Error();
  } catch (e) {
    console.error('[ECHO/importHistory] failed to parse file:', e.message, e);
    setImportStatus('❌ Не удалось прочитать файл');
    clearImportStatusSoon();
    return;
  }
  setImportStatus(`⏳ Импортирую ${meetings.length} встреч...`);
  let saved = 0;
  for (const m of meetings) {
    if (!m.id || !m.transcript) continue;
    await saveMeetingLocal({ ...m, chunks: m.chunks || [], tags: m.tags || [], title: sanitizeMeetingTitle(m.title) || fallbackMeetingTitle(m.transcript), prompt: m.summaryPrompt || m.prompt || '', summary: m.summary || '', summaryPrompt: m.summaryPrompt || m.prompt || '', summaryError: m.summaryError || '', status: m.status || MEETING_STATUS.DONE, lastError: m.lastError || '', createdAt: m.createdAt || m.id, updatedAt: m.updatedAt || m.id });
    saved++;
  }
  setImportStatus(`✅ Импортировано ${saved} встреч`);
  clearImportStatusSoon();
  renderHistory();
}

historyViews.forEach(view => {
  view.exportBtn?.addEventListener('click', exportHistory);
  view.importBtn?.addEventListener('click', () => view.importInput?.click());
  view.importInput?.addEventListener('change', () => importHistoryFromInput(view.importInput));
});

// ── Tag colors ──
const TAG_COLORS = ['#d62d20','#2196F3','#4CAF50','#FF9800','#9C27B0','#00BCD4','#E91E63','#795548'];
function tagColor(name) {
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) & 0xFFFF;
  return TAG_COLORS[h % TAG_COLORS.length];
}

// ── Preset tag management (Tags tab) ──
const newTagInput     = document.getElementById('new-tag-input');
const btnAddTag       = document.getElementById('btn-add-tag');
const presetTagsList  = document.getElementById('preset-tags-list');

function getPresetTags() {
  return new Promise(resolve => chrome.storage.local.get('presetTags', d => resolve(d.presetTags || [])));
}
function savePresetTags(tags) {
  return new Promise(resolve => chrome.storage.local.set({ presetTags: tags }, resolve));
}

async function renderPresetTags() {
  const tags = await getPresetTags();
  if (tags.length === 0) {
    presetTagsList.innerHTML = '<div class="tags-empty">Нет тегов. Добавь первый!</div>';
    return;
  }
  presetTagsList.innerHTML = tags.map(t => {
    const color = tagColor(t.name);
    return `<span class="tag-mgmt-pill" style="background:${color}18; color:${color}; border-color:${color}40;">
      ${escapeHtml(t.name)}
      <button class="tag-mgmt-delete" data-id="${t.id}" title="Удалить">×</button>
    </span>`;
  }).join('');

  presetTagsList.querySelectorAll('.tag-mgmt-delete').forEach(btn => {
    btn.addEventListener('click', async () => {
      const tags = await getPresetTags();
      await savePresetTags(tags.filter(t => t.id !== btn.dataset.id));
      renderPresetTags();
      renderTagFilter();
      renderHistory();
    });
  });
}

btnAddTag.addEventListener('click', async () => {
  const name = newTagInput.value.trim();
  if (!name) return;
  const tags = await getPresetTags();
  if (tags.some(t => t.name.toLowerCase() === name.toLowerCase())) {
    newTagInput.value = '';
    return;
  }
  await savePresetTags([...tags, { id: Date.now().toString(), name }]);
  newTagInput.value = '';
  renderPresetTags();
  renderTagFilter();
  renderHistory();
});
newTagInput.addEventListener('keydown', e => { if (e.key === 'Enter') btnAddTag.click(); });

// ── Tag filter above history ──
let activeTagFilter = null;
let historyQuery = '';

async function renderTagFilter() {
  const tags = await getPresetTags();
  const hadInvalidActiveFilter = !!activeTagFilter && !tags.some(t => t.name === activeTagFilter);
  const options = ['<option value="">Все теги</option>'];
  for (const tag of tags) {
    const selected = activeTagFilter === tag.name ? ' selected' : '';
    options.push(`<option value="${escapeAttr(tag.name)}"${selected}>${escapeHtml(tag.name)}</option>`);
  }
  if (hadInvalidActiveFilter) activeTagFilter = null;
  historyViews.forEach(view => {
    view.tagFilter.innerHTML = options.join('');
    view.tagFilter.value = activeTagFilter || '';
  });
  if (hadInvalidActiveFilter) renderHistory();
}

// ── History ──
const HISTORY_COLLAPSED_LIMIT = 7;
let allMeetings = [];
let openPickerId = null;

historyViews.forEach(view => {
  view.tagFilter.addEventListener('change', () => {
    activeTagFilter = view.tagFilter.value || null;
    historyViews.forEach(other => {
      if (other !== view) other.tagFilter.value = activeTagFilter || '';
    });
    renderHistory();
  });

  view.search.addEventListener('input', () => {
    historyQuery = view.search.value.toLowerCase().trim();
    historyViews.forEach(other => {
      if (other !== view) other.search.value = view.search.value;
    });
    renderHistory();
  });

  view.toggleBtn?.addEventListener('click', () => {
    view.expanded = !view.expanded;
    renderHistory();
  });
});

function filterMeetings(meetings, query, tagFilter) {
  return meetings.filter(m => {
    const tagNames = (m.tags || []).map(tag => tag.toLowerCase());
    const matchesTag = !tagFilter || (m.tags || []).includes(tagFilter);
    const matchesQuery = !query ||
      getMeetingTitle(m).toLowerCase().includes(query) ||
      (m.transcript || '').toLowerCase().includes(query) ||
      (m.summary || '').toLowerCase().includes(query) ||
      (m.summaryPrompt || m.prompt || '').toLowerCase().includes(query) ||
      (m.summaryError || '').toLowerCase().includes(query) ||
      (m.dateDisplay || m.date || '').toLowerCase().includes(query) ||
      tagNames.some(tag => tag.includes(query));
    return matchesTag && matchesQuery;
  });
}

function getMeetingStatusClass(status) {
  switch (status) {
    case MEETING_STATUS.RECORDING:
      return 'meeting-status meeting-status--recording';
    case MEETING_STATUS.RECORDED:
      return 'meeting-status meeting-status--recorded';
    case MEETING_STATUS.TRANSCRIBING:
      return 'meeting-status meeting-status--transcribing';
    case MEETING_STATUS.DONE:
      return 'meeting-status meeting-status--done';
    case MEETING_STATUS.ERROR:
      return 'meeting-status meeting-status--error';
    default:
      return 'meeting-status meeting-status--recorded';
  }
}

function meetingStatusHtml(status) {
  if (!status) return '';
  return `<span class="${getMeetingStatusClass(status)}">${escapeHtml(status)}</span>`;
}

function isPendingMeeting(meeting) {
  return Array.isArray(meeting.chunks) &&
    meeting.chunks.length > 0 &&
    [MEETING_STATUS.RECORDED, MEETING_STATUS.TRANSCRIBING, MEETING_STATUS.ERROR].includes(meeting.status);
}

function renderPendingRecordings(meetings) {
  const pendingMeetings = meetings.filter(isPendingMeeting);
  if (pendingMeetings.length === 0) {
    pendingRecordingsCard.style.display = 'none';
    pendingRecordingsList.innerHTML = '';
    return;
  }

  pendingRecordingsCard.style.display = '';
  pendingRecordingsList.innerHTML = pendingMeetings.map(meeting => {
    const chunkCount = Array.isArray(meeting.chunks) ? meeting.chunks.length : 0;
    const isError = meeting.status === MEETING_STATUS.ERROR;
    const note = meeting.status === MEETING_STATUS.ERROR
      ? (meeting.lastError || 'Транскрибация остановилась с ошибкой')
      : `Сохранено чанков: ${chunkCount}`;
    const actionLabel = isError ? 'Повторить' : 'Продолжить';
    return `
      <li>
        <div class="pending-info">
          <div class="pending-date">${escapeHtml(meeting.dateDisplay || meeting.date || '')}</div>
          <div class="pending-meta">
            ${meetingStatusHtml(meeting.status)}
            <span class="pending-note">${escapeHtml(note)}</span>
          </div>
        </div>
        <button class="pending-action${isError ? ' pending-action--error' : ''}" data-id="${escapeAttr(meeting.id)}">${actionLabel}</button>
      </li>`;
  }).join('');

  pendingRecordingsList.querySelectorAll('.pending-action').forEach(btn => {
    btn.addEventListener('click', () => {
      btn.disabled = true;
      btn.textContent = '⏳';
      chrome.runtime.sendMessage({ action: 'retranscribe', meetingId: parseMeetingId(btn.dataset.id) });
    });
  });
}

function tagPillHtml(name) {
  const color = tagColor(name);
  return `<span class="tag-pill" style="background:${color}18; color:${color}; border:1px solid ${color}40;">${escapeHtml(name)}</span>`;
}

function renderMeetingList(view, meetings) {
  if (meetings.length === 0) {
    const msg = (historyQuery || activeTagFilter) ? 'Ничего не найдено' : 'Пока нет записей';
    view.list.innerHTML = `<li class="empty" style="display:block; padding:8px 0;">${msg}</li>`;
    if (view.toggleBtn) view.toggleBtn.style.display = 'none';
    return;
  }

  const hasHiddenItems = meetings.length > HISTORY_COLLAPSED_LIMIT;
  const visibleMeetings = view.expanded ? meetings : meetings.slice(0, HISTORY_COLLAPSED_LIMIT);
  if (view.toggleBtn) {
    view.toggleBtn.style.display = hasHiddenItems ? 'block' : 'none';
    view.toggleBtn.textContent = view.expanded
      ? `Свернуть до ${HISTORY_COLLAPSED_LIMIT} последних`
      : `Показать всю историю (${meetings.length})`;
  }

  view.list.innerHTML = groupMeetingsByDay(visibleMeetings).map(group => {
    const itemsHtml = group.meetings.map(m => {
      const tags = m.tags || [];
      const tagsHtml = tags.map(t => tagPillHtml(t)).join('');
      const summaryData = normalizeMeetingSummary(m);
      const previewSource = summaryData.summary || m.transcript || summaryData.summaryError || '';
      const previewText = escapeHtml(previewSource.slice(0, 60));
      const displayDate = escapeHtml(m.dateDisplay || m.date || '');
      const title = escapeHtml(getMeetingTitle(m));
      const isErrorMeeting = m.status === MEETING_STATUS.ERROR;
      const retranscribeBtn = m.chunks && m.chunks.length > 0
        ? `<button class="btn-retranscribe${isErrorMeeting ? ' btn-retranscribe--error' : ''}" data-id="${escapeAttr(m.id)}">${isErrorMeeting ? 'Повторить' : '↻'}</button>`
        : '';
      const pickerKey = `${view.id}:${m.id}`;

      // Asset badges
      const hasAudio          = Array.isArray(m.chunks) && m.chunks.length > 0;
      const hasVideo          = Array.isArray(m.videoChunks) && m.videoChunks.length > 0;
      const videoErr          = m.videoError || '';
      const driveStatus       = m.driveUploadStatus || '';
      const driveDone         = driveStatus === 'done' && m.driveFolderUrl;
      const driveErr          = driveStatus === 'error';
      const driveUploading    = driveStatus === 'uploading';
      const drivePending      = m.saveDestination === 'google_drive' && driveStatus === 'pending';
      const driveBadge = driveDone
        ? `<a class="hi-badge hi-badge--drive-ok" href="${escapeAttr(m.driveFolderUrl)}" target="_blank" title="Открыть папку на Google Drive">Drive ↗</a>`
        : driveErr
          ? '<span class="hi-badge hi-badge--drive-err">Drive: ошибка</span>'
          : driveUploading
            ? '<span class="hi-badge hi-badge--drive">Drive ⏳</span>'
            : drivePending
              ? '<span class="hi-badge hi-badge--drive-pending">Drive: ожидает</span>'
              : '';
      const retryDriveBtn = driveErr
        ? `<button class="btn-retry-drive" data-id="${escapeAttr(m.id)}" title="${escapeAttr(m.driveUploadError || '')}">↻ Drive</button>`
        : '';
      const badgesHtml = [
        hasAudio ? '<span class="hi-badge hi-badge--audio">аудио</span>' : '',
        hasVideo ? '<span class="hi-badge hi-badge--video">видео</span>' : '',
        (!hasVideo && videoErr) ? '<span class="hi-badge hi-badge--video-err">видео: ошибка</span>' : '',
        driveBadge,
        retryDriveBtn
      ].filter(Boolean).join('');

      return `
        <li data-id="${escapeAttr(m.id)}">
          <div class="hi-main-row">
            <div class="history-info" data-id="${escapeAttr(m.id)}">
              <div class="hi-title">${title}</div>
              <div class="hi-head">
                <div class="hi-date">${displayDate}</div>
                ${meetingStatusHtml(m.status)}
              </div>
              <div class="hi-tags-row">
                ${tagsHtml}
                <button class="btn-tag-toggle${openPickerId === pickerKey ? ' open' : ''}" data-id="${escapeAttr(m.id)}" data-view="${escapeAttr(view.id)}" title="Изменить теги">+ тег</button>
              </div>
              ${badgesHtml ? `<div class="hi-asset-badges">${badgesHtml}</div>` : ''}
              <div class="hi-preview">${previewText}${previewText ? '...' : ''}</div>
            </div>
            <div class="hi-actions">
              ${retranscribeBtn}
              <button class="btn-delete-meeting" data-id="${escapeAttr(m.id)}" title="Удалить встречу">×</button>
            </div>
          </div>
          <div class="tag-picker" id="tag-picker-${escapeAttr(view.id)}-${escapeAttr(m.id)}" style="display:${openPickerId === pickerKey ? 'block' : 'none'};"></div>
        </li>`;
    }).join('');

    return `
      <div class="history-day-group">
        <div class="history-day-title">${escapeHtml(group.dayLabel)}</div>
        <ul class="history-day-list">
          ${itemsHtml}
        </ul>
      </div>`;
  }).join('');

  // Click to load meeting
  view.list.querySelectorAll('.history-info').forEach(el => {
    el.addEventListener('click', (e) => {
      if (e.target.closest('.btn-tag-toggle')) return;
      const m = allMeetings.find(x => x.id == el.dataset.id);
      if (!m) return;
      enterHistoryTranscriptView(m);
    });
  });

  // Retranscribe
  view.list.querySelectorAll('.btn-retranscribe').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      btn.disabled = true;
      btn.textContent = '⏳';
      chrome.runtime.sendMessage({ action: 'retranscribe', meetingId: parseMeetingId(btn.dataset.id) });
    });
  });

  // Delete meeting
  view.list.querySelectorAll('.btn-delete-meeting').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (btn.dataset.confirming) {
        clearTimeout(btn._resetTimeout);
        const id = parseMeetingId(btn.dataset.id);
        if (viewingHistoryTranscript) exitHistoryTranscriptView();
        await dbDeleteMeeting(id);
        renderHistory();
      } else {
        btn.dataset.confirming = '1';
        btn.textContent = 'Удалить?';
        btn.classList.add('confirming');
        btn._resetTimeout = setTimeout(() => {
          delete btn.dataset.confirming;
          btn.textContent = '×';
          btn.classList.remove('confirming');
        }, 3000);
      }
    });
  });

  // Tag toggle
  view.list.querySelectorAll('.btn-tag-toggle').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const id = btn.dataset.id;
      const pickerKey = `${btn.dataset.view}:${id}`;
      if (openPickerId === pickerKey) {
        openPickerId = null;
        renderHistory();
      } else {
        openPickerId = pickerKey;
        renderHistory();
        const m = allMeetings.find(x => x.id == id);
        openTagPicker(btn.dataset.view, id, m ? (m.tags || []) : []);
      }
    });
  });

  // Retry Drive upload
  view.list.querySelectorAll('.btn-retry-drive').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      btn.disabled = true;
      btn.textContent = '⏳';
      const id = parseMeetingId(btn.dataset.id);
      chrome.runtime.sendMessage({ action: 'retryDriveUpload', meetingId: id }, (resp) => {
        if (chrome.runtime.lastError || !resp || !resp.ok) {
          btn.disabled = false;
          btn.textContent = '↻ Drive';
        }
      });
    });
  });

  // Re-open picker if needed
  if (openPickerId) {
    const [viewId, meetingId] = openPickerId.split(':');
    if (viewId === view.id) {
      const m = allMeetings.find(x => x.id == meetingId);
      if (m) openTagPicker(viewId, meetingId, m.tags || []);
    }
  }
}

async function openTagPicker(viewId, meetingId, currentTags) {
  const picker = document.getElementById(`tag-picker-${viewId}-${meetingId}`);
  if (!picker) return;

  const presetTags = await getPresetTags();
  const selected = [...currentTags];

  function countHtml() {
    return `${selected.length}/3`;
  }

  function rebuildSelected() {
    picker.querySelector('.tag-count').textContent = countHtml();
    // update checkbox labels
    picker.querySelectorAll('.tag-check-label').forEach(label => {
      const val = label.querySelector('input').value;
      const isSelected = selected.includes(val);
      const color = tagColor(val);
      label.style.background = isSelected ? `${color}20` : 'transparent';
      label.style.borderColor = isSelected ? color : `${color}50`;
      label.style.color = color;
      label.querySelector('input').checked = isSelected;
    });
  }

  picker.innerHTML = `
    <div class="tag-picker-presets">
      ${presetTags.length === 0
        ? '<span style="font-size:11px;color:#bbb;">Нет предустановленных тегов</span>'
        : presetTags.map(t => {
            const color = tagColor(t.name);
            const isSel = selected.includes(t.name);
            return `<label class="tag-check-label" style="background:${isSel ? color+'20' : 'transparent'}; border-color:${isSel ? color : color+'50'}; color:${color};">
              <input type="checkbox" value="${escapeAttr(t.name)}" ${isSel ? 'checked' : ''}>
              ${escapeHtml(t.name)}
            </label>`;
          }).join('')
      }
    </div>
    <div class="tag-picker-one-time">
      <input class="tag-one-time-input" placeholder="Уникальный тег для этой встречи..." maxlength="30">
      <button class="btn-add-one-time">+</button>
    </div>
    <div class="tag-picker-footer">
      <span class="tag-count">${countHtml()}</span>
      <button class="btn-clear-tags">Очистить</button>
      <button class="btn-save-tags">Сохранить</button>
    </div>
  `;

  picker.querySelectorAll('.tag-check-label').forEach(label => {
    label.addEventListener('click', (e) => {
      e.preventDefault();
      const input = label.querySelector('input');
      const val = input.value;
      if (selected.includes(val)) {
        selected.splice(selected.indexOf(val), 1);
      } else {
        if (selected.length >= 3) return;
        selected.push(val);
      }
      rebuildSelected();
    });
  });

  const oneTimeInput = picker.querySelector('.tag-one-time-input');
  picker.querySelector('.btn-add-one-time').addEventListener('click', () => {
    const name = oneTimeInput.value.trim();
    if (!name || selected.length >= 3 || selected.includes(name)) return;
    selected.push(name);
    oneTimeInput.value = '';
    rebuildSelected();
    // Show the added one-time tag as a pill in presets area
    const presetsEl = picker.querySelector('.tag-picker-presets');
    const color = tagColor(name);
    const span = document.createElement('label');
    span.className = 'tag-check-label';
    span.style.background = `${color}20`;
    span.style.borderColor = color;
    span.style.color = color;
    span.innerHTML = `<input type="checkbox" value="${escapeAttr(name)}" checked> ${escapeHtml(name)} <em style="font-size:9px;opacity:0.6">(разово)</em>`;
    span.querySelector('input').addEventListener('change', () => {
      const idx = selected.indexOf(name);
      if (idx > -1) selected.splice(idx, 1);
      span.remove();
      rebuildSelected();
    });
    presetsEl.appendChild(span);
  });
  oneTimeInput.addEventListener('keydown', e => {
    if (e.key === 'Enter') picker.querySelector('.btn-add-one-time').click();
  });

  picker.querySelector('.btn-clear-tags').addEventListener('click', () => {
    selected.splice(0, selected.length);
    picker.querySelectorAll('.tag-check-label em').forEach(el => el.closest('.tag-check-label')?.remove());
    rebuildSelected();
  });

  picker.querySelector('.btn-save-tags').addEventListener('click', async () => {
    await updateMeetingTagsLocal(parseMeetingId(meetingId), selected);
    openPickerId = null;
    renderHistory();
  });
}

async function renderHistory() {
  try {
    allMeetings = await getMeetingsLocal();
    renderPendingRecordings(allMeetings);
    const filteredMeetings = filterMeetings(allMeetings, historyQuery, activeTagFilter);
    historyViews.forEach(view => renderMeetingList(view, filteredMeetings));
  } catch (e) {
    console.error('[ECHO/renderHistory]', e.message, e);
    pendingRecordingsCard.style.display = 'none';
    historyViews.forEach(view => {
      view.list.innerHTML = '<li class="empty" style="display:block; padding:8px 0;">Не удалось загрузить историю</li>';
    });
  }
}
