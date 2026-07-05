# Privacy Policy — Vuora

Last updated: June 6, 2026

## Introduction

"Vuora" (formerly "Web Viewing Assist" / "Web Restriction Removal Helper", hereafter "the Extension") respects user privacy and is committed to protecting personal information. This Privacy Policy explains how the Extension handles data.

## Data we collect

The Extension does not collect any personal information.

## Data stored locally

The Extension stores the following settings only on the user's device (`chrome.storage.local`):

- **`searchFixerEnabled`** (boolean): master toggle for the YouTube cleaner (parent of all 32 sub-features including Shorts removal, comment hiding, live-chat hiding, subscriptions enhancements, and the connection monitor).
- **`searchFixerFeatures`** (object): on/off state of each of the 32 YouTube cleaner sub-features (Shorts removal / search-result noise / video-attribute filtering / highlight / watch-page cleanup including comment & live-chat hiding / layout / subscriptions enhancements / connection monitor).
- **`searchFixerGridItems`** (number): YouTube home grid column count (0=auto / 4 / 5 / 6).
- **`amazonDeliveryTotalEnabled`** (boolean): whether the Subscribe & Save monthly-total feature on the Amazon recurring-delivery page is enabled.
- **`amazonRankingJumpEnabled`** (boolean): whether the "Go to this product's ranking" button on Amazon product pages is enabled. Default OFF.
- **`instagramCleanerEnabled`** (boolean): whether the Instagram cleaner is enabled.
- **`instagramCleanerFeatures`** (object): on/off state of each of the 11 Instagram cleaner sub-features (Remove Reels / Remove Explore / Hide Stories tray / Stories URL → home / Hide Threads promotion / Hide vanity counts / Block videos in posts / Hide comments / Hide Notes / Hide unread DM badge / Image download button).
- **`tiktokCleanerEnabled`** (boolean): whether the TikTok cleaner is enabled.
- **`tiktokCleanerFeatures`** (object): on/off state of each of the 3 TikTok cleaner sub-features (Hide comments / Hide suggested accounts / Image download button).
- **`volumeBoosterEnabled`** (boolean): Volume Booster master toggle. Default OFF.
- **`volumeBoosterLastGain`** (number, 0–600): Volume Booster slider position (%). Default 100.
- **`volumeBoosterAntiClipEnabled`** (boolean): whether the Volume Booster's "Auto Distortion Guard" sub-toggle (a `DynamicsCompressor` acting as a fast limiter) is enabled. Default OFF.
- **`volumeBoosterNightModeEnabled`** (boolean): whether the Volume Booster's "Night Mode" sub-toggle (a `DynamicsCompressor` that compresses dynamic range for night listening) is enabled. Default OFF.
- **`volumeBoosterMutedEnabled`** (boolean): the Volume Booster mute toggle. When ON, the `GainNode` is ramped to 0 while the slider value and sub-toggle settings are preserved (the AudioContext is kept alive so unmute can restore the volume instantly). Default OFF.
- **`volumeBoosterEqEnabled`** (boolean): whether the Volume Booster's "10-band graphic equalizer" sub-feature (10 × `BiquadFilterNode(type:"peaking")` + a preamp `GainNode`) is enabled. Default OFF.
- **`volumeBoosterEqGains`** (number array, 10 elements, each -12 to +12 dB): per-band gain values. Band center frequencies: 32 / 64 / 125 / 250 / 500 / 1K / 2K / 4K / 8K / 16K Hz. Default all 0 dB (flat).
- **`volumeBoosterEqPreamp`** (number, -12 to +12 dB): equalizer preamp (overall gain correction). Default 0 dB.
- **`volumeBoosterEqPreset`** (string): selected preset id (`flat` / `bassBoost` / `trebleBoost` / `vocal` / `loudness` / `custom`). Default `flat`. Switches automatically to `custom` when sliders are adjusted manually.
- **`loupeEnabled`** (boolean): Loupe master toggle. Default OFF.
- **`loupeZoom`** (number): Loupe magnification. One of 1.5 / 2.5 / 4.0. Default 2.5.
- **`loupeSize`** (number, 150 – 1000 / 10 px step): Loupe lens diameter in px. Default 220.
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

**On Chrome**, the Volume Booster's current per-tab gain value is held only in the offscreen document's memory and is not persisted. It is released immediately when the tab is closed, when the slider is reset to 100% with all sub-toggles and the mute toggle OFF, or when the Extension is disabled. **On Firefox**, the current gain value is held only in the in-page audio pipeline's memory (see "Tab audio access" below) and is likewise never persisted.

## Tab audio access

When the Volume Booster slider is set to a value other than 100%, or when one of Auto Distortion Guard / Night Mode / Equalizer is enabled (even at 100%), the Extension uses the `chrome.tabCapture` API to obtain the active tab's audio stream and processes it through an `AudioContext` in the offscreen document for compression, amplification, and frequency-band adjustment before re-output. Audio data is never sent externally and is never recorded or stored. The stream is released immediately when the tab is closed, when the slider is reset to 100% with all sub-toggles OFF, or when the Extension is disabled.

**The Firefox edition** cannot use `chrome.tabCapture`, so it uses **in-page Web Audio processing (MediaElementSource)** instead. Only while the Volume Booster is active, the audio output of `<video>` / `<audio>` elements in the page is routed through an `AudioContext` inside the same page for amplification, compression, and frequency-band adjustment. Everything stays inside that page (no offscreen document and no tab audio stream capture); audio data is never recorded, stored, or transmitted. Resetting the settings to neutral or turning the master toggle OFF stops all amplification, compression, and frequency adjustment immediately (audio is routed through unchanged); for technical reasons specific to Firefox, the underlying audio pipeline may remain attached in the background with no audible effect until the media element is removed from the page or the page is closed, since detaching it while media keeps playing is not possible in Firefox without interrupting audio output. This processing is not performed on DRM-protected video sites.

## Tab screen (screenshot) access

While the Loupe master toggle is ON, the Extension uses the `chrome.tabs.captureVisibleTab` API to obtain the **visible area of the active tab** as a JPEG snapshot and displays it as a magnifying lens in the content script DOM. The captured image is converted to a Blob URL and referenced only by the current tab's content script. It is never transmitted or stored outside the Extension's memory (no external server / no local file / no clipboard, etc.). When the master toggle is turned OFF, when the page is left-clicked, when the tab moves to the background, or when the Extension is disabled, the held Blob URL is released immediately via `URL.revokeObjectURL`. Re-capture is triggered automatically on user scroll, on large DOM changes, and on window resize, with a 500 ms debounce that fits within Chrome's official 2 fps rate limit.

## Data sharing

The Extension does not share any data with third parties.

## Network communication

The Extension does not communicate with any third-party external servers, with the two explicit exceptions listed below.

### Exception 1: Image download (Instagram / TikTok cleaner sub-feature)

When the Instagram / TikTok cleaner's "Show download button on images" sub-feature (opt-in, default OFF) is enabled, an image GET is issued only at the moment the user clicks the download button, and only against each site's official CDN (Instagram: `scontent-*.cdninstagram.com` / `scontent-*.fna.fbcdn.net`; TikTok: `p<digits>.tiktokcdn.com` / `p<digits>.tiktokcdn-us.com`). These are the same domains the browser already loads via `<img>` tags. The fetch uses `credentials: "omit"` (no cookies), `redirect: "manual"` (blocks redirect-based third-party transmission), and `referrerPolicy: "no-referrer"` (no referrer). Proxy fetches to other origins are blocked by a hostname allowlist (YouTube does not provide this feature). Downloaded images are saved locally via Blob URL + `<a download>` only; nothing is transmitted externally.

### Exception 2: Connection monitor (YouTube cleaner sub-feature)

When the YouTube cleaner's "Connection monitor" sub-feature (`searchFixerFeatures.connectionMonitor`, opt-in, default OFF) is enabled **and** the user is actively viewing a YouTube live stream, the Extension issues round-trip-time (RTT) measurement fetches to the two public health-check endpoints below every 5 seconds. These measurements feed the in-player HUD that helps the user diagnose buffering causes (their own network / device performance / YouTube CDN / international routing / etc.).

- `https://www.gstatic.com/generate_204` — RTT to a Google edge endpoint
- `https://speed.cloudflare.com/__down?bytes=10` — RTT to a Cloudflare endpoint (international-route baseline)

These fetches run with the following privacy controls:

- `mode: "no-cors"`: the response body is delivered as an **unreadable** (opaque) response. The Extension only measures the round-trip time via `performance.now()` deltas
- `credentials: "omit"`: no cookies are sent
- `referrerPolicy: "no-referrer"`: no referrer is sent
- `AbortSignal.timeout(4500)`: every request is forcibly aborted after 4.5 seconds

**The only information conveyed to the endpoints is "the fact that Vuora is ON" and "the approximate time the user is viewing a live stream."** No user identifier, cookies, YouTube watch history, channel names, video IDs, or other personal data are transmitted (the user's IP address inevitably reaches the destination server as part of the HTTP request protocol, but this is the same property as any ordinary web browsing). The destination URLs are hard-coded constants in `actions.js` and cannot be changed by any user action or setting (a unit test asserts the URLs are fixed). Both endpoints are public measurement endpoints operated by Google and Cloudflare; the Extension does **not** operate any server of its own.

When the connection-monitor sub-feature is OFF, when the YouTube cleaner master toggle is OFF, or when the user is **not** on a YouTube live stream (e.g. watching a VOD or browsing any other page), **none of these fetches are issued**. Measured RTT values are held only in a content-script-scope memory ring buffer (at most 6 samples / 30 seconds of data) and are not persisted. They are discarded immediately when the master toggle / sub-feature is turned OFF or the overlay is removed.

## Permission usage

- **activeTab**: used to access information about the current tab (e.g. determining the target tab for the Volume Booster) when the user changes settings via the popup.
- **storage**: used to save and restore the keys listed in "Data stored locally" on the device.
- **offscreen** (Chrome edition only; not present in the Firefox manifest): used to host an offscreen document (extension context) so the Volume Booster's `AudioContext` can be maintained outside the Service Worker lifecycle.
- **tabCapture** (Chrome edition only; not present in the Firefox manifest): used to capture the active tab's audio stream for amplification, compression, frequency-band adjustment, or muting in the `AudioContext` when the Volume Booster slider is not at 100%, or when any sub-toggle / mute / equalizer is enabled at 100%. No recording, storage, or external transmission is performed.
- **`<all_urls>` host permission**: used by the Loupe feature to call `chrome.tabs.captureVisibleTab` against the active tab and display the visible region as a magnified JPEG image in a circular lens. The `activeTab` permission alone is sometimes revoked early after the popup closes or when SPA pages trigger internal navigations, which blocks the capture. The `<all_urls>` host permission ensures the Loupe runs reliably. Captured images are held as Blob URLs locally and released with `URL.revokeObjectURL` as soon as the lens DOM is removed. No external transmission or storage is performed. Note: this extension already injects content scripts on all http(s) sites for DOM/CSS-only operations, so adding the `<all_urls>` host permission does not change the effective access scope.

## Notable changes through v1.0.18 (already applied)

The "restriction removal" features ("right-click unblock / text-selection unblock / force paste / force copy / custom right-click allowlist") that prior v1.0.x versions provided have been removed. The associated storage keys (`enabled` / `contextMenuAllowDomains` / `volumeBoosterEnabled`) and permissions (`clipboardRead` / `clipboardWrite` / `contextMenus` / `scripting`) have likewise been removed. Legacy keys are removed via `chrome.storage.local.remove` during automatic update.

The Instagram cleaner (`instagramCleanerEnabled` / `instagramCleanerFeatures`) was added at the same time. Both are default OFF (opt-in); Instagram is unaffected unless the user enables them. Instagram cleaner operations are limited to client-side DOM manipulation and CSS application, with no external transmission.

The YouTube Shorts removal feature was integrated as a YouTube cleaner sub-feature `searchFixerFeatures.removeShorts`, and the legacy `ytShortsRemovalEnabled` storage key was removed. On update, users with the legacy key set to `true` have it automatically migrated to `searchFixerFeatures.removeShorts = true` and `searchFixerEnabled = true` before the legacy key is removed, so Shorts removal continues to work.

Since v1.0.18, a "Hide comments" sub-feature has been added to the YouTube cleaner (`searchFixerFeatures.hideComments`), the Volume Booster has gained Auto Distortion Guard / Night Mode sub-toggles (`volumeBoosterAntiClipEnabled` / `volumeBoosterNightModeEnabled`), and an `EyeDropper` API based color picker has been added (`colorPickerHistory` / `colorPickerDefaultFormat` / `colorPickerHexHash`). All new keys default to OFF or to safe-side defaults; site behavior is unaffected until the user interacts with them.

## Contact

For questions about this Privacy Policy, please contact us via the Chrome Web Store support page.

## Changes

This Privacy Policy may be changed without prior notice. When changes are made, this page will be updated.
