// Chrome client_id также должен быть указан в manifest.json.
// Yandex/Web client_id используется только для launchWebAuthFlow.
globalThis.GOOGLE_DRIVE_OAUTH_CONFIG = {
  chromeExtensionClientId: 'REPLACE_WITH_YOUR_GOOGLE_CLIENT_ID.apps.googleusercontent.com',
  yandexWebClientId: 'REPLACE_WITH_YOUR_YANDEX_WEB_CLIENT_ID.apps.googleusercontent.com',
  scope: 'https://www.googleapis.com/auth/drive.file'
};
