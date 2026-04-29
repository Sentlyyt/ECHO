# Google Drive setup для разработчика

Эта инструкция только для разработчика сборки ECHO. Обычный пользователь не должен создавать Google Cloud Project, искать `client_id`, править `manifest.json` или разбираться с Extension ID.

## Что должно быть в пользовательском интерфейсе

В расширении пользователю показывается короткий сценарий:

1. Нажмите "Подключить Google Drive"
2. Выберите Google-аккаунт
3. Разрешите ECHO создавать файлы на Google Drive
4. Готово - записи будут загружаться в папку ECHO Recordings

Если OAuth не настроен в сборке, пользователь должен видеть только сообщение:

> Google Drive не настроен в этой сборке расширения. Обратитесь к разработчику.

## Два OAuth client_id

ECHO использует два разных OAuth Client:

1. **Chrome Extension OAuth client_id** - для Google Chrome и `chrome.identity.getAuthToken`.
2. **Web application OAuth client_id** - для Яндекс.Браузера и fallback через `chrome.identity.launchWebAuthFlow`.

В `manifest.json` можно указать только один OAuth client_id. Поэтому:

- Chrome Extension client_id лежит в `manifest.json` -> `oauth2.client_id`;
- этот же Chrome Extension client_id дублируется в `googleDriveConfig.js` -> `chromeExtensionClientId`, чтобы диагностика могла проверить совпадение;
- Web application client_id лежит только в `googleDriveConfig.js` -> `yandexWebClientId`;
- Web application client_id нельзя класть в `manifest.json`.

`scope` везде один:

```text
https://www.googleapis.com/auth/drive.file
```

## Настройка OAuth для Google Chrome

1. Открой `chrome://extensions`.
2. Включи режим разработчика.
3. Нажми "Загрузить распакованное расширение" и выбери папку проекта.
4. Скопируй Extension ID из карточки расширения.
5. Создай проект в [Google Cloud Console](https://console.cloud.google.com/).
6. Включи Google Drive API: APIs & Services -> Library -> Google Drive API -> Enable.
7. Создай OAuth Client: APIs & Services -> Credentials -> Create credentials -> OAuth client ID.
8. В типе приложения выбери Chrome Extension.
9. Вставь Extension ID в поле Item ID.
10. Скопируй `client_id`.
11. Вставь `client_id` в `manifest.json` в `oauth2.client_id`.
12. Вставь тот же `client_id` в `googleDriveConfig.js` в `chromeExtensionClientId`.
13. Убедись, что в `oauth2.scopes` указан только scope `https://www.googleapis.com/auth/drive.file`.

Пример:

```json
"oauth2": {
  "client_id": "123456789-abc...xyz.apps.googleusercontent.com",
  "scopes": ["https://www.googleapis.com/auth/drive.file"]
}
```

```js
globalThis.GOOGLE_DRIVE_OAUTH_CONFIG = {
  chromeExtensionClientId: '123456789-abc...xyz.apps.googleusercontent.com',
  yandexWebClientId: 'PASTE_WEB_CLIENT_ID_HERE.apps.googleusercontent.com',
  scope: 'https://www.googleapis.com/auth/drive.file'
};
```

Не используй полный scope Google Drive. Для ECHO нужен только `drive.file`: расширение сможет создавать и читать только файлы, созданные самим приложением.

## Настройка OAuth для Яндекс.Браузера

Яндекс.Браузер может возвращать `canceled` на `chrome.identity.getAuthToken`, потому что у него нет полной Google Chrome identity-интеграции. Для него ECHO использует `launchWebAuthFlow`.

1. В Google Cloud Console открой тот же проект.
2. Перейди в APIs & Services -> Credentials.
3. Создай OAuth Client типа **Web application**.
4. В поле **Authorized redirect URIs** добавь URL из debug-лога ECHO:

```text
chrome.identity.getRedirectURL()
```

Он выглядит примерно так:

```text
https://<extension-id>.chromiumapp.org/
```

5. Скопируй Web application `client_id`.
6. Вставь его в `googleDriveConfig.js` в `yandexWebClientId`.

Пример:

```js
globalThis.GOOGLE_DRIVE_OAUTH_CONFIG = {
  chromeExtensionClientId: '123456789-chrome-extension.apps.googleusercontent.com',
  yandexWebClientId: '123456789-web-application.apps.googleusercontent.com',
  scope: 'https://www.googleapis.com/auth/drive.file'
};
```

Refresh token в расширении не сохраняется. Fallback использует short-lived `access_token`; когда он истечет, пользователь пройдет авторизацию заново.

## Unpacked extension и стабильный Extension ID

OAuth работает с unpacked extension, но Google OAuth Client привязан к конкретному Extension ID.

Проблема: у распакованного расширения Extension ID может измениться при переустановке, переносе папки или загрузке на другой машине. Если ID изменился, OAuth Client перестанет подходить.

Решение: зафиксировать Extension ID через поле `"key"` в `manifest.json`.

Правила:

- Если `"key"` уже есть в `manifest.json`, не меняй его.
- Не генерируй новый `"key"` автоматически без явного решения.
- Если `"key"` нет, сначала получи стабильный ключ, затем добавь его в `manifest.json`.
- Если Extension ID изменится, OAuth Client нужно будет пересоздать или обновить в Google Cloud Console.

TODO, если `"key"` еще нет:

1. В `chrome://extensions` нажми "Упаковать расширение".
2. В поле "Корневой каталог" выбери папку проекта.
3. Поле приватного ключа оставь пустым, если ключ создается впервые.
4. Chrome создаст `.pem` файл. Это приватный ключ, его нельзя коммитить.
5. Получи публичный ключ:

```bash
openssl rsa -in telemost-recorder.pem -pubout -outform DER | base64 | tr -d '\n'
```

6. Добавь полученную строку в `manifest.json`:

```json
{
  "manifest_version": 3,
  "key": "PASTE_PUBLIC_KEY_HERE",
  "name": "ECHO (Запись и траскрибация встреч)"
}
```

`PASTE_PUBLIC_KEY_HERE` - это placeholder в документации, не значение для рабочей сборки. В сам `manifest.json` вставляй только реальный публичный ключ.

## Troubleshooting

### `invalid_client`

Чаще всего Extension ID в Google Cloud не совпадает с текущим ID расширения. Проверь `"key"` в `manifest.json`, перезагрузи расширение в `chrome://extensions` и сравни ID с Item ID в OAuth Client.

### `OAuth client not found`

`client_id` неверный, удален или относится к другому Google Cloud Project. Проверь значение `oauth2.client_id` в `manifest.json` и OAuth Client в Google Cloud Console.

### `Access blocked`

Проблема с OAuth consent screen. Проверь статус приложения, тип пользователей, тестовых пользователей и заполненность обязательных полей consent screen.

### `Drive API not enabled`

В выбранном Google Cloud Project не включен Google Drive API. Открой APIs & Services -> Library -> Google Drive API -> Enable.

### `insufficient permissions`

Проверь scope в `manifest.json`. Должен быть только:

```json
["https://www.googleapis.com/auth/drive.file"]
```

После изменения scope перезагрузи расширение и переподключи Google Drive. Иногда нужно удалить выданный доступ в настройках Google Account и пройти авторизацию заново.
