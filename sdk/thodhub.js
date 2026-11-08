(function () {
  'use strict';
  const pending = new Map();
  window.addEventListener('message', event => {
    if(event.source !== window.parent || event.data?.channel !== 'thodhub:response') return;
    const entry = pending.get(event.data.id);
    if(!entry) return;
    pending.delete(event.data.id); clearTimeout(entry.timer);
    event.data.error ? entry.reject(new Error(event.data.error)) : entry.resolve(event.data.result);
  });
  window.thodHub = Object.freeze({
    apiVersion: 1,
    call(method, params = null) {
      if(pending.size >= 64) return Promise.reject(new Error('Слишком много параллельных запросов.'));
      return new Promise((resolve, reject) => {
        const id = crypto.randomUUID();
        const timer = setTimeout(() => {pending.delete(id); reject(new Error('Утилита не ответила вовремя.'));}, 60000);
        pending.set(id, {resolve, reject, timer});
        window.parent.postMessage({channel:'thodhub:request', id, method, params}, '*');
      });
    }
  });
})();
