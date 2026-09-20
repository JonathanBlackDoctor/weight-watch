import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

function worker(offline = false) {
  const handlers = {};
  const calls = [];
  const cache = {
    addAll: async () => calls.push('install'),
    match: async (request) => request === './index.html' ? 'offline shell' : undefined,
    put: async () => calls.push('updated shell'),
  };
  const response = { ok: true, clone() { return this; } };
  vm.runInNewContext(readFileSync(new URL('../sw.js', import.meta.url), 'utf8'), {
    self: {
      addEventListener: (name, handler) => { handlers[name] = handler; },
      location: { origin: 'https://example.com' },
      registration: { scope: 'https://example.com/weight-watch/' },
      skipWaiting: async () => calls.push('activate now'),
      clients: { claim: async () => {} },
    },
    caches: {
      open: async (name) => { assert.equal(name, 'weight-watch-v4'); return cache; },
      match: async () => { throw new Error('Must not read old global caches'); },
    },
    fetch: async () => { if (offline) throw new Error('offline'); calls.push('network'); return response; },
    Request: class { constructor(url, options) { assert.equal(options.cache, 'reload'); } },
    Response, URL,
  });
  return { handlers, calls, response };
}
async function request(worker, mode) {
  let result;
  worker.handlers.fetch({ request: { method: 'GET', mode, url: 'https://example.com/weight-watch/?v=4' }, respondWith: (promise) => { result = promise; } });
  return result;
}
test('new worker activates after caching its shell without waiting for all tabs to close', async () => {
  const w = worker(); let pending;
  w.handlers.install({ waitUntil: (promise) => { pending = promise; } });
  await pending;
  assert.deepEqual(w.calls, ['install', 'activate now']);
});
test('online navigation gets the new shell, offline versioned navigation still works', async () => {
  const online = worker();
  assert.equal(await request(online, 'navigate'), online.response);
  assert.deepEqual(online.calls, ['network', 'updated shell']);
  assert.equal(await request(worker(true), 'navigate'), 'offline shell');
});
test('missing current-release asset uses network, never a stale global cache', async () => {
  const w = worker();
  assert.equal(await request(w, 'cors'), w.response);
  assert.deepEqual(w.calls, ['network']);
});
