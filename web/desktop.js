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
  $('qr').removeAttribute('src');
}
async function invitePhone() {
  try {
    const info = await call('invite', {kind:'phone'});
    hideInvite();
    invitation = info.link;
    $('qr').hidden = false;
    $('qr').src = info.qr;
    $('invitation').hidden = false;
    expiration = setTimeout(hideInvite, info.minutes * 60000);
  } catch (error) { failure(error); }
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
    $('renew-pc-code').disabled = !!view?.joined || !view?.url || !!view?.networkError;
  }
}
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
  status.hidden = false;
  status.textContent = 'Поиск компьютеров…';
  try {
    await call('scan');
    await pause(2000);
    await refresh(true);
    status.textContent = view?.candidates?.length ? 'Поиск завершён.' : 'Компьютеры не найдены.';
  } catch (error) { status.textContent = error.message; }
  finally { $('scan').disabled = false; }
};
async function join(candidate) {
  const answer = await ask({title:candidate ? 'Подключиться к ' + candidate.name : 'Подключить этот компьютер',
    body: candidate
      ? 'Введите пять символов из раздела «Подключение» → «Код приглашения для ПК» на ведущем компьютере.'
      : 'На ведущем ПК откройте «Подключение» → «Код приглашения для ПК» → «Компьютер не появляется в списке». Скопируйте полное приглашение и вставьте его сюда.',
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
$('leave').onclick = async () => {
  const answer = await ask({title:'Отключиться от ведущего ПК?', body:'Этот компьютер снова запустит свою сеть. Полученные файлы останутся в папке приёма.', action:'Отключиться'});
  if (!answer) return;
  try { await call('leave'); dirty = false; await pause(650); await refresh(true); } catch (error) { failure(error); }
};
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
    if (!view.joined) {
      row.append(button('Переименовать', () => editDevice(device, false), 'edit', true));
      const revoke = button('Удалить устройство', () => editDevice(device, true), 'remove', true);
      revoke.classList.add('remove');
      row.append(revoke);
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
  $('host-controls').hidden = !!view.joined;
  $('address-display').textContent = view.url ? (error || view.url) : (error || 'Определение локального адреса…');
  $('phone-invite').disabled = !view.url || !!error;
  $('renew-pc-code').disabled = pcCodeLoading || !view.url || !!error;
  $('certificate-settings').hidden = !!view.joined;
  $('certificate-setup').hidden = !view.certificateUrl || view.certificateUrl !== certificateSetup?.link;
  $('search').hidden = !!view.joined;
  $('discovery-results').hidden = !view.discovery;
  const found = $('candidates');
  found.replaceChildren();
  if (!view.candidates?.length) found.append(el('p', 'muted', 'Ожидание компьютеров в локальной сети.'));
  for (const candidate of view.candidates || []) {
    const row = el('div', 'device');
    row.append(el('strong', '', candidate.name), el('span', 'state', candidate.url), button('Подключиться', () => join(candidate)));
    found.append(row);
  }
  $('server-fields').disabled = !!view.joined;
  $('peer-address').hidden = !view.joined;
  $('leave').hidden = !view.joined;
  if (!dirty) {
    $('pc-name').value = view.name;
    $('address').value = view.address || '';
    $('port').value = view.port;
    $('discovery').checked = view.discovery;
    $('autostart').checked = view.autostart;
  }
}
$('config').addEventListener('input', () => { dirty = true; });
$('auto-address').onclick = () => { $('address').value = ''; dirty = true; $('address').focus(); };
$('auto-port').onclick = async () => {
  try { $('port').value = (await call('freePort', {address:$('address').value.trim() || null})).port; dirty = true; }
  catch (error) { failure(error); }
};
$('config').addEventListener('submit', async event => {
  event.preventDefault();
  try {
    const result = await call('config', {name:$('pc-name').value, address:$('address').value.trim() || null,
      port:$('port').valueAsNumber, discovery:$('discovery').checked, autostart:$('autostart').checked});
    dirty = false;
    if (result.restart) { hideInvite(); clearPcCode(); await pause(650); }
    await refresh(true);
    notice('Настройки сохранены.');
  } catch (error) { failure(error); }
});

function updateFiles() {
  showAttachments(files.map(path => ({name:path.split(/[\\/]/).at(-1)})), index => {
    if (sending) return;
    files.splice(index, 1);
    updateFiles();
  });
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
$('files').onclick = async () => {
  $('files').disabled = true;
  try { files = [...new Set([...files, ...await dialogJob('pick')])]; updateFiles(); }
  catch (error) { failure(error); }
  finally { $('files').disabled = sending; }
};
$('send').addEventListener('submit', async event => {
  event.preventDefault();
  if (sending || !selected.size) return;
  const text = $('message').value;
  if (!files.length && !text.trim()) { notice('Добавьте файлы или текст.', true); return; }
  const hasText = !!text.trim();
  const to = [...selected];
  const total = files.length + Number(hasText);
  const progress = $('progress');
  sending = true;
  $('send').classList.add('sending');
  $('files').disabled = $('message').disabled = true;
  progress.hidden = false;
  progress.max = total;
  progress.value = 0;
  renderRoster();
  try {
    const job = await call('send', {to, files, text});
    let done = 0;
    for (;;) {
      const state = await call('job', {id:job.id});
      progress.value = state.done;
      done = state.done;
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
  } catch (error) { failure(error); }
  finally {
    sending = false;
    $('send').classList.remove('sending');
    $('files').disabled = $('message').disabled = false;
    progress.hidden = true;
    renderRoster();
  }
});
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
    if (item.text == null || item.stored_name) actions.push(button('Показать в папке', () => itemAction(item, 'reveal'), 'folder', true));
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
    const changed = JSON.stringify(next) !== JSON.stringify(view);
    view = next;
    if (changed || force) { renderConnection(); renderRoster(); }
    if (!next.joined && next.url && !next.networkError && (!next.pcCodeActive || pcExpiration <= Date.now())) {
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
