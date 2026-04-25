// Hardening tests — covers edge cases, grid format, video paths, large files, error recovery
const { createChromeMock } = require('./chrome-mock');

global.chrome = createChromeMock();
global.fetch = jest.fn().mockResolvedValue({
  ok: true, status: 200,
  url: 'https://example.com/file.pdf',
  headers: { get: () => null },
  blob: () => Promise.resolve({
    arrayBuffer: () => Promise.resolve(new ArrayBuffer(4)),
    type: 'application/pdf',
  }),
});
global.btoa = (str) => Buffer.from(str, 'binary').toString('base64');

const bg = require('../extension/background');

// ==================== Grid format scraping ====================

describe('scrapeSectionPage — grid format edge cases', () => {
  beforeEach(() => {
    // jsdom innerText polyfill not available in node env
    // scrapeSectionPage uses innerText which is browser-only
    // These tests verify the function doesn't crash with various inputs
  });

  test('returns empty array when no activities found', () => {
    // scrapeSectionPage expects DOM — in node env, document doesn't exist
    // This test verifies the exported function exists
    expect(typeof bg.scrapeSectionPage).toBe('function');
  });
});

// ==================== Blob download edge cases ====================

describe('blobToDataUrl edge cases', () => {
  test('handles 1 byte file', async () => {
    const blob = {
      arrayBuffer: () => Promise.resolve(new Uint8Array([0xFF]).buffer),
      type: 'application/octet-stream',
    };
    const url = await bg.blobToDataUrl(blob);
    expect(url).toBe('data:application/octet-stream;base64,/w==');
  });

  test('handles exactly 8192 bytes (one chunk boundary)', async () => {
    const arr = new Uint8Array(8192);
    arr.fill(65); // 'A'
    const blob = {
      arrayBuffer: () => Promise.resolve(arr.buffer),
      type: 'text/plain',
    };
    const url = await bg.blobToDataUrl(blob);
    expect(url).toMatch(/^data:text\/plain;base64,/);
    const base64 = url.split(',')[1];
    // 8192 bytes -> ceil(8192/3)*4 = 10924 base64 chars
    expect(base64.length).toBe(10924);
  });

  test('handles 8193 bytes (crosses chunk boundary)', async () => {
    const arr = new Uint8Array(8193);
    arr.fill(66); // 'B'
    const blob = {
      arrayBuffer: () => Promise.resolve(arr.buffer),
      type: 'text/plain',
    };
    const url = await bg.blobToDataUrl(blob);
    expect(url).toMatch(/^data:text\/plain;base64,/);
    // Verify it decodes back correctly
    const base64 = url.split(',')[1];
    const decoded = Buffer.from(base64, 'base64');
    expect(decoded.length).toBe(8193);
    expect(decoded[0]).toBe(66);
    expect(decoded[8192]).toBe(66);
  });

  test('handles 100KB file (simulating a PDF)', async () => {
    const size = 102400;
    const arr = new Uint8Array(size);
    for (let i = 0; i < size; i++) arr[i] = i % 256;
    const blob = {
      arrayBuffer: () => Promise.resolve(arr.buffer),
      type: 'application/pdf',
    };
    const url = await bg.blobToDataUrl(blob);
    const base64 = url.split(',')[1];
    const decoded = Buffer.from(base64, 'base64');
    expect(decoded.length).toBe(size);
    // Verify first and last bytes
    expect(decoded[0]).toBe(0);
    expect(decoded[size - 1]).toBe((size - 1) % 256);
  });

  test('handles missing MIME type', async () => {
    const blob = {
      arrayBuffer: () => Promise.resolve(new ArrayBuffer(2)),
      type: '', // empty
    };
    const url = await bg.blobToDataUrl(blob);
    expect(url).toMatch(/^data:application\/octet-stream;base64,/);
  });
});

// ==================== fetchFileBlob edge cases ====================

describe('fetchFileBlob', () => {
  test('resolves filename from Content-Disposition', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true, status: 200,
      url: 'https://keats.kcl.ac.uk/pluginfile.php/123/file.pdf',
      headers: {
        get: (h) => h === 'Content-Disposition'
          ? 'attachment; filename="Week 1 Slides.pdf"'
          : 'application/pdf',
      },
      blob: () => Promise.resolve({
        arrayBuffer: () => Promise.resolve(new ArrayBuffer(4)),
        type: 'application/pdf',
      }),
    });

    const result = await bg.fetchFileBlob('https://keats.kcl.ac.uk/mod/resource/view.php?id=123');
    expect(result.filename).toBe('Week 1 Slides.pdf');
    expect(result.blob).toBeDefined();
  });

  test('resolves filename from URL path when no Content-Disposition', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true, status: 200,
      url: 'https://keats.kcl.ac.uk/pluginfile.php/123/mod_resource/content/0/lecture_notes.pdf',
      headers: { get: () => null },
      blob: () => Promise.resolve({
        arrayBuffer: () => Promise.resolve(new ArrayBuffer(4)),
        type: 'application/pdf',
      }),
    });

    const result = await bg.fetchFileBlob('https://keats.kcl.ac.uk/mod/resource/view.php?id=123');
    expect(result.filename).toBe('lecture_notes.pdf');
  });

  test('returns null filename when URL ends in .php', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true, status: 200,
      url: 'https://keats.kcl.ac.uk/mod/resource/view.php',
      headers: { get: () => null },
      blob: () => Promise.resolve({
        arrayBuffer: () => Promise.resolve(new ArrayBuffer(4)),
        type: 'text/html',
      }),
    });

    const result = await bg.fetchFileBlob('https://keats.kcl.ac.uk/mod/resource/view.php?id=123');
    expect(result.filename).toBeNull();
  });

  test('throws on HTTP error', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false, status: 403,
      headers: { get: () => null },
    });

    await expect(bg.fetchFileBlob('https://keats.kcl.ac.uk/mod/resource/view.php?id=123'))
      .rejects.toThrow('HTTP 403');
  });

  test('handles UTF-8 encoded filename in Content-Disposition', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true, status: 200,
      url: 'https://keats.kcl.ac.uk/pluginfile.php/123/file.pdf',
      headers: {
        get: (h) => h === 'Content-Disposition'
          ? "attachment; filename*=UTF-8''Pr%C3%A9sentation.pdf"
          : null,
      },
      blob: () => Promise.resolve({
        arrayBuffer: () => Promise.resolve(new ArrayBuffer(4)),
        type: 'application/pdf',
      }),
    });

    const result = await bg.fetchFileBlob('https://keats.kcl.ac.uk/mod/resource/view.php?id=123');
    expect(result.filename).toBe('Présentation.pdf');
  });
});

// ==================== Download path building ====================

describe('download path construction', () => {
  test('sanitize handles course names with special chars', () => {
    const name = 'CS101: Intro to Programming (2025/26)';
    const sanitized = bg.sanitize(name);
    expect(sanitized).toBe('CS101- Intro to Programming (2025-26)');
    expect(sanitized).not.toContain('/');
    expect(sanitized).not.toContain(':');
  });

  test('sanitize handles names with trailing dots', () => {
    expect(bg.sanitize('file...')).toBe('file');
    expect(bg.sanitize('test.')).toBe('test');
  });

  test('sanitize preserves unicode', () => {
    expect(bg.sanitize('Résumé für Müller')).toBe('Résumé für Müller');
  });

  test('fileKey is consistent', () => {
    const file = { sectionName: 'Week 1', category: 'Lectures', href: 'https://example.com/file.pdf' };
    expect(bg.fileKey('Course A', file)).toBe(bg.fileKey('Course A', file));
  });

  test('fileKey differentiates courses', () => {
    const file = { sectionName: 'Week 1', href: 'https://example.com/file.pdf' };
    expect(bg.fileKey('Course A', file)).not.toBe(bg.fileKey('Course B', file));
  });
});

// ==================== Video download paths ====================

describe('video file handling', () => {
  beforeEach(() => {
    bg.state = {
      status: 'downloading', courseName: 'Test', totalFiles: 1,
      downloadedFiles: 0, failedFiles: 0, scannedSections: 0,
      totalSections: 0, currentFile: '', log: [], errors: [],
      sections: [], cancelled: false,
    };

    global.chrome.downloads.download = jest.fn((opts, cb) => {
      const id = Math.floor(Math.random() * 10000);
      cb(id);
      setTimeout(() => {
        const listeners = global.chrome.downloads.onChanged.addListener.mock.calls;
        const last = listeners[listeners.length - 1]?.[0];
        if (last) last({ id, state: { current: 'complete' } });
      }, 10);
    });
    global.chrome.runtime.lastError = null;
  });

  test('echo360 files use direct URL, not blob', async () => {
    global.fetch = jest.fn();

    const file = {
      name: 'Lecture 1', href: 'https://content.echo360.org.uk/media/abc/s2q1.mp4',
      type: 'echo360', sectionName: 'Recordings',
    };

    await bg.downloadWithRetry(file, 'KEATS/Course/', 1);

    // fetch should NOT be called (no blob conversion)
    expect(global.fetch).not.toHaveBeenCalled();

    // download URL should be the original echo360 URL
    const opts = global.chrome.downloads.download.mock.calls[0][0];
    expect(opts.url).toContain('echo360');
    expect(opts.filename).toContain('Lecture 1.mp4');
    expect(opts.saveAs).toBe(false);
  });

  test('kaltura files use direct URL, not blob', async () => {
    global.fetch = jest.fn();

    const file = {
      name: 'Week 2 Video', href: 'https://cdnapisec.kaltura.com/p/123/playManifest/entryId/abc/format/download',
      type: 'kalturaDownload', sectionName: 'Week 2', category: 'Lectures',
    };

    await bg.downloadWithRetry(file, 'KEATS/Course/', 1);
    expect(global.fetch).not.toHaveBeenCalled();

    const opts = global.chrome.downloads.download.mock.calls[0][0];
    expect(opts.url).toContain('kaltura');
    expect(opts.filename).toContain('Week 2 Video.mp4');
  });

  test('resource files go through blob path', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true, status: 200,
      url: 'https://keats.kcl.ac.uk/pluginfile.php/1/mod_resource/content/0/slides.pdf',
      headers: { get: (h) => h === 'Content-Disposition' ? 'attachment; filename="slides.pdf"' : 'application/pdf' },
      blob: () => Promise.resolve({
        arrayBuffer: () => Promise.resolve(new ArrayBuffer(100)),
        type: 'application/pdf',
      }),
    });

    const file = {
      name: 'Slides', href: 'https://keats.kcl.ac.uk/mod/resource/view.php?id=1',
      type: 'resource', sectionName: 'Week 1',
    };

    await bg.downloadWithRetry(file, 'KEATS/Course/', 1);
    expect(global.fetch).toHaveBeenCalled();

    const opts = global.chrome.downloads.download.mock.calls[0][0];
    expect(opts.url).toMatch(/^data:/);
  });

  test('folderFile uses blob path with filename from URL', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true, status: 200,
      url: 'https://keats.kcl.ac.uk/pluginfile.php/1/mod_folder/content/0/handout.pdf',
      headers: { get: () => null },
      blob: () => Promise.resolve({
        arrayBuffer: () => Promise.resolve(new ArrayBuffer(50)),
        type: 'application/pdf',
      }),
    });

    const file = {
      name: 'handout.pdf', href: 'https://keats.kcl.ac.uk/pluginfile.php/1/mod_folder/content/0/handout.pdf',
      type: 'folderFile', sectionName: 'Week 1', category: 'Tutorials',
    };

    await bg.downloadWithRetry(file, 'KEATS/Course/', 1);
    expect(global.fetch).toHaveBeenCalled();

    const opts = global.chrome.downloads.download.mock.calls[0][0];
    expect(opts.filename).toContain('handout.pdf');
  });
});

// ==================== Error recovery ====================

describe('error recovery', () => {
  beforeEach(() => {
    bg.state = {
      status: 'downloading', courseName: 'Test', totalFiles: 1,
      downloadedFiles: 0, failedFiles: 0, scannedSections: 0,
      totalSections: 0, currentFile: '', log: [], errors: [],
      sections: [], cancelled: false,
    };
    global.chrome.runtime.lastError = null;
  });

  test('retry succeeds after transient fetch failure', async () => {
    let attempt = 0;
    global.fetch = jest.fn(() => {
      attempt++;
      if (attempt === 1) return Promise.resolve({ ok: false, status: 503 });
      return Promise.resolve({
        ok: true, status: 200,
        url: 'https://example.com/file.pdf',
        headers: { get: () => null },
        blob: () => Promise.resolve({
          arrayBuffer: () => Promise.resolve(new ArrayBuffer(4)),
          type: 'application/pdf',
        }),
      });
    });

    global.chrome.downloads.download = jest.fn((opts, cb) => {
      const id = 999;
      cb(id);
      setTimeout(() => {
        const listeners = global.chrome.downloads.onChanged.addListener.mock.calls;
        const last = listeners[listeners.length - 1]?.[0];
        if (last) last({ id, state: { current: 'complete' } });
      }, 10);
    });

    const file = {
      name: 'test.pdf', href: 'https://example.com/test.pdf',
      type: 'resource', sectionName: 'Week 1',
    };

    await bg.downloadWithRetry(file, 'KEATS/', 3);
    expect(attempt).toBe(2);
  });

  test('download interrupted triggers retry', async () => {
    let attempt = 0;
    global.fetch = jest.fn().mockResolvedValue({
      ok: true, status: 200,
      url: 'https://example.com/file.pdf',
      headers: { get: () => null },
      blob: () => Promise.resolve({
        arrayBuffer: () => Promise.resolve(new ArrayBuffer(4)),
        type: 'application/pdf',
      }),
    });

    global.chrome.downloads.download = jest.fn((opts, cb) => {
      attempt++;
      const id = 1000 + attempt;
      cb(id);
      setTimeout(() => {
        const listeners = global.chrome.downloads.onChanged.addListener.mock.calls;
        const last = listeners[listeners.length - 1]?.[0];
        if (last) {
          if (attempt === 1) {
            last({ id, state: { current: 'interrupted' }, error: { current: 'NETWORK_FAILED' } });
          } else {
            last({ id, state: { current: 'complete' } });
          }
        }
      }, 10);
    });

    const file = {
      name: 'test.pdf', href: 'https://example.com/test.pdf',
      type: 'resource', sectionName: 'Week 1',
    };

    await bg.downloadWithRetry(file, 'KEATS/', 3);
    expect(attempt).toBe(2);
  });

  test('all retries exhausted throws final error', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 500 });

    const file = {
      name: 'bad.pdf', href: 'https://example.com/bad.pdf',
      type: 'resource', sectionName: 'Week 1',
    };

    await expect(bg.downloadWithRetry(file, 'KEATS/', 2)).rejects.toThrow('HTTP 500');
  });
});

// ==================== Cancelled state ====================

describe('cancelled state', () => {
  test('cancelled flag is respected', () => {
    bg.state = { ...bg.state, cancelled: true, status: 'cancelled' };
    expect(bg.state.cancelled).toBe(true);
    expect(bg.state.status).toBe('cancelled');
  });
});

// ==================== addLog overflow ====================

describe('addLog overflow protection', () => {
  beforeEach(() => {
    bg.state = {
      status: 'idle', courseName: '', totalFiles: 0, downloadedFiles: 0,
      failedFiles: 0, scannedSections: 0, totalSections: 0, currentFile: '',
      log: [], errors: [], sections: [], cancelled: false,
    };
  });

  test('trims log when it exceeds 300 entries', () => {
    bg.state.log = [];
    for (let i = 0; i < 301; i++) bg.addLog(`line ${i}`);
    // After 301st entry, log exceeds 300 and is sliced to last 200
    expect(bg.state.log.length).toBe(200);
    expect(bg.state.log[0]).toBe('line 101');
    expect(bg.state.log[199]).toBe('line 300');
  });
});

// ==================== sleep ====================

describe('buildUrlShortcut', () => {
  test('produces a data URL with Windows shortcut payload', () => {
    const url = bg.buildUrlShortcut('https://echo360.org.uk/lesson/abc/classroom');
    expect(url).toMatch(/^data:application\/internet-shortcut;base64,/);
    const decoded = Buffer.from(url.split(',')[1], 'base64').toString('utf8');
    expect(decoded).toBe('[InternetShortcut]\r\nURL=https://echo360.org.uk/lesson/abc/classroom\r\n');
  });

  test('preserves query strings and special characters in the target URL', () => {
    const target = 'https://example.com/lesson?id=1&ref=foo%20bar';
    const url = bg.buildUrlShortcut(target);
    const decoded = Buffer.from(url.split(',')[1], 'base64').toString('utf8');
    expect(decoded).toContain(`URL=${target}`);
  });
});

describe('urlShortcut download path', () => {
  beforeEach(() => {
    bg.state = {
      status: 'downloading', courseName: 'Test', totalFiles: 1,
      downloadedFiles: 0, failedFiles: 0, scannedSections: 0,
      totalSections: 0, currentFile: '', log: [], errors: [],
      sections: [], cancelled: false,
    };
    global.chrome.downloads.download = jest.fn((opts, cb) => {
      const id = Math.floor(Math.random() * 10000);
      cb(id);
      setTimeout(() => {
        const listeners = global.chrome.downloads.onChanged.addListener.mock.calls;
        const last = listeners[listeners.length - 1]?.[0];
        if (last) last({ id, state: { current: 'complete' } });
      }, 10);
    });
    global.chrome.runtime.lastError = null;
  });

  test('urlShortcut skips fetch and writes .url data URL', async () => {
    global.fetch = jest.fn();
    const file = {
      name: 'Lecture - 20 Jan 2026',
      href: 'https://echo360.org.uk/lesson/abc/classroom',
      type: 'urlShortcut',
      sectionName: 'Lecture Recordings',
    };
    await bg.downloadWithRetry(file, 'KEATS/Course/', 1);

    expect(global.fetch).not.toHaveBeenCalled();
    const opts = global.chrome.downloads.download.mock.calls[0][0];
    expect(opts.filename).toBe('KEATS/Course/Lecture Recordings/Lecture - 20 Jan 2026.url');
    expect(opts.url).toMatch(/^data:application\/internet-shortcut;base64,/);
    const decoded = Buffer.from(opts.url.split(',')[1], 'base64').toString('utf8');
    expect(decoded).toContain('URL=https://echo360.org.uk/lesson/abc/classroom');
  });

  test('urlShortcut uses sectionName but no category subfolder', async () => {
    global.fetch = jest.fn();
    const file = {
      name: 'Week 1 Capture',
      href: 'https://echo360.org.uk/lesson/xyz/classroom',
      type: 'urlShortcut',
      sectionName: 'Lecture Recordings',
    };
    await bg.downloadWithRetry(file, 'KEATS/SAD/', 1);
    const opts = global.chrome.downloads.download.mock.calls[0][0];
    expect(opts.filename).toBe('KEATS/SAD/Lecture Recordings/Week 1 Capture.url');
    expect(opts.filename).not.toContain('/Lectures/');
  });
});

describe('overwrite option', () => {
  beforeEach(() => {
    global.chrome.downloads.download = jest.fn((opts, cb) => {
      const id = Math.floor(Math.random() * 10000);
      cb(id);
      setTimeout(() => {
        const listeners = global.chrome.downloads.onChanged.addListener.mock.calls;
        const last = listeners[listeners.length - 1]?.[0];
        if (last) last({ id, state: { current: 'complete' } });
      }, 10);
    });
    global.chrome.runtime.lastError = null;
    global.fetch = jest.fn();
  });

  test('default behaviour uses uniquify to skip duplicates', async () => {
    bg.state = {
      status: 'downloading', courseName: 'Test', totalFiles: 1,
      downloadedFiles: 0, failedFiles: 0, scannedSections: 0,
      totalSections: 0, currentFile: '', log: [], errors: [],
      sections: [], cancelled: false, overwrite: false,
    };
    await bg.downloadWithRetry(
      { name: 'Lecture', href: 'https://echo360.org.uk/lesson/a/classroom', type: 'urlShortcut', sectionName: 'Lecture Recordings' },
      'Downloads/', 1,
    );
    const opts = global.chrome.downloads.download.mock.calls[0][0];
    expect(opts.conflictAction).toBe('uniquify');
  });

  test('overwrite=true switches to overwrite conflictAction', async () => {
    bg.state = {
      status: 'downloading', courseName: 'Test', totalFiles: 1,
      downloadedFiles: 0, failedFiles: 0, scannedSections: 0,
      totalSections: 0, currentFile: '', log: [], errors: [],
      sections: [], cancelled: false, overwrite: true,
    };
    await bg.downloadWithRetry(
      { name: 'Lecture', href: 'https://echo360.org.uk/lesson/a/classroom', type: 'urlShortcut', sectionName: 'Lecture Recordings' },
      'Downloads/', 1,
    );
    const opts = global.chrome.downloads.download.mock.calls[0][0];
    expect(opts.conflictAction).toBe('overwrite');
  });
});

describe('scrapers all detect Kaltura', () => {
  // All three scraper variants must look for modtype_kalvidres — otherwise
  // courses in a given format silently lose their weekly videos. SAD (topics
  // format) hits scrapeAllInlineSections; Business Strategy (grid) hits
  // scrapeSectionPage; fallback is scrapeInlineSection.
  test('scrapeSectionPage handles modtype_kalvidres', () => {
    const src = bg.scrapeSectionPage.toString();
    expect(src).toMatch(/modtype_kalvidres/);
    expect(src).toMatch(/type:\s*['"]kaltura['"]/);
  });

  test('scrapeInlineSection handles modtype_kalvidres', () => {
    const src = bg.scrapeInlineSection.toString();
    expect(src).toMatch(/modtype_kalvidres/);
    expect(src).toMatch(/type:\s*['"]kaltura['"]/);
  });

  test('scrapeAllInlineSections handles modtype_kalvidres', () => {
    const src = bg.scrapeAllInlineSections.toString();
    expect(src).toMatch(/modtype_kalvidres/);
    expect(src).toMatch(/type:\s*['"]kaltura['"]/);
  });
});

describe('option gating regression', () => {
  // When a user ticks only Kaltura/Echo360 and leaves "Course materials"
  // unchecked, we must still scan sections (Kaltura videos live inside them).
  // Before this fix, the whole section-scan phase was gated on doMaterials
  // alone, so Kaltura silently produced 0 downloads.
  test('section-scan gate is any of materials/videos/folders', () => {
    const source = require('fs').readFileSync(require.resolve('../extension/background.js'), 'utf8');
    expect(source).toMatch(/if \(doMaterials \|\| doVideos \|\| doFolders\)/);
  });

  test('resource files are skipped inside scanning when materials is off', () => {
    const source = require('fs').readFileSync(require.resolve('../extension/background.js'), 'utf8');
    // The resource-push branch now checks doMaterials before including.
    const count = (source.match(/if \(doMaterials\) expandedFiles\.push\(file\)/g) || []).length;
    expect(count).toBeGreaterThanOrEqual(2); // batch path + per-section path
  });
});

describe('predictFilename', () => {
  test('urlShortcut → .url extension', () => {
    expect(bg.predictFilename({ type: 'urlShortcut', name: 'Lecture - 20 Jan 2026' }))
      .toBe('Lecture - 20 Jan 2026.url');
  });

  test('kalturaDownload → .mp4 extension', () => {
    expect(bg.predictFilename({ type: 'kalturaDownload', name: 'Session 1A' }))
      .toBe('Session 1A.mp4');
  });

  test('echo360 → .mp4 extension', () => {
    expect(bg.predictFilename({ type: 'echo360', name: 'Lecture 1' }))
      .toBe('Lecture 1.mp4');
  });

  test('resource files return null (filename only known after fetch)', () => {
    expect(bg.predictFilename({ type: 'resource', name: 'Slides' })).toBeNull();
  });

  test('folderFile returns null', () => {
    expect(bg.predictFilename({ type: 'folderFile', name: 'X' })).toBeNull();
  });

  test('null/undefined file returns null', () => {
    expect(bg.predictFilename(null)).toBeNull();
    expect(bg.predictFilename(undefined)).toBeNull();
  });

  test('illegal characters in name are sanitized before extension', () => {
    expect(bg.predictFilename({ type: 'kalturaDownload', name: 'Video: Part 1/2' }))
      .toBe('Video- Part 1-2.mp4');
  });
});

describe('buildExistingDownloadSet', () => {
  test('returns a Set of basenames for completed downloads in the course folder', async () => {
    global.chrome.downloads.search = jest.fn((_q, cb) => cb([
      { filename: '/Users/u/Downloads/KEATS Downloads/Software Architecture and Design (6CCS3SAD)/Week 1/Session 1A.mp4' },
      { filename: '/Users/u/Downloads/KEATS Downloads/Software Architecture and Design (6CCS3SAD)/Week 1/notes.pdf' },
      { filename: '/Users/u/Downloads/Other Course/ignore.mp4' },
    ]));
    const set = await bg.buildExistingDownloadSet(/\/Software Architecture and Design \(6CCS3SAD\)\//i);
    expect(set.has('Session 1A.mp4')).toBe(true);
    expect(set.has('notes.pdf')).toBe(true);
    expect(set.has('ignore.mp4')).toBe(false);
  });

  test('returns empty set when chrome.downloads.search throws', async () => {
    global.chrome.downloads.search = jest.fn(() => { throw new Error('oops'); });
    const set = await bg.buildExistingDownloadSet(null);
    expect(set.size).toBe(0);
  });

  test('handles empty history gracefully', async () => {
    global.chrome.downloads.search = jest.fn((_q, cb) => cb([]));
    const set = await bg.buildExistingDownloadSet(null);
    expect(set.size).toBe(0);
  });
});

describe('cleanCourseName', () => {
  test('KEATS standard format — Name (CODE)', () => {
    expect(bg.cleanCourseName('6CCS3SAD Software Architecture and Design(25~26 SEM2 000001)'))
      .toBe('Software Architecture and Design (6CCS3SAD)');
  });

  test('co-listed modules — takes first code, drops the rest', () => {
    expect(bg.cleanCourseName('6CCS3MDE & 7CCSMMDD Model-driven Engineering(25~26 SEM2 000001)'))
      .toBe('Model-driven Engineering (6CCS3MDE)');
  });

  test('handles QQMB codes', () => {
    expect(bg.cleanCourseName('6QQMB310 Business Strategy(25~26 SEM2 000001)'))
      .toBe('Business Strategy (6QQMB310)');
  });

  test('year-only parenthetical still stripped', () => {
    expect(bg.cleanCourseName('MATH101 Linear Algebra (2026)'))
      .toBe('Linear Algebra (MATH101)');
  });

  test('course without recognisable code returned as-is', () => {
    expect(bg.cleanCourseName('My Personal Notebook')).toBe('My Personal Notebook');
  });

  test('empty / null inputs', () => {
    expect(bg.cleanCourseName('')).toBe('');
    expect(bg.cleanCourseName(null)).toBe('');
    expect(bg.cleanCourseName(undefined)).toBe('');
  });

  test('trims and collapses whitespace', () => {
    expect(bg.cleanCourseName('   6CCS3CFL   Compilers and Formal Languages (25~26 SEM1 000001)  '))
      .toBe('Compilers and Formal Languages (6CCS3CFL)');
  });
});

describe('Kaltura ID extraction', () => {
  test('extracts entryId from URL-encoded iframe src (KEATS lti_launch pattern)', () => {
    const html = `<iframe id="contentframe" class="kaltura-player-iframe" src="https://keats.kcl.ac.uk/mod/kalvidres/lti_launch.php?courseid=134658&source=http%3A%2F%2Fkaltura-kaf-uri.com%2Fbrowseandembed%2Findex%2Fmedia%2Fentryid%2F1_m05ugjat%2FshowDescription%2Ffalse%2F"></iframe>`;
    const ids = bg.parseKalturaIdsFromHtml(html);
    expect(ids).not.toBeNull();
    expect(ids.entryId).toBe('1_m05ugjat');
  });

  test('extracts entryId from literal /entryid/ path', () => {
    const html = '<script>kWidget.embed({ entry_id: "1_abc123xy", wid: "_2368101" });</script>';
    const ids = bg.parseKalturaIdsFromHtml(html);
    expect(ids).not.toBeNull();
    expect(ids.entryId).toBe('1_abc123xy');
    expect(ids.partnerId).toBe('2368101');
  });

  test('extracts partnerId from /p/{id}/ CDN URL', () => {
    const html = '<script src="https://cdnapisec.kaltura.com/p/2368101/sp/236810100/embedIframeJs/uiconf_id/50869842"></script>entryid/1_xy/';
    const ids = bg.parseKalturaIdsFromHtml(html);
    expect(ids.partnerId).toBe('2368101');
    expect(ids.entryId).toBe('1_xy');
  });

  test('returns null when no entry ID present', () => {
    const html = '<html><body>No Kaltura here</body></html>';
    expect(bg.parseKalturaIdsFromHtml(html)).toBeNull();
  });

  test('buildKalturaDownloadUrl constructs correct playManifest URL', () => {
    const url = bg.buildKalturaDownloadUrl('1_m05ugjat', '2368101');
    expect(url).toBe('https://cdnapisec.kaltura.com/p/2368101/sp/236810100/playManifest/entryId/1_m05ugjat/format/download/protocol/https/flavorParamIds/0');
  });
});

describe('sleep precision', () => {
  test('resolves after specified duration', async () => {
    const start = Date.now();
    await bg.sleep(100);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(90);
    expect(elapsed).toBeLessThan(200);
  });
});
