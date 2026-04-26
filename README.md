<p align="center">
  <img src="extension/icons/icon128.png" alt="KEATS Downloader" width="80" />
</p>

<h1 align="center">KEATS Downloader</h1>

<p align="center">
  <strong>Download all your KEATS course materials in one click.</strong>
  <br />
  Lecture slides · PDFs · Videos · Podcasts — organised into folders automatically.
</p>

<p align="center">
  <a href="https://chromewebstore.google.com/detail/alcfjagceodkndgakfpejoilijfcedhp"><img src="https://img.shields.io/badge/Chrome_Web_Store-install-c1002a?style=for-the-badge&logo=googlechrome&logoColor=white" alt="Chrome Web Store" /></a>
  <a href="../../releases"><img src="https://img.shields.io/badge/version-1.5.0-c1002a?style=for-the-badge" alt="Version" /></a>
  <a href="../../blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-c1002a?style=for-the-badge" alt="MIT License" /></a>
</p>

---

## Install

### Chrome Web Store

[**Install KEATS Downloader**](https://chromewebstore.google.com/detail/alcfjagceodkndgakfpejoilijfcedhp) — one click, no developer mode needed.

### Manual Install

1. [Download this repo](../../archive/refs/heads/main.zip) and unzip
2. Open `chrome://extensions/`
3. Enable **Developer mode** → click **Load unpacked** → select the `extension/` folder

---

## How It Works

<table>
<tr>
<td width="50%">

1. Go to any KEATS course page
2. Click the extension icon
3. Pick what to download
4. Hit **Download All**

Everything saves to `Downloads/KEATS Downloads/` in organised folders. Run it again later to grab only new files.

</td>
<td width="50%">

**Download options:**
- ✅ Course materials (slides, PDFs, docs)
- ☐ Weekly videos (Kaltura MP4)
- ☐ Lecture captures (Echo360 shortcut)
- ✅ Folder contents
- ☐ Optional resources

> **Heads-up on videos.** Kaltura lectures are typically 15–50 MB each; a full course of 20+ weekly recordings can take half an hour to download. If you just want to watch a lecture once, it's usually faster to stream it in KEATS. Turn on the Kaltura option only when you actually need an offline copy.

</td>
</tr>
</table>

### Folder Structure

```
KEATS Downloads/
  Software Architecture and Design (6CCS3SAD)/
    Week 1 - Topic/
      Lectures/
        lecture_slides.pdf
        podcast.m4a
        Session_1A.mp4
      Tutorials/
        worksheet.pdf
    Assessment/
      Coursework Brief/
        brief.pdf
    Lecture Recordings/
      Lecture - 20 Jan 2026.mp4
```

Subfolders are created from section headings on the course page — lectures, tutorials, assessments, and custom sections are all detected automatically.

---

## a small note from me 😅

sorry, you have to use chrome for this — cba to make a proper desktop app. that's the honest reason.
if the actual live extension on the store isn't fully updated to repo, just unload the extension folder onto chrome://extensions/.

might work fine at other unis too if your moodle is paired with kaltura for embedded videos and/or echo360 for lecture captures — that covers a lot of uk/aus/canadian unis. give it a go on your course page; if anything misbehaves, [open an issue](../../issues) with the run log and i'll have a look.

it's all open source under MIT — if you want to build a proper native mac/windows/linux app, port it to firefox/safari, rewrite it in rust because chrome extensions feel like a war crime — fork it, rip out the chrome bits, take whatever you need. just dont rip it off as your own, credit appreciated ofc<3

— Saif

---

## Features

| Feature | Details |
|---------|---------|
| **Bulk download** | Entire course in one click |
| **Update notifications** | Badge on icon when a course has new files since last download |
| **Smart sync** | Remembers what you've downloaded — only grabs new files on re-run |
| **Smart folders** | Lectures, tutorials, assessments sorted automatically |
| **Parallel downloads** | 3 concurrent downloads with automatic retry |
| **Kaltura videos** | Embedded lecture videos → direct MP4 download |
| **Echo360 captures** | Recorded lectures → direct MP4 download (composite slides + camera) |
| **Folder expansion** | Moodle folders unpacked and downloaded |
| **Download library** | See all courses you've downloaded with file counts |
| **Custom save path** | Choose your download folder name |
| **Optional filtering** | Skip supplementary materials |
| **Progress tracking** | Live progress bar for scanning and downloading |
| **Light / dark mode** | Toggle in the popup |
| **No save dialogs** | Files download silently — no popups |
| **Zero dependencies** | Pure Chrome extension — nothing else needed |

---

## Supported Formats

Works across all KEATS course layouts:

| Layout | Status |
|--------|--------|
| Grid (image tiles) | ✅ |
| Topics (standard) | ✅ |
| Collapsed Topics | ✅ |
| One Topic (tabs) | ✅ |

### Downloadable Content

| Type | Status |
|------|--------|
| Files (PDF, PPTX, DOCX, ZIP, etc.) | ✅ |
| Media (M4A, MP3, MP4, WMV) | ✅ |
| Moodle folders | ✅ Expanded |
| Kaltura videos | ✅ Direct MP4 |
| Echo360 lecture captures | ✅ Direct MP4 (falls back to clickable `.url` shortcut if blocked) |
| External URLs | Skipped |
| Quizzes, forums, assignments | Skipped |

---

## Contributing

Open source — pull requests welcome.

- **Bugs** → [open an issue](../../issues) with a screenshot and course URL
- **PRs** → fork, fix, submit
- **Features** → suggest via issues

---

## Changelog

### v1.5.0
- **Echo360 lectures download as direct MP4** — pulled straight from the Echo360 CDN as progressive MP4 files. Default download is the **slide track** — the clean digital slide capture with lecturer audio, which is what students need for revision. No DRM, no segment muxing, no ffmpeg.
- **Auto-fallback for lectures without a slide track** — some rooms only have camera capture; the extension transparently falls back to the composite (camera angles side-by-side), then to the audio-only track, then to a clickable `.url` shortcut.
- **Two optional sub-tracks** under the Echo360 option, ticked independently:
  - **Composite (camera angles)** — adds the side-by-side room camera view (~500 MB per lecture)
  - **Audio-only track** — small ~30 MB file per lecture, ideal for listening alongside your slide notes
- **Disk dedup applies to Echo360 too** — re-running on a course skips any lecture MP4 already on disk.

### v1.4.1
- **Kaltura videos download as direct MP4** — weekly lecture videos embedded as Kaltura now save straight to disk. No browser playback, no save dialog.
- **Fast Kaltura resolution** — entry IDs parsed from the kalvidres page HTML via direct fetch. A course with 30 videos resolves in seconds instead of several minutes.
- **Echo360 lecture shortcuts** — recorded lectures save as clickable `.url` shortcuts that open the lecture in your browser. Direct download of Echo360 captures is tracked for a future release.
- **Readable course folders** — folders now use `Software Architecture and Design (6CCS3SAD)` instead of the long enrolment string. Applied consistently in the folder path, popup header and library list.
- **Clearer save-folder UI** — an explicit "Save folder (click to rename)" caption above the path bar, and the input itself has a dashed border that highlights on hover so it reads as editable.
- **Replace-on-duplicate toggle** — "Replace files with the same name (otherwise both are kept)" checkbox next to the folder path, with a hover tooltip explaining the behaviour.
- **Filename fixes** — better handling of colons, slashes, control characters, and long names; files that used to fail with "Invalid filename" now download.
- **Kaltura timeout** — videos that can't be resolved no longer hang the scanner; they're skipped with a clear log message and scanning continues.

### v1.4.0
- **Update notifications** — a badge appears on the extension icon when a course has new files since your last download. Open the popup to see how many.

### v1.3.0
- **Smart sync** — the extension remembers every file you've downloaded. Re-running on the same course only downloads new or updated files, skipping everything you already have.
- **Download library** — popup shows all courses you've downloaded with file counts. Clear per-course to force a full re-download.
- **Custom download path** — choose where files are saved within your Downloads folder.
- **Parallel downloads** — 3 files download at once instead of one at a time.
- **Retry with backoff** — failed downloads automatically retry up to 3 times.
- **No save dialogs** — files download silently regardless of your Chrome settings.
- **Progress bars** — live progress during both scanning and downloading phases.
- **Better format support** — improved detection for Grid, Collapsed Topics, and other Moodle layouts.

### v1.0.0
- Initial release. Bulk download of course materials, Kaltura videos, Echo360 lecture captures, smart folder organisation, light/dark mode.

---

## Background

Inspired by the original [keats_downloader](https://github.com/memst/keats_downloader) by [@memst](https://github.com/memst), a Python/Selenium script for Kaltura video downloads. This is a complete rewrite as a Chrome extension — no Python, no Selenium, no ffmpeg. Extends scope to all course materials, adds smart organisation, supports all Moodle formats, and includes Echo360 lecture capture downloads.

---

## License & Attribution

Copyright © 2026 **Saif-AD**. Released under the [MIT License](LICENSE).

You are free to use, modify, and redistribute this code — including for commercial purposes — **provided you keep the copyright notice and the MIT license text in any copies or substantial portions of the software**, as required by the license.

If you fork or redistribute this project, please:

- Keep the `LICENSE` file intact
- Keep the copyright headers in the source files
- Credit the original author: [Saif-AD](https://github.com/Saif-AD) — https://github.com/Saif-AD/keats_downloader

Removing attribution is a license violation and will be reported via GitHub's [DMCA process](https://github.com/contact/dmca-notice).

---

<p align="center">
  <sub>MIT License · Copyright © 2026 <a href="https://github.com/Saif-AD">Saif-AD</a> · Built for KCL students</sub>
  <br />
  <sub>KEATS downloader · KCL KEATS download · King's College London lecture downloader · Moodle course downloader · download KEATS lectures · KEATS bulk download · KCL lecture slides download · KEATS video downloader · Moodle file downloader · university course material downloader</sub>
</p>
