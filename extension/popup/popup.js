/*!
 * KEATS Downloader
 * https://github.com/Saif-AD/keats_downloader
 *
 * Copyright (c) 2026 Saif-AD
 * Released under the MIT License.
 * https://github.com/Saif-AD/keats_downloader/blob/main/LICENSE
 *
 * Original author: Saif-AD. If you are reading this in a fork or copy,
 * the MIT License requires this notice to be preserved in all copies
 * or substantial portions of the Software.
 */

// Popup UI controller

const $ = (sel) => document.querySelector(sel);

const views = {
  notKeats: $('#not-keats'),
  ready: $('#ready'),
  progress: $('#progress'),
  complete: $('#complete'),
};

function showView(name) {
  Object.values(views).forEach(v => v.classList.add('hidden'));
  views[name]?.classList.remove('hidden');
}

function isMoodleCoursePage(url) {
  if (!url) return false;
  return /\/course\/view\.php/.test(url);
}

// Prettier course name for display and folder path. Mirrors the background
// worker's logic so header, save-path and library all agree.
function cleanCourseName(raw) {
  if (!raw || typeof raw !== 'string') return '';
  let name = raw.trim();
  name = name.replace(/\s*\([^)]*(?:\d{2}~\d{2}|SEM|SY|\d{4})[^)]*\)\s*$/i, '');
  const codeToken = '[A-Z]*\\d[A-Z0-9]*';
  const codeRe = new RegExp(`^\\s*(${codeToken})(?:\\s*&\\s*${codeToken})*\\s+(\\S.*)$`);
  const m = name.match(codeRe);
  if (m) return `${m[2].trim()} (${m[1]})`;
  return name;
}

// ---------- Theme toggle ----------

function initTheme() {
  const saved = localStorage.getItem('keats-theme');
  if (saved === 'dark') {
    document.body.classList.add('dark');
    $('#theme-toggle').checked = true;
  } else {
    document.body.classList.remove('dark');
    $('#theme-toggle').checked = false;
  }
}

$('#theme-toggle').addEventListener('change', (e) => {
  if (e.target.checked) {
    document.body.classList.add('dark');
    localStorage.setItem('keats-theme', 'dark');
  } else {
    document.body.classList.remove('dark');
    localStorage.setItem('keats-theme', 'light');
  }
});

// ---------- Download path ----------

async function loadDownloadPath() {
  try {
    const data = await chrome.storage.local.get(['downloadPath', 'overwrite']);
    const path = data.downloadPath || 'KEATS Downloads';
    $('#download-path').value = path;
    autoSizePath();
    const ow = $('#opt-overwrite');
    if (ow) ow.checked = data.overwrite === true;
  } catch (e) {}
}

function autoSizePath() {
  const input = $('#download-path');
  if (input) input.style.width = Math.max(40, input.value.length * 7) + 'px';
}

$('#download-path').addEventListener('input', autoSizePath);
$('#download-path').addEventListener('change', () => {
  const val = $('#download-path').value.trim() || 'KEATS Downloads';
  $('#download-path').value = val;
  chrome.storage.local.set({ downloadPath: val });
  autoSizePath();
});

// ---------- Library ----------

async function loadLibrary() {
  try {
    const history = await sendBg({ type: 'GET_HISTORY' });
    const list = $('#library-list');
    const empty = $('#library-empty');
    const library = $('#library');

    // The last-run row can show even when the library itself is empty — e.g.
    // on a clean install after the user's first cancelled attempt.
    await loadLastRunSummary();

    if (!history || history.total === 0) {
      // Keep the library card visible if we have a last-run to show.
      const row = $('#last-run-row');
      if (row && !row.classList.contains('hidden')) {
        library.classList.remove('hidden');
        list.innerHTML = '';
        empty.classList.remove('hidden');
      } else {
        library.classList.add('hidden');
      }
      return;
    }

    library.classList.remove('hidden');
    list.innerHTML = '';
    empty.classList.add('hidden');

    const courses = Object.entries(history.courses)
      .sort((a, b) => b[1].lastDownload - a[1].lastDownload);

    for (const [name, info] of courses) {
      const date = new Date(info.lastDownload);
      const dateStr = date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
      const displayName = cleanCourseName(name) || name;
      const item = document.createElement('div');
      item.className = 'library-item';
      item.innerHTML = `
        <div class="library-item-info">
          <div class="library-item-name">${esc(displayName)}</div>
          <div class="library-item-meta">${info.count} files · ${dateStr}</div>
        </div>
        <button class="btn-text btn-clear-course" data-course="${esc(name)}">Clear</button>
      `;
      list.appendChild(item);
    }

    list.querySelectorAll('.btn-clear-course').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        const course = e.target.getAttribute('data-course');
        await sendBg({ type: 'CLEAR_HISTORY', course });
        loadLibrary();
      });
    });
  } catch (e) {}
}

$('#btn-clear-all').addEventListener('click', async () => {
  await sendBg({ type: 'CLEAR_HISTORY' });
  loadLibrary();
});

// ---------- Last-run log persistence ----------
//
// The background worker saves the log of the most recent run (complete,
// cancelled or failed) to chrome.storage so users can always review what
// happened, even after clicking Done or after the service worker has been
// suspended between sessions.

function renderLogLines(lines) {
  return lines.map(line => {
    if (line.startsWith('Downloaded:') || line.startsWith('Shortcut saved:')) return `<span class="log-success">${esc(line)}</span>`;
    if (line.startsWith('Failed:') || line.startsWith('Error:')) return `<span class="log-error">${esc(line)}</span>`;
    if (line.startsWith('Skipped')) return `<span class="log-info">${esc(line)}</span>`;
    if (line.startsWith('Course:') || line.startsWith('Sections:') || line.startsWith('Found') || line.startsWith('Done') || line.startsWith('Downloading') || line.startsWith('Format:'))
      return `<span class="log-info">${esc(line)}</span>`;
    return esc(line);
  }).join('\n');
}

async function loadLastRunSummary() {
  try {
    const run = await sendBg({ type: 'GET_LAST_RUN' });
    const row = $('#last-run-row');
    const summary = $('#last-run-summary');
    if (!row || !summary) return;
    if (!run || !run.finishedAt) {
      row.classList.add('hidden');
      return;
    }
    const when = new Date(run.finishedAt);
    const hh = when.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
    const dd = when.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
    const statusWord = run.status === 'complete' ? 'Last run' :
                       run.status === 'cancelled' ? 'Last run (cancelled)' :
                       run.status === 'error' ? 'Last run (error)' : 'Last run';
    summary.textContent = `${statusWord} · ${run.downloadedFiles || 0} ok · ${run.failedFiles || 0} failed · ${dd} ${hh}`;
    row.classList.remove('hidden');
  } catch (e) {}
}

$('#btn-last-run-log')?.addEventListener('click', async () => {
  const container = $('#last-run-log-container');
  const logEl = $('#last-run-log');
  const btn = $('#btn-last-run-log');
  if (!container || !logEl || !btn) return;
  if (!container.classList.contains('hidden')) {
    container.classList.add('hidden');
    btn.textContent = 'View last log';
    return;
  }
  try {
    const run = await sendBg({ type: 'GET_LAST_RUN' });
    logEl.innerHTML = run && Array.isArray(run.log) ? renderLogLines(run.log) : '<span class="log-info">No log saved yet.</span>';
    container.classList.remove('hidden');
    btn.textContent = 'Hide log';
    container.scrollTop = container.scrollHeight;
  } catch (e) {}
});

// ---------- Init ----------

async function init() {
  initTheme();
  await loadDownloadPath();

  // Check if we already have an active download
  try {
    const status = await sendBg({ type: 'GET_STATUS' });
    if (status && (status.status === 'scanning' || status.status === 'downloading')) {
      showView('progress');
      updateProgress(status);
      return;
    }
    if (status && (status.status === 'complete' || status.status === 'cancelled' || status.status === 'error')) {
      showView('complete');
      updateComplete(status);
      return;
    }
  } catch (e) {}

  // Check current tab
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  if (!isMoodleCoursePage(tab?.url)) {
    showView('notKeats');
    loadLibrary();
    return;
  }

  // Scrape course info
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        const h1 = document.querySelector('h1');
        const courseName = h1 ? h1.textContent.trim() : document.title.trim();
        const courseUrl = window.location.href.split('#')[0];
        const gridSections = [];
        const seen = {};
        const sectionLinks = document.querySelectorAll(
          'a[href*="course/section.php?id="], ' +
          'a[href*="course/view.php"][href*="section="], ' +
          '.grid-section a[href], .gridicon_link, #gridicons a[href]'
        );
        for (const link of sectionLinks) {
          const href = link.href.split('#')[0];
          const text = (link.textContent || '').trim().replace(/\s+/g, ' ');
          if (!seen[href] && text && text.length > 1 && !text.startsWith('Go to section')) {
            seen[href] = true;
            gridSections.push({ href, name: text });
          }
        }

        const inlineSectionsArr = [];
        const inlineSections = document.querySelectorAll(
          '#region-main .section.course-section[data-id], ' +
          '#region-main li[id^="section-"][data-id], ' +
          '#region-main .section.main[data-id]'
        );
        for (const sec of inlineSections) {
          const nameEl = sec.querySelector(
            'h3.sectionname, h3.section-title, .sectionname, ' +
            '.section-title a, .sectionhead h3, [data-for="section_title"]'
          );
          const name = nameEl ? nameEl.textContent.trim() : null;
          const sectionId = sec.getAttribute('data-id');
          const sectionNum = sec.getAttribute('data-number');
          if (!sectionId) continue;
          inlineSectionsArr.push({
            href: courseUrl + '#section-inline-' + sectionId,
            name: name || ('Section ' + (sectionNum || sectionId)),
            inline: true,
            sectionId,
          });
        }

        const tabSections = [];
        const tabs = document.querySelectorAll('.onetopic .nav-tabs .nav-link, .onetopic-tab-list a, ul.nav-tabs li a[href*="section="]');
        for (const tab of tabs) {
          const href = tab.href;
          const text = tab.textContent.trim();
          if (href && text && text.length > 0) tabSections.push({ href, name: text });
        }

        // Moodle annotates <body> with format-{topics,weeks,grid,topcoll,
        // onetopic,tiles,flexsections}. Pick the first recognised one up so
        // the background worker can log it, and use it as a tiebreaker when
        // two scrapers find the same number of sections.
        const bodyClass = document.body.className || '';
        const bodyFormatMatch = bodyClass.match(/\bformat-(topics|weeks|grid|topcoll|onetopic|tiles|flexsections)\b/);
        const bodyFormat = bodyFormatMatch ? bodyFormatMatch[1] : null;

        let sections, format;
        const counts = [
          { arr: inlineSectionsArr, fmt: 'topics' },
          { arr: gridSections, fmt: 'grid' },
          { arr: tabSections, fmt: 'onetopic' },
        ];
        counts.sort((a, b) => b.arr.length - a.arr.length);
        sections = counts[0].arr;
        format = bodyFormat || counts[0].fmt;
        return { courseName, sections, courseUrl, format, bodyFormat };
      },
    });

    const info = results[0]?.result;
    if (info && info.courseName) {
      const prettyName = cleanCourseName(info.courseName) || info.courseName;
      $('#course-name').textContent = prettyName;
      $('#path-course-name').textContent = prettyName.substring(0, 40);
      if (info.sections.length > 0) {
        $('#section-count').textContent = info.sections.length;
      } else {
        $('#section-count').textContent = '0';
        info.sections = [{ href: info.courseUrl, name: info.courseName, inline: false }];
      }
      showView('ready');
      window._courseInfo = info;
      window._tabId = tab.id;
    } else {
      showView('notKeats');
    }
  } catch (e) {
    showView('notKeats');
  }
  loadLibrary();

  // Force a fresh accurate scan whenever the popup opens — costs ~1-2s for
  // grid-format courses but means the count we show is from a real walk of
  // every section, not a stale read of just the landing page.
  try {
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (activeTab) {
      await sendBg({ type: 'CHECK_NEW_FILES', tabId: activeTab.id, forceRefresh: true });
      const sessionData = await chrome.storage.session.get(`newFiles:${activeTab.id}`);
      const info = sessionData[`newFiles:${activeTab.id}`];
      const el = $('#new-files-badge');
      if (el && info && info.partialOnly) {
        // Course has some history but no full completed run yet (likely
        // cancelled mid-way). Don't claim anything is "new" — instead nudge
        // toward resuming. No specific count, since the count would just be
        // "everything not yet saved" which isn't actionable as a new-files
        // signal.
        el.textContent = 'previous run was cancelled — pick up where you left off';
        el.title = '';
        el.classList.remove('hidden');
      } else if (el && info && !info.firstVisit && info.count > 0) {
        const items = Array.isArray(info.items) ? info.items : [];
        const preview = items.slice(0, 3).map(i => i.name).join(', ');
        const more = items.length > 3 ? ` (+${items.length - 3} more)` : '';
        el.textContent = `${info.count} new file${info.count > 1 ? 's' : ''} since last download`;
        el.title = preview ? `${preview}${more}` : '';
        el.classList.remove('hidden');
      } else if (el) {
        el.classList.add('hidden');
      }
    }
  } catch (e) {}
}

// ---------- Download button ----------

$('#btn-download').addEventListener('click', async () => {
  const btn = $('#btn-download');
  btn.disabled = true;
  btn.textContent = 'Starting...';
  showView('progress');

  const downloadPath = $('#download-path').value.trim() || 'KEATS Downloads';
  const overwrite = $('#opt-overwrite').checked;
  chrome.storage.local.set({ downloadPath, overwrite });

  await sendBg({
    type: 'START_DOWNLOAD',
    tabId: window._tabId,
    courseInfo: window._courseInfo,
    options: {
      materials: $('#opt-materials').checked,
      videos: $('#opt-videos').checked,
      captures: $('#opt-captures').checked,
      echo360Composite: $('#opt-captures-composite')?.checked === true,
      echo360Audio: $('#opt-captures-audio')?.checked === true,
      folders: $('#opt-folders').checked,
      optional: $('#opt-optional').checked,
      overwrite,
      downloadPath,
    },
  });
});

// ---------- Cancel button ----------

$('#btn-cancel').addEventListener('click', async () => {
  try { await sendBg({ type: 'CANCEL' }); } catch (e) {}
  showView('ready');
  const btn = $('#btn-download');
  btn.disabled = false;
  btn.innerHTML = `
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
      <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/>
      <polyline points="7 10 12 15 17 10"/>
      <line x1="12" y1="15" x2="12" y2="3"/>
    </svg>
    Download All
  `;
  $('#btn-cancel').textContent = 'Cancel';
  $('#btn-cancel').disabled = false;
  loadLibrary();
});

// ---------- Done button ----------

$('#btn-done').addEventListener('click', () => {
  sendBg({ type: 'CANCEL' });
  showView('ready');
  const btn = $('#btn-download');
  btn.disabled = false;
  btn.innerHTML = `
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
      <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/>
      <polyline points="7 10 12 15 17 10"/>
      <line x1="12" y1="15" x2="12" y2="3"/>
    </svg>
    Download All
  `;
  $('#btn-cancel').textContent = 'Cancel';
  $('#btn-cancel').disabled = false;
  $('#complete-log-container')?.classList.add('hidden');
  const showBtn = $('#btn-show-log');
  if (showBtn) showBtn.textContent = 'Show logs';
  loadLibrary();
});

// ---------- Progress updates (push-based, no polling) ----------

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'PROGRESS_UPDATE') {
    const s = msg.state;
    if (s.status === 'scanning' || s.status === 'downloading') {
      showView('progress');
      updateProgress(s);
    } else if (s.status === 'complete' || s.status === 'cancelled' || s.status === 'error') {
      showView('complete');
      updateComplete(s);
    }
  }
});

function updateProgress(s) {
  const statusBadge = $('#progress-status');
  const progressBar = $('#progress-bar');
  const progressCount = $('#progress-count');

  if (s.status === 'scanning') {
    statusBadge.textContent = 'Scanning';
    statusBadge.className = 'status-badge';
    progressBar.classList.add('scanning');
    const scanPct = s.totalSections > 0
      ? Math.round(s.scannedSections / s.totalSections * 100) : 0;
    progressBar.style.width = scanPct + '%';
    progressCount.textContent = s.totalSections > 0
      ? `${s.scannedSections} / ${s.totalSections} sections` : '';
  } else {
    progressBar.classList.remove('scanning');
    statusBadge.textContent = 'Downloading';
    statusBadge.className = 'status-badge downloading';
    const pct = s.totalFiles > 0
      ? Math.round((s.downloadedFiles + s.failedFiles) / s.totalFiles * 100) : 0;
    progressBar.style.width = pct + '%';
    progressCount.textContent = `${s.downloadedFiles + s.failedFiles} / ${s.totalFiles}`;
  }

  $('#current-file').textContent = s.currentFile || '';

  $('#log').innerHTML = renderLogLines(s.log);

  const lc = $('#log-container');
  lc.scrollTop = lc.scrollHeight;
}

function updateComplete(s) {
  const title = $('#complete-title');
  if (s.status === 'cancelled') title.textContent = 'Download Cancelled';
  else if (s.status === 'error') title.textContent = 'Download Error';
  else title.textContent = 'Download Complete';

  $('#stat-downloaded').textContent = s.downloadedFiles;
  $('#stat-failed').textContent = s.failedFiles;
  $('#stat-failed').parentElement.style.display = s.failedFiles > 0 ? 'flex' : 'none';

  const path = $('#download-path')?.value || 'KEATS Downloads';
  $('#save-path').innerHTML = `Saved to <strong>Downloads/${esc(path)}/</strong>`;

  // Populate the complete-view log so "Show logs" has something to render
  // even if the user only opens the popup after the run finished.
  const completeLog = $('#complete-log');
  if (completeLog && Array.isArray(s.log)) {
    completeLog.innerHTML = renderLogLines(s.log);
  }
}

// Show a size warning when the user enables Kaltura video downloads so they
// can decide whether streaming in KEATS would be faster for their purpose.
function refreshVideosHint() {
  const hint = $('#videos-warning');
  const box = $('#opt-videos');
  if (!hint || !box) return;
  if (box.checked) hint.classList.remove('hidden');
  else hint.classList.add('hidden');
}
$('#opt-videos')?.addEventListener('change', refreshVideosHint);
refreshVideosHint();

// Echo360: show the slide-track size hint and the extra-track sub-options
// only when the parent Echo360 checkbox is on.
function refreshCapturesHint() {
  const hint = $('#captures-warning');
  const extras = document.querySelectorAll('.captures-extra');
  const compBox = $('#opt-captures-composite');
  const audioBox = $('#opt-captures-audio');
  const box = $('#opt-captures');
  if (!hint || !box) return;
  if (box.checked) {
    hint.classList.remove('hidden');
    extras.forEach(e => e.classList.remove('hidden'));
  } else {
    hint.classList.add('hidden');
    extras.forEach(e => e.classList.add('hidden'));
    if (compBox) compBox.checked = false;
    if (audioBox) audioBox.checked = false;
  }
}
$('#opt-captures')?.addEventListener('change', refreshCapturesHint);
refreshCapturesHint();

// Open Chrome's own download history in a new tab. Every file the extension
// has written appears there, searchable by "Downloaded by KEATS Downloader".
$('#btn-open-downloads')?.addEventListener('click', () => {
  try { chrome.tabs.create({ url: 'chrome://downloads/' }); } catch (e) {}
});

// Toggle the post-run log visibility.
$('#btn-show-log')?.addEventListener('click', () => {
  const container = $('#complete-log-container');
  const btn = $('#btn-show-log');
  if (!container) return;
  const hidden = container.classList.contains('hidden');
  if (hidden) {
    container.classList.remove('hidden');
    btn.textContent = 'Hide logs';
    const lc = container;
    lc.scrollTop = lc.scrollHeight;
  } else {
    container.classList.add('hidden');
    btn.textContent = 'Show logs';
  }
});

// ---------- Helpers ----------

function sendBg(msg) { return chrome.runtime.sendMessage(msg); }

function esc(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

init();
