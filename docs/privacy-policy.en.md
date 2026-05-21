# Privacy Policy — Web Viewing Assist

Last updated: May 4, 2026

## Introduction

"Web Viewing Assist" (formerly "Web Restriction Removal Helper", hereafter "the Extension") respects user privacy and is committed to protecting personal information. This Privacy Policy explains how the Extension handles data.

## Data we collect

The Extension does not collect any personal information.

## Data stored locally

The Extension stores the following settings only on the user's device (`chrome.storage.local`):

- **`keepAliveEnabled`** (boolean): whether keep-session-alive is enabled.
- **`keepAliveIntervalMs`** (number, milliseconds): polling interval for keep-session-alive (1–15 minutes).
- **`keepAliveHttpPingEnabled`** (boolean): whether the lightweight HTTP ping sub-feature for keep-session-alive is enabled (opt-in, default OFF).
- **`keepAliveOrigins`** (array): list of site origins (e.g. `https://example.com`) for which keep-session-alive has been enabled. Used to scope the feature per-site.
- **`searchFixerEnabled`** (boolean): master toggle for the YouTube cleaner (parent of all 30 sub-features including Shorts removal, comment hiding, live-chat hiding, and subscriptions enhancements).
- **`searchFixerFeatures`** (object): on/off state of each of the 30 YouTube cleaner sub-features (Shorts removal / search-result noise / video-attribute filtering / highlight / watch-page cleanup including comment & live-chat hiding / layout / subscriptions enhancements).
- **`searchFixerGridItems`** (number): YouTube home grid column count (0=auto / 4 / 5 / 6).
- **`amazonDeliveryTotalEnabled`** (boolean): whether the Subscribe & Save monthly-total feature on the Amazon recurring-delivery page is enabled.
- **`amazonRankingJumpEnabled`** (boolean): whether the "Go to this product's ranking" button on Amazon product pages is enabled. Default OFF.
- **`instagramCleanerEnabled`** (boolean): whether the Instagram cleaner is enabled.
- **`instagramCleanerFeatures`** (object): on/off state of each of the 11 Instagram cleaner sub-features (Remove Reels / Remove Explore / Hide Stories tray / Stories URL → home / Hide Threads promotion / Hide vanity counts / Block videos in posts / Hide comments / Hide Notes / Hide unread DM badge / Image download button).
- **`tiktokCleanerEnabled`** (boolean): whether the TikTok cleaner is enabled.
- **`tiktokCleanerFeatures`** (object): on/off state of each of the 3 TikTok cleaner sub-features (Hide comments / Hide suggested accounts / Image download button).
- **`volumeBoosterEnabled`** (boolean): Volume Booster master toggle. Default OFF.
- **`volumeBoosterLastGain`** (number, 0–300): Volume Booster slider position (%). Default 100.
- **`volumeBoosterAntiClipEnabled`** (boolean): whether the Volume Booster's "Auto Distortion Guard" sub-toggle (a `DynamicsCompressor` acting as a fast limiter) is enabled. Default OFF.
- **`volumeBoosterNormalizeEnabled`** (boolean): whether the Volume Booster's "Auto Volume Normalization" sub-toggle is enabled. Implemented with `AnalyserNode` short-window RMS measurement plus an auto `GainNode` (no `DynamicsCompressor` is used). Default OFF.
- **`volumeBoosterNightModeEnabled`** (boolean): whether the Volume Booster's "Night Mode" sub-toggle (a `DynamicsCompressor` that compresses dynamic range for night listening) is enabled. Default OFF.
- **`volumeBoosterMutedEnabled`** (boolean): the Volume Booster mute toggle. When ON, the `GainNode` is ramped to 0 while the slider value and sub-toggle settings are preserved (the AudioContext is kept alive so unmute can restore the volume instantly). Default OFF.
- **`loupeEnabled`** (boolean): Loupe master toggle. Default OFF.
- **`loupeZoom`** (number): Loupe magnification. One of 1.5 / 2.5 / 4.0. Default 2.5.
- **`loupeSize`** (number, 150 – 1000 / 10 px step): Loupe lens diameter in px. Default 220.
- **`rtxEnhancerEnabled`** (boolean): RTX video enhancement master toggle. Default OFF. When ON, inserts a tiny invisible hint element on pages containing `<video>` elements to help GPU drivers (e.g., NVIDIA RTX Super Resolution) detect the video and apply automatic enhancement. No network traffic; DOM insertion only.
- **`videoGammaEnabled`** (boolean): Video Gamma master toggle. Default OFF.
- **`videoGammaValue`** (number, 0.3–3.0): Video Gamma value. Default 1.0 (no correction).
- **`videoFillEnabled`** (boolean): Remove-video-black-bars master toggle. Default OFF.
- **`videoFillMode`** (string, `"zoom"` / `"stretch"`): display mode for black-bar removal (zoom / stretch).
- **`videoFillTarget`** (string): target-monitor aspect-ratio preset id for black-bar removal.
- **`colorPickerHistory`** (array, up to 20 items): history of colors picked with the color picker. Each entry is `{ hex, ts }` where `hex` is `#RRGGBB` and `ts` is the pick timestamp.
- **`colorPickerDefaultFormat`** (string, one of `"hex"` / `"rgb"` / `"hsl"`): default clipboard format for picked colors.
- **`colorPickerHexHash`** (boolean, default true): whether to include the leading `#` when copying in HEX format.
- **`popupLastTab`** (string, one of `"tune"` / `"youtube"` / `"instagram"` / `"tiktok"` / `"picker"`): the last tab the popup had open. Used to restore the popup state on next launch. Legacy value `"assist"` is auto-migrated to `"tune"`.

These values are stored only on the device and are never transmitted to any external server.

The Volume Booster's current per-tab gain value is held only in the offscreen document's memory and is not persisted. It is released immediately when the tab is closed, when the slider is reset to 100% with all sub-toggles and the mute toggle OFF, or when the Extension is disabled.

## Tab audio access

When the Volume Booster slider is set to a value other than 100%, or when one of Auto Distortion Guard / Auto Volume Normalization / Night Mode is enabled (even at 100%), the Extension uses the `chrome.tabCapture` API to obtain the active tab's audio stream and processes it through an `AudioContext` in the offscreen document for normalization, compression, and amplification before re-output. Audio data is never sent externally and is never recorded or stored. The stream is released immediately when the tab is closed, when the slider is reset to 100% with all sub-toggles OFF, or when the Extension is disabled.

## Tab screen (screenshot) access

While the Loupe master toggle is ON, the Extension uses the `chrome.tabs.captureVisibleTab` API to obtain the **visible area of the active tab** as a JPEG snapshot and displays it as a magnifying lens in the content script DOM. The captured image is converted to a Blob URL and referenced only by the current tab's content script. It is never transmitted or stored outside the Extension's memory (no external server / no local file / no clipboard, etc.). When the master toggle is turned OFF, when the page is left-clicked, when the tab moves to the background, or when the Extension is disabled, the held Blob URL is released immediately via `URL.revokeObjectURL`. Re-capture is triggered automatically on user scroll, on large DOM changes, and on window resize, with a 500 ms debounce that fits within Chrome's official 2 fps rate limit.

## Data sharing

The Extension does not share any data with third parties.

## Network communication

The Extension does not communicate with any third-party external servers. When the keep-session-alive feature is enabled, the default behavior is purely client-side: synthetic events (`mousemove` / `pointermove` / `scroll` / `focus`) are dispatched against `document` / `window` in the top frame of an enabled site to reset the site's idle detection. No network communication is involved.

If the user enables the "Also send a lightweight server ping" sub-feature (opt-in, default OFF), the Extension issues `HEAD` or `GET` requests to lightweight endpoints from the top frame of the enabled site (same origin only) to extend server-side session timeouts. For example, on SharePoint (`*.sharepoint.{com,cn,de,us}`), it issues a GET to `/_api/web`; on most other sites, it tries a lightweight HEAD against the current page URL or the origin root. These are communications with the user's already-authenticated site itself, not with any third party. (`credentials: same-origin` ensures cookies are not sent across origins.) In environments behind authentication proxies (e.g. Zscaler), this can trigger 401/302 loops or generate alerts in SIEM logs. We recommend enabling this only after understanding the side effects.

When the Instagram / TikTok cleaner's "Show download button on images" sub-feature (opt-in, default OFF) is enabled, an image GET is issued only at the moment the user clicks the download button, and only against each site's official CDN (Instagram: `scontent-*.cdninstagram.com` / `scontent-*.fna.fbcdn.net`; TikTok: `p<digits>.tiktokcdn.com` / `p<digits>.tiktokcdn-us.com`). These are the same domains the browser already loads via `<img>` tags. The fetch uses `credentials: "omit"` (no cookies), `redirect: "manual"` (blocks redirect-based third-party transmission), and `referrerPolicy: "no-referrer"` (no referrer). Proxy fetches to other origins are blocked by a hostname allowlist (YouTube does not provide this feature). Downloaded images are saved locally via Blob URL + `<a download>` only; nothing is transmitted externally.

## Permission usage

- **activeTab**: used to access information about the current tab (e.g. determining the target tab for the Volume Booster) when the user changes settings via the popup.
- **storage**: used to save and restore the keys listed in "Data stored locally" on the device.
- **offscreen**: used to host an offscreen document (extension context) so the Volume Booster's `AudioContext` can be maintained outside the Service Worker lifecycle.
- **tabCapture**: used to capture the active tab's audio stream for amplification, normalization, compression, or muting in the `AudioContext` when the Volume Booster slider is not at 100%, or when any sub-toggle / mute is enabled at 100%. No recording, storage, or external transmission is performed.

## Notable changes through v1.0.18 (already applied)

The "restriction removal" features ("right-click unblock / text-selection unblock / force paste / force copy / custom right-click allowlist") that prior v1.0.x versions provided have been removed. The associated storage keys (`enabled` / `contextMenuAllowDomains` / `volumeBoosterEnabled`) and permissions (`clipboardRead` / `clipboardWrite` / `contextMenus` / `scripting`) have likewise been removed. Legacy keys are removed via `chrome.storage.local.remove` during automatic update.

The Instagram cleaner (`instagramCleanerEnabled` / `instagramCleanerFeatures`) was added at the same time. Both are default OFF (opt-in); Instagram is unaffected unless the user enables them. Instagram cleaner operations are limited to client-side DOM manipulation and CSS application, with no external transmission.

The YouTube Shorts removal feature was integrated as a YouTube cleaner sub-feature `searchFixerFeatures.removeShorts`, and the legacy `ytShortsRemovalEnabled` storage key was removed. On update, users with the legacy key set to `true` have it automatically migrated to `searchFixerFeatures.removeShorts = true` and `searchFixerEnabled = true` before the legacy key is removed, so Shorts removal continues to work.

Since v1.0.18, a "Hide comments" sub-feature has been added to the YouTube cleaner (`searchFixerFeatures.hideComments`), the Volume Booster has gained Auto Distortion Guard / Auto Volume Normalization / Night Mode sub-toggles (`volumeBoosterAntiClipEnabled` / `volumeBoosterNormalizeEnabled` / `volumeBoosterNightModeEnabled`), and an `EyeDropper` API based color picker has been added (`colorPickerHistory` / `colorPickerDefaultFormat` / `colorPickerHexHash`). All new keys default to OFF or to safe-side defaults; site behavior is unaffected until the user interacts with them.

## Contact

For questions about this Privacy Policy, please contact us via the Chrome Web Store support page.

## Changes

This Privacy Policy may be changed without prior notice. When changes are made, this page will be updated.
