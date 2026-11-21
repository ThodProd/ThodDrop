'use strict';
let roster = null;
let files = [];
let rows = [];
let more = false;
let inboxNext = 0;
let busy = false;
let refreshing = false;
let refreshQueued = false;
let pendingDelete;
let inboxVersion;
function invitationCode(url) {
  return url.pathname.match(/^\/join\/([a-f0-9]{64})$/i)?.[1]
    || url.searchParams.get('pair') || new URLSearchParams(url.hash.slice(1)).get('pair');
}
let pairCode = invitationCode(new URL(location.href));
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});

async function api(path, options = {}) {
  const response = await fetch(path, {cache:'no-store', ...options, headers:{'x-thoddrop':'1', ...options.headers}});
  if (response.status === 401) {
    roster = null;
    rows = [];
    inboxVersion = undefined;
    targets();
    setPaired(false);
    throw new Error('Подключите телефон к ThodDrop.');
  }
  if (response.status === 204) return null;
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(body?.error || 'Запрос не выполнен.');
  return body;
}
function post(path, body) {
  return api(path, {method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify(body)});
}
function setConnection(label, online) {
  $('connection').textContent = label;
  $('connection').classList.toggle('online', online);
}
function setPaired(paired) {
  $('pair').hidden = paired;
  $('main').hidden = !paired;
  if (!paired) setConnection('Нужна привязка', false);
}
$('pair-form').hidden = false;
if (pairCode) $('pair-help').textContent = 'Введите имя, которое будут видеть другие устройства.';
else {
  const codeInput = el('input');
  codeInput.id = 'manual-link';
  codeInput.placeholder = 'Вставьте ссылку из ThodDrop';
  codeInput.required = true;
  codeInput.autocomplete = 'off';
  const label = el('label', '', 'Ссылка приглашения');
  label.htmlFor = codeInput.id;
  $('pair-form').prepend(label, codeInput);
}
$('pair-form').addEventListener('submit', async event => {
  event.preventDefault();
  const submit = event.submitter;
  if (submit) submit.disabled = true;
  try {
    const url = pairCode ? null : new URL($('manual-link').value.trim());
    if (url && url.origin !== location.origin) throw new Error('Откройте веб-приложение ведущего компьютера, который создал приглашение.');
    const code = pairCode || invitationCode(url);
    if (!code) throw new Error('В ссылке нет кода привязки.');
    await post('/api/pair', {name:$('device-name').value, code, kind:'phone'});
    if (pairCode) {
      history.replaceState(null, '', '/');
      setTimeout(() => location.reload(), 0);
      return;
    }
    await refresh(true);
  } catch (error) { failure(error); }
  finally { if (submit) submit.disabled = false; }
});
function targets() { renderTargets(roster, targets); }
function attachments() {
  showAttachments(files, index => {
    if (busy) return;
    files.splice(index, 1);
    attachments();
  });
}
$('files').addEventListener('change', event => {
  files.push(...event.target.files);
  event.target.value = '';
  attachments();
});

function sendFile(file, to, batch, progress) {
  return new Promise((resolve, reject) => {
    const query = new URLSearchParams({name:file.name, to:to.join(','), batch});
    const request = new XMLHttpRequest();
    request.open('POST', '/api/upload?' + query);
    request.timeout = 60 * 60 * 1000;
    request.setRequestHeader('x-thoddrop', '1');
    request.setRequestHeader('content-type', 'application/octet-stream');
    request.upload.onprogress = event => { if (event.lengthComputable && event.total) progress(event.loaded / event.total); };
    request.onload = () => {
      if (request.status >= 200 && request.status < 300) { resolve(); return; }
      let error;
      try { error = JSON.parse(request.responseText).error; } catch {}
      reject(new Error(error || 'Не удалось передать ' + file.name + '.'));
    };
    request.onerror = request.ontimeout = () => reject(new Error('Связь прервалась при отправке файла «' + file.name + '».'));
    request.send(file);
  });
}
$('send').addEventListener('submit', async event => {
  event.preventDefault();
  if (busy || !selected.size) return;
  const text = $('message').value;
  const hasText = !!text.trim();
  const total = files.length + Number(hasText);
  if (!total) { notice('Добавьте файлы или текст.', true); return; }
  if (files.some(file => file.size > 2 * 1024 ** 3)) { notice('Один файл может занимать до 2 ГБ.', true); return; }
  const batch = crypto.randomUUID();
  const to = [...selected];
  const progress = $('progress');
  busy = true;
  $('send').classList.add('sending');
  $('files').disabled = $('message').disabled = true;
  progress.max = total;
  progress.value = 0;
  progress.hidden = false;
  targets();
  let done = 0;
  try {
    if (hasText) {
      await post('/api/text', {text, to, batch});
      $('message').value = '';
      progress.value = ++done;
    }
    while (files.length) {
      await sendFile(files[0], to, batch, fraction => { progress.value = done + fraction; });
      files.shift();
      attachments();
      progress.value = ++done;
    }
    notice('Отправлено ' + done + '.');
  } catch (error) {
    notice((done ? 'Отправлено ' + done + ' из ' + total + '. ' : '') + error.message, true);
  } finally {
    busy = false;
    $('send').classList.remove('sending');
    $('files').disabled = $('message').disabled = false;
    progress.hidden = true;
    targets();
  }
});

function remove(item) {
  pendingDelete = item.id;
  $('delete-name').textContent = item.name;
  $('confirm').showModal();
}
$('confirm-delete').addEventListener('click', async () => {
  if (!pendingDelete) return;
  $('confirm').close();
  try {
    await api('/api/items/' + pendingDelete, {method:'DELETE'});
    rows = rows.filter(item => item.id !== pendingDelete);
    renderInbox();
    await refresh(true);
  } catch (error) { failure(error); }
});
async function copyImage(item) {
  if (!navigator.clipboard?.write || !window.ClipboardItem) throw new Error('В этом браузере фото можно скачать.');
  const blob = fetch('/api/preview/' + item.id).then(async response => {
    if (!response.ok) throw new Error('Изображение недоступно.');
    const image = new Image();
    const url = URL.createObjectURL(await response.blob());
    try {
      image.src = url;
      await image.decode();
      if (image.naturalWidth * image.naturalHeight > 32_000_000) throw new Error('Изображение слишком большое для буфера обмена.');
      const canvas = document.createElement('canvas');
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      canvas.getContext('2d').drawImage(image, 0, 0);
      return await new Promise((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('Не удалось скопировать фото.')), 'image/png'));
    } finally { URL.revokeObjectURL(url); }
  });
  await navigator.clipboard.write([new ClipboardItem({'image/png':blob})]);
}
function renderInbox() {
  const parent = $('items');
  renderBatches(parent, rows, item => {
    const actions = [];
    let picture;
    if (item.text != null) actions.push(button('Скопировать текст', async () => {
      try { await navigator.clipboard.writeText(item.text); notice('Скопировано.'); } catch (error) { failure(error); }
    }, 'copy', true));
    else {
      if (imageFile(item.name)) {
        const url = '/api/preview/' + item.id;
        picture = button('Открыть фото', () => showImage(item.name, () => url), 'photo');
        picture.classList.add('image-trigger');
        picture.setAttribute('aria-label', item.name);
        const thumb = el('img', 'thumb');
        thumb.loading = 'lazy';
        thumb.alt = item.name;
        thumb.onload = () => {
          thumb.classList.remove('thumb-loading');
          picture.replaceChildren(thumb);
        };
        thumb.onerror = () => { if (thumb.getAttribute('src') !== url) thumb.src = url; };
        thumb.classList.add('thumb-loading');
        thumb.src = '/api/thumbnail/' + item.id;
        picture.append(thumb);
        if (navigator.clipboard?.write && window.ClipboardItem) actions.push(button('Скопировать изображение', async () => {
          try { await copyImage(item); notice('Скопировано.'); } catch (error) { failure(error); }
        }, 'copy', true));
      }
      actions.push(download('Скачать', '/api/file/' + item.id));
    }
    const trash = button('Удалить передачу', () => remove(item), 'remove', true);
    trash.classList.add('remove');
    return itemRow(item, [...actions, trash], picture);
  }, batch => batch.filter(item => item.text == null).length > 1
    ? download('Скачать пакет ZIP', '/api/archive/' + batch[0].batch) : null);
  $('more').hidden = !more;
}
async function loadInbox(offset = 0) {
  const query = new URLSearchParams({offset, known:offset ? '' : (inboxVersion || '')});
  const page = await api('/api/items?' + query);
  if (page.unchanged) return;
  if (!offset) inboxVersion = page.version;
  const items = offset ? [...rows, ...page.items] : page.items;
  rows = [...new Map(items.map(item => [item.id, item])).values()];
  more = page.more;
  inboxNext = page.next;
  renderInbox();
}
$('more').addEventListener('click', async () => {
  if (refreshing) return;
  refreshing = true;
  try { await loadInbox(inboxNext); } catch (error) { failure(error); }
  finally { finishRefresh(); }
});
function finishRefresh() {
  refreshing = false;
  if (refreshQueued) {
    refreshQueued = false;
    void refresh(true);
  }
}
async function refresh(force = false) {
  if (!force && document.hidden) return;
  if (refreshing) {
    refreshQueued ||= force;
    return;
  }
  refreshing = true;
  try {
    const next = await post('/api/presence', {});
    if (JSON.stringify(next) !== JSON.stringify(roster)) {
      roster = next;
      targets();
    }
    setPaired(true);
    setConnection('В сети', true);
    await loadInbox();
  } catch (error) {
    if (error.message !== 'Подключите телефон к ThodDrop.') {
      setConnection('Нет связи', false);
      if (roster) { roster = null; targets(); }
      else if (!pairCode) setPaired(false);
    }
  } finally { finishRefresh(); }
}
document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(true); });
window.addEventListener('online', () => refresh(true));
refresh();
setInterval(refresh, 4000);
