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

function scrapeFileHrefsLightweight() {
  const h1 = document.querySelector('h1');
  const courseName = h1 ? h1.textContent.trim() : document.title.trim();
  const hrefs = new Set();

  const selectors = [
    '.activity.modtype_resource a[href*="/mod/resource/"]',
    '.activity.modtype_folder a[href*="/mod/folder/"]',
    '.activity.modtype_kalvidres a[href*="/mod/kalvid"]',
    '.activity.modtype_kalvidpres a[href*="/mod/kalvid"]',
  ];

  for (const sel of selectors) {
    for (const link of document.querySelectorAll(sel)) {
      hrefs.add(link.href.split('#')[0].split('?')[0]);
    }
  }

  return { courseName, hrefs: [...hrefs] };
}

async function checkForNewFiles(tabId) {
  const result = await chrome.scripting.executeScript({
    target: { tabId },
    func: scrapeFileHrefsLightweight,
  });

  const data = result[0]?.result;
  if (!data || !data.courseName || data.hrefs.length === 0) {
    chrome.action.setBadgeText({ text: '', tabId });
    return;
  }

  const history = await getDownloadHistory();
  const courseName = sanitize(cleanCourseName(data.courseName) || data.courseName).substring(0, 120);

  // Build set of known hrefs for this course
  const knownHrefs = new Set();
  for (const [key, entry] of Object.entries(history)) {
    if (entry.course === courseName) {
      const parts = key.split('|');
      if (parts.length >= 4) {
        const href = parts.slice(3).join('|').split('#')[0].split('?')[0];
        knownHrefs.add(href);
      }
    }
  }

  // If no history for this course, don't show badge (first time)
  if (knownHrefs.size === 0) {
    chrome.action.setBadgeText({ text: '', tabId });
    return;
  }

  // Count new files
  let newCount = 0;
  for (const href of data.hrefs) {
    const norm = href.split('#')[0].split('?')[0];
    if (!knownHrefs.has(norm)) newCount++;
  }

  if (newCount > 0) {
    chrome.action.setBadgeBackgroundColor({ color: '#c1002a', tabId });
    chrome.action.setBadgeText({ text: String(newCount), tabId });
  } else {
    chrome.action.setBadgeText({ text: '', tabId });
  }

  // Store for popup to read
  await chrome.storage.session.set({
    [`newFiles:${tabId}`]: { count: newCount, courseName, timestamp: Date.now() }
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
  // Unique key: course + section + category + filename href
  return `${courseName}|${file.sectionName || ''}|${file.category || ''}|${file.href}`;
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
      checkForNewFiles(msg.tabId).then(() => sendResponse({ ok: true })).catch(() => sendResponse({ ok: false }));
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
        state.currentFile = `Saving ${syllabusData.length} Echo360 shortcuts...`;
        broadcastProgress();

        const echoHost = new URL(currentUrl).host;
        for (const recording of syllabusData) {
          if (state.cancelled) break;
          if (!recording.mediaId || !recording.isAvailable) continue;
          if (!recording.lessonId) continue;

          // Direct MP4 download for institutional Echo360 content is blocked by
          // Widevine-protected DASH streams. Save a clickable .url shortcut
          // pointing at the lecture page so students can open it in their
          // authenticated browser session. Automated extraction is tracked for
          // a future release.
          const dateStr = recording.date || 'Unknown Date';
          const lessonUrl = `https://${echoHost}/lesson/${recording.lessonId}/classroom`;
          allFiles.push({
            name: `${recording.name} - ${dateStr}`,
            href: lessonUrl,
            sectionName: 'Lecture Recordings',
            courseName: courseName,
            type: 'urlShortcut',
          });
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
      f.type === 'kalturaDownload' || f.type === 'urlShortcut'
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
  } else if (file.type === 'kalturaDownload' || file.type === 'echo360') {
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
  if (file.type === 'kalturaDownload' || file.type === 'echo360') {
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
    scrapeSectionPage, scrapeInlineSection, scrapeAllInlineSections, scrapeFolderPage,
    scrapeEcho360LTI, isMoodleCoursePage: undefined,
    get state() { return state; },
    set state(s) { state = s; },
  };
}
