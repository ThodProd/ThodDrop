// Мост между интерфейсом ThodDrop и хабом.
// Интерфейс исполняется в изолированном iframe хаба и не видит localhost, поэтому:
//  • запросы /api/admin/* идут в worker через thodHub.call('worker.http');
//  • события сервера (WebSocket /ws/ui) читаются опросом worker.events;
//  • файлы с ПК на телефон передаются частями (worker.upload.*);
//  • «localStorage» заменён настройками хаба (settings.get/set).
(function () {
  'use strict'
  const call = (m, p) => window.thodHub.call(m, p === undefined ? null : p)

  // ---- запросы к админскому API ----
  const realFetch = window.fetch.bind(window)
  window.fetch = async function (input, init) {
    const url = typeof input === 'string' ? input : input && input.url
    if (typeof url !== 'string' || !url.startsWith('/api/admin')) return realFetch(input, init)
    const headers = (init && init.headers) || {}
    const r = await call('worker.http', {
      method: (init && init.method) || 'GET',
      path: url,
      body: init && typeof init.body === 'string' ? init.body : null,
      contentType: headers['content-type'] || headers['Content-Type'] || null,
    })
    return new Response(r.body, { status: r.status, headers: { 'content-type': r.contentType || 'application/json' } })
  }

  // ---- события сервера ----
  const RealWS = window.WebSocket
  function HubSocket(url) {
    if (typeof url !== 'string' || url.indexOf('/ws/ui') < 0) return new RealWS(url)
    const self = this
    self.readyState = 0
    self.onopen = self.onmessage = self.onclose = self.onerror = null
    self.close = function () {
      self._stop = true
    }
    let since = 0
    ;(async function loop() {
      try {
        const first = await call('worker.events', { since: 0 })
        since = first.last // старые события не повторяем
        self.readyState = 1
        if (self.onopen) self.onopen({})
        while (!self._stop) {
          const r = await call('worker.events', { since })
          since = r.last
          for (const raw of r.events) if (self.onmessage) self.onmessage({ data: raw })
        }
      } catch (e) {
        // worker ещё не готов или перезапускается: приложение переподключится само
      }
      self.readyState = 3
      if (self.onclose) self.onclose({})
    })()
  }
  window.WebSocket = HubSocket

  // ---- буфер обмена ----
  try {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: (text) => call('clipboard.write', { text: String(text) }) },
    })
  } catch (e) {
    // без подмены: копирование в интерфейсе покажет ошибку
  }

  // ---- отправка файлов частями ----
  const CHUNK = 3 * 1024 * 1024
  const toB64 = (blob) =>
    new Promise((resolve, reject) => {
      const fr = new FileReader()
      fr.onload = () => resolve(String(fr.result).split(',')[1] || '')
      fr.onerror = () => reject(new Error('Не удалось прочитать файл.'))
      fr.readAsDataURL(blob)
    })
  window.thodUpload = async function (files, to, onProgress) {
    const total = files.reduce((a, f) => a + f.size, 0) || 1
    let done = 0
    for (const f of files) {
      const { id } = await call('worker.upload.begin', { name: f.name, size: f.size })
      for (let off = 0; off < f.size; off += CHUNK) {
        const part = f.slice(off, off + CHUNK)
        await call('worker.upload.chunk', { id, data: await toB64(part) })
        done += part.size
        onProgress(Math.min(1, done / total))
      }
      await call('worker.upload.end', { id, to: to || null })
    }
  }

  // ---- «localStorage» на настройках хаба ----
  const mem = {}
  let saveTimer = 0
  window.thodKV = {
    get: (k) => (Object.prototype.hasOwnProperty.call(mem, k) ? mem[k] : null),
    set: (k, v) => {
      mem[k] = String(v)
      clearTimeout(saveTimer)
      saveTimer = setTimeout(() => call('settings.set', { kv: mem }).catch(() => {}), 200)
    },
  }

  // ---- запуск приложения после загрузки настроек ----
  function start() {
    const s = document.createElement('script')
    s.src = 'app.js'
    document.body.appendChild(s)
  }
  call('settings.get')
    .then((saved) => {
      if (saved && saved.kv && typeof saved.kv === 'object') Object.assign(mem, saved.kv)
    })
    .catch(() => {})
    .then(start)
})()
