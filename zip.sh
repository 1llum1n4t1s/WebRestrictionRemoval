#!/bin/bash

# WEB制限解除サポート 拡張機能パッケージ生成スクリプト

cd "$(dirname "$0")" || exit 1
echo "拡張機能パッケージを生成中..."

rm -f ./web-restriction-remover.zip

if [ -f scripts/generate-icons.js ]; then
  echo "アイコン生成中..."
  if ! npm install --silent; then
    echo "npm install に失敗しました"
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

zip -r ./web-restriction-remover.zip \
  manifest.json \
  icons/ \
  src/ \
  -x "*.DS_Store" "*.swp" "*~"

if [ $? -eq 0 ]; then
  echo "ZIPファイルを作成しました: web-restriction-remover.zip"
  ls -lh ./web-restriction-remover.zip
else
  echo "ZIPファイルの作成に失敗しました"
  exit 1
fi
