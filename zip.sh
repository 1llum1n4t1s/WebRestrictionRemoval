#!/bin/bash

# WEB閲覧アシスト 拡張機能パッケージ生成スクリプト
# 使い方:
#   ./zip.sh                 # Chrome + Firefox 両方
#   ./zip.sh chrome          # Chrome のみ
#   ./zip.sh firefox         # Firefox のみ
#
# Firefox 版は manifest.firefox.json を manifest.json として同梱し、xpi 拡張子で出力する。
# 音量ブースター関連 (offscreen / tabCapture) は Firefox MV3 未対応のため除外されている。

set -euo pipefail
cd "$(dirname "$0")"

TARGET="${1:-both}"
case "$TARGET" in
  chrome|firefox|both) ;;
  *) echo "Usage: $0 [chrome|firefox|both]"; exit 2 ;;
esac

echo "拡張機能パッケージを生成中... (Target: $TARGET)"

if ! command -v zip &> /dev/null; then
  echo "zip をインストールしてください"
  exit 1
fi

# 依存インストール & アイコン生成
echo "依存パッケージを lockfile どおりにインストール中..."
if ! npm ci --silent; then
  echo "npm ci に失敗しました"
  exit 1
fi
if ! node scripts/generate-icons.js; then
  echo "アイコン生成に失敗しました"
  exit 1
fi

build_pkg() {
  local variant="$1"           # chrome | firefox
  local manifest_src="$2"      # manifest.json | manifest.firefox.json
  local output="$3"            # web-viewing-assist-chrome.zip | web-viewing-assist-firefox.xpi

  echo ""
  echo "==== $variant 版をビルド中 ===="
  rm -f "$output"

  local tmp="temp-build-$variant"
  rm -rf "$tmp"
  mkdir -p "$tmp"

  # manifest を variant 用にコピー (Firefox は manifest.firefox.json を manifest.json にリネーム)
  cp "$manifest_src" "$tmp/manifest.json"
  cp -r icons "$tmp/"
  cp -r src "$tmp/"
  cp -r _locales "$tmp/"

  # 不要ファイル除去
  find "$tmp" \( -name "*.DS_Store" -o -name "*.swp" -o -name "*~" \) -delete

  if [ "$variant" = "firefox" ]; then
    # Firefox 版は chrome.offscreen / chrome.tabCapture の呼び出しブロックを物理削除する。
    # AMO linter の UNSUPPORTED_API 警告 3 件を消すため、__FIREFOX_STRIP_BEGIN__ から
    # __FIREFOX_STRIP_END__ までを (マーカー行を含めて) 削除する。
    perl -i -0pe 's{\s*//\s*__FIREFOX_STRIP_BEGIN__.*?//\s*__FIREFOX_STRIP_END__\s*\n}{\n}gs' "$tmp/src/background/background.js"
    echo "Firefox build: background.js の chrome.offscreen / chrome.tabCapture 呼び出しを strip 済み"
  fi

  # アーカイブ作成 (zip / xpi いずれも zip 形式、拡張子だけが違う)
  (cd "$tmp" && zip -r "../$output" . -x "*.DS_Store" "*.swp" "*~") >/dev/null
  rm -rf "$tmp"

  if [ -f "$output" ]; then
    echo "$variant 版 作成成功: $output ($(ls -lh "$output" | awk '{print $5}'))"
  else
    echo "$variant 版 作成失敗"
    exit 1
  fi
}

# 旧名 zip を掃除
rm -f web-viewing-assist.zip web-restriction-remover.zip

if [ "$TARGET" = "chrome" ] || [ "$TARGET" = "both" ]; then
  build_pkg "chrome" "manifest.json" "web-viewing-assist-chrome.zip"
fi
if [ "$TARGET" = "firefox" ] || [ "$TARGET" = "both" ]; then
  build_pkg "firefox" "manifest.firefox.json" "web-viewing-assist-firefox.xpi"
fi

echo ""
echo "✨ パッケージング完了"
echo "   Chrome Web Store: https://chrome.google.com/webstore/devconsole"
echo "   Firefox AMO:      https://addons.mozilla.org/developers/"
