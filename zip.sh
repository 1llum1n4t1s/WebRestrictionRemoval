#!/bin/bash

# Vuora 拡張機能パッケージ生成スクリプト
# 使い方:
#   ./zip.sh                 # Chrome + Firefox 両方
#   ./zip.sh chrome          # Chrome のみ
#   ./zip.sh firefox         # Firefox のみ
#
# Firefox 版は manifest.firefox.json を manifest.json として同梱し、xpi 拡張子で出力する。
# Firefox 版では Chrome 専用の音量ブースター経路 (offscreen / tabCapture) を除外し、MES 経路を同梱する。

set -euo pipefail
cd "$(dirname "$0")"

TARGET="${1:-both}"
WORK_ROOT="${VUORA_PACKAGE_WORK_ROOT:-$PWD}"
OUTPUT_ROOT="${VUORA_PACKAGE_OUTPUT_ROOT:-$PWD}"
KEEP_WORK="${VUORA_PACKAGE_KEEP_WORK:-0}"
for root in "$WORK_ROOT" "$OUTPUT_ROOT"; do
  case "$root" in /*) ;; *) echo "Package roots must be absolute directories"; exit 2 ;; esac
  [ -d "$root" ] || { echo "Package root does not exist: $root"; exit 2; }
  ancestor="$root"
  while [ "$ancestor" != / ]; do
    [ ! -L "$ancestor" ] || { echo "Package root contains a symlink"; exit 2; }
    ancestor="$(dirname "$ancestor")"
  done
done
WORK_ROOT="$(cd "$WORK_ROOT" && pwd -P)"
OUTPUT_ROOT="$(cd "$OUTPUT_ROOT" && pwd -P)"
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
if ! bun run deps --silent; then
  echo "bun run deps に失敗しました"
  exit 1
fi
if ! bun scripts/generate-icons.js; then
  echo "アイコン生成に失敗しました"
  exit 1
fi

build_pkg() (
  local variant="$1"           # chrome | firefox
  local output="$2"            # web-viewing-assist-chrome.zip | web-viewing-assist-firefox.xpi

  echo ""
  echo "==== $variant 版をビルド中 ===="
  output="$OUTPUT_ROOT/$output"

  local work
  work="$(mktemp -d "$WORK_ROOT/package-$variant-XXXXXXXXXX")"
  local tmp="$work/content"
  # この呼出しで排他的に確保した領域だけを清掃する。
  local staged=""
  trap 'if [ "$KEEP_WORK" != 1 ]; then if [ -n "$staged" ]; then rm -f -- "$staged"; fi; rm -rf -- "$work"; fi' EXIT
  mkdir "$tmp"

  # manifest を variant 用にコピー (Firefox は manifest.firefox.json を manifest.json にリネーム)
  bun scripts/copy-package-files.js "$variant" "$tmp"

  if [ "$variant" = "firefox" ]; then
    # Firefox 版は chrome.offscreen / chrome.tabCapture の呼び出しブロックを物理削除する。
    # AMO linter の UNSUPPORTED_API 警告 3 件を消すため、__FIREFOX_STRIP_BEGIN__ から
    # __FIREFOX_STRIP_END__ までを (マーカー行を含めて) 削除する。
    bun scripts/strip-firefox-background.js "$tmp/src/background/background.js"
    echo "Firefox build: background.js の chrome.offscreen / chrome.tabCapture 呼び出しを strip 済み"
  fi

  # アーカイブ作成 (zip / xpi いずれも zip 形式、拡張子だけが違う)
  (cd "$tmp" && zip -r "$work/package.zip" . -x "*.DS_Store" "*.swp" "*~") >/dev/null
  # 出力先内でコピーを完了し、同じファイルシステム内の rename だけで置換する。
  staged="$(mktemp "$OUTPUT_ROOT/.package-XXXXXXXXXX")"
  cp "$work/package.zip" "$staged"
  chmod "$(printf '%03o' "$((0666 & ~$(umask)))")" "$staged"
  mv -f -- "$staged" "$output"
  staged=""

  if [ -f "$output" ]; then
    echo "$variant 版 作成成功: $output ($(ls -lh "$output" | awk '{print $5}'))"
  else
    echo "$variant 版 作成失敗"
    exit 1
  fi
)

if [ "$TARGET" = "chrome" ] || [ "$TARGET" = "both" ]; then
  build_pkg "chrome" "web-viewing-assist-chrome.zip"
fi
if [ "$TARGET" = "firefox" ] || [ "$TARGET" = "both" ]; then
  build_pkg "firefox" "web-viewing-assist-firefox.xpi"
fi

echo ""
echo "✨ パッケージング完了"
echo "   Chrome Web Store: https://chrome.google.com/webstore/devconsole"
echo "   Firefox AMO:      https://addons.mozilla.org/developers/"
