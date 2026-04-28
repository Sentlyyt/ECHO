#!/bin/bash
set -e

DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR"

echo "📦 Telemost Recorder — обновление"
echo "─────────────────────────────────"

if ! git rev-parse --git-dir > /dev/null 2>&1; then
  echo "❌ Это не git-репозиторий. Склонируй расширение через:"
  echo "   git clone https://github.com/Sentlyyt/telemost-recorder.git"
  exit 1
fi

BEFORE=$(git rev-parse HEAD)

git pull origin main

AFTER=$(git rev-parse HEAD)

if [ "$BEFORE" = "$AFTER" ]; then
  echo ""
  echo "✅ Уже актуальная версия, обновление не нужно."
else
  echo ""
  echo "✅ Обновлено! Что изменилось:"
  git log --oneline "$BEFORE".."$AFTER"
fi

echo ""
echo "🔄 Перезагрузи расширение в браузере:"
echo "   chrome://extensions  →  найди Telemost Recorder  →  кнопка ↺"
echo ""
