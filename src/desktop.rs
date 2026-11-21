use crate::{
    model::{self, Invite, Upstream},
    net,
    server::{self, Api, App, DeleteItem, DialogJob, Job, Page},
    win,
};
use anyhow::{Context, Result, bail};
use axum::{
    Json, Router,
    extract::{Path, Query, State},
    routing::{get, post},
};
use base64::{
    Engine,
    engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    io::Write,
    net::Ipv4Addr,
    path::PathBuf,
    time::{Duration, Instant},
};
use uuid::Uuid;

pub fn routes() -> Router<App> {
    Router::new()
        .route("/local/status", get(status))
        .route("/local/config", post(configure))
        .route("/local/free-port", post(free_port))
        .route("/local/invite", post(invite))
        .route("/local/scan", post(scan))
        .route("/local/certificate", post(certificate))
        .route("/local/join", post(join))
        .route("/local/leave", post(leave))
        .route("/local/peer-address", post(peer_address))
        .route("/local/device/{id}", post(device))
        .route("/local/inbox", get(inbox))
        .route("/local/inbox/{id}/action", post(action))
        .route("/local/pick", post(pick))
        .route("/local/attachment", post(stage_attachment))
        .route("/local/attachment/discard", post(discard_attachments))
        .route("/local/send", post(send))
        .route("/local/job/{id}", get(job))
        .route("/local/dialog/{id}", get(dialog))
        .route("/local/stop", post(stop))
}

async fn status(State(app): State<App>) -> Json<Value> {
    let (mut data, host, peer_roster, peer_online, discovery) = {
        let db = app.db.lock().unwrap();
        (
            json!({"name":db.config.name,"address":db.config.address,"port":db.config.port,
            "discovery":db.config.discovery,"autostart":db.config.autostart,"url":net::url(&db.config),
            "networkError":db.network_error,"peerError":db.peer_error,
            "pcCodeActive":db.pc_code.as_ref().is_some_and(|code| code.remaining() > 0),
            "nameSyncPending":db.config.rename_pending,
            "joined":db.config.upstream.as_ref().map(|upstream| &upstream.url)}),
            db.config.host,
            db.peer_roster.clone(),
            db.peer_error.is_none(),
            db.config.discovery,
        )
    };
    let mut roster = app.roster(host);
    if let Some(devices) = roster["devices"].as_array_mut() {
        for device in devices.iter_mut() {
            device["managed"] = json!(true);
        }
        if let Some(peer) = peer_roster
            && let Some(remote) = peer["devices"].as_array()
        {
            if let Some(peer_host) = remote.last() {
                data["peerName"] = peer_host["name"].clone();
            }
            for device in remote {
                if device["id"] != peer["self"]
                    && !devices.iter().any(|local| local["id"] == device["id"])
                {
                    let mut device = device.clone();
                    if !peer_online {
                        device["online"] = json!(false);
                    }
                    devices.push(device);
                }
            }
        }
    }
    data["roster"] = roster;
    if discovery {
        let address = net::url(&app.db.lock().unwrap().config);
        let mut candidates = app
            .candidates
            .lock()
            .unwrap()
            .values()
            .filter(|candidate| Some(&candidate.url) != address.as_ref())
            .cloned()
            .collect::<Vec<_>>();
        candidates.sort_by(|a, b| (&a.name, &a.url).cmp(&(&b.name, &b.url)));
        candidates.dedup_by(|a, b| a.url == b.url);
        data["candidates"] = json!(candidates);
    }
    data["certificateUrl"] = json!(*app.certificate_url.lock().unwrap());
    Json(data)
}

async fn scan(State(app): State<App>) -> Api<Json<Value>> {
    if !app.db.lock().unwrap().config.discovery {
        return Err(anyhow::anyhow!("Включите поиск локальных компьютеров в настройках.").into());
    }
    app.rescan.notify_one();
    Ok(Json(json!(true)))
}

#[derive(Deserialize)]
struct Settings {
    name: String,
    address: Option<Ipv4Addr>,
    port: u16,
    discovery: bool,
    autostart: bool,
}
async fn configure(State(app): State<App>, Json(settings): Json<Settings>) -> Api<Json<Value>> {
    let new_name = model::name(&settings.name)?;
    let mut db = app.db.lock().unwrap();
    let mut config = db.config.clone();
    if config.upstream.is_some() && config.name != new_name {
        config.rename_pending = true;
    }
    config.name = new_name;
    if settings.port == 0 {
        return Err(anyhow::anyhow!("Укажите порт от 1 до 65535.").into());
    }
    config.address = settings.address.or_else(net::default_address);
    config.port = settings.port;
    if config.address != db.config.address || config.port != db.config.port {
        net::lan_listener(
            config.address.context("Локальный IPv4-адрес недоступен.")?,
            config.port,
        )?;
    }
    config.discovery = settings.discovery;
    config.autostart = settings.autostart;
    let restart = config.name != db.config.name
        || config.port != db.config.port
        || config.address != db.config.address
        || config.discovery != db.config.discovery;
    if config.autostart != db.config.autostart {
        win::autostart(&app.root, config.autostart)?;
    }
    if let Err(err) = app.save_config(&mut db, config) {
        let _ = win::autostart(&app.root, db.config.autostart);
        return Err(err.into());
    }
    if restart {
        restart_later(app.clone());
    }
    Ok(Json(
        json!({"restart":restart,"nameSyncPending":db.config.rename_pending}),
    ))
}

#[derive(Deserialize)]
struct PortSearch {
    address: Option<Ipv4Addr>,
}
async fn free_port(State(app): State<App>, Json(search): Json<PortSearch>) -> Api<Json<Value>> {
    let ip = search
        .address
        .or_else(net::default_address)
        .or(app.db.lock().unwrap().config.address)
        .context("Локальный IPv4-адрес недоступен.")?;
    let port = net::lan_listener(ip, 0)?.local_addr()?.port();
    Ok(Json(json!({"port":port})))
}

fn restart_later(app: App) {
    app.restart
        .store(true, std::sync::atomic::Ordering::Relaxed);
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(300)).await;
        let _ = app.shutdown.send(true);
    });
}

#[derive(Deserialize)]
struct InviteKind {
    kind: String,
    #[serde(default)]
    renew: bool,
}
async fn invite(State(app): State<App>, Json(kind): Json<InviteKind>) -> Api<Json<Value>> {
    if kind.kind == "certificate" {
        let link = app
            .certificate_url
            .lock()
            .unwrap()
            .clone()
            .context("Страница установки сертификата пока недоступна.")?;
        return Ok(Json(
            json!({"link":link,"qr":qr_image(&link)?,"fingerprint":app.ca.fingerprint()?}),
        ));
    }
    let mut db = app.db.lock().unwrap();
    if let Some(err) = &db.network_error {
        return Err(anyhow::anyhow!("{err}").into());
    }
    let url = net::url(&db.config).context("Задайте локальный адрес в настройках.")?;
    if kind.kind == "pc"
        && !kind.renew
        && let Some(pending) = db.pc_code.as_ref().filter(|code| code.remaining() > 0)
    {
        return Ok(Json(pc_invitation(pending)?));
    }
    let code = model::secret();
    let minutes = 5;
    let expires = Instant::now() + Duration::from_secs(minutes * 60);
    let link = format!("{url}/join/{code}");
    let data = match kind.kind.as_str() {
        "pc" => {
            let invite = Invite {
                url,
                ca: app.ca.pem.clone(),
                code: code.clone(),
            };
            let pending = crate::short_code::Pending::new(invite, expires);
            let data = pc_invitation(&pending)?;
            db.pc_code = Some(pending);
            data
        }
        "phone" => json!({"link":link,"qr":qr_image(&link)?,"minutes":minutes}),
        _ => return Err(anyhow::anyhow!("Выберите тип устройства.").into()),
    };
    db.invites
        .insert(kind.kind, (model::digest(&code), expires));
    Ok(Json(data))
}

fn qr_image(link: &str) -> Result<String> {
    let qr = qrcode::QrCode::new(link).context("Не удалось создать QR-код.")?;
    let width = qr.width();
    let mut svg = format!(
        "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 {0} {0}' shape-rendering='crispEdges'><rect width='100%' height='100%' fill='white'/><path d='",
        width + 8
    );
    use std::fmt::Write;
    for y in 0..width {
        for x in 0..width {
            if qr[(x, y)] == qrcode::Color::Dark {
                write!(&mut svg, "M{} {}h1v1h-1z", x + 4, y + 4).unwrap();
            }
        }
    }
    svg.push_str("'/></svg>");
    use base64::engine::general_purpose::STANDARD;
    Ok(format!(
        "data:image/svg+xml;base64,{}",
        STANDARD.encode(svg)
    ))
}

fn pc_invitation(pending: &crate::short_code::Pending) -> Result<Value> {
    let full = URL_SAFE_NO_PAD.encode(serde_json::to_vec(pending.invite())?);
    Ok(json!({"code":pending.code(),"full":full,"remaining":pending.remaining(),"minutes":5}))
}

async fn certificate(State(app): State<App>) -> Api<Json<Value>> {
    let der = app.ca.der()?;
    start_dialog(&app, move || {
        let Some(path) = rfd::FileDialog::new()
            .set_title("Сохранить сертификат для телефона")
            .set_file_name("ThodDrop.cer")
            .add_filter("Сертификат", &["cer", "crt"])
            .save_file()
        else {
            return Ok(json!({"saved":false}));
        };
        let mut file = std::fs::File::create(path)?;
        use std::io::Write;
        file.write_all(&der)?;
        Ok(json!({"saved":true}))
    })
}

#[derive(Deserialize)]
struct Join {
    code: String,
    candidate: Option<String>,
}
async fn join(State(app): State<App>, Json(request): Json<Join>) -> Api<Json<Value>> {
    if app.db.lock().unwrap().config.upstream.is_some() {
        return Err(anyhow::anyhow!("Этот ПК уже участвует в другой сети. Чтобы добавить компьютер в свою сеть, покажите ему свой код приглашения.").into());
    }
    if request.code.len() > 8192 {
        return Err(anyhow::anyhow!("Приглашение слишком длинное.").into());
    }
    let invite: Invite = if let Some(code) = crate::short_code::normalize(&request.code) {
        let url = request.candidate.as_deref().context(
            "Выберите ведущий ПК в списке найденных компьютеров или вставьте полное приглашение.",
        )?;
        let remote = net::private_endpoint(url)?;
        let local = app
            .db
            .lock()
            .unwrap()
            .config
            .address
            .or_else(net::default_address);
        if !local.is_some_and(|local| net::same_subnet(local, remote)) {
            return Err(anyhow::anyhow!(
                "Ведущий ПК должен находиться в той же локальной подсети."
            )
            .into());
        }
        crate::short_code::redeem(url, &code).await?
    } else {
        serde_json::from_slice(
            &URL_SAFE_NO_PAD
                .decode(request.code.trim())
                .context("Проверьте код или скопируйте полное приглашение с ведущего ПК.")?,
        )
        .context("Приглашение повреждено.")?
    };
    let client = net::peer_client(&invite.url, &invite.ca)?;
    if request.candidate.is_some_and(|url| url != invite.url)
        || net::url(&app.db.lock().unwrap().config).as_deref() == Some(&invite.url)
    {
        return Err(anyhow::anyhow!("Приглашение создано для другого компьютера.").into());
    }
    let name = app.db.lock().unwrap().config.name.clone();
    let response = client
        .post(format!("{}/api/pair", invite.url))
        .header("x-thoddrop", "1")
        .json(&json!({"name":name,"code":invite.code,"kind":"pc"}))
        .send()
        .await
        .context("Не удалось подключиться к ведущему компьютеру.")?;
    let reply = result(response).await?;
    let upstream = Upstream {
        url: invite.url,
        ca: invite.ca,
        token: reply["token"]
            .as_str()
            .context("Не получен ключ устройства.")?
            .to_owned(),
        device: serde_json::from_value(reply["id"].clone())
            .context("Некорректный идентификатор устройства.")?,
    };
    let mut db = app.db.lock().unwrap();
    let mut config = db.config.clone();
    config.upstream = Some(upstream);
    config.rename_pending = false;
    app.save_config(&mut db, config)?;
    restart_later(app.clone());
    Ok(Json(json!({"restart":true})))
}

async fn leave(State(app): State<App>) -> Api<Json<Value>> {
    let mut db = app.db.lock().unwrap();
    let mut config = db.config.clone();
    config.upstream = None;
    config.rename_pending = false;
    app.save_config(&mut db, config)?;
    restart_later(app.clone());
    Ok(Json(json!({"restart":true})))
}

#[derive(Deserialize)]
struct PeerAddress {
    url: String,
}

async fn peer_address(State(app): State<App>, Json(form): Json<PeerAddress>) -> Api<Json<Value>> {
    let mut upstream = app
        .db
        .lock()
        .unwrap()
        .config
        .upstream
        .clone()
        .context("Этот компьютер не подключён к ведущему ПК.")?;
    let original = upstream.url.clone();
    let parsed =
        reqwest::Url::parse(form.url.trim()).context("Укажите HTTPS-адрес ведущего ПК.")?;
    let host = parsed.host_str().context("Укажите IP ведущего ПК.")?;
    let port = parsed.port_or_known_default().context("Укажите порт.")?;
    if parsed.scheme() != "https"
        || parsed.path() != "/"
        || parsed.query().is_some()
        || parsed.fragment().is_some()
    {
        return Err(anyhow::anyhow!("Укажите адрес в формате https://IP:порт.").into());
    }
    upstream.url = format!("https://{host}:{port}");
    let roster = contact(&upstream, reqwest::Method::GET, "/api/roster", None)
        .await
        .context("Сертификат или доступ ведущего компьютера не подтверждён.")?;
    if roster["self"] != json!(upstream.device) {
        return Err(
            anyhow::anyhow!("Ведущий компьютер не подтвердил сохранённую привязку.").into(),
        );
    }
    let mut db = app.db.lock().unwrap();
    let mut config = db.config.clone();
    if !config
        .upstream
        .as_ref()
        .is_some_and(|active| active.device == upstream.device && active.url == original)
    {
        return Err(anyhow::anyhow!("Настройки подключения уже изменились.").into());
    }
    config.upstream = Some(upstream);
    app.save_config(&mut db, config)?;
    restart_later(app.clone());
    Ok(Json(json!({"restart":true})))
}

#[derive(Deserialize)]
struct DeviceEdit {
    name: Option<String>,
}
async fn device(
    State(app): State<App>,
    Path(id): Path<Uuid>,
    Json(edit): Json<DeviceEdit>,
) -> Api<Json<Value>> {
    let mut db = app.db.lock().unwrap();
    let mut devices = db.devices.clone();
    if let Some(name) = edit.name {
        devices
            .get_mut(&id)
            .context("Устройство уже удалено.")?
            .name = model::name(&name)?;
    } else {
        devices.remove(&id);
        db.presence.remove(&id);
        // Remove the revoked device's relay entries and release their storage.
        let mut items = db.items.clone();
        let removed = items
            .extract_if(.., |_, item| item.recipient == id)
            .map(|(_, item)| item)
            .collect::<Vec<_>>();
        app.save_devices(&mut db, devices)?;
        app.save_items(&mut db, items, false)?;
        for item in removed {
            if item.text.is_none() {
                let path = app.path(&item, false);
                let _ = std::fs::remove_file(&path);
                let _ = std::fs::remove_dir(path.parent().unwrap());
            }
        }
        return Ok(Json(json!(true)));
    }
    app.save_devices(&mut db, devices)?;
    Ok(Json(json!(true)))
}

async fn inbox(State(app): State<App>, Query(page): Query<Page>) -> Json<Value> {
    let db = app.db.lock().unwrap();
    let items = db.local_items.values().chain(
        db.items
            .values()
            .filter(|item| item.recipient == db.config.host),
    );
    Json(server::page(items, &page))
}

#[derive(Deserialize)]
struct Action {
    kind: String,
    #[serde(flatten)]
    delete: DeleteItem,
}
async fn action(
    State(app): State<App>,
    Path(id): Path<Uuid>,
    Json(action): Json<Action>,
) -> Api<Json<Value>> {
    let (item, mirrored, host, upstream) = {
        let db = app.db.lock().unwrap();
        let host = db.config.host;
        let local = db.local_items.get(&id);
        let item = local
            .or_else(|| db.items.get(&id).filter(|item| item.recipient == host))
            .cloned()
            .context("Передача уже удалена.")?;
        (item, local.is_some(), host, db.config.upstream.clone())
    };
    if action.kind == "delete" {
        if mirrored && let Some(upstream) = upstream.filter(|peer| item.recipient == peer.device) {
            let client = net::peer_client(&upstream.url, &upstream.ca)?;
            let reply = net::peer_request(
                &client,
                &upstream,
                reqwest::Method::DELETE,
                &format!("/api/items/{id}"),
            )
            .send()
            .await
            .context("Ведущий компьютер недоступен.")?;
            if reply.status() != reqwest::StatusCode::NOT_FOUND {
                result(reply).await?;
            }
        }
        server::drop_item(
            &app,
            if mirrored { None } else { Some(host) },
            id,
            mirrored,
            action.delete.file,
        )?;
        return Ok(Json(json!(true)));
    }
    let path = app.path(&item, true);
    let value = tokio::task::spawn_blocking(move || -> Result<Value> {
        match action.kind.as_str() {
            "reveal" if item.text.is_none() || item.stored_name.is_some() => win::reveal(&path)?,
            "copy" => {
                if let Some(text) = item.text {
                    arboard::Clipboard::new()?.set_text(text)?;
                } else if model::image_type(&item.name).is_some() {
                    win::copy_image(&path).or_else(|_| win::copy_path(&path))?;
                } else {
                    win::copy_path(&path)?;
                }
            }
            "preview" if model::image_type(&item.name).is_some() => {
                return Ok(json!(win::image_url(&path, false)?));
            }
            "image" if model::image_type(&item.name).is_some() => {
                return Ok(json!(win::image_url(&path, true)?));
            }
            _ => bail!("Действие недоступно."),
        }
        Ok(json!(true))
    })
    .await
    .context("Действие завершилось с ошибкой.")??;
    Ok(Json(value))
}

async fn pick(State(app): State<App>) -> Api<Json<Value>> {
    start_dialog(&app, || {
        Ok(json!(
            rfd::FileDialog::new()
                .set_title("Выбрать файлы")
                .pick_files()
                .unwrap_or_default()
        ))
    })
}

fn start_dialog(
    app: &App,
    action: impl FnOnce() -> Result<Value> + Send + 'static,
) -> Api<Json<Value>> {
    let id = Uuid::new_v4();
    {
        let mut dialogs = app.dialogs.lock().unwrap();
        if dialogs.values().any(|dialog| !dialog.finished) {
            return Err(anyhow::anyhow!("Сначала закройте открытый диалог Windows.").into());
        }
        dialogs.clear();
        dialogs.insert(id, DialogJob::default());
    }
    let app = app.clone();
    tokio::spawn(async move {
        let result = tokio::task::spawn_blocking(action)
            .await
            .context("Диалог Windows завершился с ошибкой.")
            .and_then(|result| result);
        let status = match result {
            Ok(value) => DialogJob {
                finished: true,
                value: Some(value),
                error: None,
            },
            Err(err) => DialogJob {
                finished: true,
                value: None,
                error: Some(err.to_string()),
            },
        };
        app.dialogs.lock().unwrap().insert(id, status);
    });
    Ok(Json(json!({"id":id})))
}

async fn dialog(State(app): State<App>, Path(id): Path<Uuid>) -> Api<Json<DialogJob>> {
    Ok(Json(
        app.dialogs
            .lock()
            .unwrap()
            .get(&id)
            .cloned()
            .context("Диалог больше недоступен.")?,
    ))
}

#[derive(Deserialize)]
struct SendRequest {
    to: Vec<Uuid>,
    text: String,
    #[serde(default)]
    files: Vec<PathBuf>,
    #[serde(default)]
    attachments: Vec<Uuid>,
}

pub struct Attachment {
    path: tempfile::TempPath,
    name: String,
    size: u64,
    received: u64,
    updated: Instant,
}

#[derive(Deserialize)]
struct AttachmentChunk {
    id: Uuid,
    name: String,
    size: u64,
    offset: u64,
    data: String,
}

async fn stage_attachment(
    State(app): State<App>,
    Json(chunk): Json<AttachmentChunk>,
) -> Api<Json<Value>> {
    const CHUNK_LIMIT: usize = 256 * 1024;
    let bytes = STANDARD
        .decode(&chunk.data)
        .context("Не удалось прочитать вложение.")?;
    if bytes.len() > CHUNK_LIMIT
        || chunk.size > model::MAX_FILE
        || chunk.offset.saturating_add(bytes.len() as u64) > chunk.size
        || (bytes.is_empty() && chunk.size != 0)
    {
        return Err(anyhow::anyhow!("Недопустимый размер вложения. Максимум 2 ГБ на файл.").into());
    }
    let mut drafts = app.attachments.lock().unwrap();
    drafts.retain(|_, draft| draft.updated.elapsed() < Duration::from_secs(3600));
    if !drafts.contains_key(&chunk.id) {
        if chunk.offset != 0
            || drafts.len() >= 512
            || drafts.values().map(|draft| draft.size).sum::<u64>() + chunk.size
                > model::MAX_STORAGE
        {
            return Err(anyhow::anyhow!(
                "Не удалось подготовить вложение. Попробуйте отправить меньше файлов за раз."
            )
            .into());
        }
        let path = tempfile::Builder::new()
            .prefix(".upload-")
            .tempfile_in(app.root.join("runtime"))?
            .into_temp_path();
        drafts.insert(
            chunk.id,
            Attachment {
                path,
                name: model::file_name(&chunk.name),
                size: chunk.size,
                received: 0,
                updated: Instant::now(),
            },
        );
    }
    let draft = drafts.get_mut(&chunk.id).unwrap();
    if draft.size != chunk.size || draft.received != chunk.offset {
        return Err(anyhow::anyhow!("Подготовка вложения прервалась. Повторите отправку.").into());
    }
    let mut file = std::fs::OpenOptions::new().append(true).open(&draft.path)?;
    if let Err(error) = file.write_all(&bytes) {
        let _ = file.set_len(draft.received);
        return Err(error.into());
    }
    draft.received += bytes.len() as u64;
    draft.updated = Instant::now();
    Ok(Json(json!(true)))
}

async fn discard_attachments(State(app): State<App>, Json(ids): Json<Vec<Uuid>>) -> Json<Value> {
    let mut drafts = app.attachments.lock().unwrap();
    for id in ids {
        drafts.remove(&id);
    }
    Json(json!(true))
}

enum SendFile {
    Path(PathBuf),
    Staged(Attachment),
}

async fn send(State(app): State<App>, Json(request): Json<SendRequest>) -> Api<Json<Value>> {
    let total = request.files.len()
        + request.attachments.len()
        + usize::from(!request.text.trim().is_empty());
    if total == 0 || total > model::MAX_ITEMS || request.to.is_empty() {
        return Err(anyhow::anyhow!("Выберите получателей и добавьте файлы или текст.").into());
    }
    let id = Uuid::new_v4();
    let staged;
    {
        let mut jobs = app.jobs.lock().unwrap();
        if jobs.values().any(|job| !job.finished) {
            return Err(anyhow::anyhow!("Дождитесь окончания отправки.").into());
        }
        let mut drafts = app.attachments.lock().unwrap();
        let mut unique = std::collections::HashSet::new();
        if !request.attachments.iter().all(|id| {
            unique.insert(*id)
                && drafts
                    .get(id)
                    .is_some_and(|draft| draft.received == draft.size)
        }) {
            return Err(anyhow::anyhow!("Одно из вложений не готово. Повторите отправку.").into());
        }
        staged = request
            .attachments
            .iter()
            .filter_map(|id| drafts.remove(id))
            .map(SendFile::Staged)
            .collect::<Vec<_>>();
        jobs.clear();
        jobs.insert(
            id,
            Job {
                total,
                ..Job::default()
            },
        );
    }
    tokio::spawn(async move {
        let files = request.files.into_iter().map(SendFile::Path).chain(staged);
        let error = send_job(&app, id, request.to, request.text, files)
            .await
            .err()
            .map(|err| format!("{err:#}"));
        if let Some(job) = app.jobs.lock().unwrap().get_mut(&id) {
            job.error = error;
            job.finished = true;
        }
    });
    Ok(Json(json!({"id":id})))
}

async fn job(State(app): State<App>, Path(id): Path<Uuid>) -> Api<Json<Job>> {
    Ok(Json(app.jobs.lock().unwrap().get(&id).cloned().context(
        "Отправка завершилась или сервер был перезапущен.",
    )?))
}

async fn send_job(
    app: &App,
    id: Uuid,
    recipients: Vec<Uuid>,
    text: String,
    files: impl Iterator<Item = SendFile>,
) -> Result<()> {
    use reqwest::Method;
    let (upstream, local, remote) = {
        let db = app.db.lock().unwrap();
        let (local, remote): (Vec<_>, Vec<_>) = recipients
            .into_iter()
            .partition(|id| db.config.upstream.is_none() || db.devices.contains_key(id));
        (db.config.upstream.clone(), local, remote)
    };
    let upstream = upstream.filter(|_| !remote.is_empty());
    let local_client = crate::local_client();
    let peer_client = upstream
        .as_ref()
        .map(|peer| net::peer_client(&peer.url, &peer.ca))
        .transpose()?;
    let mut routes = Vec::with_capacity(2);
    if let Some(peer) = &upstream {
        routes.push((Some(peer), remote));
    }
    if !local.is_empty() {
        routes.push((None, local));
    }
    let api = |peer: Option<&Upstream>, path: &str| {
        if let Some(peer) = peer {
            net::peer_request(peer_client.as_ref().unwrap(), peer, Method::POST, path)
        } else {
            local_client
                .post(format!("http://{}{path}", app.local_addr))
                .bearer_auth(&app.local_token)
        }
    };
    let check = |peer: Option<&Upstream>, index, response: reqwest::Result<reqwest::Response>| {
        response.with_context(|| if peer.is_some() {
            "Не удалось связаться с ведущим компьютером. Проверьте его адрес и подключение к сети."
        } else if index > 0 {
            "Часть получателей уже приняла передачу. Локальный сервер недоступен."
        } else {
            "Локальный сервер недоступен."
        })
    };
    let progress = || {
        if let Some(job) = app.jobs.lock().unwrap().get_mut(&id) {
            job.done += 1;
        }
    };
    if !text.trim().is_empty() {
        for (index, (peer, to)) in routes.iter().enumerate() {
            let response = api(*peer, "/api/text")
                .json(&json!({"to":to,"text":text,"batch":id}))
                .send()
                .await;
            result(check(*peer, index, response)?)
                .await
                .with_context(|| {
                    if index == 0 {
                        "Не удалось отправить текст."
                    } else {
                        "Часть получателей уже приняла текст."
                    }
                })?;
        }
        progress();
    }
    for file in files {
        let (path, name) = match &file {
            SendFile::Path(path) => (
                path.as_path(),
                model::file_name(
                    &path
                        .file_name()
                        .context("Файл недоступен.")?
                        .to_string_lossy(),
                ),
            ),
            SendFile::Staged(draft) => (draft.path.as_ref(), draft.name.clone()),
        };
        for (index, (peer, to)) in routes.iter().enumerate() {
            let file = tokio::fs::File::open(path)
                .await
                .with_context(|| format!("Не удалось открыть «{name}»."))?;
            let meta = file.metadata().await?;
            if !meta.is_file() || meta.len() > model::MAX_FILE {
                bail!("«{name}»: выберите файл размером до 2 ГБ.");
            }
            let to = to.iter().map(Uuid::to_string).collect::<Vec<_>>().join(",");
            let body = reqwest::Body::wrap_stream(tokio_util::io::ReaderStream::new(file));
            let response = api(*peer, "/api/upload")
                .query(&[
                    ("to", to),
                    ("name", name.clone()),
                    ("batch", id.to_string()),
                ])
                .header("content-length", meta.len())
                .body(body)
                .send()
                .await;
            result(check(*peer, index, response)?)
                .await
                .with_context(|| {
                    if index == 0 {
                        format!("Не удалось отправить «{name}».")
                    } else {
                        format!("Часть получателей уже приняла «{name}».")
                    }
                })?;
        }
        progress();
    }
    Ok(())
}

pub async fn result(response: reqwest::Response) -> Result<Value> {
    let status = response.status();
    if status == reqwest::StatusCode::NO_CONTENT {
        return Ok(Value::Null);
    }
    let body = response.json::<Value>().await.unwrap_or(Value::Null);
    if !status.is_success() {
        bail!(
            "{}",
            body["error"].as_str().unwrap_or("Запрос не выполнен.")
        );
    }
    Ok(body)
}

async fn contact(
    upstream: &Upstream,
    method: reqwest::Method,
    path: &str,
    json: Option<Value>,
) -> Result<Value> {
    let client = net::peer_client(&upstream.url, &upstream.ca)?;
    let mut req =
        net::peer_request(&client, upstream, method, path).timeout(Duration::from_secs(5));
    if let Some(body) = json {
        req = req.json(&body);
    }
    result(req.send().await?).await
}

async fn stop(State(app): State<App>) -> Json<Value> {
    app.restart
        .store(false, std::sync::atomic::Ordering::Relaxed);
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(250)).await;
        let _ = app.shutdown.send(true);
    });
    Json(json!(true))
}
