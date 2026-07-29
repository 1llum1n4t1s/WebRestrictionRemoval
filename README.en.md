# 📖 Vuora

> [日本語版](README.md) もあります。

A Chrome / Firefox extension that consolidates **12 features for comfortable browsing** into a single popup.
All features start OFF — opt in only to what you need. Zero external transmission, zero personal data collection.

---

## ✨ Features

| Feature | Description |
|---------|-------------|
| 🧹 **YouTube Enhancements** | Shorts removal / hide comments / hide live chat / subscriptions-as-grid / connection monitor / broadcast-time overlay (show original air time on stream archives) / hide channels from other countries / send to Gemini Notebook and more — **34 sub-features** |
| 🐦 **X cleaner** | Hide the right pane (widening the timeline into it) / trends / who to follow / promoted posts / Premium upsells / Grok / engagement counts + open Home on "Following" (**9 sub-features**) |
| 📦 **Amazon Subscribe & Save monthly total** | Computes per-month total and displays it on the `/auto-deliveries` page |
| 🏆 **Amazon jump-to-ranking button** | Consolidates Bestsellers links from the product detail section, one-click jump to the most specific subcategory |
| 📦 **Amazon seller / shipper badge** | Shows "Sold: XXX / Ships: YYY" at the top of the product page. Amazon-fulfilled = 🟢 green, marketplace = 🟠 orange warning |
| 📷 **Instagram cleaner** | Hide Reels / Explore / Stories tray / Threads promotion etc. + image download (**11 sub-features**) |
| 🎵 **TikTok cleaner** | Hide comments / suggested accounts + image download (**3 sub-features**) |
| 🔊 **Volume Booster** | Amplify tab audio 0–300%. Distortion guard / night mode / wall-thump guard (bass cut) / mute + **10-band graphic equalizer (with presets)** |
| 🎞️ **Video Gamma** | Adjust `<video>` brightness via slider (center 1.0 = no correction, left for darker, right for brighter) |
| 🖥️ **Remove video black bars** | Removes letterbox/pillarbox bars on ultrawide screens (zoom or stretch mode) |
| 🔍 **Loupe** | Cursor-following circular magnifier — perfect for pausing a video and inspecting fine details |
| 🎨 **Color Picker** | Pick a color from the screen and copy as HEX / RGB / HSL, with up to 20 history entries |

> 📥 **Image download** is provided as a sub-feature of the Instagram / TikTok cleaners (overlays a download button on hover for post photos and video thumbnails). Not available on YouTube.

---

## 💾 Install

### Chrome / Edge

Search for **"Vuora"** on the [Chrome Web Store](https://chrome.google.com/webstore).

### Firefox (142 or later)

Search for **"Vuora"** on [addons.mozilla.org](https://addons.mozilla.org/).

> **All 12 features work on Firefox.** The Volume Booster runs on a Firefox-only in-page audio pipeline (MediaElementSource): settings apply to all tabs automatically without opening the popup, and no tab-sharing banner appears. The only limitation: it has no effect on DRM-protected video sites (Netflix, Prime Video, DAZN, Disney+, etc.) — those videos still play normally.

---

## 🚀 How to use

1. Click the toolbar icon to open the popup.
2. **Turn ON only the master toggles you need** (everything is OFF by default).
3. Tune each feature in the popup (the 34 YouTube Enhancements sub-features, Volume Booster slider, etc.).
4. Settings are persisted across sessions.

### Popup tabs
- **Tune**: 11 master toggles + Volume slider + Gamma / Loupe
- **YouTube**: 34 YouTube Enhancements sub-features
- **X**: 9 X cleaner sub-features
- **Instagram**: 11 Instagram cleaner sub-features
- **TikTok**: 3 TikTok cleaner sub-features
- **Color Picker**: EyeDropper + history

---

## 🔒 Privacy

- **Zero external transmission** — this extension does not send anything to any server.
- **No personal data collected** — all processing happens locally on your device.
- **Opt-in by design** — everything is OFF on install; only what you enable runs.
- **Open source** — code is published in this repository for anyone to inspect.

See the [Privacy Policy](docs/privacy-policy.en.md) for details.

---

## 🛡️ Permissions

| Permission | Why |
|------------|-----|
| `activeTab` | Manipulate the active tab from the popup (Volume Booster, Loupe, etc.) |
| `storage` | Persist settings (`chrome.storage.local`) |
| `offscreen` | Keeps the Volume Booster's AudioContext / GainNode chain alive outside the Service Worker |
| `tabCapture` | Captures tab audio for the Volume Booster to amplify 0–300% (all sites) |
| `host_permissions: <all_urls>` | Lets the Loupe keep capturing the screen after popup auto-close / SPA navigation. Effective access scope is the same as the existing content_scripts injection into all http(s) pages |

---

## 🐛 Troubleshooting

| Symptom | Action |
|---------|--------|
| **A setting doesn't take effect** | Close and re-open the popup. If still failing, reload the extension via 🔄 |
| **YouTube sidebar still shows Shorts** | Check that all 4 Shorts sub-toggles (shelf / chip / sidebar / button) under the YouTube Enhancements are individually ON |
| **Volume Booster has no effect (Chrome)** | Boost starts the moment you open the popup on the active tab (user gesture required — works on all sites including EME video like Netflix). Open the popup while the video is playing and adjust the volume. Boosted tabs show a "This tab is being shared" banner (a tabCapture behavior) |
| **Volume Booster has no effect (Firefox)** | The Firefox edition uses in-page processing (MediaElementSource) and applies to all tabs automatically without opening the popup. On DRM-protected video sites (Netflix, Prime Video, DAZN, Disney+, etc.) it cannot work by design — those videos still play normally. If a change does not take effect, reload the page |

---

## 🛠️ For developers

Build / test / CI / architecture details are in [CONTRIBUTING.md](CONTRIBUTING.md).
LLM-oriented implementation conventions and patterns are in [CLAUDE.md](CLAUDE.md).

---

## 📄 License

[MIT License](LICENSE)
