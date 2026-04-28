// offscreen.js — runs in offscreen document, handles MediaRecorder with chunking

const MAX_CHUNK_BYTES = 20 * 1024 * 1024;
const RECORDER_TIMESLICE_MS = 4000;

// idle → recording → rotating → recording → … → stopping → idle
const STATE = { IDLE: 'idle', RECORDING: 'recording', ROTATING: 'rotating', STOPPING: 'stopping' };

let state = STATE.IDLE;
let stream = null;
let mediaRecorder = null;
let chunks = [];
let currentTabId = null;
let currentMeetingId = null;
let chunkIndex = 0;
let currentChunkBytes = 0;
let tabClosedOnStop = false;
let mimeType = 'audio/webm';
let audioElement = null;
let heartbeatInterval = null;
let chunkRotationInterval = null;

const CHUNK_ROTATION_MS = 60000;

chrome.runtime.sendMessage({ action: 'offscreenReady' });

chrome.runtime.onMessage.addListener(async (message) => {
  if (message.action === 'startCapture') {
    if (state !== STATE.IDLE) {
      console.warn('[ECHO/offscreen] startCapture ignored — already active (state:', state, ')');
      return;
    }
    if (stream) {
      stream.getTracks().forEach(t => t.stop());
      stream = null;
    }
    if (audioElement) {
      audioElement.pause();
      audioElement.srcObject = null;
      audioElement = null;
    }

    state = STATE.IDLE;
    currentTabId = message.tabId;
    currentMeetingId = message.meetingId || null;
    chunks = [];
    chunkIndex = 0;
    currentChunkBytes = 0;
    tabClosedOnStop = false;

    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          mandatory: {
            chromeMediaSource: 'tab',
            chromeMediaSourceId: message.streamId
          }
        },
        video: false
      });

      mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : 'audio/webm';

      audioElement = new Audio();
      audioElement.srcObject = stream;
      audioElement.play().catch(e => console.warn('[ECHO/offscreen] audio playback:', e.message));

      heartbeatInterval = setInterval(() => {
        chrome.runtime.sendMessage({ action: 'recorderHeartbeat' });
      }, 20000);

      chunkRotationInterval = setInterval(() => {
        if (state === STATE.RECORDING) {
          state = STATE.ROTATING;
          mediaRecorder.stop();
        }
      }, CHUNK_ROTATION_MS);

      startChunk();

    } catch (e) {
      console.error('[ECHO/offscreen] getUserMedia failed:', e.message, e);
      state = STATE.IDLE;
      chrome.runtime.sendMessage({
        action: 'audioData',
        data: null,
        tabId: currentTabId,
        meetingId: currentMeetingId,
        chunkIndex: 0,
        isFinal: true,
        error: e.message
      });
    }
  }

  if (message.action === 'stopCapture') {
    tabClosedOnStop = !!message.tabClosed;
    requestStop();
  }
});

function startChunk() {
  if (!stream || !stream.active) return;

  chunks = [];
  currentChunkBytes = 0;
  state = STATE.RECORDING;
  mediaRecorder = new MediaRecorder(stream, { mimeType });

  mediaRecorder.ondataavailable = (e) => {
    if (!e.data || e.data.size === 0) return;
    chunks.push(e.data);
    currentChunkBytes += e.data.size;
    if (currentChunkBytes >= MAX_CHUNK_BYTES && state === STATE.RECORDING) {
      state = STATE.ROTATING;
      mediaRecorder.stop();
    }
  };

  mediaRecorder.onstop = () => {
    const isFinal = state === STATE.STOPPING;
    const index = chunkIndex;

    const blob = new Blob(chunks, { type: mimeType });
    const reader = new FileReader();
    reader.onloadend = () => {
      chrome.runtime.sendMessage({
        action: 'audioData',
        data: reader.result.split(',')[1],
        tabId: currentTabId,
        meetingId: currentMeetingId,
        chunkIndex: index,
        isFinal,
        tabClosed: isFinal ? tabClosedOnStop : false,
        sizeBytes: blob.size
      });

      if (isFinal) {
        teardown();
      } else {
        chunkIndex++;
        startChunk();
      }
    };
    reader.readAsDataURL(blob);
  };

  mediaRecorder.start(RECORDER_TIMESLICE_MS);
}

function requestStop() {
  if (state === STATE.IDLE) {
    // Recorder not active — background still needs to know so it can close offscreen.
    chrome.runtime.sendMessage({
      action: 'audioData',
      data: null,
      tabId: currentTabId,
      meetingId: currentMeetingId,
      chunkIndex: 0,
      isFinal: true,
      tabClosed: tabClosedOnStop
    });
    teardown();
    return;
  }

  if (state === STATE.STOPPING) return;

  // RECORDING → stop recorder now.
  // ROTATING  → recorder already stopping; onstop will see STOPPING and finalize.
  state = STATE.STOPPING;
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    mediaRecorder.stop();
  }
}

function teardown() {
  state = STATE.IDLE;
  clearInterval(heartbeatInterval);
  heartbeatInterval = null;
  clearInterval(chunkRotationInterval);
  chunkRotationInterval = null;
  if (audioElement) {
    audioElement.pause();
    audioElement.srcObject = null;
    audioElement = null;
  }
  if (stream) {
    stream.getTracks().forEach(t => t.stop());
    stream = null;
  }
}
