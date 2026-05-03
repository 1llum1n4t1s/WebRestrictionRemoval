#!/bin/bash

# WEB閲覧アシスト 拡張機能パッケージ生成スクリプト

cd "$(dirname "$0")" || exit 1
echo "拡張機能パッケージを生成中..."

rm -f ./web-viewing-assist.zip ./web-restriction-remover.zip

if [ -f scripts/generate-icons.js ]; then
  echo "アイコン生成中..."
  if ! npm ci --silent; then
    echo "npm ci に失敗しました"
    exit 1
  fi
  if ! node scripts/generate-icons.js; then
    echo "アイコン生成に失敗しました"
    exit 1
  fi
fi

if ! command -v zip &> /dev/null; then
  echo "zipをインストールしてください"
  exit 1
fi

zip -r ./web-viewing-assist.zip \
  manifest.json \
  icons/ \
  src/ \
  -x "*.DS_Store" "*.swp" "*~"

if [ $? -eq 0 ]; then
  echo "ZIPファイルを作成しました: web-viewing-assist.zip"
  ls -lh ./web-viewing-assist.zip
else
  echo "ZIPファイルの作成に失敗しました"
  exit 1
fi
