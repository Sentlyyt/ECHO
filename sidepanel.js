// sidepanel.js

let recording = false;
let timerInterval = null;
let seconds = 0;
let currentTranscript = '';
let currentPrompt = '';
let viewingHistoryTranscript = false;

const DEFAULT_TRANSCRIPT_PLACEHOLDER = 'Появится после остановки записи...';
const DEFAULT_SUMMARY_PLACEHOLDER = 'Появится вместе с транскриптом...';
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
const transcriptEl      = document.getElementById('transcript-text');
const summaryEl         = document.getElementById('summary-text');
const btnBackFromHistory = document.getElementById('btn-back-from-history');
const pendingRecordingsCard = document.getElementById('pending-recordings-card');
const pendingRecordingsList = document.getElementById('pending-recordings-list');
const historyList       = document.getElementById('history-list');
const copiedToast       = document.getElementById('copied-toast');

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
  renderTagFilter();
  renderHistory();
  syncRecordingState();
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

// ── Settings panel ──
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
    if (tab === 'tags') renderPresetTags();
  });
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

function setPromptOutput(text, isEmpty = false) {
  summaryEl.textContent = text;
  summaryEl.className = isEmpty ? 'empty' : '';
}

function applyRecordingState(state = {}) {
  const active = !!state.recording;
  const startedAt = state.startedAt || null;

  recording = active;
  btnRecord.disabled = false;
  if (active) {
    hideHistoryTranscriptView();
    btnRecord.textContent = '⏹ Остановить';
    btnRecord.className = 'btn-secondary';
    recDot.style.display = 'inline-block';
    recDot.classList.add('active');
    setStatus('Запись', 'recording');
    const elapsed = startedAt ? Math.floor((Date.now() - startedAt) / 1000) : 0;
    startTimerFrom(elapsed);
    transcriptCard.style.display = '';
    currentTranscript = '';
    currentPrompt = '';
    transcriptEl.textContent = 'Запись идёт...';
    transcriptEl.className = 'empty';
    setPromptOutput(DEFAULT_SUMMARY_PLACEHOLDER, true);
  } else {
    btnRecord.textContent = '⏺ Начать запись';
    btnRecord.className = 'btn-primary';
    recDot.classList.remove('active');
    recDot.style.display = 'none';
    stopTimer();
    if (statusBadge.textContent === 'Запись') {
      setStatus('Ожидание', '');
    }
    if (!viewingHistoryTranscript && transcriptEl.textContent === 'Запись идёт...' && !currentTranscript && !currentPrompt) {
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
  currentPrompt = '';
  transcriptCard.style.display = 'none';
  transcriptEl.textContent = DEFAULT_TRANSCRIPT_PLACEHOLDER;
  transcriptEl.className = 'empty';
  setPromptOutput(DEFAULT_SUMMARY_PLACEHOLDER, true);
}

function hideHistoryTranscriptView() {
  viewingHistoryTranscript = false;
  transcriptCard.style.display = 'none';
  btnBackFromHistory.style.display = 'none';
}

function enterHistoryTranscriptView(meeting) {
  viewingHistoryTranscript = true;
  transcriptCard.style.display = '';
  btnBackFromHistory.style.display = 'inline-flex';
  currentTranscript = meeting.transcript || '';
  currentPrompt = meeting.prompt || '';
  transcriptEl.textContent = currentTranscript || DEFAULT_TRANSCRIPT_PLACEHOLDER;
  transcriptEl.className = currentTranscript ? '' : 'empty';
  summaryEl.textContent = currentPrompt || DEFAULT_SUMMARY_PLACEHOLDER;
  summaryEl.className = currentPrompt ? '' : 'empty';
  setStatus('Из истории', 'done');
}

function exitHistoryTranscriptView() {
  hideHistoryTranscriptView();
  resetTranscriptView();
  setStatus('Ожидание', '');
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
        currentPrompt = '';
        setPromptOutput(resp && resp.message
          ? resp.message
          : 'Запись нужно запускать кликом по иконке ECHO на активной вкладке Телемоста.');
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
  if (currentPrompt) copyText(currentPrompt);
});
btnBackFromHistory.addEventListener('click', () => {
  if (viewingHistoryTranscript) exitHistoryTranscriptView();
});

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
    transcriptCard.style.display = '';
    transcriptEl.textContent = '⏳ Транскрибирую...';
    transcriptEl.className = 'empty';
    setPromptOutput('⏳ Формирую транскрипт и промпт...', true);
  }

  if (msg.action === 'chunkProgress') {
    hideHistoryTranscriptView();
    transcriptCard.style.display = '';
    const total = msg.total === '?' ? '' : ` из ${msg.total}`;
    transcriptEl.textContent = `⏳ Транскрибирую часть ${msg.current}${total}...`;
    transcriptEl.className = 'empty';
    setPromptOutput(`⏳ Обрабатываю часть ${msg.current}${total}...`, true);
  }

  if (msg.action === 'recordingDiscarded') {
    hideHistoryTranscriptView();
    applyRecordingState({ recording: false });
    resetTranscriptView();
    transcriptCard.style.display = '';
    transcriptEl.textContent = 'Короткая запись удалена.';
    transcriptEl.className = 'empty';
    setStatus('Удалено', '');
    setPromptOutput('Короткая запись удалена.', true);
    renderHistory();
  }

  if (msg.action === 'retranscribing') {
    hideHistoryTranscriptView();
    setStatus('Обработка', 'processing');
    transcriptCard.style.display = '';
    transcriptEl.textContent = '⏳ Повторная транскрипция...';
    transcriptEl.className = 'empty';
    setPromptOutput('⏳ Повторно формирую транскрипт и промпт...', true);
  }

  if (msg.action === 'transcriptReady') {
    hideHistoryTranscriptView();
    applyRecordingState({ recording: false });
    transcriptCard.style.display = '';
    currentTranscript = msg.transcript || '';
    currentPrompt = msg.prompt || '';
    setStatus('Готово', 'done');
    transcriptEl.textContent = currentTranscript;
    transcriptEl.className = '';
    summaryEl.textContent = currentPrompt;
    summaryEl.className = '';
    renderHistory();
  }

  if (msg.action === 'error') {
    hideHistoryTranscriptView();
    applyRecordingState({ recording: false });
    setStatus('Ошибка', '');
    currentTranscript = '';
    currentPrompt = '';
    transcriptCard.style.display = '';
    setPromptOutput('❌ ' + msg.error);
  }
});

window.addEventListener('focus', syncRecordingState);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) syncRecordingState();
});

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

function buildPrompt(transcript) {
  return `Вот транскрипт записи встречи. Сделай:\n1. Краткое общее саммари созвона\n2. Определение ключевых задач и областей ответственности сторон\n3. Важные поинты, которые можно и нужно внести в задачи и использовать в дальнейшей проработке — все согласованные моменты\n\nТранскрипт:\n${transcript}`;
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
  fileDropArea.querySelector('.file-drop-label').innerHTML = 'Нажми или перетащи файл<br><strong>Аудио или видео</strong> · до 25 МБ';
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
  if (selectedFile.size > 25 * 1024 * 1024) {
    uploadStatus.textContent = '❌ Файл слишком большой. Максимум 25 МБ для Groq Whisper.';
    return;
  }
  const apiKey = await getStoredApiKey();
  if (!apiKey) { uploadStatus.textContent = '❌ Groq API ключ не настроен.'; return; }

  btnTranscribeFile.disabled = true;
  btnCancelFile.disabled = true;
  uploadStatus.textContent = '⏳ Отправляю в Groq...';
  setStatus('Обработка', 'processing');
  currentTranscript = '';
  currentPrompt = '';
  setPromptOutput('⏳ Формирую транскрипт и промпт...', true);

  try {
    const formData = new FormData();
    formData.append('file', selectedFile, selectedFile.name);
    formData.append('model', 'whisper-large-v3');
    formData.append('language', 'ru');
    formData.append('response_format', 'text');

    const resp = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: formData
    });
    if (!resp.ok) throw new Error(`Groq ${resp.status}: ${await resp.text()}`);

    const transcript = await resp.text();
    const prompt = buildPrompt(transcript);
    const title = await generateMeetingTitle(transcript, apiKey).catch(() => fallbackMeetingTitle(transcript));
    currentTranscript = transcript;
    currentPrompt = prompt;
    transcriptEl.textContent = transcript;
    transcriptEl.className = '';
    summaryEl.textContent = prompt;
    summaryEl.className = '';
    setStatus('Готово', 'done');

    const meetingId = Date.now();
    await saveMeetingLocal({
      id: meetingId,
      date: formatDateLocal(meetingId),
      dateDisplay: new Date(meetingId).toLocaleString('ru') + ' · ' + selectedFile.name,
      title,
      chunks: [],
      transcript,
      prompt,
      tags: [],
      status: MEETING_STATUS.DONE,
      lastError: '',
      createdAt: meetingId,
      updatedAt: meetingId
    });
    renderHistory();

    resetFileUI();
    uploadStatus.textContent = '✅ Сохранено в историю';
  } catch (e) {
    console.error('[ECHO/transcribeFile]', e.message, e);
    uploadStatus.textContent = '❌ ' + e.message;
    setStatus('Ошибка', '');
    setPromptOutput('❌ ' + e.message);
  } finally {
    btnTranscribeFile.disabled = false;
    btnCancelFile.disabled = false;
  }
});

// ── History export / import ──
const btnExportHistory = document.getElementById('btn-export-history');
const btnImportHistory = document.getElementById('btn-import-history');
const importFileInput  = document.getElementById('import-file-input');
const importStatus     = document.getElementById('import-status');

btnExportHistory.addEventListener('click', async () => {
  try {
    const meetings = await getMeetingsLocal();
    if (meetings.length === 0) {
      importStatus.textContent = 'Нечего экспортировать — история пуста.';
      setTimeout(() => { importStatus.textContent = ''; }, 3000);
      return;
    }
    const exportData = meetings.map(({ id, date, dateDisplay, title, transcript, prompt, tags, status, lastError, createdAt, updatedAt }) =>
      ({ id, date, dateDisplay, title: sanitizeMeetingTitle(title) || getMeetingTitle({ id, date, dateDisplay, title, transcript, prompt, tags }), transcript, prompt, tags: tags || [], status: status || MEETING_STATUS.DONE, lastError: lastError || '', createdAt: createdAt || id, updatedAt: updatedAt || id })
    );
    const url = 'data:application/json;charset=utf-8,' + encodeURIComponent(JSON.stringify(exportData, null, 2));
    const a = document.createElement('a');
    a.href = url;
    a.download = `telemost-history-${formatDateLocal(Date.now())}.json`;
    a.click();
    importStatus.textContent = `✅ Экспортировано ${meetings.length} встреч`;
    setTimeout(() => { importStatus.textContent = ''; }, 3000);
  } catch (e) {
    console.error('[ECHO/exportHistory]', e.message, e);
    importStatus.textContent = '❌ Не удалось экспортировать историю';
    setTimeout(() => { importStatus.textContent = ''; }, 3000);
  }
});

btnImportHistory.addEventListener('click', () => importFileInput.click());

importFileInput.addEventListener('change', async () => {
  const file = importFileInput.files[0];
  if (!file) return;
  importFileInput.value = '';
  let meetings;
  try {
    meetings = JSON.parse(await file.text());
    if (!Array.isArray(meetings)) throw new Error();
  } catch (e) {
    console.error('[ECHO/importHistory] failed to parse file:', e.message, e);
    importStatus.textContent = '❌ Не удалось прочитать файл';
    setTimeout(() => { importStatus.textContent = ''; }, 3000);
    return;
  }
  importStatus.textContent = `⏳ Импортирую ${meetings.length} встреч...`;
  let saved = 0;
  for (const m of meetings) {
    if (!m.id || !m.transcript) continue;
    await saveMeetingLocal({ ...m, chunks: m.chunks || [], tags: m.tags || [], title: sanitizeMeetingTitle(m.title) || fallbackMeetingTitle(m.transcript), status: m.status || MEETING_STATUS.DONE, lastError: m.lastError || '', createdAt: m.createdAt || m.id, updatedAt: m.updatedAt || m.id });
    saved++;
  }
  importStatus.textContent = `✅ Импортировано ${saved} встреч`;
  setTimeout(() => { importStatus.textContent = ''; }, 3000);
  renderHistory();
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
const historyTagFilter = document.getElementById('history-tag-filter');
let activeTagFilter = null;

async function renderTagFilter() {
  const tags = await getPresetTags();
  const hadInvalidActiveFilter = !!activeTagFilter && !tags.some(t => t.name === activeTagFilter);
  const options = ['<option value="">Все теги</option>'];
  for (const tag of tags) {
    const selected = activeTagFilter === tag.name ? ' selected' : '';
    options.push(`<option value="${escapeAttr(tag.name)}"${selected}>${escapeHtml(tag.name)}</option>`);
  }
  if (hadInvalidActiveFilter) activeTagFilter = null;
  historyTagFilter.innerHTML = options.join('');
  historyTagFilter.value = activeTagFilter || '';
  if (hadInvalidActiveFilter) renderHistory();
}

// ── History ──
const searchInput = document.getElementById('history-search');
let allMeetings = [];
let openPickerId = null;

historyTagFilter.addEventListener('change', () => {
  activeTagFilter = historyTagFilter.value || null;
  renderHistory();
});

searchInput.addEventListener('input', () => {
  const q = searchInput.value.toLowerCase().trim();
  const filtered = filterMeetings(allMeetings, q, activeTagFilter);
  renderMeetingList(filtered);
});

function filterMeetings(meetings, query, tagFilter) {
  return meetings.filter(m => {
    const tagNames = (m.tags || []).map(tag => tag.toLowerCase());
    const matchesTag = !tagFilter || (m.tags || []).includes(tagFilter);
    const matchesQuery = !query ||
      getMeetingTitle(m).toLowerCase().includes(query) ||
      (m.transcript || '').toLowerCase().includes(query) ||
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

function renderMeetingList(meetings) {
  if (meetings.length === 0) {
    const msg = (searchInput.value.trim() || activeTagFilter) ? 'Ничего не найдено' : 'Пока нет записей';
    historyList.innerHTML = `<li class="empty" style="display:block; padding:8px 0;">${msg}</li>`;
    return;
  }

  historyList.innerHTML = groupMeetingsByDay(meetings).map(group => {
    const itemsHtml = group.meetings.map(m => {
      const tags = m.tags || [];
      const tagsHtml = tags.map(t => tagPillHtml(t)).join('');
      const previewText = escapeHtml((m.transcript || '').slice(0, 60));
      const displayDate = escapeHtml(m.dateDisplay || m.date || '');
      const title = escapeHtml(getMeetingTitle(m));
      const isErrorMeeting = m.status === MEETING_STATUS.ERROR;
      const retranscribeBtn = m.chunks && m.chunks.length > 0
        ? `<button class="btn-retranscribe${isErrorMeeting ? ' btn-retranscribe--error' : ''}" data-id="${escapeAttr(m.id)}">${isErrorMeeting ? 'Повторить' : '↻'}</button>`
        : '';
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
                <button class="btn-tag-toggle${openPickerId == m.id ? ' open' : ''}" data-id="${escapeAttr(m.id)}" title="Изменить теги">+ тег</button>
              </div>
              <div class="hi-preview">${previewText}${previewText ? '...' : ''}</div>
            </div>
            <div class="hi-actions">
              ${retranscribeBtn}
              <button class="btn-delete-meeting" data-id="${escapeAttr(m.id)}" title="Удалить встречу">×</button>
            </div>
          </div>
          <div class="tag-picker" id="tag-picker-${escapeAttr(m.id)}" style="display:${openPickerId == m.id ? 'block' : 'none'};"></div>
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
  historyList.querySelectorAll('.history-info').forEach(el => {
    el.addEventListener('click', (e) => {
      if (e.target.closest('.btn-tag-toggle')) return;
      const m = allMeetings.find(x => x.id == el.dataset.id);
      if (!m) return;
      enterHistoryTranscriptView(m);
    });
  });

  // Retranscribe
  historyList.querySelectorAll('.btn-retranscribe').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      btn.disabled = true;
      btn.textContent = '⏳';
      chrome.runtime.sendMessage({ action: 'retranscribe', meetingId: parseMeetingId(btn.dataset.id) });
    });
  });

  // Delete meeting
  historyList.querySelectorAll('.btn-delete-meeting').forEach(btn => {
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
  historyList.querySelectorAll('.btn-tag-toggle').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const id = btn.dataset.id;
      if (openPickerId == id) {
        openPickerId = null;
        renderHistory();
      } else {
        openPickerId = id;
        renderHistory();
        const m = allMeetings.find(x => x.id == id);
        openTagPicker(id, m ? (m.tags || []) : []);
      }
    });
  });

  // Re-open picker if needed
  if (openPickerId) {
    const m = allMeetings.find(x => x.id == openPickerId);
    if (m) openTagPicker(openPickerId, m.tags || []);
  }
}

async function openTagPicker(meetingId, currentTags) {
  const picker = document.getElementById(`tag-picker-${meetingId}`);
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
    const q = searchInput.value.toLowerCase().trim();
    renderMeetingList(filterMeetings(allMeetings, q, activeTagFilter));
  } catch (e) {
    console.error('[ECHO/renderHistory]', e.message, e);
    pendingRecordingsCard.style.display = 'none';
    historyList.innerHTML = '<li class="empty" style="display:block; padding:8px 0;">Не удалось загрузить историю</li>';
  }
}
