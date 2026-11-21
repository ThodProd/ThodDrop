'use strict';
const theme = new URLSearchParams(location.search).get('theme');
if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme;
const call = (method, data) => thodHub.call('worker.' + method, data ?? null);
const copy = text => thodHub.call('clipboard.write', {text});
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
let view;
let tab = 'transfers';
let invitation;
let expiration;
let phoneInviteLoading = false;
let pcExpiration = 0;
let pcCodeLoading = false;
let certificateSetup;
let certificateLoading = false;
let fullPcInvitation;
let files = [];
let entries = [];
let hasMore = false;
let inboxNext = 0;
let loading = false;
let sending = false;
let dirty = false;
let saving = false;
let inboxVersion;

function switchTab(id) {
  tab = id;
  for (const button of document.querySelectorAll('[data-tab]')) {
    const active = button.dataset.tab === id;
    button.setAttribute('aria-selected', active);
    $(button.dataset.tab).hidden = !active;
  }
  refresh();
}
document.querySelectorAll('[data-tab]').forEach(button => button.addEventListener('click', () => switchTab(button.dataset.tab)));
document.querySelector('nav').addEventListener('keydown', event => {
  if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
  const buttons = [...document.querySelectorAll('[data-tab]')];
  const next = (buttons.findIndex(button => button.dataset.tab === tab) + (event.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length;
  buttons[next].focus();
  switchTab(buttons[next].dataset.tab);
});
$('to-transfers').onclick = () => switchTab('transfers');

function ask({title, body, field, value, file, action = 'Сохранить', danger = false}) {
  const dialog = $('prompt');
  const submit = $('prompt-submit');
  const input = $('prompt-value');
  $('prompt-title').textContent = title;
  $('prompt-body').textContent = body || '';
  $('prompt-body').hidden = !body;
  $('prompt-label').hidden = !field;
  $('prompt-caption').textContent = field || '';
  input.value = value || '';
  $('prompt-file').hidden = !file;
  $('prompt-delete-file').checked = false;
  submit.textContent = action;
  submit.classList.toggle('danger', danger);
  submit.classList.toggle('primary', !danger);
  dialog.returnValue = '';
  submit.onclick = () => {
    if (field && !input.value.trim()) { input.focus(); return; }
    dialog.close('yes');
  };
  $('prompt-cancel').onclick = () => dialog.close('cancel');
  dialog.querySelector('form').onsubmit = event => event.preventDefault();
  input.onkeydown = event => {
    if (event.key === 'Enter' && !event.isComposing && !danger) {
      event.preventDefault();
      submit.click();
    }
  };
  dialog.showModal();
  if (field) input.focus();
  return new Promise(resolve => dialog.addEventListener('close', () => {
    resolve(dialog.returnValue === 'yes' ? {value:input.value.trim(), file:$('prompt-delete-file').checked} : null);
  }, {once:true}));
}
function hideInvite() {
  clearTimeout(expiration);
  invitation = null;
  $('invitation').hidden = true;
  $('phone-invite').setAttribute('aria-expanded', 'false');
  $('phone-invite-label').textContent = 'Показать QR-код для телефона';
  $('qr').removeAttribute('src');
}
async function invitePhone() {
  if (invitation) { hideInvite(); return; }
  if (phoneInviteLoading) return;
  phoneInviteLoading = true;
  $('phone-invite').disabled = true;
  try {
    const info = await call('invite', {kind:'phone'});
    hideInvite();
    invitation = info.link;
    $('qr').hidden = false;
    $('qr').src = info.qr;
    $('invitation').hidden = false;
    $('phone-invite').setAttribute('aria-expanded', 'true');
    $('phone-invite-label').textContent = 'Скрыть QR-код';
    expiration = setTimeout(hideInvite, info.minutes * 60000);
  } catch (error) { failure(error); }
  finally {
    phoneInviteLoading = false;
    $('phone-invite').disabled = !invitation && (!view?.url || !!view?.networkError);
  }
}
$('phone-invite').onclick = invitePhone;
function clearPcCode() {
  pcExpiration = 0;
  fullPcInvitation = null;
  $('pc-code').value = '';
  $('copy-pc-code').disabled = $('copy-full-pc-code').disabled = true;
  renderPcTimer();
}
function renderPcTimer() {
  const remaining = Math.max(0, pcExpiration - Date.now());
  const seconds = Math.ceil(remaining / 1000);
  $('pc-code-progress').value = remaining;
  $('pc-code-status').textContent = pcExpiration
    ? Math.floor(seconds / 60) + ':' + String(seconds % 60).padStart(2, '0') : '';
  if (!remaining) $('copy-pc-code').disabled = $('copy-full-pc-code').disabled = true;
}
async function createPcCode(renew = false) {
  if (pcCodeLoading) return;
  pcCodeLoading = true;
  $('renew-pc-code').disabled = true;
  try {
    const info = await call('invite', {kind:'pc', renew});
    $('pc-code').value = info.code;
    fullPcInvitation = info.full;
    pcExpiration = Date.now() + info.remaining;
    $('copy-pc-code').disabled = false;
    $('copy-full-pc-code').disabled = !fullPcInvitation;
    renderPcTimer();
  } catch (error) {
    if (renew) failure(error);
    else $('pc-code-status').textContent = error.message;
  } finally {
    pcCodeLoading = false;
    $('renew-pc-code').disabled = !view?.url || !!view?.networkError;
  }
}
$('pc-invite').onclick = () => {
  const panel = $('pc-invitation');
  panel.hidden = !panel.hidden;
  $('pc-invite').setAttribute('aria-expanded', String(!panel.hidden));
  $('pc-invite-label').textContent = panel.hidden ? 'Показать код приглашения' : 'Скрыть код приглашения';
  if (!panel.hidden) void createPcCode();
};
$('renew-pc-code').onclick = () => createPcCode(true);
setInterval(renderPcTimer, 1000);
$('copy-pc-code').onclick = async () => {
  const code = $('pc-code').value;
  if (!code) return;
  try { await copy(code); notice('Код приглашения скопирован.'); } catch (error) { failure(error); }
};
$('copy-full-pc-code').onclick = async () => {
  if (!fullPcInvitation) return;
  try { await copy(fullPcInvitation); notice('Полное приглашение скопировано.'); } catch (error) { failure(error); }
};
$('copy-invite').onclick = async () => {
  if (!invitation) return;
  try { await copy(invitation); notice('Приглашение скопировано.'); } catch (error) { failure(error); }
};
$('certificate').onclick = async () => {
  $('certificate').disabled = true;
  try {
    if ((await dialogJob('certificate')).saved) notice('Сертификат сохранён.');
  } catch (error) { failure(error); }
  finally { $('certificate').disabled = false; }
};
$('open-certificate').onclick = () => switchTab('settings');
$('copy-certificate-url').onclick = async () => {
  if (!certificateSetup) return;
  try { await copy(certificateSetup.link); notice('Ссылка на сертификат скопирована.'); } catch (error) { failure(error); }
};
async function loadCertificateSetup() {
  if (!view?.certificateUrl || certificateLoading || view.certificateUrl === certificateSetup?.link) return;
  certificateLoading = true;
  try {
    const setup = await call('invite', {kind:'certificate'});
    if (view.certificateUrl !== setup.link) return;
    certificateSetup = setup;
    $('certificate-qr').src = setup.qr;
    $('certificate-url').textContent = setup.link;
    $('certificate-fingerprint').textContent = setup.fingerprint;
    $('certificate-setup').hidden = false;
  } catch (error) { failure(error); }
  finally { certificateLoading = false; }
}
$('scan').onclick = async () => {
  const status = $('scan-status');
  $('scan').disabled = true;
  $('scan').dataset.running = 'true';
  status.hidden = false;
  status.textContent = 'Поиск компьютеров…';
  try {
    await call('scan');
    await pause(2000);
    await refresh(true);
    status.textContent = view?.candidates?.length ? 'Поиск завершён.' : 'Компьютеры не найдены.';
  } catch (error) { status.textContent = error.message; }
  finally { delete $('scan').dataset.running; $('scan').disabled = !view?.discovery; }
};
async function join(candidate) {
  if (view?.joined) {
    notice('Этот ПК уже подключён к ведущему. Чтобы добавить другой компьютер, покажите на этом ПК свой код приглашения.', true);
    return;
  }
  const answer = await ask({title:candidate ? 'Подключиться к ' + candidate.name : 'Подключить этот компьютер',
    body: candidate
      ? 'Введите пять символов из раздела «Подключение» → «Код приглашения для ПК» на ведущем компьютере.'
      : 'На другом ПК нажмите «Показать код приглашения» → «Скопировать полное приглашение» и вставьте его сюда.',
    field: candidate ? 'Код приглашения' : 'Полное приглашение', action:'Подключить'});
  if (!answer) return;
  try {
    await call('join', {code:answer.value, candidate:candidate?.url});
    hideInvite();
    clearPcCode();
    dirty = false;
    await pause(650);
    await refresh(true);
    notice('Компьютер подключён.');
  } catch (error) { failure(error); }
}
$('manual-join').onclick = () => join();
$('peer-address').onclick = async () => {
  const answer = await ask({title:'Обновить адрес ведущего ПК', field:'Новый HTTPS-адрес', value:view.joined});
  if (!answer) return;
  try {
    await call('peerAddress', {url:answer.value});
    await pause(650);
    await refresh(true);
    notice('Адрес обновлён.');
  } catch (error) { failure(error); }
};
async function forgetPc() {
  const answer = await ask({title:'Забыть ведущий ПК?', body:'Полученные файлы сохранятся. Для нового подключения понадобится приглашение.', action:'Забыть', danger:true});
  if (!answer) return;
  try {
    const result = await call('leave');
    dirty = false;
    await pause(650);
    await refresh(true);
    notice(result.notified ? 'Компьютер забыт.' : 'Компьютер забыт на этом ПК. Ведущий был недоступен для уведомления.');
  } catch (error) { failure(error); }
}
$('leave').onclick = forgetPc;
async function editDevice(device, revoke) {
  const answer = await ask(revoke ? {title:'Удалить устройство?', body:'«' + device.name + '» потеряет доступ. Его входящие на сервере будут удалены.', action:'Удалить', danger:true}
    : {title:'Переименовать устройство', field:'Имя', value:device.name});
  if (!answer) return;
  try { await call('device', {id:device.id, name:revoke ? null : answer.value}); await refresh(true); }
  catch (error) { failure(error); }
}
function renderRoster() {
  renderTargets(view?.roster, renderRoster);
  const list = $('devices');
  list.replaceChildren();
  const devices = view?.roster?.devices.filter(device => device.id !== view.roster.self) || [];
  if (!devices.length) list.append(el('p', 'muted', 'Подключённых устройств пока нет.'));
  for (const device of devices) {
    const row = el('div', 'device');
    row.append(deviceButton(device, renderRoster), el('span', 'state' + (device.online ? ' online' : ''), device.online ? 'В сети' : 'Не в сети'));
    if (device.managed) {
      row.append(button('Переименовать', () => editDevice(device, false), 'edit', true));
      const revoke = button(device.kind === 'pc' ? 'Забыть компьютер' : 'Удалить устройство', () => editDevice(device, true), 'remove', true);
      revoke.classList.add('remove');
      row.append(revoke);
    } else if (device.id === view.peerId) {
      row.append(button('Забыть компьютер', forgetPc, 'remove', true));
    }
    list.append(row);
  }
  $('to-transfers').hidden = !selected.size;
}
function renderConnection() {
  const status = $('connection');
  const error = view.joined ? view.peerError : view.networkError;
  status.textContent = error ? 'Нет связи' : view.joined ? 'В сети' : view.url ? 'Сервер запущен' : 'Запуск…';
  status.title = error || '';
  status.classList.toggle('online', !error && !!(view.url || view.joined));
  $('address-display').textContent = view.networkError || view.url || 'Определение локального адреса…';
  $('peer-status').hidden = !view.joined;
  $('peer-status').textContent = view.joined
    ? 'Ведущий ПК · ' + (view.peerName || view.joined) + (view.peerError ? ' · нет связи' : '')
    : '';
  $('phone-invite').disabled = phoneInviteLoading || (!invitation && (!view.url || !!view.networkError));
  $('pc-invite').disabled = $('pc-invitation').hidden && (!view.url || !!view.networkError);
  $('renew-pc-code').disabled = pcCodeLoading || !view.url || !!view.networkError;
  $('certificate-setup').hidden = !view.certificateUrl || view.certificateUrl !== certificateSetup?.link;
  $('scan').disabled = !view.discovery || $('scan').dataset.running === 'true';
  const found = $('candidates');
  found.replaceChildren();
  const candidates = new Map((view.candidates || []).map(candidate => [candidate.url, candidate]));
  if (view.joined && !candidates.has(view.joined)) {
    candidates.set(view.joined, {url:view.joined, name:view.peerName || 'Ведущий ПК'});
  }
  if (!candidates.size && view.discovery) found.append(el('p', 'muted', 'Поиск компьютеров в локальной сети…'));
  if (!candidates.size && !view.discovery) found.append(el('p', 'muted', 'Поиск отключён в настройках.'));
  for (const candidate of candidates.values()) {
    const row = el('div', 'device candidate');
    const detail = el('div', 'candidate-info');
    detail.append(el('strong', '', candidate.name), el('small', '', candidate.url));
    const connected = candidate.url === view.joined;
    row.append(detail, connected
      ? button('Забыть компьютер', forgetPc)
      : button('Подключиться', () => join(candidate)));
    found.append(row);
  }
  $('peer-address').hidden = !view.joined;
  $('leave').hidden = !view.joined;
  $('phone-http-url').hidden = !view.phoneHttpUrl;
  $('phone-http-url').textContent = view.phoneHttpUrl || '';
  if (!dirty) {
    $('pc-name').value = view.name;
    $('address').value = view.address || '';
    $('port').value = view.port;
    $('discovery').checked = view.discovery;
    $('autostart').checked = view.autostart;
    $('phone-http').checked = view.phoneHttp;
  }
}
$('config').addEventListener('input', () => { dirty = true; });
$('auto-address').onclick = () => { $('address').value = ''; dirty = true; $('address').focus(); };
$('auto-port').onclick = async () => {
  try { $('port').value = (await call('freePort', {address:$('address').value.trim() || null})).port; dirty = true; }
  catch (error) { failure(error); }
};
async function saveSettings() {
  if (saving || !$('config').reportValidity()) return;
  const status = $('settings-status');
  const submit = $('save-settings');
  saving = submit.disabled = true;
  status.hidden = false;
  status.classList.remove('error');
  status.textContent = 'Сохранение…';
  try {
    const result = await call('config', {name:$('pc-name').value, address:$('address').value.trim() || null,
      port:$('port').valueAsNumber, discovery:$('discovery').checked, autostart:$('autostart').checked, phone_http:$('phone-http').checked});
    dirty = false;
    status.textContent = result.nameSyncPending
      ? 'Настройки сохранены. Имя на ведущем ПК обновится при синхронизации.'
      : 'Настройки сохранены.';
    if (result.restart) { hideInvite(); clearPcCode(); await pause(650); }
    await refresh(true);
  } catch (error) {
    status.classList.add('error');
    status.textContent = error.message;
  } finally { saving = submit.disabled = false; }
}
$('save-settings').onclick = saveSettings;
$('config').addEventListener('keydown', event => {
  if (event.key === 'Enter' && event.target.matches('input:not([type="checkbox"])') && !event.isComposing) {
    event.preventDefault();
    void saveSettings();
  }
});

function updateFiles() {
  showAttachments(files, index => {
    if (sending) return;
    files.splice(index, 1);
    updateFiles();
  });
}
function addFiles(incoming) {
  if ([...incoming].some(file => file.size > 2 * 1024 ** 3)) {
    notice('Один файл может занимать до 2 ГБ.', true);
    return;
  }
  if (files.length + incoming.length > 512) {
    notice('Можно прикрепить до 512 файлов за одну отправку.', true);
    return;
  }
  files.push(...incoming);
  updateFiles();
}
$('files').onchange = event => {
  if (!sending) addFiles(event.target.files);
  event.target.value = '';
};
const dropZone = $('drop-zone');
const acceptsDrop = event => tab === 'transfers'
  && [...event.dataTransfer.types].some(type => ['Files', 'text/plain', 'text/uri-list'].includes(type));
document.addEventListener('dragover', event => {
  if (!acceptsDrop(event)) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = sending ? 'none' : 'copy';
  dropZone.classList.toggle('dragging', !sending);
});
document.addEventListener('dragleave', event => {
  if (!event.relatedTarget) dropZone.classList.remove('dragging');
});
document.addEventListener('drop', event => {
  dropZone.classList.remove('dragging');
  if (!acceptsDrop(event)) return;
  event.preventDefault();
  if (sending) return;
  if (event.dataTransfer.files.length) {
    addFiles(event.dataTransfer.files);
    return;
  }
  const text = event.dataTransfer.getData('text/plain') || event.dataTransfer.getData('text/uri-list').trim();
  if (!text) return;
  const field = $('message');
  const combined = field.value ? field.value + '\n' + text : text;
  if (combined.length > field.maxLength) {
    notice('Добавленный текст превышает допустимый размер.', true);
    return;
  }
  field.value = combined;
  field.focus();
});

async function stageFile(file, id, onProgress) {
  const chunkSize = 256 * 1024;
  let offset = 0;
  do {
    const bytes = new Uint8Array(await file.slice(offset, offset + chunkSize).arrayBuffer());
    let binary = '';
    for (let start = 0; start < bytes.length; start += 8192) {
      binary += String.fromCharCode(...bytes.subarray(start, start + 8192));
    }
    await call('stageAttachment', {id, name:file.name, size:file.size, offset, data:btoa(binary)});
    offset += bytes.length;
    onProgress(file.size === 0 ? 1 : offset / file.size);
  } while (offset < file.size);
}
async function dialogJob(method) {
  const job = await call(method);
  for (;;) {
    await pause(500);
    const status = await call('dialogJob', {id:job.id});
    if (status.finished) {
      if (status.error) throw new Error(status.error);
      return status.value;
    }
  }
}
$('send-button').onclick = async () => {
  if (sending || !selected.size) return;
  const text = $('message').value;
  if (!files.length && !text.trim()) { notice('Добавьте файлы или текст.', true); return; }
  const hasText = !!text.trim();
  const to = [...selected];
  const total = files.length + Number(hasText);
  const status = $('send-status');
  sending = true;
  $('send').classList.add('sending');
  $('files').disabled = $('message').disabled = true;
  status.hidden = false;
  status.textContent = files.length ? 'Подготовка вложений…' : 'Отправка…';
  renderRoster();
  const attachments = [];
  try {
    for (const [index, file] of files.entries()) {
      const id = crypto.randomUUID();
      attachments.push(id);
      attachmentProgress(index, 0);
      await stageFile(file, id, fraction => attachmentProgress(index, fraction * 30));
    }
    status.textContent = 'Отправка…';
    const job = await call('send', {to, attachments, text});
    let done = 0;
    for (;;) {
      const state = await call('job', {id:job.id});
      done = state.done;
      const sentFiles = Math.max(0, done - Number(hasText));
      for (let index = 0; index < sentFiles; index++) attachmentProgress(index, 100);
      if (done >= Number(hasText) && sentFiles < files.length) {
        const fraction = state.file_size ? state.file_progress / state.file_size : 0;
        attachmentProgress(sentFiles, Math.min(99, 30 + fraction * 69));
      }
      if (state.finished) {
        if (hasText && done) $('message').value = '';
        files = files.slice(Math.max(0, done - Number(hasText)));
        updateFiles();
        if (state.error) throw new Error((done ? 'Отправлено ' + done + ' из ' + total + '. ' : '') + state.error);
        notice('Отправлено ' + done + '.');
        break;
      }
      await pause(400);
    }
  } catch (error) {
    if (attachments.length) void call('discardAttachments', attachments).catch(() => {});
    failure(error);
  } finally {
    sending = false;
    $('send').classList.remove('sending');
    $('files').disabled = $('message').disabled = false;
    updateFiles();
    status.hidden = true;
    renderRoster();
  }
};
async function itemAction(item, kind) {
  try {
    if (kind === 'delete') {
      const answer = await ask({title:'Удалить передачу?', body:item.text == null ? item.name : 'Текст будет удалён из входящих.', file:item.text == null || !!item.stored_name, action:'Удалить', danger:true});
      if (!answer) return;
      await call('item', {id:item.id, kind, file:answer.file});
      entries = entries.filter(row => row.id !== item.id);
      renderInbox();
      await loadInbox();
    } else {
      const data = await call('item', {id:item.id, kind});
      if (kind === 'copy') notice('Скопировано.');
      return data;
    }
  } catch (error) { failure(error); }
}
const previews = new IntersectionObserver(observed => {
  for (const entry of observed) {
    if (!entry.isIntersecting) continue;
    const trigger = entry.target;
    previews.unobserve(trigger);
    trigger.dataset.loaded = 'true';
    call('item', {id:trigger.dataset.id, kind:'preview'}).then(src => {
      const thumb = el('img', 'thumb');
      thumb.src = src;
      thumb.alt = trigger.getAttribute('aria-label');
      trigger.replaceChildren(thumb);
    }).catch(() => {});
  }
}, {rootMargin:'120px'});
function renderInbox() {
  const list = $('items');
  const existing = new Map([...list.querySelectorAll('.image-trigger')].map(node => [node.dataset.id, node]));
  previews.disconnect();
  renderBatches(list, entries, item => {
    const actions = [button('Скопировать', () => itemAction(item, 'copy'), 'copy', true)];
    if (item.text == null) actions.push(button('Показать в папке', () => itemAction(item, 'reveal'), 'folder', true));
    const trash = button('Удалить передачу', () => itemAction(item, 'delete'), 'remove', true);
    trash.classList.add('remove');
    actions.push(trash);
    let picture = existing.get(item.id);
    if (!picture && item.text == null && imageFile(item.name)) {
      picture = button('Открыть фото', () => showImage(item.name, () => call('item', {id:item.id, kind:'image'})), 'photo');
      picture.classList.add('image-trigger');
      picture.setAttribute('aria-label', item.name);
      picture.dataset.id = item.id;
    }
    return itemRow(item, actions, picture);
  });
  for (const trigger of list.querySelectorAll('.image-trigger:not([data-loaded])')) previews.observe(trigger);
  $('more').hidden = !hasMore;
}
async function loadInbox(offset = 0) {
  const page = await call('inbox', {offset, known:offset ? null : inboxVersion});
  if (page.unchanged) return;
  if (!offset) inboxVersion = page.version;
  const items = offset ? [...entries, ...page.items] : page.items;
  entries = [...new Map(items.map(item => [item.id, item])).values()];
  hasMore = page.more;
  inboxNext = page.next;
  renderInbox();
}
$('more').onclick = async () => {
  if (loading) return;
  loading = true;
  try { await loadInbox(inboxNext); } catch (error) { failure(error); }
  finally { loading = false; }
};
async function refresh(force = false) {
  if (loading || (document.hidden && !force)) return;
  loading = true;
  try {
    const next = await call('status');
    if (view?.roster && next.roster) {
      const previous = new Set(view.roster.devices.map(device => device.id));
      const added = next.roster.devices.filter(device => !previous.has(device.id));
      if (invitation && added.some(device => device.kind === 'phone')) hideInvite();
    }
    if (view?.nameSyncPending && !next.nameSyncPending && !next.peerError && !dirty) {
      $('settings-status').textContent = 'Имя обновлено на ведущем ПК.';
    }
    const changed = JSON.stringify(next) !== JSON.stringify(view);
    view = next;
    if (changed || force) { renderConnection(); renderRoster(); }
    if (next.url && !next.networkError && !$('pc-invitation').hidden && (!next.pcCodeActive || pcExpiration <= Date.now())) {
      void createPcCode();
    }
    if (tab === 'settings') void loadCertificateSetup();
    if (tab === 'transfers') await loadInbox();
  } catch (error) {
    $('connection').textContent = 'Нет связи';
    $('connection').classList.remove('online');
    if (!view || force) failure(error);
  } finally { loading = false; }
}
refresh();
setInterval(refresh, 3000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(true); });
