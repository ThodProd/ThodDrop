'use strict';
const $ = id => document.getElementById(id);
const icons = {
  pc: '<rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8m-4-4v4"/>',
  phone: '<rect x="7" y="2" width="10" height="20" rx="2"/><path d="M11 18h2"/>',
  attach: '<path d="m9 13 5-5a2 2 0 0 1 3 3l-7 7a4 4 0 0 1-6-6l8-8a5 5 0 0 1 7 7l-8 8"/>',
  send: '<path d="m22 2-7 20-4-9-9-4 20-7ZM22 2 11 13"/>',
  copy: '<rect x="8" y="8" width="12" height="13" rx="2"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9H3Z"/>',
  edit: '<path d="m14 5 5 5M5 14 16 3l5 5-11 11-6 1 1-6Z"/>',
  remove: '<path d="m6 6 12 12M18 6 6 18"/>',
  down: '<path d="M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5"/>',
  photo: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="m3 17 5-5 5 5 3-3 5 5"/><circle cx="15" cy="8" r="1"/>'
};
function icon(name) {
  const node = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  node.setAttribute('viewBox', '0 0 24 24');
  node.setAttribute('aria-hidden', 'true');
  node.innerHTML = icons[name];
  return node;
}
document.querySelectorAll('[data-icon]').forEach(node => node.replaceWith(icon(node.dataset.icon)));
function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text != null) node.textContent = text;
  return node;
}
function button(label, click, graphic, small = false) {
  const node = el('button', small ? 'icon-button' : '', small ? null : label);
  node.type = 'button';
  if (graphic) node.prepend(icon(graphic));
  if (small) { node.title = label; node.setAttribute('aria-label', label); }
  node.addEventListener('click', click);
  return node;
}
let noticeTimer;
function notice(message, error = false) {
  clearTimeout(noticeTimer);
  const node = $('notice');
  node.textContent = message;
  node.classList.toggle('error', error);
  node.hidden = !message;
  if (!error && message) noticeTimer = setTimeout(() => { node.hidden = true; }, 5500);
}
function failure(err) { notice(err.message || 'Действие не выполнено.', true); }
function size(bytes) {
  if (bytes < 1024) return bytes + ' Б';
  if (bytes < 1024 ** 2) return (bytes / 1024).toFixed(1) + ' КБ';
  if (bytes < 1024 ** 3) return (bytes / 1024 ** 2).toFixed(1) + ' МБ';
  return (bytes / 1024 ** 3).toFixed(1) + ' ГБ';
}
const date = new Intl.DateTimeFormat('ru', {day:'numeric', month:'short', hour:'2-digit', minute:'2-digit'});
const imageFile = name => /\.(png|jpe?g|webp|gif|bmp|tiff?|ico|hei[cf]|avif)$/i.test(name);
const selected = new Set();
function renderTargets(roster, rerender) {
  const all = roster?.devices.filter(d => d.id !== roster.self) || [];
  for (const id of selected) if (!all.some(d => d.id === id)) selected.delete(id);
  const list = $('targets');
  list.replaceChildren();
  if (!all.length) list.append(el('span', 'muted', 'Подключите устройство для отправки.'));
  for (const device of all) {
    const node = deviceButton(device, rerender);
    if (!device.online) {
      node.append(el('small', '', 'Не в сети'));
      node.title = 'Передача появится при следующем подключении';
    }
    list.append(node);
  }
  $('send-button').disabled = !selected.size || list.closest('form').classList.contains('sending');
}
function deviceButton(device, rerender) {
  const node = button(device.name, () => {
    if (selected.has(device.id)) selected.delete(device.id);
    else selected.add(device.id);
    rerender();
  }, device.kind === 'pc' ? 'pc' : 'phone');
  node.classList.add('recipient');
  node.setAttribute('aria-pressed', selected.has(device.id));
  return node;
}
function showAttachments(files, remove) {
  const list = $('attachments');
  list.replaceChildren();
  list.hidden = !files.length;
  files.forEach((file, index) => {
    const row = el('li');
    row.append(el('span', '', file.name), button('Убрать файл', () => remove(index), 'remove', true));
    list.append(row);
  });
}
function download(label, href, graphic = 'down') {
  const link = el('a', 'link-button', label);
  link.href = href;
  link.download = '';
  link.prepend(icon(graphic));
  return link;
}
function itemRow(item, actions, picture) {
  const row = el('article', 'item');
  const title = el('div', 'item-title');
  title.append(el('strong', '', item.name));
  if (item.text == null) title.append(el('small', '', size(item.size)));
  const toolbar = el('div', 'item-actions');
  toolbar.append(...actions);
  const head = el('div', 'item-head');
  head.append(title, toolbar);
  row.append(head);
  if (item.text != null) {
    const details = el('details', 'message');
    const sample = item.text.replace(/\s+/g, ' ').trim();
    details.append(el('summary', '', sample.length > 90 ? sample.slice(0, 90) + '…' : sample), el('div', 'message-text', item.text));
    row.append(details);
  } else if (picture) row.append(picture);
  return row;
}

function renderBatches(parent, items, renderItem, batchAction) {
  const open = new Set([...parent.querySelectorAll('article:has(details[open])')].map(node => node.dataset.id));
  const batches = new Map();
  for (const item of items) {
    if (!batches.has(item.batch)) batches.set(item.batch, []);
    batches.get(item.batch).push(item);
  }
  const cards = [];
  for (const batch of batches.values()) {
    const newest = batch[0];
    const card = el('section', 'transfer');
    const head = el('header', 'transfer-head');
    head.append(el('strong', '', newest.sender), el('time', 'muted', date.format(newest.time)));
    const action = batchAction?.(batch);
    if (action) head.append(action);
    card.append(head);
    const content = el('div', 'transfer-content');
    for (const item of [...batch].reverse()) {
      const node = renderItem(item);
      node.dataset.id = item.id;
      if (open.has(item.id) && item.text != null) node.querySelector('details').open = true;
      content.append(node);
    }
    card.append(content);
    cards.push(card);
  }
  parent.replaceChildren(...(cards.length ? cards : [el('p', 'muted', 'Здесь появятся полученные файлы и текст.')]));
}

const imageDialog = $('image-viewer');
const fullImage = $('full-image');
let imageRequest = 0;
imageDialog.querySelector('button').onclick = () => imageDialog.close();
imageDialog.addEventListener('click', event => { if (event.target === imageDialog) imageDialog.close(); });
imageDialog.addEventListener('close', () => {
  if (imageDialog.open) return;
  ++imageRequest;
  fullImage.removeAttribute('src');
});

async function showImage(name, url) {
  const request = ++imageRequest;
  const status = $('image-status');
  fullImage.hidden = true;
  fullImage.alt = name;
  status.hidden = false;
  status.textContent = 'Загрузка изображения…';
  if (!imageDialog.open) imageDialog.showModal();
  try {
    const src = await url();
    if (request !== imageRequest || !imageDialog.open) return;
    fullImage.src = src;
    await fullImage.decode();
    if (request !== imageRequest || !imageDialog.open) return;
    status.hidden = true;
    fullImage.hidden = false;
  } catch (error) {
    if (request === imageRequest && imageDialog.open) {
      status.textContent = error.message && !(error instanceof DOMException) ? error.message : 'Не удалось открыть изображение.';
    }
  }
}
