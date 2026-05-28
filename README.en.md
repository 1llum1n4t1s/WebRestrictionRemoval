# 📖 Web Viewing Assist

> [日本語版](README.md) もあります。

A Chrome / Firefox extension that consolidates **13 features for comfortable browsing** into a single popup.
All features start OFF — opt in only to what you need. Zero external transmission, zero personal data collection.

---

## ✨ Features

| Feature | Description |
|---------|-------------|
| 🔄 **Keep session alive** | Mitigates auto-logout on enterprise SharePoint / Box etc. With the master toggle ON, dispatches synthetic activity periodically across all tabs |
| 🧹 **YouTube cleaner** | Shorts removal / hide comments / hide live chat / subscriptions-as-grid and more — **30 sub-features** |
| 📦 **Amazon Subscribe & Save monthly total** | Computes per-month total and displays it on the `/auto-deliveries` page |
| 🏆 **Amazon jump-to-ranking button** | Consolidates Bestsellers links from the product detail section, one-click jump to the most specific subcategory |
| 📦 **Amazon seller / shipper badge** | Shows "Sold: XXX / Ships: YYY" at the top of the product page. Amazon-fulfilled = 🟢 green, marketplace = 🟠 orange warning |
| 📷 **Instagram cleaner** | Hide Reels / Explore / Stories tray / Threads promotion etc. (**11 sub-features**) |
| 🎵 **TikTok cleaner** | Hide comments / suggested accounts (**3 sub-features**) |
| 📥 **Image download** | Overlays a download button on hover for Instagram / TikTok content images and video thumbnails |
| 🔊 **Volume Booster** | Amplify tab audio 0–300%. Distortion guard / auto-normalization / night mode / mute |
| 🎞️ **Video Gamma** | Adjust `<video>` brightness via slider (center 1.0 = no correction, left for darker, right for brighter) |
| 🖥️ **Remove video black bars** | Removes letterbox/pillarbox bars on ultrawide screens (zoom or stretch mode) |
| 🔍 **Loupe** | Cursor-following circular magnifier — perfect for pausing a video and inspecting fine details |
| 🎨 **Color Picker** | Pick a color from the screen and copy as HEX / RGB / HSL, with up to 20 history entries |
| 🎮 **RTX Video Enhancement** | Helps GPU driver-side video enhancement (e.g. NVIDIA RTX Super Resolution) detect video pages |

---

## 💾 Install

### Chrome / Edge

Search for **"Web Viewing Assist"** on the [Chrome Web Store](https://chrome.google.com/webstore).

### Firefox (142 or later)

Search for **"Web Viewing Assist"** on [addons.mozilla.org](https://addons.mozilla.org/).

> On Firefox, the Volume Booster only works on ordinary video sites (YouTube / X / Twitch / TikTok / Instagram / niconico, etc.). EME-heavy sites (Netflix / Prime Video, etc.) are not supported because Firefox does not implement `chrome.tabCapture`. All other 12 features work as on Chrome.

---

## 🚀 How to use

1. Click the toolbar icon to open the popup.
2. **Turn ON only the master toggles you need** (everything is OFF by default).
3. Tune each feature in the popup (YouTube cleaner's 30 sub-features, Volume Booster slider, etc.).
4. Settings are persisted across sessions.

### Popup tabs
- **Tune**: 9 master toggles + Volume slider + Gamma / Loupe / RTX
- **YouTube**: 30 YouTube cleaner sub-features
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
| `offscreen` | Volume Booster EME path (so audio can be boosted on Netflix etc.) |
| `tabCapture` | Same as above |
| `host_permissions: <all_urls>` | Lets the Loupe keep capturing the screen after popup auto-close / SPA navigation. Effective access scope is the same as the existing content_scripts injection into all http(s) pages |

---

## 🐛 Troubleshooting

| Symptom | Action |
|---------|--------|
| **A setting doesn't take effect** | Close and re-open the popup. If still failing, reload the extension via 🔄 |
| **YouTube sidebar still shows Shorts** | Check that all 4 Shorts sub-toggles (shelf / chip / sidebar / button) under the YouTube cleaner are individually ON |
| **Volume Booster has no effect on Netflix (Chrome)** | Netflix is an EME-heavy site, so boost starts the moment you open the popup (user gesture required). Open the popup while the video is playing and adjust the volume |
| **Volume Booster has no effect on Netflix (Firefox)** | Firefox does not support `chrome.tabCapture`, so boost on EME sites is structurally impossible |
| **Keep-session-alive is ON but I still get logged out** | Some sites have idle timeouts at a separate layer (auth proxy etc.) that this feature cannot bypass. Try also enabling the HTTP ping sub-toggle |

---

## 🛠️ For developers

Build / test / CI / architecture details are in [CONTRIBUTING.md](CONTRIBUTING.md).
LLM-oriented implementation conventions and patterns are in [CLAUDE.md](CLAUDE.md).

---

## 📄 License

[MIT License](LICENSE)
