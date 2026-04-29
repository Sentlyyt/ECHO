// offscreen.js — audio recording (transcription) + optional video recording (export)

const MAX_CHUNK_BYTES = 20 * 1024 * 1024;
const RECORDER_TIMESLICE_MS = 4000;
const CHUNK_ROTATION_MS = 60000;
const VIDEO_BITRATE = 800000; // 800 kbps — reasonable quality, ~360 MB/hr

// idle → recording → rotating → recording → … → stopping → idle
const STATE = { IDLE: 'idle', RECORDING: 'recording', ROTATING: 'rotating', STOPPING: 'stopping' };

let state = STATE.IDLE;
let stream = null;
let audioStream = null;
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

// Video recording (optional, accumulates all chunks in memory, sent at stop)
let videoEnabled = false;
let videoMediaRecorder = null;
let videoChunks = [];
let videoMimeType = 'video/webm';

chrome.runtime.sendMessage({ action: 'offscreenReady' });

chrome.runtime.onMessage.addListener(async (message) => {
  if (message.action === 'startCapture') {
    if (state !== STATE.IDLE) {
      console.warn('[ECHO/offscreen] startCapture ignored — already active (state:', state, ')');
      return;
    }

    cleanupAll();

    state = STATE.IDLE;
    currentTabId = message.tabId;
    currentMeetingId = message.meetingId || null;
    chunks = [];
    chunkIndex = 0;
    currentChunkBytes = 0;
    tabClosedOnStop = false;
    videoEnabled = !!message.enableVideo;
    videoChunks = [];

    try {
      if (videoEnabled) {
        try {
          stream = await navigator.mediaDevices.getUserMedia({
            audio: {
              mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: message.streamId }
            },
            video: {
              mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: message.streamId }
            }
          });
        } catch (videoErr) {
          console.warn('[ECHO/offscreen] Video capture failed, falling back to audio-only:', videoErr.message);
          videoEnabled = false;
          chrome.runtime.sendMessage({
            action: 'videoData',
            data: null,
            meetingId: currentMeetingId,
            chunkIndex: 0,
            isFinal: true,
            error: videoErr.message,
            sizeBytes: 0
          });
          stream = await navigator.mediaDevices.getUserMedia({
            audio: {
              mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: message.streamId }
            },
            video: false
          });
        }
      } else {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: message.streamId }
          },
          video: false
        });
      }

      // Audio-only stream for transcription (separate from video)
      audioStream = new MediaStream(stream.getAudioTracks());

      mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : 'audio/webm';

      audioElement = new Audio();
      audioElement.srcObject = audioStream;
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

      // Start video recorder if stream has video tracks
      if (videoEnabled) {
        const videoTracks = stream.getVideoTracks();
        if (videoTracks.length > 0) {
          startVideoRecorder();
        } else {
          videoEnabled = false;
          chrome.runtime.sendMessage({
            action: 'videoData',
            data: null,
            meetingId: currentMeetingId,
            chunkIndex: 0,
            isFinal: true,
            error: 'Видеодорожка не найдена в захваченном потоке',
            sizeBytes: 0
          });
        }
      }

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

function selectVideoMimeType() {
  const candidates = [
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm;codecs=vp9',
    'video/webm;codecs=vp8',
    'video/webm'
  ];
  return candidates.find(t => MediaRecorder.isTypeSupported(t)) || 'video/webm';
}

function startVideoRecorder() {
  videoChunks = [];
  videoMimeType = selectVideoMimeType();

  try {
    videoMediaRecorder = new MediaRecorder(stream, {
      mimeType: videoMimeType,
      videoBitsPerSecond: VIDEO_BITRATE
    });
  } catch (e) {
    console.warn('[ECHO/offscreen] Video MediaRecorder creation failed:', e.message);
    videoEnabled = false;
    chrome.runtime.sendMessage({
      action: 'videoData',
      data: null,
      meetingId: currentMeetingId,
      chunkIndex: 0,
      isFinal: true,
      error: e.message,
      sizeBytes: 0
    });
    return;
  }

  videoMediaRecorder.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) videoChunks.push(e.data);
  };

  videoMediaRecorder.onstop = () => {
    finalizeVideoData();
  };

  videoMediaRecorder.onerror = (e) => {
    console.warn('[ECHO/offscreen] Video recorder error:', e.error && e.error.message);
    videoEnabled = false;
    chrome.runtime.sendMessage({
      action: 'videoData',
      data: null,
      meetingId: currentMeetingId,
      chunkIndex: 0,
      isFinal: true,
      error: (e.error && e.error.message) || 'Ошибка видеозаписи',
      sizeBytes: 0
    });
  };

  videoMediaRecorder.start(RECORDER_TIMESLICE_MS);
}

function stopVideoRecorder() {
  if (!videoEnabled) {
    // Video was never started or failed early — the error was already sent
    return;
  }
  if (videoMediaRecorder && videoMediaRecorder.state !== 'inactive') {
    videoMediaRecorder.stop();
    // onstop → finalizeVideoData
  } else {
    finalizeVideoData();
  }
}

function finalizeVideoData() {
  if (videoChunks.length === 0) {
    chrome.runtime.sendMessage({
      action: 'videoData',
      data: null,
      meetingId: currentMeetingId,
      chunkIndex: 0,
      isFinal: true,
      error: null,
      sizeBytes: 0
    });
    return;
  }

  const blob = new Blob(videoChunks, { type: videoMimeType });
  videoChunks = [];

  const reader = new FileReader();
  reader.onloadend = () => {
    chrome.runtime.sendMessage({
      action: 'videoData',
      data: reader.result.split(',')[1],
      meetingId: currentMeetingId,
      chunkIndex: 0,
      isFinal: true,
      error: null,
      sizeBytes: blob.size
    });
  };
  reader.readAsDataURL(blob);
}

function startChunk() {
  if (!audioStream || !audioStream.active) return;

  chunks = [];
  currentChunkBytes = 0;
  state = STATE.RECORDING;
  mediaRecorder = new MediaRecorder(audioStream, { mimeType });

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
        // Stop video recorder — it will finalize and send videoData asynchronously
        stopVideoRecorder();
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
    chrome.runtime.sendMessage({
      action: 'audioData',
      data: null,
      tabId: currentTabId,
      meetingId: currentMeetingId,
      chunkIndex: 0,
      isFinal: true,
      tabClosed: tabClosedOnStop
    });
    stopVideoRecorder();
    teardown();
    return;
  }

  if (state === STATE.STOPPING) return;

  state = STATE.STOPPING;
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    mediaRecorder.stop();
  }
}

function cleanupAll() {
  clearInterval(heartbeatInterval);
  heartbeatInterval = null;
  clearInterval(chunkRotationInterval);
  chunkRotationInterval = null;
  if (audioElement) {
    audioElement.pause();
    audioElement.srcObject = null;
    audioElement = null;
  }
  if (videoMediaRecorder && videoMediaRecorder.state !== 'inactive') {
    try { videoMediaRecorder.stop(); } catch (_) {}
  }
  videoMediaRecorder = null;
  videoChunks = [];
  if (stream) {
    stream.getTracks().forEach(t => t.stop());
    stream = null;
  }
  audioStream = null;
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
  audioStream = null;
  videoMediaRecorder = null;
}
