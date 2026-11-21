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
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
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
        .route("/local/certificate", post(certificate))
        .route("/local/join", post(join))
        .route("/local/leave", post(leave))
        .route("/local/peer-address", post(peer_address))
        .route("/local/device/{id}", post(device))
        .route("/local/inbox", get(inbox))
        .route("/local/inbox/{id}/action", post(action))
        .route("/local/pick", post(pick))
        .route("/local/send", post(send))
        .route("/local/job/{id}", get(job))
        .route("/local/dialog/{id}", get(dialog))
        .route("/local/stop", post(stop))
}

async fn status(State(app): State<App>) -> Json<Value> {
    let (mut data, host, upstream, discovery) = {
        let db = app.db.lock().unwrap();
        (
            json!({"name":db.config.name,"address":db.config.address,"port":db.config.port,
            "discovery":db.config.discovery,"autostart":db.config.autostart,"url":net::url(&db.config),
            "networkError":db.network_error,"peerError":db.peer_error,
            "joined":db.config.upstream.as_ref().map(|upstream| &upstream.url)}),
            db.config.host,
            db.config.upstream.clone(),
            db.config.discovery,
        )
    };
    data["roster"] = if let Some(upstream) = upstream {
        match contact(&upstream, reqwest::Method::GET, "/api/roster", None).await {
            Ok(roster) => roster,
            Err(_) => json!({"self":upstream.device,"devices":[]}),
        }
    } else {
        app.roster(host)
    };
    if discovery {
        let address = net::url(&app.db.lock().unwrap().config);
        let candidates = app
            .candidates
            .lock()
            .unwrap()
            .values()
            .filter(|candidate| {
                Some(&candidate.url) != address.as_ref()
                    && candidate
                        .seen
                        .is_some_and(|seen| seen.elapsed() < Duration::from_secs(150))
            })
            .cloned()
            .collect::<Vec<_>>();
        data["candidates"] = json!(candidates);
    }
    Json(data)
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
    let rename = {
        let db = app.db.lock().unwrap();
        db.config
            .upstream
            .clone()
            .filter(|_| db.config.name != new_name)
    };
    if let Some(upstream) = rename {
        contact(
            &upstream,
            reqwest::Method::POST,
            "/api/name",
            Some(json!({"name":new_name})),
        )
        .await?;
    }
    let mut db = app.db.lock().unwrap();
    let mut config = db.config.clone();
    config.name = new_name;
    if settings.port == 0 {
        return Err(anyhow::anyhow!("Укажите порт от 1 до 65535.").into());
    }
    config.address = settings.address.or_else(net::default_address);
    config.port = settings.port;
    if config.upstream.is_none()
        && (config.address != db.config.address || config.port != db.config.port)
    {
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
    win::autostart(&app.root, config.autostart)?;
    if let Err(err) = app.save_config(&mut db, config) {
        let _ = win::autostart(&app.root, db.config.autostart);
        return Err(err.into());
    }
    if restart {
        restart_later(app.clone());
    }
    Ok(Json(json!({"restart":restart})))
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
}
async fn invite(State(app): State<App>, Json(kind): Json<InviteKind>) -> Api<Json<Value>> {
    let mut db = app.db.lock().unwrap();
    if db.config.upstream.is_some() {
        return Err(anyhow::anyhow!("Создайте приглашение на ведущем компьютере.").into());
    }
    if let Some(err) = &db.network_error {
        return Err(anyhow::anyhow!("{err}").into());
    }
    let url = net::url(&db.config).context("Задайте локальный адрес в настройках.")?;
    let code = model::secret();
    let minutes = 5;
    let link = format!("{url}/#pair={code}");
    let data = match kind.kind.as_str() {
        "pc" => {
            let invite = Invite {
                url,
                ca: app.ca.pem.clone(),
                code: code.clone(),
            };
            json!({"code":URL_SAFE_NO_PAD.encode(serde_json::to_vec(&invite).context("Не удалось сформировать приглашение.")?),"minutes":minutes})
        }
        "phone" => {
            let qr = qrcode::QrCode::new(&link).context("Не удалось создать QR-код.")?;
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
            json!({"link":link,"qr":format!("data:image/svg+xml;base64,{}",STANDARD.encode(svg)),"minutes":minutes})
        }
        _ => return Err(anyhow::anyhow!("Выберите тип устройства.").into()),
    };
    db.invites.insert(
        kind.kind,
        (
            model::digest(&code),
            Instant::now() + Duration::from_secs(minutes * 60),
        ),
    );
    Ok(Json(data))
}

async fn certificate(State(app): State<App>) -> Api<Json<Value>> {
    let encoded = app
        .ca
        .pem
        .lines()
        .filter(|line| !line.starts_with("-----"))
        .collect::<String>();
    let der = base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .context("Не удалось прочитать сертификат.")?;
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
    if request.code.len() > 8192 {
        return Err(anyhow::anyhow!("Приглашение слишком длинное.").into());
    }
    let invite: Invite = serde_json::from_slice(
        &URL_SAFE_NO_PAD
            .decode(request.code.trim())
            .context("Скопируйте приглашение с ведущего компьютера.")?,
    )
    .context("Приглашение повреждено.")?;
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
    app.save_config(&mut db, config)?;
    restart_later(app.clone());
    Ok(Json(json!({"restart":true})))
}

async fn leave(State(app): State<App>) -> Api<Json<Value>> {
    let mut db = app.db.lock().unwrap();
    let mut config = db.config.clone();
    config.upstream = None;
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
            "reveal" if item.text.is_none() => win::reveal(&path)?,
            "copy" => {
                if let Some(text) = item.text {
                    arboard::Clipboard::new()?.set_text(text)?;
                } else if model::image_type(&item.name).is_some() {
                    win::copy_file(&path, false)?;
                } else {
                    win::copy_path(&path)?;
                }
            }
            "preview" if model::image_type(&item.name).is_some() => {
                return Ok(json!(win::copy_file(&path, true)?));
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
    files: Vec<PathBuf>,
}
async fn send(State(app): State<App>, Json(request): Json<SendRequest>) -> Api<Json<Value>> {
    let total = request.files.len() + usize::from(!request.text.trim().is_empty());
    if total == 0 || total > model::MAX_ITEMS || request.to.is_empty() {
        return Err(anyhow::anyhow!("Выберите получателей и добавьте файлы или текст.").into());
    }
    let id = Uuid::new_v4();
    {
        let mut jobs = app.jobs.lock().unwrap();
        if jobs.values().any(|job| !job.finished) {
            return Err(anyhow::anyhow!("Дождитесь окончания отправки.").into());
        }
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
        let error = send_job(&app, id, request)
            .await
            .err()
            .map(|err| err.to_string());
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

async fn send_job(app: &App, id: Uuid, request: SendRequest) -> Result<()> {
    use reqwest::Method;
    let upstream = app.db.lock().unwrap().config.upstream.clone();
    let client = if let Some(upstream) = &upstream {
        net::peer_client(&upstream.url, &upstream.ca)?
    } else {
        crate::local_client()
    };
    let api = |method, path: &str| {
        if let Some(upstream) = &upstream {
            net::peer_request(&client, upstream, method, path)
        } else {
            client
                .request(method, format!("http://{}{path}", app.local_addr))
                .bearer_auth(&app.local_token)
        }
    };
    let progress = || {
        if let Some(job) = app.jobs.lock().unwrap().get_mut(&id) {
            job.done += 1;
        }
    };
    let text = request.text.trim();
    if !text.is_empty() {
        result(
            api(Method::POST, "/api/text")
                .json(&json!({"to":request.to,"text":request.text,"batch":id}))
                .send()
                .await?,
        )
        .await?;
        progress();
    }
    for path in request.files {
        let name = model::file_name(
            path.file_name()
                .context("Файл недоступен.")?
                .to_string_lossy()
                .as_ref(),
        );
        let file = tokio::fs::File::open(&path)
            .await
            .with_context(|| format!("Не удалось открыть «{name}»."))?;
        let meta = file.metadata().await?;
        if !meta.is_file() || meta.len() > model::MAX_FILE {
            bail!("«{name}»: выберите файл размером до 2 ГБ.");
        }
        let to = request
            .to
            .iter()
            .map(Uuid::to_string)
            .collect::<Vec<_>>()
            .join(",");
        let body = reqwest::Body::wrap_stream(tokio_util::io::ReaderStream::new(file));
        result(
            api(Method::POST, "/api/upload")
                .query(&[("to", to), ("name", name), ("batch", id.to_string())])
                .header("content-length", meta.len())
                .body(body)
                .send()
                .await?,
        )
        .await?;
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
