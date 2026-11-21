use anyhow::{Context, Result, bail};
use axum::{
    Json, Router,
    body::Body,
    extract::{ConnectInfo, DefaultBodyLimit, Extension, Path as AxumPath, Query, Request, State},
    http::{HeaderMap, HeaderValue, StatusCode, header},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{delete, get, post},
};
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, HashMap, HashSet},
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
    model::{
        self, Config, Device, Devices, Item, Items, MAX_FILE, MAX_ITEMS, MAX_STORAGE, PublicDevice,
        Upstream,
    },
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
    pub attachments: Mutex<HashMap<Uuid, crate::desktop::Attachment>>,
    pub candidates: Mutex<HashMap<String, Candidate>>,
    pub rescan: tokio::sync::Notify,
    pub certificate_url: Mutex<Option<String>>,
    pub phone_http_url: Mutex<Option<String>>,
    pub share_gate: tokio::sync::Mutex<()>,
    pub uploads: Semaphore,
    pub archives: Semaphore,
    pub restart: std::sync::atomic::AtomicBool,
    pub notifications: tokio::sync::mpsc::Sender<usize>,
    pub push: Option<crate::push::Push>,
}

pub struct Database {
    pub config: Config,
    pub devices: Devices,
    pub items: Items,
    pub local_items: Items,
    pub inbox_folders: BTreeMap<Uuid, String>,
    pub presence: HashMap<Uuid, Instant>,
    pub invites: HashMap<String, (String, Instant)>,
    pub pc_code: Option<crate::short_code::Pending>,
    pub network_error: Option<String>,
    pub peer_error: Option<String>,
    pub peer_roster: Option<Value>,
    pub peer_sharing: bool,
    pub shared: BTreeMap<Uuid, Vec<PublicDevice>>,
}

#[derive(Clone, Serialize)]
pub struct Candidate {
    pub url: String,
    pub name: String,
}

#[derive(Clone, Default, Serialize)]
pub struct Job {
    pub done: usize,
    pub total: usize,
    pub finished: bool,
    pub error: Option<String>,
    pub file_progress: u64,
    pub file_size: u64,
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
        let peer_roster = config.upstream.as_ref().and_then(|upstream| {
            model::read::<Option<Value>>(&root.join("peer-roster-v3.json"))
                .ok()
                .flatten()
                .filter(|roster| roster["self"] == json!(upstream.device))
        });
        let peer_error = config
            .upstream
            .as_ref()
            .map(|_| "Подключение к ведущему компьютеру…".into());
        let db = Database {
            devices: model::read(&root.join("devices-v2.json"))?,
            items: model::read(&root.join("transfers-v2.json"))?,
            local_items: model::read(&root.join("received-v2.json"))?,
            inbox_folders: model::read(&root.join("inbox-folders-v3.json"))?,
            config,
            presence: HashMap::new(),
            invites: HashMap::new(),
            pc_code: None,
            network_error: None,
            peer_error,
            peer_roster,
            peer_sharing: false,
            shared: model::read(&root.join("shared-devices-v3.json"))?,
        };
        let (notifications, receiver) = tokio::sync::mpsc::channel(128);
        tokio::spawn(win::notifications(receiver));
        let push = crate::push::Push::load(&root)
            .map_err(|error| eprintln!("Мобильные уведомления: {error}"))
            .ok();
        Ok(Arc::new(Self {
            ca: net::Authority::load(&root)?,
            root,
            db: Mutex::new(db),
            local_token: model::secret(),
            shutdown,
            local_addr,
            jobs: Mutex::default(),
            dialogs: Mutex::default(),
            attachments: Mutex::default(),
            candidates: Mutex::default(),
            rescan: tokio::sync::Notify::new(),
            certificate_url: Mutex::default(),
            phone_http_url: Mutex::default(),
            share_gate: tokio::sync::Mutex::new(()),
            uploads: Semaphore::new(4),
            archives: Semaphore::new(2),
            restart: false.into(),
            notifications,
            push,
        }))
    }

    pub fn path(&self, item: &Item, local: bool) -> PathBuf {
        if local && let (Some(folder), Some(name)) = (&item.inbox_folder, &item.stored_name) {
            return self
                .root
                .join("inbox")
                .join(model::file_name(folder))
                .join(model::file_name(name));
        }
        let dirname = if local { "inbox" } else { "relay" };
        self.root
            .join(dirname)
            .join(item.id.to_string())
            .join(model::file_name(&item.name))
    }

    pub fn save_inbox_file(
        &self,
        db: &mut Database,
        item: &mut Item,
        source: &Path,
    ) -> Result<PathBuf> {
        let inbox = self.root.join("inbox");
        let sender = item
            .sender_id
            .unwrap_or_else(|| Uuid::new_v5(&item.recipient, item.sender.as_bytes()));
        let folder = if let Some(folder) = db.inbox_folders.get(&sender) {
            model::file_name(folder)
        } else {
            let label = model::file_name(&item.sender.chars().take(64).collect::<String>());
            let mut folder = label.clone();
            let mut index = 2;
            while inbox.join(&folder).exists()
                || db
                    .inbox_folders
                    .values()
                    .any(|existing| existing.to_lowercase() == folder.to_lowercase())
            {
                folder = format!("{label} ({index})");
                index += 1;
            }
            let mut folders = db.inbox_folders.clone();
            folders.insert(sender, folder.clone());
            model::write(&self.root.join("inbox-folders-v3.json"), &folders)?;
            db.inbox_folders = folders;
            folder
        };
        let dir = inbox.join(&folder);
        std::fs::create_dir_all(&dir)?;
        let original = if item.text.is_some() {
            "Текст.txt".into()
        } else {
            model::file_name(&model::file_name(&item.name))
        };
        let mut filename = original.clone();
        for index in 2.. {
            let path = dir.join(&filename);
            match std::fs::hard_link(source, &path) {
                Ok(()) => {
                    item.inbox_folder = Some(folder);
                    item.stored_name = Some(filename);
                    return Ok(path);
                }
                Err(err) if err.kind() == std::io::ErrorKind::AlreadyExists => {
                    let prefix = format!("{index}-");
                    let (stem, extension) = match original.rsplit_once('.') {
                        Some((stem, ext)) if ext.chars().count() <= 12 => (stem, format!(".{ext}")),
                        _ => (original.as_str(), String::new()),
                    };
                    let fit = 100 - prefix.len() - extension.chars().count();
                    filename = model::file_name(&format!(
                        "{prefix}{}{extension}",
                        stem.chars().take(fit).collect::<String>()
                    ));
                }
                Err(err) => return Err(err.into()),
            }
        }
        unreachable!()
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
        let mut devices = published_devices(&db);
        let mut seen: HashSet<Uuid> = devices.iter().map(|device| device.id).collect();
        seen.insert(db.config.host);
        if let Some(peer) = &db.peer_roster
            && let Some(remote) = peer["devices"].as_array()
        {
            let relay = db.config.upstream.as_ref().map(|upstream| upstream.device);
            for device in remote {
                let Ok(mut device) = serde_json::from_value::<PublicDevice>(device.clone()) else {
                    continue;
                };
                if relay != Some(device.id) && seen.insert(device.id) {
                    device.online &= db.peer_error.is_none();
                    devices.push(device);
                }
            }
        }
        devices.push(PublicDevice {
            id: db.config.host,
            name: db.config.name.clone(),
            kind: "pc".into(),
            online: true,
        });
        json!({"self":principal,"devices":devices})
    }
}

fn online(db: &Database, id: Uuid) -> bool {
    db.presence
        .get(&id)
        .is_some_and(|last| last.elapsed() < Duration::from_secs(12))
}

pub fn published_devices(db: &Database) -> Vec<PublicDevice> {
    let mut devices = db
        .devices
        .values()
        .map(|device| PublicDevice {
            id: device.id,
            name: device.name.clone(),
            kind: device.kind.clone(),
            online: online(db, device.id),
        })
        .collect::<Vec<_>>();
    for (owner, shared) in &db.shared {
        if !db.devices.contains_key(owner) {
            continue;
        }
        let connected = online(db, *owner);
        devices.extend(shared.iter().cloned().map(|mut device| {
            device.online &= connected;
            device
        }));
    }
    devices
}

pub fn relay_owner(db: &Database, id: Uuid) -> Option<Uuid> {
    db.shared.iter().find_map(|(owner, devices)| {
        (db.devices.contains_key(owner) && devices.iter().any(|device| device.id == id))
            .then_some(*owner)
    })
}

fn is_pc(db: &Database, id: Uuid) -> bool {
    db.devices
        .get(&id)
        .is_some_and(|device| device.kind == "pc")
}

async fn share(
    State(app): State<App>,
    Principal(owner): Principal,
    Json(mut devices): Json<Vec<PublicDevice>>,
) -> Api<Json<Value>> {
    if devices.len() > 128 {
        return Err(anyhow::anyhow!("Слишком много устройств в группе.").into());
    }
    devices.sort_by_key(|device| device.id);
    let mut ids = HashSet::new();
    let mut db = app.db.lock().unwrap();
    if !is_pc(&db, owner) {
        return Err(denied());
    }
    for device in &mut devices {
        device.name = model::name(&device.name)?;
        if !matches!(device.kind.as_str(), "pc" | "phone")
            || device.id.is_nil()
            || device.id == db.config.host
            || !ids.insert(device.id)
            || db.devices.contains_key(&device.id)
            || db
                .config
                .upstream
                .as_ref()
                .is_some_and(|peer| peer.device == device.id)
            || relay_owner(&db, device.id).is_some_and(|registered| registered != owner)
        {
            return Err(anyhow::anyhow!("В группе совпали идентификаторы устройств.").into());
        }
    }
    if db.shared.get(&owner) != Some(&devices) {
        let mut shared = db.shared.clone();
        shared.insert(owner, devices);
        if shared.values().map(Vec::len).sum::<usize>() > 256 {
            return Err(anyhow::anyhow!("Слишком много устройств в группе.").into());
        }
        model::write(&app.root.join("shared-devices-v3.json"), &shared)?;
        db.shared = shared;
        purge_items(&app, &mut db, |item| {
            item.relay_to == Some(owner) && !ids.contains(&item.recipient)
        })?;
    }
    db.presence.insert(owner, Instant::now());
    drop(db);
    Ok(Json(app.roster(owner)))
}

fn purge_items(app: &App, db: &mut Database, mut remove: impl FnMut(&Item) -> bool) -> Result<()> {
    let mut items = db.items.clone();
    let removed = items
        .extract_if(.., |_, item| remove(item))
        .map(|(_, item)| item)
        .collect::<Vec<_>>();
    if removed.is_empty() {
        return Ok(());
    }
    app.save_items(db, items, false)?;
    for item in removed {
        if item.text.is_none() {
            let path = app.path(&item, false);
            let _ = std::fs::remove_file(&path);
            let _ = std::fs::remove_dir(path.parent().unwrap());
        }
    }
    Ok(())
}

pub fn forget_device(app: &App, db: &mut Database, id: Uuid) -> Result<()> {
    let mut devices = db.devices.clone();
    devices.remove(&id);
    app.save_devices(db, devices)?;
    if let Some(push) = &app.push
        && let Err(error) = push.forget(id)
    {
        eprintln!("Удаление подписки: {error}");
    }
    db.presence.remove(&id);
    if db.shared.contains_key(&id) {
        let mut shared = db.shared.clone();
        shared.remove(&id);
        model::write(&app.root.join("shared-devices-v3.json"), &shared)?;
        db.shared = shared;
    }
    purge_items(app, db, |item| {
        item.recipient == id || item.relay_to == Some(id)
    })
}

async fn unpair(State(app): State<App>, Principal(id): Principal) -> Api<StatusCode> {
    let mut db = app.db.lock().unwrap();
    if !is_pc(&db, id) {
        return Err(denied());
    }
    forget_device(&app, &mut db, id)?;
    Ok(StatusCode::NO_CONTENT)
}

pub fn common() -> Router<App> {
    Router::new()
        .route("/api/roster", get(roster))
        .route("/api/presence", post(heartbeat))
        .route("/api/share", post(share))
        .route("/api/unpair", post(unpair))
        .route("/api/items", get(items))
        .route("/api/pending", get(pending))
        .route("/api/delivered", post(delivered))
        .route("/api/items/{id}", delete(remove_item))
        .route("/api/file/{id}", get(download))
        .route("/api/preview/{id}", get(preview))
        .route("/api/thumbnail/{id}", get(thumbnail))
        .route("/api/archive/{batch}", get(archive))
        .route("/api/photos.zip", get(photo_archive))
        .route("/api/name", post(own_name))
        .route("/api/text", post(send_text))
        .route("/api/upload", post(upload))
}

pub fn lan(app: App, ip: Ipv4Addr, port: u16) -> Router {
    web_lan(app, ip, port, false)
}

#[derive(Clone, Copy)]
pub struct WebHttp(pub bool);

pub fn web_lan(app: App, ip: Ipv4Addr, port: u16, plain: bool) -> Router {
    let expected = format!("{ip}:{port}");
    let mask = net::subnet_mask(ip);
    let layer_app = app.clone();
    let routes = if plain {
        // Laptop-to-laptop credentials and relay administration require HTTPS.
        Router::new()
            .route("/api/presence", post(heartbeat))
            .route("/api/items", get(items))
            .route("/api/items/{id}", delete(remove_item))
            .route("/api/file/{id}", get(download))
            .route("/api/preview/{id}", get(preview))
            .route("/api/thumbnail/{id}", get(thumbnail))
            .route("/api/archive/{batch}", get(archive))
            .route("/api/photos.zip", get(photo_archive))
            .route("/api/text", post(send_text))
            .route("/api/upload", post(upload))
    } else {
        common()
            .route("/api/pc-code", post(crate::short_code::exchange))
            .route(
                "/api/push",
                get(crate::push::state)
                    .post(crate::push::subscribe)
                    .delete(crate::push::unsubscribe),
            )
    };
    routes
        .merge(crate::phone::routes())
        .route("/api/pair", post(pair))
        .layer(middleware::from_fn(move |req: Request, next: Next| {
            let app = layer_app.clone();
            let expected = expected.clone();
            async move {
                if !lan_request(
                    &req,
                    ip,
                    port == if plain { 80 } else { 443 },
                    mask,
                    &expected,
                ) {
                    return StatusCode::FORBIDDEN.into_response();
                }
                if plain && !app.db.lock().unwrap().config.phone_http {
                    return StatusCode::FORBIDDEN.into_response();
                }
                if req.method() != axum::http::Method::GET
                    && req.headers().get("x-thoddrop").is_none()
                {
                    return StatusCode::FORBIDDEN.into_response();
                }
                let mut req = req;
                if let Some(principal) = identify(&app, req.headers(), plain) {
                    req.extensions_mut().insert(Principal(principal));
                }
                req.extensions_mut().insert(WebHttp(plain));
                secure(next.run(req).await)
            }
        }))
        .layer(small_body())
        .with_state(app)
}

pub fn certificate_lan(app: App, ip: Ipv4Addr, port: u16) -> Router {
    let expected = format!("{ip}:{port}");
    let mask = net::subnet_mask(ip);
    crate::phone::certificate_bootstrap()
        .layer(middleware::from_fn(move |req: Request, next: Next| {
            let expected = expected.clone();
            async move {
                if !lan_request(&req, ip, port == 80, mask, &expected) {
                    return StatusCode::FORBIDDEN.into_response();
                }
                secure(next.run(req).await)
            }
        }))
        .with_state(app)
}

fn lan_request(
    req: &Request,
    ip: Ipv4Addr,
    default_port: bool,
    mask: Option<u32>,
    expected: &str,
) -> bool {
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
    trusted
        && (host == Some(expected)
            || (default_port && host.is_some_and(|host| host == ip.to_string())))
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
fn identify(app: &App, headers: &HeaderMap, plain: bool) -> Option<Uuid> {
    let prefix = if plain {
        "thoddrop-lan="
    } else {
        "__Host-thoddrop="
    };
    let token = (!plain).then(|| bearer(headers)).flatten().or_else(|| {
        headers
            .get(header::COOKIE)?
            .to_str()
            .ok()?
            .split(';')
            .find_map(|cookie| cookie.trim().strip_prefix(prefix))
    })?;
    if token.len() != 64 || !token.bytes().all(|c| c.is_ascii_hexdigit()) {
        return None;
    }
    let hash = model::digest(token);
    app.db.lock().unwrap().devices.values().find_map(|device| {
        (device.web_http == plain && device.token_hash.as_deref() == Some(&hash))
            .then_some(device.id)
    })
}

#[derive(Deserialize)]
struct Pair {
    code: String,
    name: String,
    kind: String,
}
async fn pair(
    State(app): State<App>,
    Extension(WebHttp(plain)): Extension<WebHttp>,
    Json(form): Json<Pair>,
) -> Api<Response> {
    let name = model::name(&form.name)?;
    if !matches!(form.kind.as_str(), "phone" | "pc") || (plain && form.kind != "phone") {
        return Err(denied());
    }
    let mut db = app.db.lock().unwrap();
    let code = model::digest(&form.code);
    let kind = if plain {
        "phone-http"
    } else {
        form.kind.as_str()
    };
    if !db
        .invites
        .get(kind)
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
        web_http: plain,
    };
    let mut devices = db.devices.clone();
    devices.insert(id, device);
    app.save_devices(&mut db, devices)?;
    db.invites.remove(kind);
    db.presence.insert(id, Instant::now());
    if form.kind == "pc" {
        db.pc_code = None;
        return Ok(Json(json!({"id":id,"token":token})).into_response());
    }
    let mut res = Json(json!({"id":id})).into_response();
    let cookie = if plain {
        format!("thoddrop-lan={token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=34560000")
    } else {
        format!(
            "__Host-thoddrop={token}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=34560000"
        )
    };
    res.headers_mut()
        .insert(header::SET_COOKIE, HeaderValue::from_str(&cookie).unwrap());
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
    let has_photos = rows.iter().any(|item| photo(item));
    rows.sort_unstable_by_key(|item| (std::cmp::Reverse(item.time), item.id));
    let mut seen = HashSet::new();
    let batches = rows
        .iter()
        .filter(|item| seen.insert(item.batch))
        .map(|item| item.batch)
        .collect::<Vec<_>>();
    let end = query.offset.saturating_add(30);
    let more = end < batches.len();
    let selected = batches
        .into_iter()
        .skip(query.offset)
        .take(30)
        .collect::<HashSet<_>>();
    let rows = rows
        .into_iter()
        .filter(|item| selected.contains(&item.batch))
        .collect::<Vec<_>>();
    let mut hash = Sha256::new();
    for item in &rows {
        hash.update(item.id.as_bytes());
    }
    hash.update([u8::from(more)]);
    let version = format!("{:x}", hash.finalize());
    if query.known.as_deref() == Some(version.as_str()) {
        return json!({"unchanged":true,"hasPhotos":has_photos});
    }
    json!({"items":rows,"more":more,"version":version,"next":end,"hasPhotos":has_photos})
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
        .filter(|item| (item.recipient == id || item.relay_to == Some(id)) && !item.delivered)
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
    let receipts: HashSet<_> = receipts.into_iter().collect();
    purge_items(&app, &mut db, |item| {
        item.relay_to == Some(id) && receipts.contains(&item.id)
    })?;
    if db
        .items
        .values()
        .any(|item| item.recipient == id && !item.delivered && receipts.contains(&item.id))
    {
        let mut items = db.items.clone();
        for receipt in receipts {
            if let Some(item) = items.get_mut(&receipt).filter(|item| item.recipient == id) {
                item.delivered = true;
            }
        }
        app.save_items(&mut db, items, false)?;
    }
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
    if file && (item.text.is_none() || item.stored_name.is_some()) {
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
        .filter(|item| {
            (item.recipient == owner || item.relay_to == Some(owner)) && item.text.is_none()
        })
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
    let path = app.path(&item, local);
    match mime {
        "image/heif" | "image/tiff" | "image/x-icon" | "image/avif" => {
            match rendered_preview(&app, path.clone(), true).await {
                Ok(response) => Ok(response),
                Err(_) => stream_file(&path, &item.name, mime, true).await,
            }
        }
        _ => stream_file(&path, &item.name, mime, true).await,
    }
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
    rendered_preview(&app, app.path(&item, local), false).await
}

async fn rendered_preview(app: &App, path: PathBuf, full: bool) -> Api<Response> {
    let _permit = app
        .archives
        .acquire()
        .await
        .context("Очередь изображений закрыта.")?;
    let (mime, data) = tokio::task::spawn_blocking(move || win::preview_image(&path, full))
        .await
        .context("Не удалось создать миниатюру.")??;
    Ok(([(header::CONTENT_TYPE, mime)], data).into_response())
}

async fn stream_file(path: &Path, name: &str, mime: &str, inline: bool) -> Api<Response> {
    let file = tokio::fs::File::open(path).await.map_err(|_| missing())?;
    let size = file.metadata().await?.len();
    Ok(stream(file, size, name, mime, inline))
}

fn stream(file: tokio::fs::File, size: u64, name: &str, mime: &str, inline: bool) -> Response {
    let disposition = if inline { "inline" } else { "attachment" };
    let fallback: String = name
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || matches!(ch, '.' | '-' | '_' | ' ') {
                ch
            } else {
                '_'
            }
        })
        .collect();
    let name = percent_encoding::utf8_percent_encode(name, percent_encoding::NON_ALPHANUMERIC);
    (
        [
            (header::CONTENT_TYPE, mime.to_owned()),
            (header::CONTENT_LENGTH, size.to_string()),
            (
                header::CONTENT_DISPOSITION,
                format!("{disposition}; filename=\"{fallback}\"; filename*=UTF-8''{name}"),
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
    inbox_archive(&app, owner, Some(batch)).await
}

async fn photo_archive(State(app): State<App>, Principal(owner): Principal) -> Api<Response> {
    inbox_archive(&app, owner, None).await
}

fn photo(item: &Item) -> bool {
    item.text.is_none() && model::image_type(&item.name).is_some()
}

async fn inbox_archive(app: &App, owner: Uuid, batch: Option<Uuid>) -> Api<Response> {
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
            .filter(|item| {
                item.recipient == owner
                    && match batch {
                        Some(batch) => item.batch == batch && item.text.is_none(),
                        None => photo(item),
                    }
            })
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
        if batch.is_some() {
            "ThodDrop.zip"
        } else {
            "ThodDrop-photos.zip"
        },
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

fn targets(db: &Database, from: Uuid, to: &[Uuid]) -> Result<()> {
    if to.is_empty() || to.len() > 64 {
        bail!("Выберите получателей.")
    }
    let mut seen = HashSet::new();
    for id in to {
        if *id == from || !seen.insert(*id) {
            bail!("Проверьте список получателей.")
        }
        if *id != db.config.host && !db.devices.contains_key(id) && relay_owner(db, *id).is_none() {
            bail!("Одно из устройств больше не подключено.")
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
    targets(&db, from, to)?;
    let sender = if from == db.config.host {
        db.config.name.clone()
    } else {
        db.devices
            .get(&from)
            .map(|device| device.name.clone())
            .or_else(|| {
                relay_owner(&db, from)
                    .and_then(|owner| db.shared[&owner].iter().find(|device| device.id == from))
                    .map(|device| device.name.clone())
            })
            .context("Доступ отозван.")?
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
    let mut committed = Vec::with_capacity(to.len());
    let text_file = match text.as_ref().filter(|_| to.contains(&db.config.host)) {
        Some(text) => Some(model::stage_text(&app.root, text)?),
        None => None,
    };
    let result = (|| -> Result<()> {
        for &recipient in to {
            let mut item = Item {
                id: Uuid::new_v4(),
                batch: Uuid::new_v5(&from, batch.as_bytes()),
                sender: sender.clone(),
                recipient,
                name: name.clone(),
                time: model::instant(),
                size,
                text: text.clone(),
                sender_id: Some(from),
                inbox_folder: None,
                stored_name: None,
                delivered: false,
                relay_to: relay_owner(&db, recipient),
            };
            if recipient == db.config.host {
                let source = file
                    .as_ref()
                    .map(|file| file.inbox.unwrap_or(file.relay))
                    .or(text_file.as_deref());
                if let Some(source) = source {
                    paths.push(app.save_inbox_file(&mut db, &mut item, source)?);
                }
            } else if let Some(file) = &file {
                let path = app.path(&item, false);
                let parent = path.parent().unwrap();
                std::fs::create_dir(parent)?;
                if let Err(error) = std::fs::hard_link(file.relay, &path) {
                    let _ = std::fs::remove_dir(parent);
                    return Err(error).context("Не удалось сохранить файл для передачи.");
                }
                paths.push(path);
            }
            committed.push(item.id);
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
    if let Some(push) = &app.push {
        for id in committed {
            let item = &db.items[&id];
            if item.relay_to.is_none() {
                push.notify(item);
            }
        }
    }
    if to.contains(&db.config.host) {
        let _ = app.notifications.try_send(1);
    }
    Ok(to.len())
}

struct TransferRoute {
    from: Uuid,
    local: Vec<Uuid>,
    upstream: Option<(Upstream, Vec<Uuid>, Option<Uuid>)>,
    hops: u8,
}

fn transfer_route(
    app: &App,
    principal: Uuid,
    headers: &HeaderMap,
    recipients: Vec<Uuid>,
) -> Api<TransferRoute> {
    let db = app.db.lock().unwrap();
    let hops = match headers.get("x-thoddrop-hops") {
        Some(value) if is_pc(&db, principal) => value
            .to_str()
            .ok()
            .and_then(|value| value.parse::<u8>().ok())
            .filter(|hops| *hops <= 8)
            .context("Слишком много промежуточных компьютеров.")?,
        Some(_) => return Err(denied()),
        None => 0,
    };
    let claimed = headers.get("x-thoddrop-sender");
    let from = if let Some(claimed) = claimed {
        let id = claimed
            .to_str()
            .ok()
            .and_then(|value| Uuid::parse_str(value).ok())
            .ok_or_else(denied)?;
        if !is_pc(&db, principal) || relay_owner(&db, id) != Some(principal) {
            return Err(denied());
        }
        id
    } else {
        principal
    };
    if recipients.is_empty() || recipients.len() > 64 {
        return Err(anyhow::anyhow!("Выберите получателей.").into());
    }
    let mut unique = HashSet::new();
    let mut local = Vec::new();
    let mut remote = Vec::new();
    for id in recipients {
        if id == from || !unique.insert(id) {
            return Err(anyhow::anyhow!("Проверьте список получателей.").into());
        }
        if id == db.config.host || db.devices.contains_key(&id) || relay_owner(&db, id).is_some() {
            local.push(id);
        } else {
            if db
                .config
                .upstream
                .as_ref()
                .is_some_and(|peer| peer.device == id)
            {
                return Err(anyhow::anyhow!("Нельзя отправить передачу этому компьютеру.").into());
            }
            if db
                .peer_roster
                .as_ref()
                .and_then(|roster| roster["devices"].as_array())
                .is_some_and(|devices| devices.iter().any(|device| device["id"] == json!(id)))
            {
                remote.push(id);
            } else {
                return Err(anyhow::anyhow!("Одно из устройств больше не подключено.").into());
            }
        }
    }
    let upstream = if remote.is_empty() {
        None
    } else {
        let peer = db
            .config
            .upstream
            .clone()
            .context("Ведущий компьютер недоступен.")?;
        let sender = (from != db.config.host).then_some(from);
        if sender.is_some() && !db.peer_sharing {
            if db.peer_error.is_some() {
                return Err(anyhow::anyhow!("Ведущий компьютер недоступен.").into());
            }
            return Err(anyhow::anyhow!(
                "Обновите ThodDrop на ведущем ПК для передачи между подключёнными устройствами."
            )
            .into());
        }
        Some((peer, remote, sender))
    };
    Ok(TransferRoute {
        from,
        local,
        upstream,
        hops,
    })
}

async fn forward(
    app: &App,
    peer: &Upstream,
    sender: Option<Uuid>,
    hops: u8,
    path: &str,
) -> Result<reqwest::RequestBuilder> {
    let client = net::peer_client(&peer.url, &peer.ca)?;
    if sender.is_some() {
        // A newly paired phone can send before the next periodic directory sync.
        let _guard = app.share_gate.lock().await;
        let devices = published_devices(&app.db.lock().unwrap());
        let response = net::peer_request(&client, peer, reqwest::Method::POST, "/api/share")
            .timeout(Duration::from_secs(5))
            .json(&devices)
            .send()
            .await
            .context("Не удалось синхронизировать устройства с ведущим ПК.")?;
        crate::desktop::result(response).await?;
    }
    let request = net::peer_request(&client, peer, reqwest::Method::POST, path)
        .header("x-thoddrop-hops", u16::from(hops) + 1);
    Ok(match sender {
        Some(id) => request.header("x-thoddrop-sender", id.to_string()),
        None => request,
    })
}

async fn forward_result(request: reqwest::RequestBuilder) -> Api<usize> {
    let response = request
        .send()
        .await
        .context("Ведущий компьютер недоступен.")?;
    let reply = crate::desktop::result(response).await?;
    Ok(reply["count"].as_u64().unwrap_or_default() as usize)
}

async fn send_text(
    State(app): State<App>,
    Principal(principal): Principal,
    headers: HeaderMap,
    Json(form): Json<TextSend>,
) -> Api<Json<Value>> {
    if form.text.trim().is_empty() || form.text.len() > 48 * 1024 {
        return Err(anyhow::anyhow!("Введите текст объёмом до 48 КБ.").into());
    }
    let route = transfer_route(&app, principal, &headers, form.to)?;
    let mut count = 0;
    if let Some((peer, remote, sender)) = route.upstream {
        count += forward_result(
            forward(&app, &peer, sender, route.hops, "/api/text")
                .await?
                .json(&json!({"to":remote,"text":form.text,"batch":form.batch})),
        )
        .await?;
    }
    if !route.local.is_empty() {
        count += store(
            &app,
            route.from,
            &route.local,
            form.batch,
            "Текст".into(),
            Some(form.text),
            None,
        )
        .with_context(|| {
            if count > 0 {
                "Часть получателей уже приняла текст."
            } else {
                "Не удалось отправить текст."
            }
        })?;
    }
    Ok(Json(json!({"count":count})))
}

pub fn accept_relay(app: &App, mut item: Item, source: Option<&Path>) -> Result<()> {
    let mut db = app.db.lock().unwrap();
    item.relay_to = relay_owner(&db, item.recipient);
    item.delivered = false;
    item.inbox_folder = None;
    item.stored_name = None;
    if db.items.contains_key(&item.id)
        || (item.relay_to.is_none() && !db.devices.contains_key(&item.recipient))
    {
        return Ok(());
    }
    let used = db.items.values().map(|entry| entry.size).sum::<u64>();
    if db.items.len() >= MAX_ITEMS || used.saturating_add(item.size) > MAX_STORAGE {
        bail!("Хранилище получателя заполнено.");
    }
    let path = app.path(&item, false);
    if let Some(source) = source {
        let parent = path.parent().context("Несуществующая папка.")?;
        std::fs::create_dir_all(parent)?;
        match std::fs::hard_link(source, &path) {
            Ok(()) => {}
            Err(error)
                if error.kind() == std::io::ErrorKind::AlreadyExists
                    && path.metadata().is_ok_and(|file| file.len() == item.size) => {}
            Err(error) => return Err(error.into()),
        }
    }
    let mut items = db.items.clone();
    let id = item.id;
    items.insert(id, item);
    if let Err(error) = app.save_items(&mut db, items, false) {
        if source.is_some() {
            let _ = std::fs::remove_file(path);
        }
        return Err(error);
    }
    if let Some(push) = &app.push {
        let item = &db.items[&id];
        if item.relay_to.is_none() {
            push.notify(item);
        }
    }
    Ok(())
}

async fn upload(
    State(app): State<App>,
    Principal(principal): Principal,
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
    let route = transfer_route(&app, principal, request.headers(), to)?;
    let host_needs_copy =
        route.local.len() > 1 && route.local.contains(&app.db.lock().unwrap().config.host);
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
    let mut count = 0;
    if let Some((peer, remote, sender)) = route.upstream {
        let file = tokio::fs::File::open(&temp).await?;
        let recipients = remote
            .iter()
            .map(Uuid::to_string)
            .collect::<Vec<_>>()
            .join(",");
        count += forward_result(
            forward(&app, &peer, sender, route.hops, "/api/upload")
                .await?
                .query(&[
                    ("to", recipients),
                    ("name", form.name.clone()),
                    ("batch", form.batch.to_string()),
                ])
                .header(header::CONTENT_LENGTH, size)
                .body(reqwest::Body::wrap_stream(ReaderStream::new(file))),
        )
        .await?;
    }
    if !route.local.is_empty() {
        count += store(
            &app,
            route.from,
            &route.local,
            form.batch,
            model::file_name(&form.name),
            None,
            Some(StagedFile {
                relay: &temp,
                inbox: inbox.as_deref(),
                size,
            }),
        )
        .with_context(|| {
            if count > 0 {
                "Часть получателей уже приняла файл."
            } else {
                "Не удалось отправить файл."
            }
        })?;
    }
    Ok(Json(json!({"count":count})))
}

pub fn small_body() -> DefaultBodyLimit {
    DefaultBodyLimit::max(96 * 1024)
}
