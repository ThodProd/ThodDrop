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
let pushReady = false;
let pushPermission;
let subscribeOnTap;
let focusInbox = new URLSearchParams(location.search).has('inbox');
const appleMobile = /iPhone|iPad|iPod/.test(navigator.userAgent)
  || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const homeApp = navigator.standalone === true || matchMedia('(display-mode: standalone)').matches;
$('ios-install-hint').hidden = !appleMobile || homeApp;
function invitationCode(url) {
  return url.pathname.match(/^\/join\/([a-f0-9]{64})$/i)?.[1]
    || url.searchParams.get('pair') || new URLSearchParams(url.hash.slice(1)).get('pair');
}
let pairCode = invitationCode(new URL(location.href));
if (location.protocol === 'http:') $('certificate-link').hidden = true;
const serviceWorker = navigator.serviceWorker;
const workerReady = serviceWorker?.register('/sw.js').then(() => serviceWorker.ready).catch(() => null);
serviceWorker?.addEventListener('message', event => {
  if (event.data !== 'open-inbox') return;
  focusInbox = true;
  void refresh(true);
});

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
  if (!paired) {
    pushReady = false;
    subscribeOnTap = undefined;
    setConnection('Нужна привязка', false);
  } else {
    void preparePush();
  }
}

function supportsPush() {
  return window.isSecureContext && workerReady && 'PushManager' in window
    && 'Notification' in window && (!appleMobile || homeApp);
}

function requestPushPermission() {
  if (!supportsPush() || Notification.permission !== 'default' || pushPermission) return;
  // Call synchronously from the existing tap so WebKit can show the system dialog.
  pushPermission = Notification.requestPermission().then(permission => {
    if (permission === 'granted' && !$('main').hidden) void preparePush();
  }).catch(() => {});
}

document.addEventListener('click', event => {
  if (!event.isTrusted || $('main').hidden || !event.target.closest('#main')) return;
  if (event.target.closest('a, .file-button, .icon-button')) return;
  if (subscribeOnTap) {
    subscribeOnTap();
  } else {
    requestPushPermission();
  }
}, {capture:true});

async function preparePush() {
  if (!supportsPush() || Notification.permission !== 'granted' || pushReady) return;
  pushReady = true;
  try {
    const [registration, state] = await Promise.all([workerReady, api('/api/push')]);
    if (!registration) return;
    const key = state.key.replace(/-/g, '+').replace(/_/g, '/');
    const applicationServerKey = Uint8Array.from(atob(key.padEnd(Math.ceil(key.length / 4) * 4, '=')), character => character.charCodeAt(0));
    const options = {userVisibleOnly:true, applicationServerKey};
    let subscription = await registration.pushManager.getSubscription();
    const existingKey = subscription?.options?.applicationServerKey;
    const existingBytes = existingKey && new Uint8Array(existingKey);
    if (existingBytes && (existingBytes.length !== applicationServerKey.length ||
        existingBytes.some((byte, index) => byte !== applicationServerKey[index]))) {
      await subscription.unsubscribe();
      subscription = null;
    }
    const save = subscription => post('/api/push', subscription.toJSON());
    try {
      await save(subscription || await registration.pushManager.subscribe(options));
    } catch (error) {
      if (error.name !== 'NotAllowedError' || Notification.permission !== 'granted') throw error;
      // Some browsers also require a tap when creating a subscription after permission was granted.
      subscribeOnTap = () => {
        subscribeOnTap = undefined;
        registration.pushManager.subscribe(options).then(save).catch(() => {});
      };
    }
  } catch (error) {
    console.warn('Не удалось зарегистрировать уведомления ThodDrop.', error.name);
  }
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
    requestPushPermission();
    await post('/api/pair', {name:$('device-name').value, code, kind:'phone'});
    if (pairCode) {
      await pushPermission;
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

function batchId() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
  return [hex.slice(0,8), hex.slice(8,12), hex.slice(12,16), hex.slice(16,20), hex.slice(20)].join('-');
}
async function copyText(text) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const field = el('textarea', 'sr');
  field.value = text;
  field.readOnly = true;
  document.body.append(field);
  try {
    field.focus();
    field.select();
    field.setSelectionRange(0, text.length);
    if (!document.execCommand('copy')) throw new Error('Выделите текст, чтобы скопировать его.');
  } finally { field.remove(); }
}
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
  const batch = batchId();
  const to = [...selected];
  busy = true;
  $('send').classList.add('sending');
  $('files').disabled = $('message').disabled = true;
  targets();
  let done = 0;
  try {
    if (hasText) {
      await post('/api/text', {text, to, batch});
      $('message').value = '';
      done++;
    }
    while (files.length) {
      attachmentProgress(0, 0);
      await sendFile(files[0], to, batch, fraction => attachmentProgress(0, Math.min(99, fraction * 100)));
      files.shift();
      attachments();
      done++;
    }
    notice('Отправлено ' + done + '.');
  } catch (error) {
    notice((done ? 'Отправлено ' + done + ' из ' + total + '. ' : '') + error.message, true);
  } finally {
    busy = false;
    $('send').classList.remove('sending');
    $('files').disabled = $('message').disabled = false;
    attachments();
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

const saveDialog = $('save-file');
const savePhoto = $('save-photo');
const saveHint = $('save-hint');
const saveShare = $('save-share');
const shareLimit = 32 * 1024 ** 2;
const shareTypes = {
  jpg:'image/jpeg', jpeg:'image/jpeg', png:'image/png', gif:'image/gif', webp:'image/webp',
  bmp:'image/bmp', heic:'image/heic', heif:'image/heif', tif:'image/tiff', tiff:'image/tiff',
  avif:'image/avif', ico:'image/x-icon', pdf:'application/pdf', txt:'text/plain'
};
let saveRequest;
let shareFile;
saveDialog.addEventListener('close', () => {
  if (saveDialog.open) return;
  saveRequest?.abort();
  shareFile = null;
  savePhoto.removeAttribute('src');
});
saveShare.onclick = async () => {
  if (!shareFile) return;
  try { await navigator.share({files:[shareFile]}); }
  catch (error) {
    if (error.name !== 'AbortError') {
      saveHint.textContent = savePhoto.hidden
        ? 'Воспользуйтесь кнопкой «Скачать файл».'
        : 'Удерживайте фото и выберите «Сохранить в Фото».';
      saveHint.hidden = false;
    }
  }
};
async function showSave(name, href, bytes, preview) {
  saveRequest?.abort();
  const request = new AbortController();
  saveRequest = request;
  shareFile = null;
  saveShare.hidden = true;
  $('save-name').textContent = name;
  $('save-download').href = href;
  $('save-download').download = name;
  savePhoto.hidden = !preview;
  if (preview) {
    savePhoto.alt = name;
    savePhoto.onerror = () => {
      savePhoto.hidden = true;
      saveHint.hidden = true;
    };
    savePhoto.src = preview;
  } else {
    savePhoto.removeAttribute('src');
  }
  saveHint.textContent = preview ? 'Удерживайте фото и выберите «Сохранить в Фото».' : '';
  saveHint.hidden = !preview;
  if (!saveDialog.open) saveDialog.showModal();
  if (!navigator.share || !navigator.canShare || bytes == null || bytes > shareLimit) return;
  try {
    const response = await fetch(href, {cache:'no-store', signal:request.signal});
    if (!response.ok || Number(response.headers.get('content-length')) > shareLimit) return;
    const blob = await response.blob();
    if (request.signal.aborted || !saveDialog.open || blob.size > shareLimit) return;
    const type = shareTypes[name.split('.').at(-1).toLowerCase()] || blob.type;
    const file = new File([blob], name, {type});
    if (navigator.canShare({files:[file]})) {
      shareFile = file;
      saveShare.hidden = false;
    }
  } catch {
    // The download link and the iOS image menu are still available.
  }
}
function saveAction(label, name, href, bytes, preview, compact = false) {
  if (appleMobile) {
    return button(label, () => showSave(name, href, bytes, preview), 'down', compact);
  }
  const link = download(label, href);
  link.download = name;
  return link;
}

function renderInbox() {
  const parent = $('items');
  renderBatches(parent, rows, item => {
    const actions = [];
    let picture;
    if (item.text != null) actions.push(button('Скопировать текст', async () => {
      try { await copyText(item.text); notice('Скопировано.'); } catch (error) { failure(error); }
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
      const photo = imageFile(item.name);
      actions.push(saveAction(photo && appleMobile ? 'Сохранить фото' : 'Скачать', item.name,
        '/api/file/' + item.id, item.size, photo ? '/api/preview/' + item.id : null, true));
    }
    const trash = button('Удалить передачу', () => remove(item), 'remove', true);
    trash.classList.add('remove');
    return itemRow(item, [...actions, trash], picture);
  }, batch => batch.filter(item => item.text == null).length > 1
    ? saveAction('Скачать пакет ZIP', 'ThodDrop.zip', '/api/archive/' + batch[0].batch) : null);
  $('more').hidden = !more;
}
async function loadInbox(offset = 0) {
  const query = new URLSearchParams({offset, known:offset ? '' : (inboxVersion || '')});
  const page = await api('/api/items?' + query);
  $('download-photos').hidden = !page.hasPhotos;
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
    if (focusInbox) {
      focusInbox = false;
      $('items').focus({preventScroll:true});
      $('items').scrollIntoView({block:'start'});
    }
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
