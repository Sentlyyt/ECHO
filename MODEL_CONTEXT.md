# Telemost Recorder — context for LLM

This file is a compact operating map for the repository. Use it as the first stop before touching code.

## What this extension does

`Telemost Recorder` is a Chrome / Chromium extension for Yandex Telemost meetings.

Core behavior:

1. Captures tab audio from a Telemost call.
2. Records audio in chunks.
3. Sends each chunk to Groq Whisper for Russian transcription.
4. Builds a Claude-ready prompt from the full transcript.
5. Saves audio, transcript, and meeting metadata locally.
6. Supports history, tag management, file upload transcription, and retranscription.

## Runtime architecture

The extension is split into four main runtime pieces:

### `background.js`

Service worker and orchestration layer.

Responsibilities:

- starts/stops recording
- opens the side panel or popup fallback
- creates the offscreen document when needed
- receives audio chunks from `offscreen.js`
- calls Groq transcription API
- builds the final prompt
- saves meeting data into IndexedDB via `db.js`
- handles retranscription and tag storage
- shows notifications and relays status messages to UI parts

### `offscreen.js`

Audio capture worker inside the offscreen document.

Responsibilities:

- receives a `tabCapture` stream ID
- opens tab audio with `getUserMedia`
- runs `MediaRecorder`
- splits recording into chunks
- stops and releases the stream on command
- sends base64 audio back to `background.js`

Important detail:

- chunk rotation is time-based, `20 minutes` per chunk
- `MediaRecorder.start(5000)` means data is collected in 5-second slices inside each chunk

### `content.js`

Injected into Telemost pages only.

Responsibilities:

- renders the floating record button overlay
- detects whether a meeting is active
- detects whether participants have joined
- suggests starting a recording when people join
- reacts to background messages like `transcribing`, `transcriptReady`, `error`

### `sidepanel.js` / `sidepanel.html`

Main UI for the extension.

Responsibilities:

- setup screen for Groq API key
- start/stop recording from the panel
- show live status and timer
- show transcript and Claude prompt
- allow copying transcript / prompt
- support file upload transcription
- render meeting history
- support export/import of history
- manage preset tags and tag filtering
- trigger retranscription for old meetings

### `popup.js` / `popup.html`

Minimal API key popup.

Used as a simple fallback / quick settings entry point.

### `db.js`

IndexedDB helper.

Stores meeting objects in a single object store:

- database name: `TelemostRecorder`
- store: `meetings`
- key path: `id`

## Data flow

### Recording flow

1. User clicks record in the side panel or overlay.
2. `background.js` asks for the Groq key.
3. `chrome.tabCapture.getMediaStreamId()` gets the tab audio stream ID.
4. `background.js` creates the offscreen document if needed.
5. `offscreen.js` records audio and rotates chunks.
6. Each chunk is sent back to `background.js` as base64 webm data.
7. `background.js` transcribes each chunk through Groq.
8. When all chunks are ready, it:
   - merges transcripts
   - builds the Claude prompt
   - downloads audio files and transcript text into `Telemost Recordings/...`
   - saves metadata to IndexedDB
   - sends `transcriptReady` to the UI

### File upload flow

The side panel also lets the user upload a local audio or video file.

That path bypasses recording and sends the chosen file directly to Groq Whisper.

### Retranscription flow

The saved meeting contains raw audio chunks in IndexedDB.
If the first transcription fails or Groq quota is exhausted, the user can retranscribe the stored meeting without re-recording.

## Storage

### `chrome.storage.local`

Used for:

- `groqApiKey`
- `presetTags`

### IndexedDB

Used for meeting history and retranscription.

Meeting objects currently include:

- `id`
- `date`
- `dateDisplay`
- `chunks`
- `transcript`
- `prompt`
- `tags`

## Manifest and permissions

Relevant permissions in `manifest.json`:

- `tabCapture` for recording the Telemost tab
- `offscreen` for audio capture
- `storage` for settings and tags
- `downloads` for saving audio/transcript files
- `notifications` for error / completion messages
- `clipboardWrite` for copying the prompt
- `activeTab`, `tabs` for tab interaction
- `sidePanel` for the main UI

Host permissions:

- `https://telemost.yandex.ru/*`
- `https://telemost.yandex.com/*`
- `https://api.groq.com/*`

## File map

- `manifest.json` — extension manifest and permissions
- `background.js` — orchestration, transcription, persistence
- `offscreen.js` — MediaRecorder and chunking
- `content.js` — floating overlay inside Telemost
- `sidepanel.html` — main UI markup
- `sidepanel.js` — main UI logic
- `popup.html` / `popup.js` — quick API key popup
- `db.js` — IndexedDB helpers
- `README.md` — user-facing install / usage guide
- `icons/` — extension icons

## Groq integration

The extension uses Groq in two places:

1. Speech-to-text transcription:
   - endpoint: `https://api.groq.com/openai/v1/audio/transcriptions`
   - model: `whisper-large-v3`
   - language: `ru`

2. Auto-tagging:
   - endpoint: `https://api.groq.com/openai/v1/chat/completions`
   - model: `llama-3.1-8b-instant`
   - output is constrained to preset tags

## Important implementation details

- The extension assumes Telemost meeting URLs contain `/j/`.
- `content.js` relies on specific UI text / selectors to detect meeting state.
- `background.js` keeps chunk state in memory, so recording lifecycle is tied to the service worker process.
- `offscreen.js` is the only place that talks to `MediaRecorder`.
- Downloaded files land in `Telemost Recordings/<date>_meeting/`.
- If `chunkTabClosed` is true, completion is signaled by a notification instead of a tab message.

## Things to be careful with

- Do not break message names between modules. Most coordination is string-based.
- Do not change storage keys casually. `groqApiKey`, `presetTags`, and meeting object shape are shared across files.
- If you change chunking behavior, check both:
  - `offscreen.js` chunk rotation
  - `background.js` chunk assembly and progress reporting
- If you touch the side panel UI, verify both the setup state and the main state.
- If you touch Telemost detection logic, verify the overlay still appears only on actual meetings.

## Current code smell / risk areas

- `background.js` is doing a lot: orchestration, API calls, persistence, notifications. This is the first candidate for careful refactor, not casual edits.
- The state is split across memory, `chrome.storage.local`, and IndexedDB. Bugs here usually look like “works once, breaks after reload”.
- Meeting detection in `content.js` is heuristic and can break when Telemost UI changes.

## Recommended edit order

If you need to change behavior, start here:

1. `background.js`
2. `sidepanel.js`
3. `offscreen.js`
4. `content.js`
5. `db.js`

If you need to understand the user flow, start with:

1. `README.md`
2. `manifest.json`
3. `background.js`
4. `sidepanel.js`
5. `content.js`

## One-line summary

This extension records Telemost tab audio, chunks it, sends it to Groq for Russian transcription, stores the result locally, and exposes the transcript and prompt through a side panel and overlay.
