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

// Background service worker - orchestrates scraping and downloads
// Supports any Moodle-based LMS (KEATS, Moodle, etc.) + Echo360 lecture recordings


let state = {
  status: 'idle', // idle | scanning | downloading | complete | error | cancelled
  courseName: '',
  totalFiles: 0,
  downloadedFiles: 0,
  failedFiles: 0,
  scannedSections: 0,
  totalSections: 0,
  currentFile: '',
  log: [],
  errors: [],
  sections: [],
  cancelled: false,
};

// ==================== Service worker keep-alive ====================
//
// MV3 service workers are killed after ~30 seconds of idle, which would drop
// our in-memory download queue and the per-download onChanged listeners
// mid-run. Chrome's own download engine keeps streaming bytes, but our JS
// loses the ability to advance to the next file. A periodic alarm keeps the
// worker awake for the duration of a scan/download run.

const KEEPALIVE_ALARM = 'keats-keepalive';

function startKeepAlive() {
  try {
    chrome.alarms.create(KEEPALIVE_ALARM, {
      delayInMinutes: 0.25,
      periodInMinutes: 0.25,
    });
  } catch (e) { /* alarms unavailable — best effort */ }
}

function stopKeepAlive() {
  try { chrome.alarms.clear(KEEPALIVE_ALARM); } catch (e) {}
}

// Top-level listener; firing the alarm is enough to wake the worker if it
// was suspended. The callback doesn't need to do anything — its existence
// resets Chrome's idle timer.
if (typeof chrome !== 'undefined' && chrome.alarms && chrome.alarms.onAlarm) {
  chrome.alarms.onAlarm.addListener(() => { /* keepalive ping */ });
}

// ==================== New file detection ====================

const _recentChecks = {};

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'complete' || !tab.url) return;

  // While a scan/download run is active, leave the toolbar badge alone so
  // the live progress indicator stays visible on every tab including KEATS.
  if (state.status === 'scanning' || state.status === 'downloading') return;

  // Clear badge when navigating away from a course page
  if (!/\/course\/view\.php/.test(tab.url)) {
    chrome.action.setBadgeText({ text: '', tabId });
    return;
  }

  // Debounce: skip if same tab+URL checked in last 60s
  const cacheKey = `${tabId}:${tab.url.split('#')[0]}`;
  const now = Date.now();
  if (_recentChecks[cacheKey] && now - _recentChecks[cacheKey] < 60000) return;
  _recentChecks[cacheKey] = now;

  try { await checkForNewFiles(tabId); } catch (e) {}
});

chrome.tabs.onRemoved.addListener((tabId) => {
  for (const key of Object.keys(_recentChecks)) {
    if (key.startsWith(`${tabId}:`)) delete _recentChecks[key];
  }
});

// Returns a structured snapshot of activities visible in the course-page DOM.
// Activities in collapsed topcoll/topics sections are still in the DOM (only
// CSS-hidden), so a single querySelectorAll catches them without needing to
// click toggles. For grid/tiles/onetopic formats the landing page only shows
// section tiles — we expose those URLs so the caller can fetch each section
// page and merge results.
function scrapeFileHrefsLightweight() {
  const h1 = document.querySelector('h1');
  const courseName = h1 ? h1.textContent.trim() : document.title.trim();

  let format = 'unknown';
  for (const cls of (document.body && document.body.classList) || []) {
    if (cls.startsWith('format-')) { format = cls.replace('format-', ''); break; }
  }

  const cleanName = (txt) => (txt || '').trim().replace(/\n+/g, ' ')
    .replace(/\s*(File|Folder|URL|Page|Kaltura Video (Resource|Presentation)|External tool)\s*/gi, '')
    .replace(/\s+/g, ' ').trim();

  const activities = [];
  const els = document.querySelectorAll(
    '.activity.modtype_resource, ' +
    '.activity.modtype_folder, ' +
    '.activity.modtype_kalvidres, ' +
    '.activity.modtype_kalvidpres, ' +
    '.activity.modtype_lti'
  );
  for (const el of els) {
    let type = 'resource';
    let link = null;
    if (el.classList.contains('modtype_resource')) {
      type = 'resource';
      link = el.querySelector('a[href*="/mod/resource/"]');
    } else if (el.classList.contains('modtype_folder')) {
      type = 'folder';
      link = el.querySelector('a[href*="/mod/folder/"]');
    } else if (el.classList.contains('modtype_kalvidres') || el.classList.contains('modtype_kalvidpres')) {
      type = 'kaltura';
      link = el.querySelector('a[href*="/mod/kalvid"]');
    } else if (el.classList.contains('modtype_lti')) {
      type = 'lti';
      link = el.querySelector('a[href*="/mod/lti/"]');
    }
    if (!link || !link.href) continue;
    const name = cleanName(el.innerText);
    if (!name || name.length < 2) continue;
    activities.push({
      type,
      href: link.href.split('#')[0],
      name,
    });
  }

  // Section subpage URLs — only meaningful when sections live on separate
  // pages (grid/tiles/onetopic/flexsections). For inline formats this list is
  // ignored.
  const sectionUrls = new Set();
  const tileSelectors = [
    'a[href*="/course/view.php"][href*="section="]',
    'a[href*="/course/view.php"][href*="topicid="]',
    '.tile a[href*="/course/view.php"]',
    '.section_link a',
  ];
  for (const sel of tileSelectors) {
    for (const a of document.querySelectorAll(sel)) {
      try {
        const u = new URL(a.href);
        if (!/\/course\/view\.php/.test(u.pathname)) continue;
        if (u.searchParams.has('section') || u.searchParams.has('topicid')) {
          sectionUrls.add(u.toString().split('#')[0]);
        }
      } catch (e) { /* ignore malformed */ }
    }
  }

  return { courseName, format, activities, sectionUrls: [...sectionUrls] };
}

// Runs in the tab's page context so cookies attach automatically. Fetches a
// list of section subpage URLs in parallel, parses each as HTML, extracts
// activities. Used for grid/tiles courses where the landing page is empty.
function fetchSectionActivitiesInPage(urls) {
  const cleanName = (txt) => (txt || '').trim().replace(/\n+/g, ' ')
    .replace(/\s*(File|Folder|URL|Page|Kaltura Video (Resource|Presentation)|External tool)\s*/gi, '')
    .replace(/\s+/g, ' ').trim();

  const parseDoc = (html) => {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const out = [];
    const els = doc.querySelectorAll(
      '.activity.modtype_resource, ' +
      '.activity.modtype_folder, ' +
      '.activity.modtype_kalvidres, ' +
      '.activity.modtype_kalvidpres, ' +
      '.activity.modtype_lti'
    );
    for (const el of els) {
      let type = 'resource';
      let link = null;
      if (el.classList.contains('modtype_resource')) {
        type = 'resource'; link = el.querySelector('a[href*="/mod/resource/"]');
      } else if (el.classList.contains('modtype_folder')) {
        type = 'folder'; link = el.querySelector('a[href*="/mod/folder/"]');
      } else if (el.classList.contains('modtype_kalvidres') || el.classList.contains('modtype_kalvidpres')) {
        type = 'kaltura'; link = el.querySelector('a[href*="/mod/kalvid"]');
      } else if (el.classList.contains('modtype_lti')) {
        type = 'lti'; link = el.querySelector('a[href*="/mod/lti/"]');
      }
      if (!link || !link.href) continue;
      const name = cleanName(el.innerText || el.textContent);
      if (!name || name.length < 2) continue;
      out.push({ type, href: link.href.split('#')[0], name });
    }
    return out;
  };

  return Promise.all(urls.map(async (url) => {
    try {
      const r = await fetch(url, { credentials: 'include' });
      if (!r.ok) return [];
      const html = await r.text();
      return parseDoc(html);
    } catch (e) { return []; }
  })).then((arrs) => {
    const merged = [];
    for (const a of arrs) merged.push(...a);
    return merged;
  });
}

// Course content rarely changes mid-session — once we've done a deep scan we
// reuse the result for this long before re-fetching. Keeps the badge
// responsive without hammering KEATS on every tab reload.
const NEW_FILES_CACHE_TTL_MS = 5 * 60 * 1000;
const MAX_DEEP_SCAN_SECTIONS = 20;

// Build a matchable identity set from download history for one course.
// Match in two dimensions because the underlying href changes shape between
// what's on the page and what we record in history (Kaltura is the obvious
// case: page has /mod/kalvidres/view.php?id=… but history holds the resolved
// playManifest CDN URL). Falling back to lowercased activity name catches
// every case where href shape differs but the title is stable.
// Strip the URL fragment (#anchor) but keep the query string. Moodle uses the
// query string to carry the unique activity id (e.g. ?id=99999) — stripping
// it would collapse every mod/resource/view.php into one identical string and
// the badge would think a course only ever has one resource. We do strip
// known-noise params like &forcedownload=1 that some Moodle download links
// occasionally add.
function normaliseHref(href) {
  if (!href) return '';
  let out = href.split('#')[0];
  // Strip noise params that don't change resource identity
  out = out.replace(/[?&]forcedownload=\d+/g, '').replace(/[?&]redirect=\d+/g, '');
  // Tidy up if stripping left us with a trailing ? or doubled &
  out = out.replace(/\?&/, '?').replace(/\?$/, '');
  return out;
}

function buildKnownIdentity(history, courseName) {
  const knownHrefs = new Set();
  const knownNames = new Set();
  for (const [key, entry] of Object.entries(history)) {
    if (!entry || entry.course !== courseName) continue;
    const parts = key.split('|');
    if (parts.length >= 4) {
      const href = normaliseHref(parts.slice(3).join('|'));
      if (href) knownHrefs.add(href);
    }
    if (entry.name) {
      const norm = String(entry.name).toLowerCase().replace(/\s+/g, ' ').trim();
      if (norm) knownNames.add(norm);
    }
  }
  return { knownHrefs, knownNames };
}

function activityIsKnown(activity, knownHrefs, knownNames) {
  const href = normaliseHref(activity.href || '');
  if (href && knownHrefs.has(href)) return true;
  const name = (activity.name || '').toLowerCase().replace(/\s+/g, ' ').trim();
  if (name && knownNames.has(name)) return true;
  return false;
}

async function checkForNewFiles(tabId, opts = {}) {
  const forceRefresh = opts.forceRefresh === true;

  let scrape;
  try {
    const result = await chrome.scripting.executeScript({
      target: { tabId },
      func: scrapeFileHrefsLightweight,
    });
    scrape = result[0]?.result;
  } catch (e) {
    return; // tab closed or restricted page
  }

  if (!scrape || !scrape.courseName) {
    chrome.action.setBadgeText({ text: '', tabId });
    return;
  }

  const courseName = sanitize(cleanCourseName(scrape.courseName) || scrape.courseName).substring(0, 120);
  const tabInfo = await chrome.tabs.get(tabId).catch(() => null);
  const tabUrl = tabInfo?.url ? tabInfo.url.split('#')[0] : '';
  const cacheKey = tabUrl ? `newFilesCache:${tabUrl}` : null;

  // Decide whether the landing-page DOM is enough or whether we need to walk
  // section subpages (grid/tiles/onetopic etc).
  const needsDeepScan =
    scrape.sectionUrls.length > 0 &&
    (scrape.format === 'grid' || scrape.format === 'tiles' ||
     scrape.format === 'onetopic' || scrape.format === 'flexsections' ||
     scrape.activities.length === 0);

  let activities = scrape.activities;
  let usedCache = false;

  if (cacheKey && !forceRefresh) {
    const stored = (await chrome.storage.session.get(cacheKey))[cacheKey];
    if (stored && Date.now() - stored.scannedAt < NEW_FILES_CACHE_TTL_MS) {
      activities = stored.activities || [];
      usedCache = true;
    }
  }

  if (!usedCache && needsDeepScan) {
    try {
      const subpageUrls = scrape.sectionUrls.slice(0, MAX_DEEP_SCAN_SECTIONS);
      const fetchResult = await chrome.scripting.executeScript({
        target: { tabId },
        args: [subpageUrls],
        func: fetchSectionActivitiesInPage,
      });
      const fetched = fetchResult[0]?.result || [];
      const seen = new Map();
      for (const a of [...activities, ...fetched]) {
        const key = a.href || a.name;
        if (key && !seen.has(key)) seen.set(key, a);
      }
      activities = [...seen.values()];
    } catch (e) {
      // Fall through with whatever the landing page gave us.
    }
  }

  if (!usedCache && cacheKey) {
    try {
      await chrome.storage.session.set({
        [cacheKey]: { activities, scannedAt: Date.now() },
      });
    } catch (e) { /* session storage best-effort */ }
  }

  const history = await getDownloadHistory();
  const completions = await getCourseCompletions();
  const historyCount = Object.values(history).filter(e => e && e.course === courseName).length;
  const { knownHrefs, knownNames } = buildKnownIdentity(history, courseName);

  // Lazy migration for users upgrading from a pre-completion-tracking
  // release. Anything with substantial history (≥20 entries for this
  // course) is almost certainly a course that was fully downloaded at
  // some point — we backfill a completion record so the badge keeps
  // working as before. Anything below the threshold is more likely
  // partial/cancelled and we leave it un-migrated; it'll either get a
  // real completion next time it's re-run, or stay silent in the
  // meantime (the safe default).
  let hasCompleted = !!completions[courseName];
  if (!hasCompleted && historyCount >= 20) {
    await markCourseCompleted(courseName, historyCount);
    hasCompleted = true;
  }

  // Only fire the badge when there's a meaningful baseline. Two "no badge"
  // cases:
  //  1. No history at all → first visit, nothing to compare against.
  //  2. Has partial history but no completed run on record → e.g. user
  //     started downloading then cancelled. The remaining files aren't NEW,
  //     they're just not-yet-downloaded. Saying "96 new since last download"
  //     would be a lie because there was no last download — there was an
  //     abandoned run. The library card already shows "Last run (cancelled)
  //     · 5 ok" so the user has the right context there.
  if ((knownHrefs.size === 0 && knownNames.size === 0) || !hasCompleted) {
    chrome.action.setBadgeText({ text: '', tabId });
    await chrome.storage.session.set({
      [`newFiles:${tabId}`]: {
        count: 0,
        total: activities.length,
        courseName,
        items: [],
        timestamp: Date.now(),
        firstVisit: knownHrefs.size === 0 && knownNames.size === 0,
        partialOnly: !hasCompleted && (knownHrefs.size > 0 || knownNames.size > 0),
      },
    });
    return;
  }

  const newItems = [];
  for (const a of activities) {
    if (!activityIsKnown(a, knownHrefs, knownNames)) newItems.push(a);
  }
  const newCount = newItems.length;

  if (newCount > 0) {
    chrome.action.setBadgeBackgroundColor({ color: '#c1002a', tabId });
    chrome.action.setBadgeText({ text: String(newCount), tabId });
  } else {
    chrome.action.setBadgeText({ text: '', tabId });
  }

  await chrome.storage.session.set({
    [`newFiles:${tabId}`]: {
      count: newCount,
      total: activities.length,
      courseName,
      items: newItems.slice(0, 50),
      timestamp: Date.now(),
      firstVisit: false,
    },
  });
}

// ==================== Download history ====================

async function getDownloadHistory() {
  const data = await chrome.storage.local.get('downloadHistory');
  return data.downloadHistory || {};
}

async function saveDownloadHistory(history) {
  await chrome.storage.local.set({ downloadHistory: history });
}

// Course completion tracking. Distinct from download history: we record the
// timestamp of every run that actually finished (status === 'complete', not
// 'cancelled' or 'error'). The new-files badge only fires after a course has
// at least one completion on record — without this gate, cancelling a run
// halfway through a fresh course would leave the entire un-downloaded
// remainder showing up as "new files since last download" forever, which is
// misleading because they never appeared after a download — the download
// just never finished. Better to stay quiet until the user has done a real
// full pass and there's a meaningful baseline to compare against.
async function getCourseCompletions() {
  const data = await chrome.storage.local.get('courseCompletions');
  return data.courseCompletions || {};
}

async function markCourseCompleted(courseName, fileCount) {
  if (!courseName) return;
  const completions = await getCourseCompletions();
  completions[courseName] = {
    completedAt: Date.now(),
    fileCount: typeof fileCount === 'number' ? fileCount : 0,
  };
  await chrome.storage.local.set({ courseCompletions: completions });
}

// Persist the log of the most recent run so users can always review or debug
// what happened, even after clicking Done or after the service worker has
// been suspended. One entry is kept (most recent terminal state).
async function saveLastRun() {
  try {
    await chrome.storage.local.set({
      lastRun: {
        status: state.status,
        courseName: state.courseName,
        totalFiles: state.totalFiles,
        downloadedFiles: state.downloadedFiles,
        failedFiles: state.failedFiles,
        finishedAt: Date.now(),
        log: Array.isArray(state.log) ? state.log.slice(-500) : [],
        errors: Array.isArray(state.errors) ? state.errors.slice(-50) : [],
      },
    });
  } catch (e) { /* best-effort */ }
}

async function getLastRun() {
  try {
    const data = await chrome.storage.local.get('lastRun');
    return data.lastRun || null;
  } catch (e) {
    return null;
  }
}

function fileKey(courseName, file) {
  // Unique key: course + section + category + href. We prefer the page-level
  // href (file.originalHref) over any resolved CDN URL so that the new-files
  // detector — which only sees what's in the DOM — can match its scraped
  // hrefs against this history. For Kaltura the page DOM has
  // /mod/kalvidres/view.php?id=… while the CDN URL is a one-off playManifest
  // signed URL, so without this preference the badge would always claim
  // every Kaltura video is "new" no matter how many times it was downloaded.
  const href = file.originalHref || file.href;
  return `${courseName}|${file.sectionName || ''}|${file.category || ''}|${href}`;
}

async function markDownloaded(courseName, file, downloadPath) {
  const history = await getDownloadHistory();
  history[fileKey(courseName, file)] = {
    name: file.name,
    path: downloadPath,
    date: Date.now(),
    course: courseName,
  };
  await saveDownloadHistory(history);
}

async function isAlreadyDownloaded(courseName, file) {
  const history = await getDownloadHistory();
  return history[fileKey(courseName, file)] || null;
}

// Build a set of download filenames (basenames) that Chrome already has on
// record as successfully completed. Used as a secondary skip check — catches
// cases where the user re-ran the extension after losing its own history but
// the MP4 is still on disk from an earlier session.
async function buildExistingDownloadSet(courseFolderMatcher) {
  return new Promise((resolve) => {
    try {
      chrome.downloads.search(
        { state: 'complete', exists: true, limit: 5000 },
        (items) => {
          const names = new Set();
          for (const it of items || []) {
            if (!it || !it.filename) continue;
            if (courseFolderMatcher && !courseFolderMatcher.test(it.filename)) continue;
            const base = it.filename.split(/[\\/]/).pop();
            if (base) names.add(base);
          }
          resolve(names);
        }
      );
    } catch (e) {
      resolve(new Set());
    }
  });
}

// ---------- Message handling ----------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  switch (msg.type) {
    case 'START_DOWNLOAD':
      startDownload(msg.tabId, msg.courseInfo, msg.options).catch(err => {
        state.status = 'error';
        addLog(`Error: ${err.message}`);
        broadcastProgress();
      });
      sendResponse({ ok: true });
      break;
    case 'GET_STATUS':
      sendResponse({ ...state });
      break;
    case 'CANCEL':
      if (state.status === 'scanning' || state.status === 'downloading') {
        state.cancelled = true;
        state.status = 'cancelled';
        chrome.downloads.setUiOptions({ enabled: true }).catch(() => {});
        stopKeepAlive();
        saveLastRun().catch(() => {});
        broadcastProgress();
      } else {
        // Reset state when called from "Done"
        state = { status: 'idle', courseName: '', totalFiles: 0, downloadedFiles: 0,
          failedFiles: 0, scannedSections: 0, totalSections: 0, currentFile: '', log: [], errors: [], sections: [], cancelled: false };
        stopKeepAlive();
        updateToolbarBadge();
      }
      sendResponse({ ok: true });
      break;
    case 'GET_LAST_RUN':
      getLastRun().then(run => sendResponse(run));
      return true; // async response
    case 'GET_HISTORY':
      getDownloadHistory().then(h => {
        // Group by course
        const courses = {};
        for (const [key, entry] of Object.entries(h)) {
          const course = entry.course || 'Unknown';
          if (!courses[course]) courses[course] = { count: 0, lastDownload: 0 };
          courses[course].count++;
          if (entry.date > courses[course].lastDownload) courses[course].lastDownload = entry.date;
        }
        sendResponse({ total: Object.keys(h).length, courses });
      });
      return true; // async response
    case 'CLEAR_HISTORY':
      if (msg.course) {
        // Clear history for a specific course
        getDownloadHistory().then(h => {
          for (const [key, entry] of Object.entries(h)) {
            if (entry.course === msg.course) delete h[key];
          }
          saveDownloadHistory(h).then(() => sendResponse({ ok: true }));
        });
      } else {
        saveDownloadHistory({}).then(() => sendResponse({ ok: true }));
      }
      return true; // async response
    case 'CHECK_NEW_FILES':
      checkForNewFiles(msg.tabId, { forceRefresh: msg.forceRefresh === true })
        .then(() => sendResponse({ ok: true }))
        .catch(() => sendResponse({ ok: false }));
      return true;
  }
  return false;
});

// ---------- Fetch file as blob and resolve filename ----------

async function fetchFileBlob(url) {
  const resp = await fetch(url, { redirect: 'follow' });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

  // Resolve filename from headers
  const cd = resp.headers.get('Content-Disposition') || '';
  const match = cd.match(/filename\*?=["']?(?:UTF-8'')?([^"';\r\n]+)/i);
  let filename = null;
  if (match) {
    filename = sanitize(decodeURIComponent(match[1]));
  } else {
    const urlPath = new URL(resp.url).pathname;
    const urlFilename = decodeURIComponent(urlPath.split('/').pop());
    if (urlFilename && urlFilename.includes('.') && !urlFilename.endsWith('.php')) {
      filename = sanitize(urlFilename);
    }
  }

  const blob = await resp.blob();
  return { blob, filename };
}

async function blobToDataUrl(blob) {
  const buffer = await blob.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  const chunks = [];
  for (let i = 0; i < bytes.length; i += 8192) {
    chunks.push(String.fromCharCode.apply(null, bytes.subarray(i, i + 8192)));
  }
  const base64 = btoa(chunks.join(''));
  const mimeType = blob.type || 'application/octet-stream';
  return `data:${mimeType};base64,${base64}`;
}

// Standard Windows .url shortcut format (RFC-compatible; macOS and Linux also
// open these in the default browser when double-clicked).
function buildUrlShortcut(targetUrl) {
  const body = `[InternetShortcut]\r\nURL=${targetUrl}\r\n`;
  return 'data:application/internet-shortcut;base64,' + btoa(body);
}

// ---------- Core workflow ----------

async function startDownload(_tabId, courseInfo, options = {}) {
  const sectionCount = courseInfo?.sections?.length || 0;
  const rawName = courseInfo?.courseName || 'Unknown';
  const cName = cleanCourseName(rawName) || rawName;

  state = {
    status: 'scanning',
    courseName: cName,
    totalFiles: 0,
    downloadedFiles: 0,
    failedFiles: 0,
    scannedSections: 0,
    totalSections: sectionCount,
    currentFile: '',
    log: [],
    errors: [],
    sections: [],
    cancelled: false,
  };

  // Keep the service worker alive for the whole run. Without this, MV3 will
  // suspend it after ~30s of idle and drop our in-memory onChanged listeners
  // mid-download, leaving the queue frozen with files still streaming.
  startKeepAlive();

  const doMaterials = options.materials !== false;
  const doVideos = options.videos === true;
  const doCaptures = options.captures === true;
  const doFolders = options.folders !== false;
  const doOptional = options.optional === true;
  state.overwrite = options.overwrite === true;
  // Pass-through flags read inside the Echo360 phase loop closure.
  options.echo360Composite = options.echo360Composite === true;
  options.echo360Audio = options.echo360Audio === true;

  const courseName = sanitize(cName).substring(0, 120);
  const downloadFolder = sanitize(options.downloadPath || 'KEATS Downloads');
  const basePath = `${downloadFolder}/${courseName}/`;

  addLog(`Course: ${courseName}`);
  addLog(`Sections: ${sectionCount}`);
  const detectedFormat = courseInfo?.format || 'unknown';
  addLog(`Format: ${detectedFormat}`);
  if (doVideos) addLog(`Kaltura video download enabled`);
  if (doCaptures) addLog(`Echo360 capture download enabled`);
  broadcastProgress();

  const tempTab = await chrome.tabs.create({ url: 'about:blank', active: false });
  const tempTabId = tempTab.id;

  try {
    // ==================== Phase 1: Scan sections for files ====================
    const allFiles = [];

    // Phase 1 runs whenever the user wants anything that lives inside a
    // section — not just "materials". Kaltura videos live inside weekly
    // sections, and expanded folder contents do too, so section scanning has
    // to happen even when the user has unticked "course materials".
    if (doMaterials || doVideos || doFolders) {
      // Check if all sections are inline (topics/topcoll format)
      const allInline = courseInfo.sections.every(s => s.inline && s.sectionId);

      if (allInline && courseInfo.sections.length > 0) {
        // Batch scrape: all sections live on one page, scrape them all at once
        const coursePageUrl = courseInfo.courseUrl.split('#')[0];
        addLog(`Scanning all ${courseInfo.sections.length} sections...`);
        broadcastProgress();

        addLog(`Loading course page...`);
        broadcastProgress();
        await navigateTab(tempTabId, coursePageUrl);
        await sleep(1500);

        const sectionIds = courseInfo.sections.map(s => s.sectionId);
        addLog(`Expanding sections...`);
        broadcastProgress();

        // Expand any collapsed sections first, then wait for DOM to update
        const expandedCount = await executeScrape(tempTabId, expandCollapsedSections, sectionIds);
        if (expandedCount > 0) {
          addLog(`Expanded ${expandedCount} collapsed sections`);
          await sleep(1000);
        }

        addLog(`Scraping content...`);
        broadcastProgress();
        const batchResults = await executeScrape(tempTabId, scrapeAllInlineSections, sectionIds, doOptional);

        for (let i = 0; i < courseInfo.sections.length; i++) {
          if (state.cancelled) break;
          const section = courseInfo.sections[i];
          const sectionName = sanitize(section.name);
          if (!sectionName || /^-+$/.test(sectionName)) continue;

          const files = batchResults[section.sectionId] || [];
          const expandedFiles = [];
          for (const file of files) {
            if (state.cancelled) break;
            if (file.type === 'folder' && doFolders) {
              addLog(`  Expanding folder: ${file.name}`);
              await navigateTab(tempTabId, file.href);
              await sleep(800);
              const folderFiles = await executeScrape(tempTabId, scrapeFolderPage);
              for (const ff of folderFiles) {
                ff.category = file.category;
                ff.folderName = file.name;
                expandedFiles.push(ff);
              }
            } else if (file.type === 'kaltura' && doVideos) {
              try {
                const resolved = await resolveKalturaVideo(tempTabId, file);
                if (resolved) {
                  file.originalHref = file.href;
                  file.href = resolved;
                  file.type = 'kalturaDownload';
                  expandedFiles.push(file);
                } else {
                  addLog(`  Could not resolve video: ${file.name}`);
                }
              } catch (e) {
                addLog(`  Video error: ${file.name} - ${e.message}`);
              }
            } else if (file.type !== 'folder' && file.type !== 'kaltura') {
              if (doMaterials) expandedFiles.push(file);
            }
          }

          for (const file of expandedFiles) {
            file.sectionName = sectionName;
            file.courseName = courseName;
          }
          allFiles.push(...expandedFiles);
          state.sections.push({ name: sectionName, fileCount: expandedFiles.length });
          state.scannedSections++;
          addLog(`Scanned: ${sectionName} (${expandedFiles.length} files)`);
          broadcastProgress();
        }
      } else {
        // Grid format or mixed: navigate to each section page
        for (let i = 0; i < courseInfo.sections.length; i++) {
          if (state.cancelled) break;

          const section = courseInfo.sections[i];
          const sectionName = sanitize(section.name);
          if (!sectionName || /^-+$/.test(sectionName)) continue;

          state.scannedSections = i;
          addLog(`Scanning ${i + 1}/${courseInfo.sections.length}: ${sectionName}`);
          broadcastProgress();

          let files;
          if (section.inline && section.sectionId) {
            const coursePageUrl = courseInfo.courseUrl.split('#')[0];
            const currentUrl = await getTabUrl(tempTabId);
            if (!currentUrl || !currentUrl.includes(coursePageUrl.split('?')[0])) {
              await navigateTab(tempTabId, coursePageUrl);
              await sleep(1500);
            }
            files = await executeScrape(tempTabId, scrapeInlineSection, section.sectionId, doOptional);
          } else {
            await navigateTab(tempTabId, section.href);
            await sleep(1000);
            files = await executeScrape(tempTabId, scrapeSectionPage, doOptional);
          }

          const expandedFiles = [];
          for (const file of files) {
            if (state.cancelled) break;
            if (file.type === 'folder' && doFolders) {
              addLog(`  Expanding folder: ${file.name}`);
              await navigateTab(tempTabId, file.href);
              await sleep(800);
              const folderFiles = await executeScrape(tempTabId, scrapeFolderPage);
              for (const ff of folderFiles) {
                ff.category = file.category;
                ff.folderName = file.name;
                expandedFiles.push(ff);
              }
            } else if (file.type === 'kaltura' && doVideos) {
              try {
                const resolved = await resolveKalturaVideo(tempTabId, file);
                if (resolved) {
                  file.originalHref = file.href;
                  file.href = resolved;
                  file.type = 'kalturaDownload';
                  expandedFiles.push(file);
                } else {
                  addLog(`  Could not resolve video: ${file.name}`);
                }
              } catch (e) {
                addLog(`  Video error: ${file.name} - ${e.message}`);
              }
            } else if (file.type !== 'folder' && file.type !== 'kaltura') {
              if (doMaterials) expandedFiles.push(file);
            }
          }

          for (const file of expandedFiles) {
            file.sectionName = sectionName;
            file.courseName = courseName;
          }
          allFiles.push(...expandedFiles);
          state.sections.push({ name: sectionName, fileCount: expandedFiles.length });
          state.scannedSections = i + 1;
          broadcastProgress();
        }
      }
    }

    // ==================== Phase 2: Scan Echo360 for videos ====================
    if (doCaptures && !state.cancelled) {
      addLog(`\nScanning for Echo360 lecture captures...`);
      state.currentFile = 'Looking for Echo360 lecture capture link...';
      broadcastProgress();

      // Find Echo360 LTI link on the main course page
      const coursePageUrl = courseInfo.courseUrl.split('#')[0];
      await navigateTab(tempTabId, coursePageUrl);
      await sleep(2000);

      const ltiLinks = await executeScrape(tempTabId, scrapeEcho360LTI);

      for (const lti of ltiLinks) {
        if (state.cancelled) break;

        addLog(`Checking LTI: ${lti.name}`);
        state.currentFile = `Connecting to Echo360: ${lti.name}`;
        broadcastProgress();

        // Navigate to LTI page first to get the launch URL
        await navigateTab(tempTabId, lti.href);
        await sleep(2000);

        // The LTI view page opens a new window or has a launch link
        // Navigate to the launch URL which redirects to Echo360
        const launchUrl = lti.href.replace('/view.php', '/launch.php') +
          (lti.href.includes('?') ? '&' : '?') + 'triggerview=0';
        await navigateTab(tempTabId, launchUrl);
        await sleep(6000);

        const currentUrl = await getTabUrl(tempTabId);
        if (!currentUrl || !currentUrl.includes('echo360')) {
          if (!lti.isCandidate) addLog(`  Could not access Echo360`);
          continue;
        }

        addLog(`  Connected to Echo360`);

        // Get the Echo360 section ID from the URL
        const sectionMatch = currentUrl.match(/section\/([a-f0-9-]+)/);
        const echo360SectionId = sectionMatch ? sectionMatch[1] : null;

        if (!echo360SectionId) {
          addLog(`  Could not find Echo360 section ID`);
          continue;
        }

        // Fetch syllabus data via Echo360 API (runs in Echo360 page context)
        const syllabusData = await executeScrape(tempTabId, scrapeEcho360Syllabus, echo360SectionId);

        if (!syllabusData || syllabusData.length === 0) {
          addLog(`  No recordings found`);
          continue;
        }

        addLog(`Found ${syllabusData.length} Echo360 recordings`);
        state.currentFile = `Resolving ${syllabusData.length} Echo360 lectures...`;
        broadcastProgress();

        const echoHost = new URL(currentUrl).host;
        const cdnHost = echo360ContentHost(echoHost);

        // Pull the institutionId out of the Echo360 page. The ECHO_JWT
        // cookie is usually HttpOnly so document.cookie can't see it; the
        // PLAY_SESSION cookie embeds an `institution=<uuid>` field in plain
        // form, and the same UUID appears in dozens of places in the
        // classroom page's HTML/JS bootstrap. Try each source in turn so
        // the extension works on any Echo360 deployment.
        let institutionId = null;
        try {
          const probeResult = await chrome.scripting.executeScript({
            target: { tabId: tempTabId },
            func: () => {
              // 1. ECHO_JWT cookie (often HttpOnly — usually unavailable)
              const ej = document.cookie.match(/ECHO_JWT=([^;]+)/);
              if (ej) return { source: 'echo_jwt', value: ej[1] };

              // 2. PLAY_SESSION cookie body has institution=<uuid>
              const ps = document.cookie.match(/PLAY_SESSION=[^;]*?institution=([a-f0-9-]{36})/i);
              if (ps) return { source: 'play_session', value: ps[1] };

              // 3. Page source — institutionId appears in JSON bootstraps
              //    and in REST URLs the player uses
              const html = document.documentElement.outerHTML;
              const inst = html.match(/institutionId["':\s]+["']?([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/i);
              if (inst) return { source: 'page', value: inst[1] };

              return null;
            },
          });
          const probe = probeResult[0]?.result;
          if (probe) {
            if (probe.source === 'echo_jwt') {
              institutionId = parseEcho360InstitutionId(probe.value);
            } else if (/^[a-f0-9-]{36}$/i.test(probe.value)) {
              institutionId = probe.value;
            }
          }
        } catch (e) { /* will fall back below */ }

        // Final fallback for KCL — echo360.org.uk is exclusively KCL within
        // KEATS, so the institutionId is stable. Other universities will
        // either have hit one of the page-scan branches above or land on
        // the .url shortcut path.
        if (!institutionId && /(^|\.)echo360\.org\.uk$/i.test(echoHost)) {
          institutionId = '86e349d2-638d-4bf7-9b75-0b259b92e283';
        }

        if (!institutionId) {
          addLog(`  Could not resolve Echo360 institution ID — falling back to .url shortcuts`);
        }

        for (const recording of syllabusData) {
          if (state.cancelled) break;
          if (!recording.mediaId || !recording.isAvailable) continue;
          if (!recording.lessonId) continue;

          const dateStr = recording.date || 'Unknown Date';
          const lessonUrl = `https://${echoHost}/lesson/${recording.lessonId}/classroom`;

          // Echo360 publishes up to three tracks per lecture:
          //   s0q1 — audio-only stream (no video frame)
          //   s1q1 — the slide recording: clean digital slide capture +
          //          lecturer audio. The view labelled "Video 1" in the
          //          player and what students need for revision.
          //   s2q1 — server-rendered composite (e.g. side-by-side of
          //          slides and camera).
          //
          // Default download is the slide track. Auto-fall through to
          // composite, then audio-only, then a clickable .url shortcut.
          // If "Echo360 all tracks" is on we queue every probe-passing
          // track as separate files.
          const probeStream = async (stream) => {
            const url = buildEcho360Url(cdnHost, institutionId, recording.mediaId, stream);
            try {
              const probeResult = await chrome.scripting.executeScript({
                target: { tabId: tempTabId },
                func: async (u) => {
                  try {
                    const resp = await fetch(u, { method: 'HEAD', credentials: 'include', redirect: 'follow' });
                    return { ok: resp.ok, status: resp.status };
                  } catch (e) {
                    return { ok: false, error: String(e && e.message || e) };
                  }
                },
                args: [url],
              });
              const r = probeResult[0]?.result;
              return r && r.ok ? url : null;
            } catch (e) {
              return null;
            }
          };

          let queued = false;
          if (institutionId && cdnHost) {
            const STREAM_LABEL = { s1q1: 'slides', s2q1: 'composite', s0q1: 'audio' };
            // Priority order for the primary download: slides → composite
            // → audio-only. We always probe in this order and pick the
            // first track that's actually available for this lecture.
            const primaryOrder = ['s1q1', 's2q1', 's0q1'];
            let primaryStream = null;
            let primaryUrl = null;
            for (const stream of primaryOrder) {
              const url = await probeStream(stream);
              if (url) { primaryStream = stream; primaryUrl = url; break; }
            }

            if (primaryStream) {
              allFiles.push({
                name: `${recording.name} - ${dateStr}`,
                href: primaryUrl,
                sectionName: 'Lecture Recordings',
                courseName: courseName,
                type: 'echo360Mp4',
              });
              addLog(`  Echo360 ready (${STREAM_LABEL[primaryStream]}): ${recording.name} - ${dateStr}`);
              queued = true;

              // Optional extra tracks. Each is independently toggleable so
              // students can keep just the audio if they only want to
              // listen alongside notes, or grab the camera angles if they
              // need the room view, without paying for both.
              const extras = [];
              if (options.echo360Composite && primaryStream !== 's2q1') extras.push('s2q1');
              if (options.echo360Audio && primaryStream !== 's0q1') extras.push('s0q1');

              for (const stream of extras) {
                const url = await probeStream(stream);
                if (!url) continue;
                allFiles.push({
                  name: `${recording.name} - ${dateStr} (${STREAM_LABEL[stream]})`,
                  href: url,
                  sectionName: 'Lecture Recordings',
                  courseName: courseName,
                  type: 'echo360Mp4',
                });
                addLog(`    + extra track: ${STREAM_LABEL[stream]}`);
              }
            } else {
              addLog(`  Echo360 MP4 unavailable for ${recording.name} — saving shortcut`);
            }
          }

          if (!queued) {
            allFiles.push({
              name: `${recording.name} - ${dateStr}`,
              href: lessonUrl,
              sectionName: 'Lecture Recordings',
              courseName: courseName,
              type: 'urlShortcut',
            });
          }
        }
      }
      state.currentFile = '';
      broadcastProgress();
    }

    // Remove temp tab
    try { await chrome.tabs.remove(tempTabId); } catch (e) {}

    // ==================== Phase 3: Download files ====================
    const downloadable = allFiles.filter(f =>
      f.type === 'resource' || f.type === 'folderFile' || f.type === 'echo360' ||
      f.type === 'kalturaDownload' || f.type === 'echo360Mp4' || f.type === 'urlShortcut'
    );

    // Filter out already-downloaded files using two checks:
    //  (1) internal fileKey history — same href was downloaded before;
    //  (2) disk-level Chrome downloads history — a file with the predicted
    //      filename is still present on disk (catches videos the user kept
    //      from an earlier run even if our history was cleared).
    const courseFolderRe = new RegExp('/' + courseName.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&') + '/', 'i');
    const onDiskFilenames = await buildExistingDownloadSet(courseFolderRe);
    let skippedFiles = 0;
    let skippedOnDisk = 0;
    const toDownload = [];
    for (const file of downloadable) {
      const existing = await isAlreadyDownloaded(courseName, file);
      if (existing) {
        skippedFiles++;
        continue;
      }
      const predicted = predictFilename(file);
      if (predicted && onDiskFilenames.has(predicted)) {
        skippedOnDisk++;
        await markDownloaded(courseName, file, basePath);
        continue;
      }
      toDownload.push(file);
    }

    if (skippedFiles > 0) {
      addLog(`\nSkipped ${skippedFiles} previously downloaded files`);
    }
    if (skippedOnDisk > 0) {
      addLog(`Skipped ${skippedOnDisk} videos already present on disk`);
    }

    state.totalFiles = toDownload.length;
    state.status = 'downloading';
    addLog(`Downloading ${toDownload.length} new files...`);
    broadcastProgress();

    if (state.cancelled) return;

    // Hide Chrome's download bar/bubble during bulk download
    try { await chrome.downloads.setUiOptions({ enabled: false }); } catch (e) {}

    const CONCURRENCY = 3;
    let idx = 0;

    async function worker() {
      while (idx < toDownload.length && !state.cancelled) {
        const file = toDownload[idx++];
        state.currentFile = file.name;
        broadcastProgress();

        try {
          await downloadWithRetry(file, basePath, 3);
          state.downloadedFiles++;
          await markDownloaded(courseName, file, basePath);
          if (file.type === 'urlShortcut') {
            addLog(`Shortcut saved: ${file.name}`);
          } else {
            addLog(`Downloaded: ${file.name}`);
          }
        } catch (err) {
          state.failedFiles++;
          state.errors.push({ name: file.name, error: err.message || String(err) });
          addLog(`Failed: ${file.name} - ${err.message || err}`);
        }
        broadcastProgress();
      }
    }

    await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

    // Re-enable Chrome's download UI
    try { await chrome.downloads.setUiOptions({ enabled: true }); } catch (e) {}

    state.status = state.cancelled ? 'cancelled' : 'complete';
    state.currentFile = '';
    addLog(`\nDone! ${state.downloadedFiles} downloaded, ${state.failedFiles} failed.${skippedFiles > 0 ? ` ${skippedFiles} skipped (already downloaded).` : ''}`);
    stopKeepAlive();
    if (state.status === 'complete') {
      await markCourseCompleted(courseName, state.downloadedFiles + skippedFiles);
    }
    await saveLastRun();
    broadcastProgress();

    // Clear new-files badges on all tabs
    try {
      const tabs = await chrome.tabs.query({});
      for (const t of tabs) {
        chrome.action.setBadgeText({ text: '', tabId: t.id });
      }
    } catch (e) {}

  } catch (err) {
    state.status = 'error';
    addLog(`Error: ${err.message}`);
    stopKeepAlive();
    await saveLastRun();
    broadcastProgress();
    try { await chrome.tabs.remove(tempTabId); } catch (e) {}
    try { await chrome.downloads.setUiOptions({ enabled: true }); } catch (e) {}
  }

}

// ==================== Scraping functions (injected into tabs) ====================

function scrapeSectionPage(includeOptional) {
  const results = [];
  let currentCategory = 'other';
  let isOptional = false;

  const activities = document.querySelectorAll('.activity');
  for (const el of activities) {
    if (el.classList.contains('modtype_label')) {
      const raw = el.innerText.trim();
      if (!raw || /^-+$/.test(raw) || raw.length < 3) continue;

      const firstLine = raw.split('\n')[0].trim();
      if (firstLine.length < 3 || firstLine.length > 120) continue;

      const fl = firstLine.toUpperCase();

      // Detect optional/mandatory markers
      if (fl.includes('OPTIONAL')) { isOptional = true; }
      if (fl.includes('MANDATORY') || fl.includes('REQUIRED') || fl.includes('CORE')) { isOptional = false; }

      if (fl.includes('LECTURE MATERIAL') || fl.includes('LECTURE SLIDES') ||
          fl.includes('LECTURE PODCAST') ||
          (fl.includes('WEEK') && fl.includes('LECTURE'))) {
        currentCategory = 'Lectures';
      } else if (fl.includes('TUTORIAL MATERIAL') || fl.includes('TUTORIAL SLIDES') ||
                 fl.includes('TUTORIAL PRE-READING') || fl.includes('TUTORIAL PREPARATION') ||
                 fl.includes('SEMINAR MATERIAL')) {
        currentCategory = 'Tutorials';
      } else {
        const isHeading = firstLine.length <= 80 &&
          /^[A-Z]/.test(firstLine) &&
          !firstLine.includes('. ') &&
          firstLine.split(' ').length <= 12;

        if (isHeading) {
          currentCategory = firstLine.replace(/[/\\?%*:|"<>]/g, '-').substring(0, 60).trim();
        }
      }
      continue;
    }

    // Skip optional resources unless user opted in
    if (isOptional && !includeOptional) continue;

    if (el.classList.contains('modtype_resource')) {
      const link = el.querySelector('a[href*="/mod/resource/"]');
      if (!link) continue;
      const name = el.innerText.trim().replace(/\n/g, ' ').replace(/\s*(File|Folder)\s*/g, '').trim();
      if (!name || name.length < 2) continue;
      results.push({ name, href: link.href, category: currentCategory, type: 'resource', optional: isOptional });
    }

    if (el.classList.contains('modtype_folder')) {
      const link = el.querySelector('a[href*="/mod/folder/"]');
      if (!link) continue;
      const name = el.innerText.trim().replace(/\n/g, ' ').replace(/\s*(File|Folder)\s*/g, '').trim();
      if (!name || name.length < 2) continue;
      results.push({ name, href: link.href, category: currentCategory, type: 'folder', optional: isOptional });
    }

    // Kaltura video resources
    if (el.classList.contains('modtype_kalvidres') || el.classList.contains('modtype_kalvidpres')) {
      const link = el.querySelector('a[href*="/mod/kalvid"]');
      if (!link) continue;
      const name = el.innerText.trim().replace(/\n/g, ' ')
        .replace(/\s*Kaltura Video (Resource|Presentation)\s*/gi, '').trim();
      if (!name || name.length < 2) continue;
      results.push({ name, href: link.href, category: currentCategory, type: 'kaltura', optional: isOptional });
    }
  }

  return results;
}

function scrapeInlineSection(sectionId, includeOptional) {
  // Find the section — try multiple selectors for different Moodle formats
  let section = document.querySelector(
    `.section.course-section[data-id="${sectionId}"], ` +
    `.section.main[data-id="${sectionId}"], ` +
    `li[id^="section-"][data-id="${sectionId}"]`
  );
  if (!section) return [];

  // For topcoll format, expand the section if collapsed
  const toggle = section.querySelector('.toggle_closed');
  if (toggle) { toggle.click(); }

  const results = [];
  let currentCategory = 'other';
  let isOptional = false;

  // Get activities — look in the section and any toggled content divs inside it
  const activities = section.querySelectorAll('.activity');
  for (const el of activities) {
    if (el.classList.contains('modtype_label')) {
      const raw = el.innerText.trim();
      if (!raw || /^-+$/.test(raw) || raw.length < 3) continue;
      const firstLine = raw.split('\n')[0].trim();
      if (firstLine.length < 3 || firstLine.length > 120) continue;
      const fl = firstLine.toUpperCase();

      if (fl.includes('OPTIONAL')) { isOptional = true; }
      if (fl.includes('MANDATORY') || fl.includes('REQUIRED') || fl.includes('CORE')) { isOptional = false; }

      if (fl.includes('LECTURE MATERIAL') || fl.includes('LECTURE SLIDES') ||
          fl.includes('LECTURE PODCAST') ||
          (fl.includes('WEEK') && fl.includes('LECTURE'))) {
        currentCategory = 'Lectures';
      } else if (fl.includes('TUTORIAL MATERIAL') || fl.includes('TUTORIAL SLIDES') ||
                 fl.includes('TUTORIAL PRE-READING') || fl.includes('TUTORIAL PREPARATION') ||
                 fl.includes('SEMINAR MATERIAL')) {
        currentCategory = 'Tutorials';
      } else {
        const isHeading = firstLine.length <= 80 &&
          /^[A-Z]/.test(firstLine) &&
          !firstLine.includes('. ') &&
          firstLine.split(' ').length <= 12;
        if (isHeading) {
          currentCategory = firstLine.replace(/[/\\?%*:|"<>]/g, '-').substring(0, 60).trim();
        }
      }
      continue;
    }

    if (isOptional && !includeOptional) continue;

    if (el.classList.contains('modtype_resource')) {
      const link = el.querySelector('a[href*="/mod/resource/"]');
      if (!link) continue;
      const name = el.innerText.trim().replace(/\n/g, ' ').replace(/\s*(File|Folder)\s*/g, '').trim();
      if (!name || name.length < 2) continue;
      results.push({ name, href: link.href, category: currentCategory, type: 'resource' });
    }

    if (el.classList.contains('modtype_folder')) {
      const link = el.querySelector('a[href*="/mod/folder/"]');
      if (!link) continue;
      const name = el.innerText.trim().replace(/\n/g, ' ').replace(/\s*(File|Folder)\s*/g, '').trim();
      if (!name || name.length < 2) continue;
      results.push({ name, href: link.href, category: currentCategory, type: 'folder' });
    }

    if (el.classList.contains('modtype_kalvidres') || el.classList.contains('modtype_kalvidpres')) {
      const link = el.querySelector('a[href*="/mod/kalvid"]');
      if (!link) continue;
      const name = el.innerText.trim().replace(/\n/g, ' ')
        .replace(/\s*Kaltura Video (Resource|Presentation)\s*/gi, '').trim();
      if (!name || name.length < 2) continue;
      results.push({ name, href: link.href, category: currentCategory, type: 'kaltura', optional: isOptional });
    }
  }

  return results;
}

function expandCollapsedSections(sectionIds) {
  // Click every collapsed toggle so its content becomes scrape-able. We look
  // for the three patterns that show up across Moodle format variants:
  //   * legacy topcoll: .toggle_closed
  //   * Boost collapse states: .toggled-off / .collapsed around the section header
  //   * modern topcoll (ES6 rewrite) + tiles: [aria-expanded="false"]
  let expanded = 0;
  for (const sectionId of sectionIds) {
    const section = document.querySelector(
      `.section.course-section[data-id="${sectionId}"], ` +
      `.section.main[data-id="${sectionId}"], ` +
      `li[id^="section-"][data-id="${sectionId}"]`
    );
    if (!section) continue;
    const toggle = section.querySelector(
      '.toggle_closed, ' +
      '.toggled-off .sectionname a, ' +
      '.collapsed .sectionname a, ' +
      '[aria-expanded="false"]'
    );
    if (toggle) { toggle.click(); expanded++; }
  }
  return expanded;
}

function scrapeAllInlineSections(sectionIds, includeOptional) {
  const resultMap = {};

  for (const sectionId of sectionIds) {
    const section = document.querySelector(
      `.section.course-section[data-id="${sectionId}"], ` +
      `.section.main[data-id="${sectionId}"], ` +
      `li[id^="section-"][data-id="${sectionId}"]`
    );
    if (!section) { resultMap[sectionId] = []; continue; }

    const results = [];
    let currentCategory = 'other';
    let isOptional = false;

    const activities = section.querySelectorAll('.activity');
    for (const el of activities) {
      if (el.classList.contains('modtype_label')) {
        const raw = el.innerText.trim();
        if (!raw || /^-+$/.test(raw) || raw.length < 3) continue;
        const firstLine = raw.split('\n')[0].trim();
        if (firstLine.length < 3 || firstLine.length > 120) continue;
        const fl = firstLine.toUpperCase();

        if (fl.includes('OPTIONAL')) { isOptional = true; }
        if (fl.includes('MANDATORY') || fl.includes('REQUIRED') || fl.includes('CORE')) { isOptional = false; }

        if (fl.includes('LECTURE MATERIAL') || fl.includes('LECTURE SLIDES') ||
            fl.includes('LECTURE PODCAST') ||
            (fl.includes('WEEK') && fl.includes('LECTURE'))) {
          currentCategory = 'Lectures';
        } else if (fl.includes('TUTORIAL MATERIAL') || fl.includes('TUTORIAL SLIDES') ||
                   fl.includes('TUTORIAL PRE-READING') || fl.includes('TUTORIAL PREPARATION') ||
                   fl.includes('SEMINAR MATERIAL')) {
          currentCategory = 'Tutorials';
        } else {
          const isHeading = firstLine.length <= 80 &&
            /^[A-Z]/.test(firstLine) &&
            !firstLine.includes('. ') &&
            firstLine.split(' ').length <= 12;
          if (isHeading) {
            currentCategory = firstLine.replace(/[/\\?%*:|"<>]/g, '-').substring(0, 60).trim();
          }
        }
        continue;
      }

      if (isOptional && !includeOptional) continue;

      if (el.classList.contains('modtype_resource')) {
        const link = el.querySelector('a[href*="/mod/resource/"]');
        if (!link) continue;
        const name = el.innerText.trim().replace(/\n/g, ' ').replace(/\s*(File|Folder)\s*/g, '').trim();
        if (!name || name.length < 2) continue;
        results.push({ name, href: link.href, category: currentCategory, type: 'resource' });
      }

      if (el.classList.contains('modtype_folder')) {
        const link = el.querySelector('a[href*="/mod/folder/"]');
        if (!link) continue;
        const name = el.innerText.trim().replace(/\n/g, ' ').replace(/\s*(File|Folder)\s*/g, '').trim();
        if (!name || name.length < 2) continue;
        results.push({ name, href: link.href, category: currentCategory, type: 'folder' });
      }

      if (el.classList.contains('modtype_kalvidres') || el.classList.contains('modtype_kalvidpres')) {
        const link = el.querySelector('a[href*="/mod/kalvid"]');
        if (!link) continue;
        const name = el.innerText.trim().replace(/\n/g, ' ')
          .replace(/\s*Kaltura Video (Resource|Presentation)\s*/gi, '').trim();
        if (!name || name.length < 2) continue;
        results.push({ name, href: link.href, category: currentCategory, type: 'kaltura', optional: isOptional });
      }
    }

    resultMap[sectionId] = results;
  }

  return resultMap;
}

function scrapeFolderPage() {
  const results = [];

  let links = document.querySelectorAll('.fp-filename-icon a[href*="pluginfile.php"]');
  if (links.length === 0) {
    links = document.querySelectorAll('#region-main a[href*="pluginfile.php"]');
  }
  if (links.length === 0) {
    links = document.querySelectorAll('.filemanager a[href*="pluginfile.php"], .foldertree a[href*="pluginfile.php"]');
  }

  for (const link of links) {
    const href = link.href;
    const urlPath = new URL(href).pathname;
    const name = decodeURIComponent(urlPath.split('/').pop());
    if (name && name.length > 1) {
      results.push({ name, href, type: 'folderFile' });
    }
  }

  return results;
}

function scrapeKalturaVideo() {
  // Step 1: Find the Kaltura iframe and extract entry ID
  const iframe = document.querySelector('iframe.kaltura-player-iframe, iframe#contentframe, iframe[src*="kalvidres"]');
  if (!iframe || !iframe.src) return null;

  const decodedSrc = decodeURIComponent(iframe.src);
  const entryMatch = decodedSrc.match(/entryid\/([^\/&]+)/i) ||
                     decodedSrc.match(/entry_id[=\/]([^\/&]+)/i);
  if (!entryMatch) return null;

  const entryId = entryMatch[1];

  // Step 2: Try to find partner ID and KS from the page or iframe
  // These are often in script tags or data attributes
  let partnerId = '2368101'; // KEATS default
  let ks = null;

  // Check page scripts for Kaltura config
  const scripts = document.querySelectorAll('script');
  for (const s of scripts) {
    const text = s.textContent;
    if (text.includes('partnerId')) {
      const pMatch = text.match(/partnerId['":\s]+(\d+)/);
      if (pMatch) partnerId = pMatch[1];
    }
    if (text.includes('"ks"')) {
      const kMatch = text.match(/"ks"\s*:\s*"([^"]+)"/);
      if (kMatch) ks = kMatch[1];
    }
  }

  // Step 3: Construct direct download URL
  // Kaltura's /format/download/ endpoint returns a direct MP4
  let downloadUrl = `https://cdnapisec.kaltura.com/p/${partnerId}/sp/${partnerId}00/playManifest/entryId/${entryId}/format/download/protocol/https`;
  if (ks) {
    downloadUrl += `/ks/${ks}`;
  }

  return {
    entryId,
    partnerId,
    downloadUrl,
    hasKs: !!ks,
  };
}

function scrapeKalturaIframeSrc() {
  const iframe = document.querySelector('iframe.kaltura-player-iframe, iframe#contentframe, iframe[src*="kalvidres"]');
  return iframe ? iframe.src : null;
}

function scrapeKalturaKS() {
  // When navigated directly to the KAF page, multiple KS values exist in script tags.
  // Some are domain-restricted and won't work for API calls.
  // Collect all unique KS values so the caller can try each.
  const ksValues = [];
  let partnerId = null;

  const scripts = document.querySelectorAll('script');
  for (const s of scripts) {
    const text = s.textContent;
    // Find all KS strings
    const matches = text.matchAll(/"ks"\s*:\s*"([^"]+)"/g);
    for (const m of matches) {
      if (!ksValues.includes(m[1])) ksValues.push(m[1]);
    }
    if (text.includes('partnerId') && !partnerId) {
      const pMatch = text.match(/partnerId['":\s]+(\d+)/);
      if (pMatch) partnerId = pMatch[1];
    }
  }

  // Also check for KS in the page source via other patterns
  const bodyText = document.body.innerHTML;
  const altMatches = bodyText.matchAll(/["']ks["']\s*:\s*["']([^"']+)["']/g);
  for (const m of altMatches) {
    if (!ksValues.includes(m[1])) ksValues.push(m[1]);
  }

  return { ksValues, partnerId };
}

function scrapeEcho360LTI() {
  // Find LTI links that look like lecture capture
  const results = [];

  // Check all LTI activities
  const activities = document.querySelectorAll('.activity.modtype_lti');
  for (const act of activities) {
    const actLink = act.querySelector('a[href*="/mod/lti/"]');
    if (!actLink) continue;

    const text = (act.getAttribute('data-activityname') || act.innerText || '').toLowerCase();
    const href = actLink.href;

    // Match common lecture capture naming patterns
    if (text.includes('lecture capture') || text.includes('echo360') ||
        text.includes('recording') || text.includes('lecture recording')) {
      results.push({
        name: act.getAttribute('data-activityname') || actLink.textContent.trim() || 'Lecture Capture',
        href: href,
      });
    }
  }

  // If no obvious matches, include all LTI links as candidates
  // (the background will check if they redirect to Echo360)
  if (results.length === 0) {
    for (const act of activities) {
      const actLink = act.querySelector('a[href*="/mod/lti/"]');
      if (actLink) {
        results.push({
          name: act.getAttribute('data-activityname') || actLink.textContent.trim() || 'LTI Activity',
          href: actLink.href,
          isCandidate: true, // might not be Echo360
        });
      }
    }
  }

  return results;
}

function scrapeEcho360Section() {
  // Check if current page is Echo360
  const url = window.location.href;
  if (!url.includes('echo360')) return [];

  const rows = document.querySelectorAll('.class-row');
  const results = [];
  for (const row of rows) {
    results.push({
      text: row.textContent.trim().substring(0, 200),
    });
  }
  return results;
}

function scrapeEcho360Syllabus(sectionId) {
  // Fetch Echo360 syllabus API from within the Echo360 page context
  return fetch(`/section/${sectionId}/syllabus`, { credentials: 'include' })
    .then(r => r.json())
    .then(data => {
      return (data.data || []).map(item => {
        const lesson = item.lesson;
        if (!lesson || !lesson.hasVideo) return null;

        const media = lesson.medias && lesson.medias[0];
        if (!media || !media.isAvailable) return null;

        const startDate = lesson.lesson?.timing?.start;
        const dateStr = startDate
          ? new Date(startDate).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
          : null;

        return {
          name: lesson.lesson?.displayName || 'Lecture',
          lessonId: lesson.lesson?.id,
          mediaId: media.id,
          isAvailable: media.isAvailable,
          date: dateStr,
        };
      }).filter(Boolean);
    })
    .catch(() => []);
}

// ==================== Kaltura video resolution ====================

// Extract the Kaltura entryId + partnerId from a Moodle kalvidres view.php
// page. Parses the HTML directly via fetch — no tab navigation — so 30+
// videos resolve in seconds, not minutes. The entryId lives inside the
// embedded iframe's URL-encoded `source` query param, e.g.
//   .../entryid%2F1_m05ugjat%2F... (URL-encoded)
//   .../entryid/1_m05ugjat/...      (literal)
function parseKalturaIdsFromHtml(html) {
  const entryMatch = html.match(/entryid(?:%2F|\/)([0-9]+_[A-Za-z0-9]+)/i) ||
                     html.match(/entry_?id[=\/:\s"']+([0-9]+_[A-Za-z0-9]+)/i);
  if (!entryMatch) return null;

  let partnerId = null;
  const patterns = [
    /partner_?id[=\/:\s"']+(\d{3,})/i,
    /\/p\/(\d{3,})\//,
    /wid["'\s:=]+_?(\d{3,})/i,
  ];
  for (const p of patterns) {
    const m = html.match(p);
    if (m) { partnerId = m[1]; break; }
  }

  return { entryId: entryMatch[1], partnerId };
}

function buildKalturaDownloadUrl(entryId, partnerId) {
  return `https://cdnapisec.kaltura.com/p/${partnerId}/sp/${partnerId}00/playManifest/entryId/${entryId}/format/download/protocol/https/flavorParamIds/0`;
}

// ==================== Echo360 MP4 resolution ====================

// Echo360 streams come from a CDN at content.echo360.{tld} as plain
// progressive MP4 with byte-range support. Authentication is via CloudFront
// signed cookies that the user's logged-in browser already holds for the
// echo360 domain — Chrome attaches them on chrome.downloads.download with
// no extra work required.
//
// The path layout is:
//   https://content.echo360.{tld}/0000.{instId}/{mediaId}/1/{stream}.mp4
//
// where {stream} is one of:
//   s0q1 — camera feed
//   s1q1 — slides / screen capture
//   s2q1 — composite (the side-by-side view the player shows by default)
function buildEcho360Url(host, institutionId, mediaId, stream) {
  // Host is the CDN host that Echo360 uses for content delivery, derived
  // from the user's session host (e.g. echo360.org.uk -> content.echo360.org.uk).
  return `https://${host}/0000.${institutionId}/${mediaId}/1/${stream}.mp4`;
}

function echo360ContentHost(sessionHost) {
  if (!sessionHost) return null;
  if (sessionHost.startsWith('content.')) return sessionHost;
  return 'content.' + sessionHost;
}

// Pulls the institution UUID out of an ECHO_JWT cookie. The JWT body has
// a `content.institutionId` field. Falls through to null if the cookie
// isn't present or can't be decoded — caller will fall back to the .url
// shortcut path.
function parseEcho360InstitutionId(jwtString) {
  if (!jwtString || typeof jwtString !== 'string') return null;
  const parts = jwtString.split('.');
  if (parts.length < 2) return null;
  try {
    const payloadB64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = payloadB64 + '=='.slice(0, (4 - payloadB64.length % 4) % 4);
    const payload = JSON.parse(atob(padded));
    return payload?.content?.institutionId || null;
  } catch (e) {
    return null;
  }
}

// Fetches the kalvidres view page (from the tab's page context so KEATS
// cookies are automatically attached) and returns a direct MP4 playManifest
// URL. Falls through to null if the page can't be parsed — caller logs and
// skips. KCL has the format/download endpoint enabled with no KS required.
//
// Running the fetch via chrome.scripting.executeScript puts the request in
// the tab's origin, which means same-origin cookies ride along. A service
// worker fetch with credentials:"include" does not reliably get the same
// KEATS session in MV3.
async function resolveKalturaVideo(tabId, file) {
  addLog(`  Resolving video: ${file.name}`);
  broadcastProgress();

  let html = null;
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: async (href) => {
        try {
          const resp = await fetch(href, { credentials: 'include', redirect: 'follow' });
          if (!resp.ok) return { ok: false, status: resp.status };
          return { ok: true, html: await resp.text() };
        } catch (e) {
          return { ok: false, error: String(e && e.message || e) };
        }
      },
      args: [file.href],
    });
    const r = results[0]?.result;
    if (!r) {
      addLog(`    Fetch gave no response`);
      return null;
    }
    if (!r.ok) {
      addLog(`    Fetch failed (HTTP ${r.status ?? 'err'}${r.error ? ': ' + r.error : ''})`);
      return null;
    }
    html = r.html;
  } catch (e) {
    addLog(`    Fetch threw: ${e.message || e}`);
    return null;
  }

  const ids = parseKalturaIdsFromHtml(html);
  if (!ids || !ids.entryId) {
    addLog(`    No entryId in page HTML (${(html || '').length} chars)`);
    return null;
  }

  // KEATS partnerId fallback when the page doesn't expose it directly.
  const isKeats = typeof file.href === 'string' && /keats\.kcl\.ac\.uk/.test(file.href);
  const partnerId = ids.partnerId || (isKeats ? '2368101' : null);
  if (!partnerId) {
    addLog(`    No partnerId found (entryId ${ids.entryId})`);
    return null;
  }

  addLog(`    -> ${ids.entryId} (partner ${partnerId})`);
  return buildKalturaDownloadUrl(ids.entryId, partnerId);
}

// ==================== Download with retry ====================

async function downloadWithRetry(file, basePath, maxRetries = 3) {
  let lastError;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      await downloadSingleFile(file, basePath);
      return;
    } catch (err) {
      lastError = err;
      if (attempt < maxRetries) {
        const delay = 1000 * Math.pow(2, attempt - 1); // 1s, 2s, 4s
        addLog(`  Retry ${attempt}/${maxRetries - 1} for: ${file.name}`);
        await sleep(delay);
      }
    }
  }
  throw lastError;
}

// ==================== Download handler ====================

async function downloadSingleFile(file, basePath) {
  // Build directory path
  let dirPath = basePath;

  if (file.sectionName) {
    dirPath += `${sanitize(file.sectionName)}/`;
  }

  if (file.category && file.category !== 'other') {
    dirPath += `${file.category}/`;
  }

  if (file.folderName) {
    dirPath += `${sanitize(file.folderName)}/`;
  }

  // Build download URL
  let url = file.href;
  if (file.type === 'resource') {
    const sep = url.includes('?') ? '&' : '?';
    url = url + sep + 'redirect=1';
  }

  // Determine filename and fetch content
  let filename;
  let downloadUrl;

  if (file.type === 'urlShortcut') {
    // Windows .url shortcut format — double-click opens default browser on
    // Windows, macOS, and Linux. Used for content that can't be auto-downloaded
    // (Widevine-protected Echo360 lectures, disabled Kaltura endpoints, etc.).
    filename = sanitize(file.name) + '.url';
    downloadUrl = buildUrlShortcut(file.href);
  } else if (file.type === 'folderFile') {
    const urlPath = new URL(file.href).pathname;
    filename = sanitize(decodeURIComponent(urlPath.split('/').pop()));
    const fetched = await fetchFileBlob(url);
    if (fetched.filename) filename = fetched.filename;
    downloadUrl = await blobToDataUrl(fetched.blob);
  } else if (file.type === 'kalturaDownload' || file.type === 'echo360' || file.type === 'echo360Mp4') {
    // Video files: download directly from CDN (too large for data URL)
    filename = sanitize(file.name) + '.mp4';
    downloadUrl = url;
  } else {
    // Fetch file content and convert to data URL to bypass save dialog
    const fetched = await fetchFileBlob(url);
    if (fetched.filename) filename = fetched.filename;
    if (!filename) filename = sanitize(file.name) || 'download';
    downloadUrl = await blobToDataUrl(fetched.blob);
  }

  const fullPath = dirPath + filename;
  const conflictAction = state.overwrite ? 'overwrite' : 'uniquify';

  return new Promise((resolve, reject) => {
    chrome.downloads.download(
      { url: downloadUrl, filename: fullPath, saveAs: false, conflictAction },
      (downloadId) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        if (downloadId === undefined) {
          reject(new Error('Download failed to start'));
          return;
        }

        const listener = (delta) => {
          if (delta.id !== downloadId) return;
          if (delta.state) {
            if (delta.state.current === 'complete') {
              chrome.downloads.onChanged.removeListener(listener);
              clearTimeout(safetyTimer);
              resolve();
            } else if (delta.state.current === 'interrupted') {
              chrome.downloads.onChanged.removeListener(listener);
              clearTimeout(safetyTimer);
              reject(new Error(delta.error?.current || 'Download interrupted'));
            }
          }
        };

        chrome.downloads.onChanged.addListener(listener);

        // Generous safety net for very large files on slow networks. Chrome's
        // own download manager reports success/failure via onChanged; this
        // timer only kicks in if we somehow lose the listener (rare). 30
        // minutes covers a 1 GB file at ~600 KB/s, well above typical
        // Kaltura lecture sizes (17-50 MB).
        const safetyTimer = setTimeout(() => {
          chrome.downloads.onChanged.removeListener(listener);
          reject(new Error('Download timeout after 30 min'));
        }, 30 * 60 * 1000);
      }
    );
  });
}

// ==================== Execute scraping in a tab ====================

async function executeScrape(tabId, func, ...args) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func,
    args,
  });
  return results[0]?.result ?? [];
}

// ==================== Helpers ====================

function navigateTab(tabId, url) {
  return new Promise((resolve, reject) => {
    let listener = null;
    const timeout = setTimeout(() => {
      if (listener) chrome.tabs.onUpdated.removeListener(listener);
      resolve(); // Resolve anyway after timeout
    }, 30000);

    chrome.tabs.update(tabId, { url }, () => {
      if (chrome.runtime.lastError) {
        clearTimeout(timeout);
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }

      listener = (id, info) => {
        if (id === tabId && info.status === 'complete') {
          chrome.tabs.onUpdated.removeListener(listener);
          clearTimeout(timeout);
          resolve();
        }
      };
      chrome.tabs.onUpdated.addListener(listener);
    });
  });
}

async function getTabUrl(tabId) {
  const tab = await chrome.tabs.get(tabId);
  return tab.url;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function sanitize(name) {
  return name
    .replace(/[/\\?%*:|"<>\x00-\x1f\x7f]/g, '-')  // illegal + control chars
    .replace(/\s+/g, ' ')                            // collapse whitespace
    .trim()
    .replace(/\.+$/, '')
    .substring(0, 200);                               // max length safety
}

// Predicts the on-disk filename for a scraped file entry, mirroring the
// logic in downloadSingleFile for the cases where the name is deterministic
// (.url shortcuts, Kaltura MP4s, Echo360 MP4s). Returns null for resource
// and folderFile entries whose filename is only known after fetch.
function predictFilename(file) {
  if (!file) return null;
  if (file.type === 'urlShortcut') return sanitize(file.name) + '.url';
  if (file.type === 'kalturaDownload' || file.type === 'echo360' || file.type === 'echo360Mp4') {
    return sanitize(file.name) + '.mp4';
  }
  return null;
}

// Turns a raw Moodle course name like
//   "6CCS3SAD Software Architecture and Design(25~26 SEM2 000001)"
// into a friendlier folder name like
//   "Software Architecture and Design (6CCS3SAD)"
//
// Handles co-listed codes ("6CCS3MDE & 7CCSMMDD Model-driven Engineering(...)"
// → "Model-driven Engineering (6CCS3MDE)"), strips trailing academic-year
// parenthetical blocks, and falls back to the raw input when no recognisable
// course code is found.
function cleanCourseName(raw) {
  if (!raw || typeof raw !== 'string') return '';
  let name = raw.trim();

  // Drop a trailing (...) block that looks like an enrolment/year marker
  // e.g. "(25~26 SEM2 000001)" — these always live at the very end.
  name = name.replace(/\s*\([^)]*(?:\d{2}~\d{2}|SEM|SY|\d{4})[^)]*\)\s*$/i, '');

  // Extract the first course code token (uppercase + digits, with at least one
  // digit anywhere), then skip any co-listed "& XXX" siblings. Matches codes
  // like "6CCS3SAD", "7CCSMMDD", "6QQMB310", "MATH101".
  const codeToken = '[A-Z]*\\d[A-Z0-9]*';
  const codeRe = new RegExp(`^\\s*(${codeToken})(?:\\s*&\\s*${codeToken})*\\s+(\\S.*)$`);
  const m = name.match(codeRe);
  if (m) {
    const code = m[1];
    const rest = m[2].trim();
    return `${rest} (${code})`;
  }

  return name;
}

function addLog(msg) {
  state.log.push(msg);
  if (state.log.length > 300) {
    state.log = state.log.slice(-200);
  }
}

function broadcastProgress() {
  chrome.runtime.sendMessage({ type: 'PROGRESS_UPDATE', state: { ...state } }).catch(() => {});
  updateToolbarBadge();
}

// Live progress badge on the toolbar icon. Downloads don't pause when the
// popup closes (Chrome's download manager handles bytes independently); the
// badge gives an always-visible status indicator.
//
// Chrome's badge model has a quirk: a per-tab badge overrides the global
// one, and once a per-tab badge is set (even to an empty string) it stays
// set until we explicitly reassign it. The new-files detector sets per-tab
// badges on KEATS course pages, so if we only set the global progress badge
// it would be hidden on exactly the tab the user is looking at. Work around
// this by propagating the progress text to every open tab's per-tab badge
// during a run, then clearing them when the run ends.
let _lastBadgeText = null;

async function updateToolbarBadge() {
  try {
    let text = '';
    let colour = null;
    let done = false;

    if (state.status === 'scanning') {
      colour = '#888888';
      const pct = state.totalSections > 0
        ? Math.min(99, Math.round(state.scannedSections / state.totalSections * 100))
        : 0;
      text = `${pct}%`;
    } else if (state.status === 'downloading') {
      colour = '#c1002a';
      const doneCount = state.downloadedFiles + state.failedFiles;
      const total = state.totalFiles || 0;
      if (total > 0) {
        const pct = Math.min(99, Math.round(doneCount / total * 100));
        text = `${pct}%`;
      } else {
        text = `${doneCount}`;
      }
    } else if (state.status === 'complete') {
      colour = '#2b8a3e';
      text = '✓';
      done = true;
    } else if (state.status === 'cancelled' || state.status === 'error' || state.status === 'idle') {
      text = '';
      done = true;
    }

    if (colour) {
      chrome.action.setBadgeBackgroundColor({ color: colour });
    }

    chrome.action.setBadgeText({ text });

    // Skip the expensive all-tabs loop when the text is unchanged — during a
    // run, broadcastProgress can fire many times with the same progress
    // string (e.g. while a single file is still downloading).
    const textChanged = text !== _lastBadgeText;
    _lastBadgeText = text;

    if (textChanged) {
      if (state.status === 'scanning' || state.status === 'downloading') {
        // Propagate the progress text to every open tab so the per-tab
        // badges set by the new-files detector don't hide progress on the
        // KEATS course page.
        try {
          const tabs = await chrome.tabs.query({});
          for (const t of tabs) {
            try { chrome.action.setBadgeText({ text, tabId: t.id }); } catch (e) {}
          }
        } catch (e) {}
      } else if (done) {
        // Clear per-tab overrides so either the green tick or empty state is
        // the only thing shown; the new-files detector is free to repopulate
        // tab-specific badges on its next pass.
        try {
          const tabs = await chrome.tabs.query({});
          for (const t of tabs) {
            try { chrome.action.setBadgeText({ text: '', tabId: t.id }); } catch (e) {}
          }
        } catch (e) {}
      }
    }

    if (done && state.status === 'complete') {
      setTimeout(() => {
        try { chrome.action.setBadgeText({ text: '' }); } catch (e) {}
      }, 8000);
    }
  } catch (e) { /* badge best-effort */ }
}

// Expose internals for testing (no-op in Chrome extension context)
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    sanitize, cleanCourseName, predictFilename, addLog, sleep, downloadWithRetry, fileKey, blobToDataUrl, fetchFileBlob,
    buildUrlShortcut, parseKalturaIdsFromHtml, buildKalturaDownloadUrl, buildExistingDownloadSet,
    buildEcho360Url, echo360ContentHost, parseEcho360InstitutionId,
    scrapeSectionPage, scrapeInlineSection, scrapeAllInlineSections, scrapeFolderPage,
    scrapeFileHrefsLightweight, fetchSectionActivitiesInPage,
    buildKnownIdentity, activityIsKnown, normaliseHref,
    getCourseCompletions, markCourseCompleted,
    scrapeEcho360LTI, isMoodleCoursePage: undefined,
    get state() { return state; },
    set state(s) { state = s; },
  };
}
