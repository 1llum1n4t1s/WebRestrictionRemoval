# 📖 Web Viewing Assist

A Chrome extension that consolidates 8 features for comfortable browsing into a single popup: **Keep session alive** / **YouTube cleaner (29 sub-features including Shorts removal, comment hiding, live-chat hiding, and subscriptions enhancements)** / **Amazon Subscribe & Save monthly total** / **Instagram cleaner (11 sub-features)** / **TikTok cleaner (3 sub-features)** / **Volume Booster** / **Video Gamma** / **Color Picker**. An **image download button (Instagram / TikTok)** is also available as a sub-feature of each cleaner.

> **Notable changes through v1.0.18**: The "restriction removal" features (right-click / selection / force paste & copy) have been fully removed; the Extension is now focused exclusively on web viewing assistance. The Extension was also renamed from "Web Restriction Removal Helper" to "Web Viewing Assist". Version numbers are finalized via the `/vava` skill at release time.

## Features

### 🔄 Keep session alive (opt-in, default OFF)

Mitigates session timeouts on enterprise SharePoint / Box and similar sites.

| Behavior | Description |
|---|---|
| Synthetic activity (default) | At a periodic interval, dispatches conservative `mousemove` / `pointermove` / `scroll` / `focus` events on the top frame of the current site (origin) you enabled in the popup, resetting the site's JS idle detection. No network communication. |
| Same-origin ping (opt-in, default OFF) | When the "Also send a lightweight server ping" sub-toggle is ON, the Extension also issues a GET to `/_api/web` on SharePoint (`*.sharepoint.{com,cn,de,us}`) or a lightweight `HEAD` against the current URL / origin root on other sites, all from the top frame of the enabled site, to help server-side session retention. |
| Interval | Adjustable from 1 to 15 minutes via the popup slider (default 4 minutes). |

No third-party server is contacted. With the HTTP ping enabled, the Extension only issues same-origin `HEAD` / `GET` requests against the user's already-authenticated site.

**Why HTTP ping is OFF by default**: Behind authentication proxies (e.g. Zscaler), automatic access to `/_api/web` can trigger 401/302 loops or generate alerts in enterprise SIEM/WAF logs. The design exposes this only to users who understand the side effects.

**Limitations**: Server-side session retention only works on sites where the same-origin ping actually reaches the authentication backend. Sites that reject `HEAD`, sites where a Service Worker locally answers requests, environments with separate idle timeouts at the auth proxy layer, and tabs frozen by Memory Saver may still experience re-login.

### 🧹 YouTube cleaner (opt-in, default OFF)

Cleans up YouTube search results, watch pages, and the home grid through **29 sub-features** (3 of them subscription enhancements) plus a **home grid column count** setting. Each sub-feature is shown one toggle per row with a detailed description, so you know what will happen before you flip it.

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

Amplifies the active tab's volume from **0% to 300%**. With the **master toggle ON**, the slider is enabled and your settings (gain value, sub-toggles) are persisted globally. At 100% the AudioContext is released to free resources; other values start the amplification pipeline. The "Auto Distortion Guard", "Auto Volume Normalization", and "Night Mode" sub-toggles (all default OFF) enable individual audio nodes. Auto normalization is implemented with short-window RMS measurement via `AnalyserNode` plus an automatic `GainNode`; the distortion guard and Night Mode are implemented with `DynamicsCompressor`.

| Behavior | Description |
|---|---|
| Acquire | `chrome.tabCapture.getMediaStreamId` obtains the active tab's audio stream. |
| Process | The offscreen document's `AudioContext` builds a 6-node chain: `source → normalizerAnalyzer → normalizerGainNode → nightModeNode → gainNode → antiClipNode → destination`, applying loudness correction → compression → user gain → limiter in order before re-output. |
| Release | Master toggle OFF / slider back to 100% with all sub-toggles OFF / tab closed / Extension disabled — any of these immediately releases the stream. |

### 🎞️ Video Gamma (opt-in, default OFF)

Applies gamma correction to `<video>` elements on the page (custom implementation based on SVG `<feComponentTransfer type="gamma">`). Master toggle + slider; the slider center (1.0) means no correction, moving left makes the video darker (max 3.0), moving right makes it brighter (min 0.3). The setting is shared across all tabs, and `<video>` elements inside iframes (e.g. YouTube embeds) also receive the same correction via `all_frames: true`.

### 🎨 Color Picker (always available)

The "Color Picker" tab in the popup uses the `EyeDropper` API to pick a color from anywhere on screen and copy it to the clipboard in HEX / RGB / HSL. Whether to include `#` in HEX is individually configurable. Picked colors are stored as a specimen box (history) of up to 20 entries inside `chrome.storage.local` only — nothing is transmitted externally.

## How to use

1. Click the toolbar icon to open the popup.
2. Toggle features on/off (applied immediately).
3. For Volume Booster, drag the slider to set the amplification ratio.
4. For Color Picker, switch to the "Color Picker" tab and trigger `EyeDropper`.

Settings are stored in `chrome.storage.local` and persist across sessions. **All master toggles default to OFF on first install** (Keep session alive OFF / YouTube cleaner OFF / Amazon total OFF / Instagram cleaner OFF / TikTok cleaner OFF / Volume Booster OFF / Video Gamma OFF). The Extension does not modify any site behavior unless the user opts in. The Volume Booster releases its AudioContext when the master toggle is OFF, or when the master is ON but the slider is at 100% with all sub-toggles OFF.

## Install

### From the Chrome Web Store

Search for "Web Viewing Assist" on the [Chrome Web Store](https://chrome.google.com/webstore) to install.

### Manual install for development

1. Clone this repository.
2. Open `chrome://extensions/`.
3. Enable "Developer mode".
4. Click "Load unpacked" and select the project folder.

## Build

```bash
npm install
npm run build                # generate icons + screenshots
npm run generate-icons       # icons only
npm run generate-screenshots # screenshots only
```

### Generate the store-submission package

```bash
# Windows (PowerShell)
powershell -ExecutionPolicy Bypass -File zip.ps1

# Unix
bash ./zip.sh
```

A `web-viewing-assist.zip` file is produced.

## Technical details

- **Manifest V3** (Chrome 140 or later)
- **Permissions**: `activeTab`, `storage`, `offscreen`, `tabCapture` (for Volume Booster)
- No third-party server communication
- No personal information is collected

### Architecture

```
Popup (src/popup/popup.{html,js,css})
  ──APPLY_SETTINGS──▶ Background (src/background/background.js)
                        │ storage update +
                        ──APPLY_KEEP_ALIVE_CS / APPLY_SEARCH_FIXER_CS / APPLY_AMAZON_DELIVERY_TOTAL_CS / APPLY_INSTAGRAM_CLEANER_CS / APPLY_VIDEO_GAMMA_CS──▶
                          each Content Script

[Volume Booster]
  Popup ──VOLUME_BOOSTER_SET_GAIN (gain, antiClip, normalize, nightMode)──▶ Background
                                    │ chrome.tabCapture.getMediaStreamId
                                    ──ACTION_VOLUME_SET_GAIN──▶ Offscreen Document
                                                                  │ getUserMedia + AudioContext
                                                                  │ source → normalizerAnalyzer → normalizerGainNode → nightModeNode → gainNode → antiClipNode → destination
                                                                  │ (short-window RMS normalization → night-mode compression → manual gain → limiter)
                                                                  └ auto gain correction + compression + amplification, then re-output
```

### How keep-session-alive works

- An `setInterval`-based poller dispatches a bundle of synthetic events (`mousemove` / `pointermove` / `scroll` / `focus`) only on the top frame of enabled origins, and supplementarily fires same-origin HTTP pings.
- SharePoint uses a dedicated GET; other sites use a lightweight `HEAD` fallback.
- Multiple firings inside same-origin iframes are avoided via cross-origin checks.
- On Memory-Saver-frozen tabs, the poller naturally stops.

### How Volume Booster works

- Chrome allows only one offscreen document per extension, so `tabCapture` (USER_MEDIA) and AudioContext output (AUDIO_PLAYBACK) coexist in the same document.
- When the slider is at UNITY (100%) AND all sub-toggles (Auto Distortion Guard / Auto Volume Normalization / Night Mode) are OFF, `getMediaStreamId` is not called and the AudioContext is released. At 100% with any sub-toggle ON, the AudioContext is preserved so auto correction can still apply.
- When a tab is closed, `chrome.tabs.onRemoved` releases immediately (this API fires durably and is not affected by Service Worker restarts).
- While a boost is active, the offscreen document's idle close is suppressed and the AudioContext is preserved.

## Privacy

- No personal information is collected.
- All processing is completed on the user's device.
- See the [Privacy Policy](docs/privacy-policy.en.md) for details.

## License

[MIT License](LICENSE)
