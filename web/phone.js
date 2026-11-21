'use strict';
let roster = null;
let files = [];
let rows = [];
let more = false;
let busy = false;
let refreshing = false;
let pendingDelete;
let inboxVersion;
const pairCode = new URLSearchParams(location.hash.slice(1)).get('pair');
if (pairCode) history.replaceState(null, '', '/');
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});

async function api(path, options = {}) {
  const response = await fetch(path, {cache:'no-store', ...options, headers:{'x-thoddrop':'1', ...options.headers}});
  if (response.status === 401) {
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
    const code = pairCode || new URLSearchParams(url.hash.slice(1)).get('pair');
    if (!code) throw new Error('В ссылке нет кода привязки.');
    await post('/api/pair', {name:$('device-name').value, code, kind:'phone'});
    await refresh(true);
  } catch (error) { failure(error); }
  finally { if (submit) submit.disabled = false; }
});
function targets() { renderTargets(roster, targets, true); }
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
  const open = new Set([...parent.querySelectorAll('article:has(details[open])')].map(node => node.dataset.id));
  parent.replaceChildren();
  if (!rows.length) parent.append(el('p', 'muted', 'Здесь появятся полученные файлы и текст.'));
  const batches = new Map();
  for (const row of rows) if (row.text == null) batches.set(row.batch, (batches.get(row.batch) || 0) + 1);
  const shown = new Set();
  for (const item of rows) {
    if (batches.get(item.batch) > 1 && !shown.has(item.batch)) {
      const tools = el('div', 'batch');
      tools.append(download('Скачать пакет ZIP', '/api/archive/' + item.batch));
      parent.append(tools);
      shown.add(item.batch);
    }
    const actions = [];
    let picture;
    if (item.text != null) actions.push(button('Скопировать текст', async () => {
      try { await navigator.clipboard.writeText(item.text); notice('Скопировано.'); } catch (error) { failure(error); }
    }, 'copy', true));
    else {
      if (imageFile(item.name)) {
        picture = el('img', 'thumb');
        picture.loading = 'lazy';
        picture.src = '/api/thumbnail/' + item.id;
        picture.alt = item.name;
        picture.onerror = () => { picture.hidden = true; };
        if (navigator.clipboard?.write && window.ClipboardItem) actions.push(button('Скопировать изображение', async () => {
          try { await copyImage(item); notice('Скопировано.'); } catch (error) { failure(error); }
        }, 'copy', true));
      }
      actions.push(download('Скачать', '/api/file/' + item.id));
    }
    const trash = button('Удалить передачу', () => remove(item), 'remove', true);
    trash.classList.add('remove');
    const node = itemRow(item, [...actions, trash], picture);
    node.dataset.id = item.id;
    if (open.has(item.id) && item.text != null) node.querySelector('details').open = true;
    parent.append(node);
  }
  $('more').hidden = !more;
}
async function loadInbox(offset = 0) {
  const query = new URLSearchParams({offset, known:offset ? '' : (inboxVersion || '')});
  const page = await api('/api/items?' + query);
  if (page.unchanged) return;
  if (!offset) inboxVersion = page.version;
  const next = offset ? [...rows, ...page.items] : [...page.items, ...rows.slice(30)];
  const unique = new Map(next.map(item => [item.id, item]));
  const old = rows.map(item => item.id).join();
  rows = [...unique.values()];
  if (offset || rows.length <= 30) more = page.more;
  if (old !== rows.map(item => item.id).join() || !$('items').children.length) renderInbox();
}
$('more').addEventListener('click', () => loadInbox(rows.length).catch(failure));
async function refresh(force = false) {
  if (refreshing || (document.hidden && !force)) return;
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
  } finally { refreshing = false; }
}
document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(true); });
window.addEventListener('online', () => refresh(true));
refresh();
setInterval(refresh, 4000);
