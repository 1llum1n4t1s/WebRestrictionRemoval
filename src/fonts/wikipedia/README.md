# Wikipedia の同梱 Web フォント

Wikipedia 閲覧調整で本文・見出しに選択した書体だけを拡張内から読み込みます。PC へのインストールや外部のフォント配信サービスへの接続は不要です。設定画面用の `src/popup/fonts` は別のサブセットです。

`D:\Dev\ReplaceFontSelect\src\fonts` の同梱 WOFF2（2026-11-02 時点）から、通常・太字に必要な12ファイルをバイナリの変更なしで複製しました。各ファイルに含まれる上流の著作権・名称・ライセンス情報を保持しています。

| 書体 | 同梱版 | ファイル |
| --- | --- | --- |
| Noto Sans JP | 2.004-H2 | `NotoSansJP-{Regular,Bold}.woff2` |
| IBM Plex Sans JP | 1.004 | `IBMPlexSansJP-{Regular,Bold}.woff2` |
| M PLUS 2 | 1.100 | `MPLUS2.woff2`（可変書体、通常・太字で共有） |
| M PLUS Rounded 1c | 1.059.20150529 | `MPLUSRounded1c-{Regular,Bold}.woff2` |
| Murecho | 1.010 | `Murecho.woff2`（可変書体、通常・太字で共有） |
| Zen Kaku Gothic New | 1.002 | `ZenKakuGothicNew-{Regular,Bold}.woff2` |
| LINE Seed JP | 1.016 | `LINESeedJP-{Regular,Bold}.woff2` |

同梱版は元プロジェクトのフォント台帳によります。フォントは SIL Open Font License 1.1 で配布されており、全文は [LICENSE](LICENSE)、Rounded M+ の著作権表示は [MPLUSRounded1c-OFL.txt](MPLUSRounded1c-OFL.txt) に収録しています。

配布時にはこのディレクトリとライセンスを含めてください。Web Accessible Resources では WOFF2 のみを Wikipedia に公開します。書体・ファイル対応の正本は `src/lib/actions.js` の `WikipediaReader.FONTS` です。
