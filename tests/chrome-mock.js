// Shared Chrome API mock for tests
function createChromeMock() {
  const downloadListeners = [];
  let nextDownloadId = 1;

  return {
    runtime: {
      lastError: null,
      onMessage: { addListener: jest.fn() },
      onConnect: { addListener: jest.fn() },
      connect: jest.fn(() => ({ onDisconnect: { addListener: jest.fn() }, disconnect: jest.fn() })),
      sendMessage: jest.fn().mockResolvedValue(undefined),
    },
    tabs: {
      create: jest.fn().mockResolvedValue({ id: 99 }),
      remove: jest.fn().mockResolvedValue(),
      update: jest.fn((id, opts, cb) => cb && cb()),
      get: jest.fn().mockResolvedValue({ url: 'about:blank' }),
      query: jest.fn().mockResolvedValue([]),
      onUpdated: {
        addListener: jest.fn(),
        removeListener: jest.fn(),
      },
      onRemoved: {
        addListener: jest.fn(),
      },
    },
    downloads: {
      download: jest.fn((opts, cb) => {
        const id = nextDownloadId++;
        cb(id);
        // Auto-complete the download after a tick
        setTimeout(() => {
          for (const listener of downloadListeners) {
            listener({ id, state: { current: 'complete' } });
          }
        }, 10);
      }),
      search: jest.fn((_query, cb) => cb([])),
      setUiOptions: jest.fn().mockResolvedValue(),
      onChanged: {
        addListener: jest.fn((fn) => downloadListeners.push(fn)),
        removeListener: jest.fn((fn) => {
          const idx = downloadListeners.indexOf(fn);
          if (idx >= 0) downloadListeners.splice(idx, 1);
        }),
      },
    },
    scripting: {
      executeScript: jest.fn().mockResolvedValue([{ result: [] }]),
    },
    action: {
      setBadgeText: jest.fn().mockResolvedValue(),
      setBadgeBackgroundColor: jest.fn().mockResolvedValue(),
    },
    alarms: {
      create: jest.fn(),
      clear: jest.fn((_name, cb) => cb && cb(true)),
      onAlarm: { addListener: jest.fn() },
    },
    storage: {
      local: (() => {
        let store = {};
        return {
          get: jest.fn((key) => Promise.resolve({ [key]: store[key] })),
          set: jest.fn((obj) => { Object.assign(store, obj); return Promise.resolve(); }),
          _clear: () => { store = {}; },
        };
      })(),
      session: (() => {
        let store = {};
        return {
          get: jest.fn((key) => Promise.resolve({ [key]: store[key] })),
          set: jest.fn((obj) => { Object.assign(store, obj); return Promise.resolve(); }),
          remove: jest.fn(() => Promise.resolve()),
        };
      })(),
    },
  };
}

module.exports = { createChromeMock };
