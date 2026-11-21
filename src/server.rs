use anyhow::{Context, Result, bail};
use axum::{
    Json, Router,
    body::Body,
    extract::{ConnectInfo, DefaultBodyLimit, Path as AxumPath, Query, Request, State},
    http::{HeaderMap, HeaderValue, StatusCode, header},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{delete, get, post},
};
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::{HashMap, HashSet},
    net::{Ipv4Addr, SocketAddr},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tokio::{
    io::AsyncWriteExt,
    sync::{Semaphore, watch},
};
use tokio_util::io::ReaderStream;
use uuid::Uuid;

use crate::{
    model::{self, Config, Device, Devices, Item, Items, MAX_FILE, MAX_ITEMS, MAX_STORAGE},
    net, win,
};

pub type App = Arc<Server>;
pub struct Server {
    pub root: PathBuf,
    pub db: Mutex<Database>,
    pub local_token: String,
    pub ca: net::Authority,
    pub shutdown: watch::Sender<bool>,
    pub local_addr: SocketAddr,
    pub jobs: Mutex<HashMap<Uuid, Job>>,
    pub dialogs: Mutex<HashMap<Uuid, DialogJob>>,
    pub candidates: Mutex<HashMap<String, Candidate>>,
    pub uploads: Semaphore,
    pub archives: Semaphore,
    pub restart: std::sync::atomic::AtomicBool,
    pub notifications: tokio::sync::mpsc::Sender<usize>,
}

pub struct Database {
    pub config: Config,
    pub devices: Devices,
    pub items: Items,
    pub local_items: Items,
    pub presence: HashMap<Uuid, Instant>,
    pub invites: HashMap<String, (String, Instant)>,
    pub pc_code: Option<crate::short_code::Pending>,
    pub network_error: Option<String>,
    pub peer_error: Option<String>,
}

#[derive(Clone, Serialize)]
pub struct Candidate {
    pub url: String,
    pub name: String,
    #[serde(skip)]
    pub seen: Option<Instant>,
}

#[derive(Clone, Default, Serialize)]
pub struct Job {
    pub done: usize,
    pub total: usize,
    pub finished: bool,
    pub error: Option<String>,
}

#[derive(Clone, Default, Serialize)]
pub struct DialogJob {
    pub finished: bool,
    pub error: Option<String>,
    pub value: Option<Value>,
}

#[derive(Debug)]
pub struct ApiError(StatusCode, String);
pub type Api<T> = std::result::Result<T, ApiError>;
impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.0, Json(json!({"error":self.1}))).into_response()
    }
}
impl From<anyhow::Error> for ApiError {
    fn from(error: anyhow::Error) -> Self {
        Self(StatusCode::BAD_REQUEST, error.to_string())
    }
}
impl From<std::io::Error> for ApiError {
    fn from(error: std::io::Error) -> Self {
        eprintln!("Ошибка ввода-вывода: {error}");
        Self(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Не удалось прочитать или записать данные.".into(),
        )
    }
}
fn denied() -> ApiError {
    ApiError(
        StatusCode::UNAUTHORIZED,
        "Нужна привязка устройства.".into(),
    )
}
fn missing() -> ApiError {
    ApiError(StatusCode::NOT_FOUND, "Передача недоступна.".into())
}

#[derive(Clone, Copy)]
pub struct Principal(pub Uuid);
impl axum::extract::FromRequestParts<App> for Principal {
    type Rejection = ApiError;
    async fn from_request_parts(parts: &mut axum::http::request::Parts, _: &App) -> Api<Self> {
        parts.extensions.get::<Self>().copied().ok_or_else(denied)
    }
}

impl Server {
    pub fn init(
        root: PathBuf,
        local_addr: SocketAddr,
        shutdown: watch::Sender<bool>,
    ) -> Result<App> {
        let config_path = root.join("network-v2.json");
        let mut config: Config = model::read(&config_path)?;
        let created = !config_path.exists();
        let previous_address = config.address;
        if config.address.is_none() {
            config.address = net::default_address();
        }
        if created || config.address != previous_address {
            model::write(&config_path, &config)?;
        }
        for dir in ["inbox", "relay", "runtime"] {
            std::fs::create_dir_all(root.join(dir))?;
        }
        // Incomplete uploads are never indexed. This directory belongs to this daemon only.
        for entry in std::fs::read_dir(root.join("runtime"))? {
            let entry = entry?;
            if entry.file_name().to_string_lossy().starts_with(".upload-")
                && entry.file_type()?.is_file()
            {
                let _ = std::fs::remove_file(entry.path());
            }
        }
        let db = Database {
            devices: model::read(&root.join("devices-v2.json"))?,
            items: model::read(&root.join("transfers-v2.json"))?,
            local_items: model::read(&root.join("received-v2.json"))?,
            config,
            presence: HashMap::new(),
            invites: HashMap::new(),
            pc_code: None,
            network_error: None,
            peer_error: None,
        };
        let (notifications, receiver) = tokio::sync::mpsc::channel(128);
        tokio::spawn(win::notifications(receiver));
        Ok(Arc::new(Self {
            ca: net::Authority::load(&root)?,
            root,
            db: Mutex::new(db),
            local_token: model::secret(),
            shutdown,
            local_addr,
            jobs: Mutex::default(),
            dialogs: Mutex::default(),
            candidates: Mutex::default(),
            uploads: Semaphore::new(4),
            archives: Semaphore::new(2),
            restart: false.into(),
            notifications,
        }))
    }

    pub fn path(&self, item: &Item, local: bool) -> PathBuf {
        let dirname = if local { "inbox" } else { "relay" };
        self.root
            .join(dirname)
            .join(item.id.to_string())
            .join(model::file_name(&item.name))
    }

    pub fn save_config(&self, db: &mut Database, config: Config) -> Result<()> {
        model::write(&self.root.join("network-v2.json"), &config)?;
        db.config = config;
        Ok(())
    }

    pub fn save_devices(&self, db: &mut Database, devices: Devices) -> Result<()> {
        model::write(&self.root.join("devices-v2.json"), &devices)?;
        db.devices = devices;
        Ok(())
    }

    pub fn save_items(&self, db: &mut Database, items: Items, local: bool) -> Result<()> {
        let name = if local {
            "received-v2.json"
        } else {
            "transfers-v2.json"
        };
        model::write(&self.root.join(name), &items)?;
        if local {
            db.local_items = items;
        } else {
            db.items = items;
        }
        Ok(())
    }

    pub fn roster(&self, principal: Uuid) -> Value {
        let db = self.db.lock().unwrap();
        let mut devices = vec![];
        for device in db.devices.values() {
            let online = db
                .presence
                .get(&device.id)
                .is_some_and(|last| last.elapsed() < Duration::from_secs(12));
            devices.push(
                json!({"id":device.id,"name":device.name,"kind":device.kind,"online":online}),
            );
        }
        devices.push(json!({"id":db.config.host,"name":db.config.name,"kind":"pc","online":true}));
        json!({"self":principal,"devices":devices})
    }
}

pub fn common() -> Router<App> {
    Router::new()
        .route("/api/roster", get(roster))
        .route("/api/presence", post(heartbeat))
        .route("/api/items", get(items))
        .route("/api/pending", get(pending))
        .route("/api/delivered", post(delivered))
        .route("/api/items/{id}", delete(remove_item))
        .route("/api/file/{id}", get(download))
        .route("/api/preview/{id}", get(preview))
        .route("/api/thumbnail/{id}", get(thumbnail))
        .route("/api/archive/{batch}", get(archive))
        .route("/api/name", post(own_name))
        .route("/api/text", post(send_text))
        .route("/api/upload", post(upload))
}

pub fn lan(app: App, ip: Ipv4Addr, port: u16) -> Router {
    let expected = format!("{ip}:{port}");
    let mask = net::subnet_mask(ip);
    let layer_app = app.clone();
    common()
        .merge(crate::phone::routes())
        .route("/api/pair", post(pair))
        .route("/api/pc-code", post(crate::short_code::exchange))
        .layer(middleware::from_fn(move |req: Request, next: Next| {
            let app = layer_app.clone();
            let expected = expected.clone();
            async move {
                let src = req
                    .extensions()
                    .get::<ConnectInfo<SocketAddr>>()
                    .map(|src| src.0.ip());
                let trusted = matches!((src, mask), (Some(std::net::IpAddr::V4(src)), Some(mask)) if net::in_subnet(ip, src, mask));
                let host = req
                    .uri()
                    .authority()
                    .map(|authority| authority.as_str())
                    .or_else(|| {
                        req.headers()
                            .get(header::HOST)
                            .and_then(|value| value.to_str().ok())
                    });
                let expected_host = host == Some(expected.as_str())
                    || (port == 443 && host.is_some_and(|host| host == ip.to_string()));
                if !trusted || !expected_host {
                    return StatusCode::FORBIDDEN.into_response();
                }
                if req.method() != axum::http::Method::GET
                    && req.headers().get("x-thoddrop").is_none()
                {
                    return StatusCode::FORBIDDEN.into_response();
                }
                let mut req = req;
                if let Some(principal) = identify(&app, req.headers()) {
                    req.extensions_mut().insert(Principal(principal));
                }
                secure(next.run(req).await)
            }
        }))
        .layer(small_body())
        .with_state(app)
}

pub fn local(app: App) -> Router {
    let layer_app = app.clone();
    common()
        .merge(crate::desktop::routes())
        .route("/local/ping", get(|| async { StatusCode::NO_CONTENT }))
        .layer(middleware::from_fn(move |mut req: Request, next: Next| {
            let app = layer_app.clone();
            async move {
                if bearer(req.headers()) != Some(app.local_token.as_str()) {
                    return denied().into_response();
                }
                let host = app.db.lock().unwrap().config.host;
                req.extensions_mut().insert(Principal(host));
                secure(next.run(req).await)
            }
        }))
        .layer(DefaultBodyLimit::max(4 * 1024 * 1024))
        .with_state(app)
}

fn secure(mut response: Response) -> Response {
    let h = response.headers_mut();
    for (name, value) in [
        ("x-content-type-options", "nosniff"),
        ("referrer-policy", "no-referrer"),
        ("cache-control", "no-store"),
        ("x-frame-options", "DENY"),
        (
            "content-security-policy",
            "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; manifest-src 'self'; connect-src 'self'; worker-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
        ),
    ] {
        h.insert(name, HeaderValue::from_static(value));
    }
    response
}

fn bearer(headers: &HeaderMap) -> Option<&str> {
    headers
        .get(header::AUTHORIZATION)?
        .to_str()
        .ok()?
        .strip_prefix("Bearer ")
}
fn identify(app: &App, headers: &HeaderMap) -> Option<Uuid> {
    let token = bearer(headers).or_else(|| {
        headers
            .get(header::COOKIE)?
            .to_str()
            .ok()?
            .split(';')
            .find_map(|cookie| cookie.trim().strip_prefix("__Host-thoddrop="))
    })?;
    if token.len() != 64 || !token.bytes().all(|c| c.is_ascii_hexdigit()) {
        return None;
    }
    let hash = model::digest(token);
    app.db
        .lock()
        .unwrap()
        .devices
        .values()
        .find_map(|device| (device.token_hash.as_deref() == Some(&hash)).then_some(device.id))
}

#[derive(Deserialize)]
struct Pair {
    code: String,
    name: String,
    kind: String,
}
async fn pair(State(app): State<App>, Json(form): Json<Pair>) -> Api<Response> {
    let name = model::name(&form.name)?;
    if !matches!(form.kind.as_str(), "phone" | "pc") {
        return Err(denied());
    }
    let mut db = app.db.lock().unwrap();
    let code = model::digest(&form.code);
    if !db
        .invites
        .get(&form.kind)
        .is_some_and(|(hash, until)| *hash == code && *until > Instant::now())
    {
        return Err(ApiError(
            StatusCode::FORBIDDEN,
            "Код приглашения недействителен. Создайте новый на ведущем ПК.".into(),
        ));
    }
    if db.devices.len() >= 64 {
        return Err(anyhow::anyhow!("Достигнут предел в 64 устройства.").into());
    }
    let token = model::secret();
    let id = Uuid::new_v4();
    let device = Device {
        id,
        name,
        kind: form.kind.clone(),
        token_hash: Some(model::digest(&token)),
    };
    let mut devices = db.devices.clone();
    devices.insert(id, device);
    app.save_devices(&mut db, devices)?;
    db.invites.remove(&form.kind);
    db.presence.insert(id, Instant::now());
    if form.kind == "pc" {
        db.pc_code = None;
        return Ok(Json(json!({"id":id,"token":token})).into_response());
    }
    let mut res = Json(json!({"id":id})).into_response();
    res.headers_mut().insert(
        header::SET_COOKIE,
        HeaderValue::from_str(&format!(
            "__Host-thoddrop={token}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=34560000"
        ))
        .unwrap(),
    );
    Ok(res)
}

async fn roster(State(app): State<App>, Principal(id): Principal) -> Json<Value> {
    Json(app.roster(id))
}
async fn heartbeat(State(app): State<App>, Principal(id): Principal) -> Json<Value> {
    app.db.lock().unwrap().presence.insert(id, Instant::now());
    Json(app.roster(id))
}

#[derive(Deserialize)]
struct OwnName {
    name: String,
}
async fn own_name(
    State(app): State<App>,
    Principal(id): Principal,
    Json(form): Json<OwnName>,
) -> Api<StatusCode> {
    let name = model::name(&form.name)?;
    let mut db = app.db.lock().unwrap();
    let mut devices = db.devices.clone();
    devices.get_mut(&id).ok_or_else(denied)?.name = name;
    app.save_devices(&mut db, devices)?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize, Default)]
pub struct Page {
    #[serde(default)]
    pub offset: usize,
    pub known: Option<String>,
}
pub fn page<'a>(items: impl Iterator<Item = &'a Item>, query: &Page) -> Value {
    use sha2::{Digest, Sha256};
    let mut rows: Vec<_> = items.collect();
    rows.sort_unstable_by_key(|item| (std::cmp::Reverse(item.time), item.id));
    let more = query.offset.saturating_add(30) < rows.len();
    let rows = rows
        .into_iter()
        .skip(query.offset)
        .take(30)
        .collect::<Vec<_>>();
    let mut hash = Sha256::new();
    for item in &rows {
        hash.update(item.id.as_bytes());
    }
    hash.update([u8::from(more)]);
    let version = format!("{:x}", hash.finalize());
    if query.known.as_deref() == Some(version.as_str()) {
        return json!({"unchanged":true});
    }
    json!({"items":rows,"more":more,"version":version})
}

async fn items(
    State(app): State<App>,
    Principal(id): Principal,
    Query(query): Query<Page>,
) -> Json<Value> {
    Json(page(
        app.db
            .lock()
            .unwrap()
            .items
            .values()
            .filter(|item| item.recipient == id),
        &query,
    ))
}

async fn pending(State(app): State<App>, Principal(id): Principal) -> Api<Json<Value>> {
    let db = app.db.lock().unwrap();
    if !db
        .devices
        .get(&id)
        .is_some_and(|device| device.kind == "pc")
    {
        return Err(denied());
    }
    let mut items: Vec<_> = db
        .items
        .values()
        .filter(|item| item.recipient == id && !item.delivered)
        .collect();
    items.sort_unstable_by_key(|item| (item.time, item.id));
    items.truncate(30);
    Ok(Json(json!({"items":items})))
}

async fn delivered(
    State(app): State<App>,
    Principal(id): Principal,
    Json(receipts): Json<Vec<Uuid>>,
) -> Api<StatusCode> {
    if receipts.len() > 30 {
        return Err(anyhow::anyhow!("Слишком много подтверждений.").into());
    }
    let mut db = app.db.lock().unwrap();
    if !db
        .devices
        .get(&id)
        .is_some_and(|device| device.kind == "pc")
    {
        return Err(denied());
    }
    if !receipts.iter().any(|id_to_mark| {
        db.items
            .get(id_to_mark)
            .is_some_and(|item| item.recipient == id && !item.delivered)
    }) {
        return Ok(StatusCode::NO_CONTENT);
    }
    let mut items = db.items.clone();
    for receipt in receipts {
        if let Some(item) = items.get_mut(&receipt).filter(|item| item.recipient == id) {
            item.delivered = true;
        }
    }
    app.save_items(&mut db, items, false)?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
pub struct DeleteItem {
    #[serde(default)]
    pub file: bool,
}

pub fn drop_item(
    app: &App,
    owner: Option<Uuid>,
    id: Uuid,
    mirrored: bool,
    file: bool,
) -> Result<bool> {
    let mut db = app.db.lock().unwrap();
    let items = if mirrored { &db.local_items } else { &db.items };
    let Some(item) = items
        .get(&id)
        .filter(|item| owner.is_none_or(|owner| item.recipient == owner))
        .cloned()
    else {
        return Ok(false);
    };
    let path = app.path(&item, mirrored || item.recipient == db.config.host);
    if file && item.text.is_none() {
        match std::fs::remove_file(&path) {
            Ok(()) => {
                if let Some(parent) = path.parent() {
                    let _ = std::fs::remove_dir(parent);
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error).context("Не удалось удалить файл."),
        }
    }
    let mut items = items.clone();
    items.remove(&id);
    app.save_items(&mut db, items, mirrored)?;
    Ok(true)
}

async fn remove_item(
    State(app): State<App>,
    Principal(owner): Principal,
    AxumPath(id): AxumPath<Uuid>,
) -> Api<StatusCode> {
    if !drop_item(&app, Some(owner), id, false, true)? {
        return Err(missing());
    }
    Ok(StatusCode::NO_CONTENT)
}

fn lookup(app: &App, owner: Uuid, id: Uuid) -> Api<(Item, bool)> {
    let db = app.db.lock().unwrap();
    let item = db
        .items
        .get(&id)
        .filter(|item| item.recipient == owner && item.text.is_none())
        .cloned()
        .ok_or_else(missing)?;
    Ok((item, owner == db.config.host))
}

async fn download(
    State(app): State<App>,
    Principal(owner): Principal,
    AxumPath(id): AxumPath<Uuid>,
) -> Api<Response> {
    let (item, local) = lookup(&app, owner, id)?;
    stream_file(
        &app.path(&item, local),
        &item.name,
        "application/octet-stream",
        false,
    )
    .await
}
async fn preview(
    State(app): State<App>,
    Principal(owner): Principal,
    AxumPath(id): AxumPath<Uuid>,
) -> Api<Response> {
    let (item, local) = lookup(&app, owner, id)?;
    let mime = model::image_type(&item.name).ok_or_else(missing)?;
    stream_file(&app.path(&item, local), &item.name, mime, true).await
}

async fn thumbnail(
    State(app): State<App>,
    Principal(owner): Principal,
    AxumPath(id): AxumPath<Uuid>,
) -> Api<Response> {
    let (item, local) = lookup(&app, owner, id)?;
    if model::image_type(&item.name).is_none() {
        return Err(missing());
    }
    let path = app.path(&item, local);
    let _permit = app
        .archives
        .acquire()
        .await
        .context("Очередь изображений закрыта.")?;
    let data = tokio::task::spawn_blocking(move || win::thumbnail(&path))
        .await
        .context("Не удалось создать миниатюру.")??;
    Ok(([(header::CONTENT_TYPE, "image/png")], data).into_response())
}

async fn stream_file(path: &Path, name: &str, mime: &str, inline: bool) -> Api<Response> {
    let file = tokio::fs::File::open(path).await.map_err(|_| missing())?;
    let size = file.metadata().await?.len();
    Ok(stream(file, size, name, mime, inline))
}

fn stream(file: tokio::fs::File, size: u64, name: &str, mime: &str, inline: bool) -> Response {
    let disposition = if inline { "inline" } else { "attachment" };
    let name = percent_encoding::utf8_percent_encode(name, percent_encoding::NON_ALPHANUMERIC);
    (
        [
            (header::CONTENT_TYPE, mime.to_owned()),
            (header::CONTENT_LENGTH, size.to_string()),
            (
                header::CONTENT_DISPOSITION,
                format!("{disposition}; filename*=UTF-8''{name}"),
            ),
        ],
        Body::from_stream(ReaderStream::new(file)),
    )
        .into_response()
}

async fn archive(
    State(app): State<App>,
    Principal(owner): Principal,
    AxumPath(batch): AxumPath<Uuid>,
) -> Api<Response> {
    let _permit = app.archives.try_acquire().map_err(|_| {
        ApiError(
            StatusCode::TOO_MANY_REQUESTS,
            "Подождите завершения предыдущего архива.".into(),
        )
    })?;
    let files = {
        let db = app.db.lock().unwrap();
        db.items
            .values()
            .filter(|item| item.recipient == owner && item.batch == batch && item.text.is_none())
            .map(|item| (item.name.clone(), app.path(item, owner == db.config.host)))
            .collect::<Vec<_>>()
    };
    if files.is_empty() {
        return Err(missing());
    }
    let (file, size) = tokio::task::spawn_blocking(move || -> Result<_> {
        use std::io::{Seek, SeekFrom};
        let mut names = HashSet::new();
        let mut writer = zip::ZipWriter::new(tempfile::tempfile()?);
        for (name, path) in files {
            let mut unique = name.clone();
            let mut index = 2;
            while !names.insert(unique.to_lowercase()) {
                unique = format!("{index}-{name}");
                index += 1;
            }
            writer.start_file(
                unique,
                zip::write::SimpleFileOptions::default()
                    .compression_method(zip::CompressionMethod::Stored)
                    .large_file(true),
            )?;
            std::io::copy(&mut std::fs::File::open(path)?, &mut writer)?;
        }
        let mut file = writer.finish()?;
        let size = file.seek(SeekFrom::End(0))?;
        file.seek(SeekFrom::Start(0))?;
        Ok((file, size))
    })
    .await
    .context("Не удалось создать архив.")??;
    Ok(stream(
        tokio::fs::File::from_std(file),
        size,
        "ThodDrop.zip",
        "application/zip",
        false,
    ))
}

#[derive(Deserialize)]
pub struct TextSend {
    pub to: Vec<Uuid>,
    pub text: String,
    pub batch: Uuid,
}
#[derive(Deserialize)]
pub struct FileSend {
    pub to: String,
    pub name: String,
    pub batch: Uuid,
}

fn targets(db: &Database, from: Uuid, to: &[Uuid], require_online: bool) -> Result<()> {
    if to.is_empty() || to.len() > 64 {
        bail!("Выберите получателей.")
    }
    let mut seen = HashSet::new();
    for id in to {
        if *id == from || !seen.insert(*id) {
            bail!("Проверьте список получателей.")
        }
        if *id != db.config.host
            && (!db.devices.contains_key(id)
                || require_online
                    && !db
                        .presence
                        .get(id)
                        .is_some_and(|last| last.elapsed() < Duration::from_secs(12)))
        {
            bail!("Один из получателей вышел из сети. Обновите список.")
        }
    }
    Ok(())
}

struct StagedFile<'a> {
    relay: &'a Path,
    inbox: Option<&'a Path>,
    size: u64,
}

fn store(
    app: &App,
    from: Uuid,
    to: &[Uuid],
    batch: Uuid,
    name: String,
    text: Option<String>,
    file: Option<StagedFile<'_>>,
) -> Result<usize> {
    let mut db = app.db.lock().unwrap();
    targets(&db, from, to, file.is_none())?;
    let sender = if from == db.config.host {
        db.config.name.clone()
    } else {
        db.devices
            .get(&from)
            .context("Доступ отозван.")?
            .name
            .clone()
    };
    let size = file.as_ref().map_or_else(
        || text.as_ref().map_or(0, |text| text.len() as u64),
        |file| file.size,
    );
    let used = db.items.values().map(|item| item.size).sum::<u64>();
    if db.items.len() + to.len() > MAX_ITEMS || used + size * to.len() as u64 > MAX_STORAGE {
        bail!("Хранилище заполнено. Удалите часть передач.")
    }
    let mut items = db.items.clone();
    let mut paths = Vec::new();
    let result = (|| -> Result<()> {
        for &recipient in to {
            let item = Item {
                id: Uuid::new_v4(),
                batch: Uuid::new_v5(&from, batch.as_bytes()),
                sender: sender.clone(),
                recipient,
                name: name.clone(),
                time: model::instant(),
                size,
                text: text.clone(),
                delivered: false,
            };
            if let Some(file) = &file {
                let path = app.path(&item, recipient == db.config.host);
                let parent = path.parent().unwrap();
                std::fs::create_dir(parent)?;
                paths.push(path.clone());
                let source = if recipient == db.config.host {
                    file.inbox.unwrap_or(file.relay)
                } else {
                    file.relay
                };
                std::fs::hard_link(source, &path)
                    .context("Не удалось сохранить файл в папку приёма.")?;
            }
            items.insert(item.id, item);
        }
        app.save_items(&mut db, items, false)
    })();
    if result.is_err() {
        for path in paths {
            let _ = std::fs::remove_file(&path);
            let _ = std::fs::remove_dir(path.parent().unwrap());
        }
    }
    result?;
    if to.contains(&db.config.host) {
        let _ = app.notifications.try_send(1);
    }
    Ok(to.len())
}

async fn send_text(
    State(app): State<App>,
    Principal(from): Principal,
    Json(form): Json<TextSend>,
) -> Api<Json<Value>> {
    if form.text.trim().is_empty() || form.text.len() > 48 * 1024 {
        return Err(anyhow::anyhow!("Введите текст объёмом до 48 КБ.").into());
    }
    let count = store(
        &app,
        from,
        &form.to,
        form.batch,
        "Текст".into(),
        Some(form.text),
        None,
    )?;
    Ok(Json(json!({"count":count})))
}

async fn upload(
    State(app): State<App>,
    Principal(from): Principal,
    Query(form): Query<FileSend>,
    request: Request,
) -> Api<Json<Value>> {
    let _permit = app.uploads.try_acquire().map_err(|_| {
        ApiError(
            StatusCode::TOO_MANY_REQUESTS,
            "Подождите завершения текущих передач.".into(),
        )
    })?;
    let to = form
        .to
        .split(',')
        .map(Uuid::parse_str)
        .collect::<std::result::Result<Vec<_>, _>>()
        .map_err(|_| anyhow::anyhow!("Проверьте список получателей."))?;
    let host_needs_copy = {
        let db = app.db.lock().unwrap();
        targets(&db, from, &to, true)?;
        to.len() > 1 && to.contains(&db.config.host)
    };
    let temp = tempfile::Builder::new()
        .prefix(".upload-")
        .tempfile_in(app.root.join("runtime"))?
        .into_temp_path();
    let mut file = tokio::fs::OpenOptions::new()
        .write(true)
        .open(&temp)
        .await?;
    let mut stream = request.into_body().into_data_stream();
    let mut size = 0_u64;
    while let Some(bytes) = tokio::time::timeout(Duration::from_secs(25), stream.next())
        .await
        .context("Истекло время ожидания данных.")?
    {
        let bytes = bytes.context("Передача прервана.")?;
        size += bytes.len() as u64;
        if size > MAX_FILE {
            return Err(ApiError(
                StatusCode::PAYLOAD_TOO_LARGE,
                "Один файл может занимать до 2 ГБ.".into(),
            ));
        }
        file.write_all(&bytes).await?;
    }
    file.sync_all().await?;
    drop(file);
    let inbox = if host_needs_copy {
        // The editable inbox copy must be independent of the relay data.
        let copy = tempfile::Builder::new()
            .prefix(".upload-")
            .tempfile_in(app.root.join("runtime"))?
            .into_temp_path();
        tokio::fs::copy(&temp, &copy).await?;
        Some(copy)
    } else {
        None
    };
    let count = store(
        &app,
        from,
        &to,
        form.batch,
        model::file_name(&form.name),
        None,
        Some(StagedFile {
            relay: &temp,
            inbox: inbox.as_deref(),
            size,
        }),
    )?;
    Ok(Json(json!({"count":count})))
}

pub fn small_body() -> DefaultBodyLimit {
    DefaultBodyLimit::max(96 * 1024)
}
