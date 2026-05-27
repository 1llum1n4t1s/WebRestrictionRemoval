# 📖 Web Viewing Assist

A Chrome extension that consolidates 13 features for comfortable browsing into a single popup: **Keep session alive (all tabs)** / **YouTube cleaner (30 sub-features including Shorts removal, comment hiding, live-chat hiding, and subscriptions enhancements)** / **Amazon Subscribe & Save monthly total** / **Amazon jump-to-ranking button** / **Amazon Date First Available display** / **Instagram cleaner (11 sub-features)** / **TikTok cleaner (3 sub-features)** / **Volume Booster (MediaElementSource + tabCapture dual-path)** / **Video Gamma** / **Remove video black bars** / **Loupe** / **RTX Video Enhancer** / **Color Picker**. An **image download button (Instagram / TikTok)** is also available as a sub-feature of each cleaner.

> **Notable changes through v1.0.18**: The "restriction removal" features (right-click / selection / force paste & copy) have been fully removed; the Extension is now focused exclusively on web viewing assistance. The Extension was also renamed from "Web Restriction Removal Helper" to "Web Viewing Assist". Version numbers are finalized via the `/vava` skill at release time.

## Features

### 🔄 Keep session alive (opt-in, default OFF, all tabs)

Mitigates session timeouts on enterprise SharePoint / Box and similar sites. A single master toggle applies to **all http(s) tabs** — this is an all-tabs-shared design (changed in v1.0.33 from the previous site-by-site origin allowlist design).

| Behavior | Description |
|---|---|
| Synthetic activity (default) | While the master toggle is ON, dispatches conservative `mousemove` / `pointermove` / `scroll` / `focus` events on the top frame of every http(s) tab at a periodic interval, resetting each site's JS idle detection. No network communication. |
| Same-origin ping (opt-in, default OFF) | When the "Also send a lightweight server ping" sub-toggle is ON, the Extension also issues a GET to `/_api/web` on SharePoint (`*.sharepoint.{com,cn,de,us}`) or a lightweight `HEAD` against the current URL / origin root on other sites, from the top frame of each tab, to help server-side session retention. |
| Interval | Adjustable from 1 to 15 minutes via the popup slider (default 4 minutes). |

No third-party server is contacted. With the HTTP ping enabled, the Extension only issues same-origin `HEAD` / `GET` requests against each tab's own origin. `credentials: "same-origin"` + `redirect: "manual"` prevent authentication info from leaking to third-party domains.

**Why HTTP ping is OFF by default**: Behind authentication proxies (e.g. Zscaler), automatic access to `/_api/web` can trigger 401/302 loops or generate alerts in enterprise SIEM/WAF logs. The design exposes this only to users who understand the side effects.

**Limitations**: Server-side session retention only works on sites where the same-origin ping actually reaches the authentication backend. Sites that reject `HEAD`, sites where a Service Worker locally answers requests, environments with separate idle timeouts at the auth proxy layer, and tabs frozen by Memory Saver may still experience re-login.

### 🧹 YouTube cleaner (opt-in, default OFF)

Cleans up YouTube search results, watch pages, and the home grid through **30 sub-features** (3 of them subscription enhancements) plus a **home grid column count** setting. Each sub-feature is shown one toggle per row with a detailed description, so you know what will happen before you flip it.

- 📺 **Site-wide**: Shorts removal (sidebar / shelf / chip removal + `/shorts/<id>` → `/watch?v=<id>` redirect)
- 🗑️ **Search-result noise**: video shelf / card list / playlist / mix / course / channel / Shorts shelf / single Shorts / live / related-search block
- 🚫 **Filter by video attribute**: verified / artist / already watched / videos with chapters
- ✨ **Highlight**: grey out keyword non-matches / thumbnail outline
- 🎬 **Watch page**: hide comments / hide live chat
- 📐 **Layout**: grid view for search results + home column count (auto / 4 / 5 / 6)
- 📋 **Subscriptions enhancements**:
    - **Show all subscriptions in left menu**: inject all subscriptions hidden by YouTube's display cap into the left navigation (fetched same-origin from `/feed/channels`, cached 24h in `sessionStorage`)
    - **"All subscriptions" shortcut**: add a one-click entry to `/feed/channels` at the top of the Subscriptions section in the left sidebar, styled like a native menu item
    - **`/feed/channels` as grid**: reshape the long single-column list into a video-feed-style responsive grid with a search box (sort uses YouTube's native dropdown). Each card lazy-fetches the latest video thumbnail when entering the viewport — extracts the Featured `videoId` from the channel HTML and shows `i.ytimg.com/vi/{videoId}/maxresdefault.jpg` (16:9, 1280x720) with `mqdefault.jpg` fallback, cached 24h.

### 📦 Amazon Subscribe & Save monthly total (opt-in, default OFF)

Shows a per-month total on `https://www.amazon.co.jp/auto-deliveries`. The MutationObserver follows a disconnect → write → reconnect pattern to prevent re-firing caused by its own DOM writes.

### 🏆 Amazon jump-to-ranking button (opt-in, default OFF)

The "Amazon Bestsellers Rank" links in a product's detail section appear in different positions on every product page, making them hard to find. This feature consolidates a single "Go to this product's ranking" button at the top of the product info. Clicking it navigates (in the same tab) to the **most specific subcategory** ranking. It only scans `a[href*="bestsellers/"]` inside the product-detail containers and picks the target (the last subcategory link that carries a node id), so the button only appears on product pages that have a ranking link. It is pure DOM manipulation with zero data collection or external transmission.

### 📅 Amazon Date First Available display (opt-in, default OFF)

Extracts the "Date First Available" entry from the Amazon product-detail section and shows it as a **non-clickable info panel** ("📅 Date First Available: YYYY/M/D / about N years ago") at the top of the product info, right next to the jump-to-ranking button. This lets you see at a glance how old a product is — useful for deciding whether to upgrade to a newer model. Same Amazon orange color as the ranking-jump button placed inline. Supports both `bullet list` and `table` DOM structures, and detects both the Japanese label ("取り扱い開始日") and the English label ("Date First Available"). Pure DOM manipulation with zero external transmission.

### 📷 Instagram cleaner (opt-in, default OFF)

A custom implementation that hides Instagram's redundant UI in **11 sub-features**. Selectors are built from semantic attributes such as `aria-label` / `href` / `role` / `data-pagelet` / SVG path data, avoiding obfuscated class names that change per build.

- 🚫 **Main**: Remove Reels (with URL redirect) / Remove Explore / Hide Stories tray / Stories URL → home / Hide Threads promotion
- ✂️ **Extras**: Hide vanity counts / Block videos in posts / Hide comments / Hide Notes / Hide unread DM badge / Image download button

### 🎵 TikTok cleaner (opt-in, default OFF)

A custom implementation that hides TikTok's redundant UI in **3 sub-features**. Selectors are built from semantic attributes such as `data-e2e` and `[class*="DivBrowserModeContainer"]`, avoiding obfuscated class names that change per build.

- 🚫 **Main**: Hide comments / Hide suggested accounts / Image download button

For direct photo / video URL access (`/@user/photo/...`), the entire right panel is hidden ("simple mode"); in the modal viewer (Browser Mode), only `DivCommentListContainer` is hidden so the profile and caption remain visible.

### 📥 Image download (shared sub-feature for Instagram / TikTok)

Toggling the `imageDownload` sub-feature inside the Instagram / TikTok cleaner overlays a download button on the top-left of content images (post photos / video thumbnails) on hover. Clicking saves a `{service}_{YYYYMMDD_HHMMSS}.{ext}` file via Blob URL + `<a download>` (no `downloads` permission added). YouTube does not provide this feature.

Fetches are limited to each site's official CDN (`*.cdninstagram.com` / `scontent-*.fna.fbcdn.net` / `*.tiktokcdn.com` / `*.tiktokcdn-us.com`); proxy fetches to other origins are blocked. The fetch uses `credentials: "omit"` + `redirect: "manual"` + `referrerPolicy: "no-referrer"` to avoid cross-origin auth-info transmission.

### 🔊 Volume Booster (opt-in, default OFF)

Amplifies tab audio from **0% to 300%**. With the **master toggle ON**, the slider is enabled and your settings (gain value, sub-toggles, mute) are persisted globally. At 100% with all sub-toggles and mute OFF the AudioContext is released to free resources; otherwise the amplification pipeline is started. The "Auto Distortion Guard", "Auto Volume Normalization", and "Night Mode" sub-toggles (all default OFF) enable individual audio nodes. A **mute 🔊/🔇 button** sits at the left edge of the slider — clicking it ramps the gain to 0 while preserving the slider value and sub-toggle settings, and clicking again restores the original volume instantly (this is an independent layer from Chrome's native tab mute). Auto normalization is implemented with short-window RMS measurement via `AnalyserNode` plus an automatic `GainNode`; the distortion guard and Night Mode are implemented with `DynamicsCompressor`.

Since v1.0.33 the Volume Booster uses a **MediaElementSource + tabCapture dual-path design**. Ordinary video sites (YouTube / X / Twitch / TikTok / Instagram / niconico, etc.) are boosted via the content script's MES path — **no user gesture required; the boost applies automatically without ever opening the popup**. EME (DRM) heavy sites (Netflix / Prime Video / DAZN / Disney+ / Hulu / Apple TV+ / Abema / U-NEXT / TVer / Spotify, etc. — 15 hosts) are excluded from MES via a hostname blacklist and instead boosted through the tabCapture path triggered when the popup is opened (user gesture required).

| Path | Acquire | Process | When it applies |
|------|---------|---------|----------------|
| **MediaElementSource (default)** | Content script attaches to `<video>` / `<audio>` elements via `ctx.createMediaElementSource(media)` | Same 6-node chain (`source → normalizerAnalyzer → normalizerGainNode → nightModeNode → gainNode → antiClipNode → destination`) built in the content script's AudioContext | **Auto-applies without opening the popup**, even before video playback starts |
| **tabCapture (EME fallback)** | popup → background calls `chrome.tabCapture.getMediaStreamId` to acquire the active tab's audio stream | Same 6-node chain built in the offscreen document's AudioContext | Applies the moment the popup is opened (= user gesture); works on DRM-protected video too |

| Behavior | Description |
|---|---|
| Mute | `gainNode.gain` is ramped to 0 while `lastSetPercent` is preserved. The AudioContext is kept alive so unmute can restore the volume instantly. |
| Release | Master toggle OFF / slider back to 100% with all sub-toggles and mute OFF / tab closed / Extension disabled — any of these immediately releases the stream. |

### 🎞️ Video Gamma (opt-in, default OFF)

Applies gamma correction to `<video>` elements on the page (custom implementation based on SVG `<feComponentTransfer type="gamma">`). Master toggle + slider; the slider center (1.0) means no correction, moving left makes the video darker (max 3.0), moving right makes it brighter (min 0.3). The setting is shared across all tabs, and `<video>` elements inside iframes (e.g. YouTube embeds) also receive the same correction via `all_frames: true`.

### 🖥️ Remove video black bars (opt-in, default OFF)

Removes the letterbox/pillarbox black bars that appear on ultrawide monitors by either **Zoom** (aspect-preserving crop) or **Stretch** (expand only the deficient axis) to fill the screen. Master toggle + display-mode selection + target-monitor preset; the video's own aspect ratio is auto-detected from `videoWidth` / `videoHeight`. The setting is shared across all tabs and `<video>` elements inside iframes also receive the same treatment via `all_frames: true`.

### 🔍 Loupe (opt-in, default OFF)

A circular magnifier that follows the cursor. When the master toggle is ON, the Extension captures the active tab as a JPEG snapshot via `chrome.tabs.captureVisibleTab` and displays it as a `background-image` inside a circular `position: fixed` lens. `mousemove` updates `background-position` at 60 fps using `requestAnimationFrame` coalescing to show the area under the cursor magnified. Because the captured pixels include video / iframe / canvas content, this is ideal for **pausing a video and inspecting fine details**.

| Behavior | Description |
|---|---|
| Zoom | 1.5× / 2.5× / 4× — pick one via the popup segment control. |
| Lens size | Adjustable 150 – 1000 px (default 220 px) via the popup slider. |
| Off | Left-click anywhere on the page while the lens is showing — the lens is removed instantly and the popup toggle flips OFF. |
| Re-capture | Triggered automatically on initial activation, on scroll (500 ms debounced), on large DOM changes (`MutationObserver`), and on window resize. |
| Memory | The captured JPEG is converted to a Blob URL and `URL.revokeObjectURL` is called on cleanup so it is released reliably. |

Note: Chrome's `captureVisibleTab` is rate-limited to 2 fps, so re-capture after scrolling or DOM changes is delayed by up to 500 ms by design. This is unnoticeable for the "pause → inspect → resume" workflow.

### 🎨 Color Picker (always available)

The "Color Picker" tab in the popup uses the `EyeDropper` API to pick a color from anywhere on screen and copy it to the clipboard in HEX / RGB / HSL. Whether to include `#` in HEX is individually configurable. Picked colors are stored as a specimen box (history) of up to 20 entries inside `chrome.storage.local` only — nothing is transmitted externally.

## How to use

1. Click the toolbar icon to open the popup.
2. Toggle features on/off (applied immediately).
3. For Volume Booster, drag the slider to set the amplification ratio.
4. For Color Picker, switch to the "Color Picker" tab and trigger `EyeDropper`.

Settings are stored in `chrome.storage.local` and persist across sessions. **All master toggles default to OFF on first install** (Keep session alive OFF / YouTube cleaner OFF / Amazon total OFF / Amazon ranking jump OFF / Amazon Date First Available OFF / Instagram cleaner OFF / TikTok cleaner OFF / Volume Booster OFF / Video Gamma OFF / Remove video black bars OFF / Loupe OFF / RTX Video Enhancer OFF). The Extension does not modify any site behavior unless the user opts in. The Volume Booster releases its AudioContext when the master toggle is OFF, or when the master is ON but the slider is at 100% with all sub-toggles and the mute toggle OFF.

## Install

### From the Chrome Web Store

Search for "Web Viewing Assist" on the [Chrome Web Store](https://chrome.google.com/webstore) to install.

### From Firefox AMO

Search for "Web Viewing Assist" on [addons.mozilla.org](https://addons.mozilla.org/) to install (Firefox 142 or later). The Firefox build provides the Volume Booster via the MediaElementSource path only — it works on ordinary video sites (YouTube / X / Twitch / TikTok / Instagram / niconico, etc.) but not on EME-heavy sites (Netflix / Prime Video, etc.) because Firefox does not support `chrome.tabCapture` — plus all other 12 features.

### Manual install for development

**Chrome**:
1. Clone this repository.
2. Open `chrome://extensions/`.
3. Enable "Developer mode".
4. Click "Load unpacked" and select the project folder.

**Firefox**:
1. Generate `web-viewing-assist-firefox.xpi` via `powershell -ExecutionPolicy Bypass -File zip.ps1 -Target firefox` (Win) or `./zip.sh firefox` (Unix).
2. Open `about:debugging#/runtime/this-firefox` and use "Load Temporary Add-on" to load the xpi (unloaded when Firefox restarts).
3. Or use `about:addons` → ⚙ → "Install Add-on From File" (signed xpi only; the temporary path is recommended during development).

## Build

```bash
npm install
npm run build                # generate icons + screenshots
npm run generate-icons       # icons only
npm run generate-screenshots # screenshots only
```

### Generate the store-submission package

```bash
# Both Chrome and Firefox
powershell -ExecutionPolicy Bypass -File zip.ps1                  # Win
bash ./zip.sh                                                      # Unix

# Chrome only
powershell -ExecutionPolicy Bypass -File zip.ps1 -Target chrome
bash ./zip.sh chrome

# Firefox only (xpi output)
powershell -ExecutionPolicy Bypass -File zip.ps1 -Target firefox
bash ./zip.sh firefox
```

Outputs:
- `web-viewing-assist-chrome.zip` — Chrome Web Store package (13 features, full dual-path Volume Booster)
- `web-viewing-assist-firefox.xpi` — Firefox AMO package (13 features; Volume Booster is partial — MES path only, ordinary sites only)

### CI auto-publish

Pushing a `release/<X.Y.Z>` branch triggers GitHub Actions to:
1. Submit to **Chrome Web Store** for review (`web-viewing-assist.zip`)
2. Submit to **Firefox AMO** via submission API (`web-ext sign --channel=listed`)

in parallel. Required GitHub Secrets:
- Chrome: `CWS_CLIENT_ID` / `CWS_CLIENT_SECRET` / `CWS_REFRESH_TOKEN` / `CWS_EXTENSION_ID`
- Firefox: `AMO_JWT_ISSUER` / `AMO_JWT_SECRET` ([key page](https://addons.mozilla.org/en-US/developers/addon/api/key/))

Even if Chrome publish fails (e.g. duplicate version upload), the Firefox AMO step runs independently via `if: success() || failure()`.

## Technical details

- **Manifest V3** (Chrome 140+ / Firefox 142+)
- **Permissions**: `activeTab`, `storage`, `offscreen`, `tabCapture` (for the Volume Booster EME fallback path)
- **host_permissions**: `<all_urls>` (added in v1.0.33 so the Loupe's `captureVisibleTab` keeps working after popup auto-close / SPA internal navigation; effective access scope is the same as the existing content_scripts injection into all http(s) pages)
- No third-party server communication
- No personal information is collected

### Architecture

```
Popup (src/popup/popup.{html,js,css})
  ──APPLY_SETTINGS──▶ Background (src/background/background.js)
                        │ storage update +
                        ──APPLY_KEEP_ALIVE_CS / APPLY_SEARCH_FIXER_CS / APPLY_AMAZON_DELIVERY_TOTAL_CS
                          / APPLY_AMAZON_RANKING_JUMP_CS / APPLY_AMAZON_RELEASE_DATE_CS
                          / APPLY_INSTAGRAM_CLEANER_CS / APPLY_TIKTOK_CLEANER_CS
                          / APPLY_VIDEO_GAMMA_CS / APPLY_VIDEO_FILL_CS
                          / APPLY_LOUPE_CS / APPLY_RTX_ENHANCER_CS
                          / APPLY_IMAGE_DOWNLOADER_CS──▶ each Content Script

[Volume Booster — MediaElementSource path (default, v1.0.33+, ordinary sites)]
  Popup ──chrome.storage.local.set (gain, antiClip, normalize, nightMode, muted)──▶ Storage
                                                                                       │ onChanged
  Content Script (src/content/volume-booster.js, all http(s) + all_frames:true) ◀──────┘
    │ isEmeHost(location.hostname) — early return on EME-heavy sites (Netflix, etc.)
    │ detect <video> / <audio> (querySelectorAll on start + MutationObserver for dynamic adds)
    │ ctx.createMediaElementSource(media) to attach
    │ source → normalizerAnalyzer → normalizerGainNode → nightModeNode → gainNode → antiClipNode → destination
    └ no user gesture required; applies automatically before playback even starts (no popup needed)

[Volume Booster — tabCapture path (EME fallback for Netflix / Prime Video / DAZN, etc.)]
  Popup ──VOLUME_BOOSTER_SET_GAIN (gain, antiClip, normalize, nightMode, muted)──▶ Background
                                    │ called from popup when active tab is isEmeUrl
                                    │ chrome.tabCapture.getMediaStreamId
                                    ──ACTION_VOLUME_SET_GAIN──▶ Offscreen Document
                                                                  │ getUserMedia + AudioContext
                                                                  │ source → normalizerAnalyzer → normalizerGainNode → nightModeNode → gainNode → antiClipNode → destination
                                                                  └ captures decrypted output of EME video too (popup required = user gesture)

[Loupe]
  Content Script ──LOUPE_REQUEST_CAPTURE──▶ Background
                                              │ chrome.tabs.captureVisibleTab(windowId, {jpeg, quality:70})
                                              └ JPEG DataURL returned via sendResponse → content script converts to Blob URL and paints into lens
```

### How keep-session-alive works

- An `setInterval`-based poller dispatches a bundle of synthetic events (`mousemove` / `pointermove` / `scroll` / `focus`) on the top frame of every http(s) tab while the master toggle is ON, and supplementarily fires same-origin HTTP pings (v1.0.33 changed this from the previous site-by-site origin allowlist design to an all-tabs-shared design).
- SharePoint uses a dedicated GET; other sites use a lightweight `HEAD` fallback.
- Multiple firings inside same-origin iframes are avoided via cross-origin checks.
- Settings changes propagate to all tabs / frames via `chrome.storage.onChanged`.
- On Memory-Saver-frozen tabs, the poller naturally stops.

### How Volume Booster works (dual-path design, v1.0.33+)

**Path A: MediaElementSource (default, ordinary sites)**:
- The content script (`src/content/volume-booster.js`) is injected into all http(s) pages with `all_frames:true` and attaches to in-page `<video>` / `<audio>` elements via `ctx.createMediaElementSource(media)`.
- **No user gesture required; auto-applies even before video playback starts** (no need to ever open the popup).
- On startup it evaluates `VolumeBooster.isEmeHost(location.hostname)` and early-returns on EME-heavy sites (15 hosts) to prevent total audio silencing.
- State is managed via WeakMap; MutationObserver follows dynamically added videos; works on Firefox MV3 too.

**Path B: tabCapture (EME fallback)**:
- When the popup detects via `VolumeBooster.isEmeUrl(tab.url)` that the active tab is an EME-heavy site, it kicks off the background → offscreen path using `chrome.tabCapture.getMediaStreamId` + `getUserMedia` + AudioContext.
- Chrome allows only one offscreen document per extension, so `tabCapture` (USER_MEDIA) and AudioContext output (AUDIO_PLAYBACK) coexist in the same document.
- Requires popup open (= user gesture); does not work on Firefox because `chrome.tabCapture` is unsupported.

**Common**:
- When the slider is at UNITY (100%) AND all sub-toggles (Auto Distortion Guard / Auto Volume Normalization / Night Mode) and the mute toggle are OFF, both paths release the AudioContext to free resources. At 100% with any sub-toggle or mute ON, the AudioContext is preserved so auto correction or muting can still apply.
- When a tab is closed, `chrome.tabs.onRemoved` releases immediately (this API fires durably and is not affected by Service Worker restarts).
- While a boost is active, the offscreen document's idle close is suppressed and the AudioContext is preserved.

## Privacy

- No personal information is collected.
- All processing is completed on the user's device.
- See the [Privacy Policy](docs/privacy-policy.en.md) for details.

## License

[MIT License](LICENSE)
