// offscreen.js — runs in offscreen document, handles MediaRecorder with chunking

const MAX_CHUNK_BYTES = 20 * 1024 * 1024;
const RECORDER_TIMESLICE_MS = 4000;

let stream = null;
let mediaRecorder = null;
let chunks = [];
let currentTabId = null;
let chunkIndex = 0;
let currentChunkBytes = 0;
let stopRequested = false;
let tabClosedOnStop = false;
let mimeType = 'audio/webm';

chrome.runtime.onMessage.addListener(async (message) => {
  if (message.action === 'startCapture') {
    currentTabId = message.tabId;
    chunks = [];
    chunkIndex = 0;
    currentChunkBytes = 0;
    stopRequested = false;
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

      startChunk();

    } catch (e) {
      chrome.runtime.sendMessage({
        action: 'audioData',
        data: null,
        tabId: currentTabId,
        chunkIndex: 0,
        isFinal: true,
        error: e.message
      });
    }
  }

  if (message.action === 'stopCapture') {
    tabClosedOnStop = !!message.tabClosed;
    stopCurrentChunk(true);
  }
});

function startChunk() {
  if (!stream || !stream.active) return;

  chunks = [];
  currentChunkBytes = 0;
  stopRequested = false;
  mediaRecorder = new MediaRecorder(stream, { mimeType });

  mediaRecorder.ondataavailable = (e) => {
    if (!e.data || e.data.size === 0) return;
    chunks.push(e.data);
    currentChunkBytes += e.data.size;
    if (currentChunkBytes >= MAX_CHUNK_BYTES && mediaRecorder.state !== 'inactive' && !stopRequested) {
      stopRequested = true;
      mediaRecorder._isFinal = false;
      mediaRecorder.stop();
    }
  };

  mediaRecorder.onstop = () => {
    const isFinal = mediaRecorder._isFinal || false;
    const index = chunkIndex;

    const blob = new Blob(chunks, { type: mimeType });
    const reader = new FileReader();
    reader.onloadend = () => {
      chrome.runtime.sendMessage({
        action: 'audioData',
        data: reader.result.split(',')[1],
        tabId: currentTabId,
        chunkIndex: index,
        isFinal: isFinal,
        tabClosed: isFinal ? tabClosedOnStop : false,
        sizeBytes: blob.size
      });

      if (!isFinal && stream && stream.active) {
        chunkIndex++;
        startChunk();
      }
    };
    reader.readAsDataURL(blob);
  };

  mediaRecorder.start(RECORDER_TIMESLICE_MS);
}

function stopCurrentChunk(isFinal) {
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    stopRequested = true;
    mediaRecorder._isFinal = isFinal;
    mediaRecorder.stop();
  }
  if (isFinal && stream) {
    stream.getTracks().forEach(t => t.stop());
    stream = null;
  }
}
