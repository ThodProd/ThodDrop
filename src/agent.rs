use crate::{
    desktop,
    model::{self, Config, Item, Upstream},
    net,
    server::{self, App, Candidate},
    win,
};
use anyhow::{Context, Result};
use mdns_sd::{ServiceDaemon, ServiceEvent};
use serde::{Deserialize, Serialize};
use std::{
    fs::File,
    net::{Ipv4Addr, SocketAddr},
    path::{Path, PathBuf},
    time::Duration,
};
use tokio::{io::AsyncWriteExt, sync::watch};

#[derive(Default, Deserialize, Serialize)]
pub struct Endpoint {
    pub port: u16,
    #[serde(with = "crate::win::protected")]
    pub token: String,
}

fn sleep() -> Duration {
    Duration::from_secs(3)
}

pub async fn run(root: PathBuf) -> Result<()> {
    let runtime = root.join("runtime");
    let Some(lock) = lock_server(&root)? else {
        return Ok(());
    };
    let socket = tokio::net::TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await?;
    let local_addr = socket.local_addr()?;
    let (tx, mut rx) = watch::channel(false);
    let app = server::Server::init(root.clone(), local_addr, tx)?;
    let endpoint = runtime.join("server.json");
    model::write(
        &endpoint,
        &Endpoint {
            port: local_addr.port(),
            token: app.local_token.clone(),
        },
    )?;
    let config = app.db.lock().unwrap().config.clone();
    let discovery = config.discovery.then(|| ServiceDaemon::new()).transpose();
    let discovery = match discovery {
        Ok(discovery) => discovery,
        Err(error) => {
            eprintln!("Поиск устройств: {error}");
            None
        }
    };
    if let Some(discovery) = &discovery {
        tokio::spawn(browse(app.clone(), discovery.clone()));
    }
    let mut tasks = tokio::task::JoinSet::new();
    if let Some(upstream) = config.upstream {
        tasks.spawn(sync(app.clone(), upstream));
    }
    tasks.spawn(serve_lan(app.clone(), discovery.clone()));
    let mut local = tokio::spawn(axum::serve(socket, server::local(app.clone())).into_future());
    let result = tokio::select! {
        result = &mut local => result?.map_err(anyhow::Error::from),
        _ = rx.changed() => Ok(()),
        signal = tokio::signal::ctrl_c() => signal.map_err(anyhow::Error::from),
    };
    local.abort();
    tasks.shutdown().await;
    if let Some(discovery) = discovery
        && let Ok(receiver) = discovery.shutdown()
    {
        let _ = tokio::time::timeout(Duration::from_millis(250), receiver.recv_async()).await;
    }
    let _ = std::fs::remove_file(endpoint);
    drop(lock);
    if app.restart.load(std::sync::atomic::Ordering::Relaxed) {
        win::spawn_daemon(&root)?;
    }
    result
}

fn lock_server(root: &Path) -> Result<Option<File>> {
    let runtime = root.join("runtime");
    std::fs::create_dir_all(&runtime)?;
    let file = std::fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(runtime.join("server.lock"))?;
    match file.try_lock() {
        Ok(()) => Ok(Some(file)),
        Err(std::fs::TryLockError::WouldBlock) => Ok(None),
        Err(std::fs::TryLockError::Error(error)) => Err(error.into()),
    }
}

pub async fn set_autostart(root: &Path, client: &reqwest::Client, enabled: bool) -> Result<()> {
    for _ in 0..30 {
        if let Some(endpoint) = try_endpoint(root, client).await {
            let response = client
                .post(format!(
                    "http://127.0.0.1:{}/local/autostart",
                    endpoint.port
                ))
                .bearer_auth(endpoint.token)
                .json(&enabled)
                .timeout(Duration::from_secs(2))
                .send()
                .await;
            if let Ok(response) = response {
                desktop::result(response).await?;
                return Ok(());
            }
        }
        if let Some(_lock) = lock_server(root)? {
            let mut config = model::read(&root.join("network-v2.json"))?;
            return win::save_autostart(root, &mut config, enabled);
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    anyhow::bail!("Сервер занят. Повторите изменение автозапуска.")
}

async fn serve_lan(app: App, discovery: Option<ServiceDaemon>) {
    loop {
        let mut config = {
            let mut db = app.db.lock().unwrap();
            let mut config = db.config.clone();
            if config.address.is_none()
                && let Some(ip) = net::default_address()
            {
                config.address = Some(ip);
                if let Err(err) = app.save_config(&mut db, config.clone()) {
                    eprintln!("Адрес сервера: {err}");
                }
            }
            config
        };
        if let Err(error) = listen(&app, &mut config, discovery.as_ref()).await {
            app.db.lock().unwrap().network_error = Some(format!("{error}"));
            tokio::time::sleep(sleep()).await;
        }
    }
}

async fn listen(app: &App, config: &mut Config, discovery: Option<&ServiceDaemon>) -> Result<()> {
    let ip = config.address.context("Локальная сеть пока недоступна.")?;
    let socket = match net::lan_listener(ip, config.port) {
        Ok(socket) => socket,
        Err(error)
            if config.port == model::PORT
                && error
                    .downcast_ref::<std::io::Error>()
                    .is_some_and(|error| error.kind() == std::io::ErrorKind::AddrInUse) =>
        {
            let mut db = app.db.lock().unwrap();
            if !db.devices.is_empty()
                || db.config.port != config.port
                || db.config.address != config.address
            {
                return Err(error);
            }
            // A fresh local network can use an available port without invalidating phone sessions.
            let socket = net::lan_listener(ip, 0)?;
            *config = db.config.clone();
            config.port = socket.local_addr()?.port();
            app.save_config(&mut db, config.clone())?;
            socket
        }
        Err(error) => return Err(error),
    };
    let tls = app.ca.tls(ip).await?;
    let service = axum_server::from_tcp_rustls(socket, tls.clone())?;
    let bootstrap = if let Some(port) = config.phone_port.filter(|_| config.phone_http) {
        net::lan_listener(ip, port)
    } else {
        config
            .port
            .checked_add(1)
            .and_then(|port| net::lan_listener(ip, port).ok())
            .map(Ok)
            .unwrap_or_else(|| net::lan_listener(ip, 0))
    }
    .and_then(|socket| {
        Ok((
            socket.local_addr()?.port(),
            tokio::net::TcpListener::from_std(socket)?,
        ))
    });
    let phone_http = config.phone_http;
    let mut bootstrap = std::pin::pin!(async {
        match bootstrap {
            Ok((port, socket)) => {
                if phone_http {
                    let mut db = app.db.lock().unwrap();
                    if db.config.phone_port != Some(port) {
                        let mut config = db.config.clone();
                        config.phone_port = Some(port);
                        if let Err(error) = app.save_config(&mut db, config) {
                            eprintln!("Адрес телефона: {error}");
                        }
                    }
                    *app.phone_http_url.lock().unwrap() = Some(format!("http://{ip}:{port}"));
                }
                *app.certificate_url.lock().unwrap() =
                    Some(format!("http://{ip}:{port}/certificate"));
                let router = if phone_http {
                    server::web_lan(app.clone(), ip, port, true)
                } else {
                    server::certificate_lan(app.clone(), ip, port)
                };
                axum::serve(
                    socket,
                    router.into_make_service_with_connect_info::<SocketAddr>(),
                )
                .await
            }
            Err(error) => {
                eprintln!("Адрес телефона: {error}");
                std::future::pending().await
            }
        }
    });
    let fullname = config.host.simple().to_string();
    if let Some(discovery) = discovery {
        let service = mdns_sd::ServiceInfo::new(
            net::SERVICE,
            &fullname,
            &format!("thoddrop-{fullname}.local."),
            std::net::IpAddr::V4(ip),
            config.port,
            &[("name", config.name.as_str())][..],
        );
        if let Err(err) = service.and_then(|service| discovery.register(service)) {
            eprintln!("Объявление в локальной сети: {err}");
        }
    }
    app.db.lock().unwrap().network_error = None;
    let mut server = std::pin::pin!(
        service.serve(
            server::lan(app.clone(), ip, config.port)
                .into_make_service_with_connect_info::<SocketAddr>()
        )
    );
    let mut bootstrap_running = true;
    let result = loop {
        tokio::select! {
            result = &mut server => break result,
            result = &mut bootstrap, if bootstrap_running => {
                bootstrap_running = false;
                *app.certificate_url.lock().unwrap() = None;
                *app.phone_http_url.lock().unwrap() = None;
                if let Err(error) = result { eprintln!("Загрузка сертификата: {error}"); }
            }
            _ = tokio::time::sleep(Duration::from_secs(90 * 24 * 60 * 60)) => {
                match app.ca.tls(ip).await {
                    Ok(next) => tls.reload_from_config(next.get_inner()),
                    Err(err) => eprintln!("Обновление сертификата: {err}"),
                }
            }
        }
    };
    *app.certificate_url.lock().unwrap() = None;
    *app.phone_http_url.lock().unwrap() = None;
    if let Some(discovery) = discovery {
        let _ = discovery.unregister(&format!("{fullname}.{}", net::SERVICE));
    }
    result?;
    Ok(())
}

async fn browse(app: App, discovery: ServiceDaemon) {
    let mut events = match discovery.browse(net::SERVICE) {
        Ok(events) => events,
        Err(err) => {
            eprintln!("Поиск компьютеров: {err}");
            return;
        }
    };
    loop {
        let event = tokio::select! {
            event = events.recv_async() => match event {
                Ok(event) => event,
                Err(_) => break,
            },
            _ = app.rescan.notified() => {
                match discovery.browse(net::SERVICE) {
                    Ok(next) => events = next,
                    Err(err) => eprintln!("Поиск компьютеров: {err}"),
                }
                continue;
            }
        };
        match event {
            ServiceEvent::ServiceResolved(service) => {
                let (local, host) = {
                    let db = app.db.lock().unwrap();
                    (
                        db.config.address.or_else(net::default_address),
                        db.config.host,
                    )
                };
                let instance = service.get_fullname();
                if instance.eq_ignore_ascii_case(&format!("{}.{}", host.simple(), net::SERVICE)) {
                    continue;
                }
                let mut candidates = app.candidates.lock().unwrap();
                candidates.retain(|key, _| !key.starts_with(&format!("{instance}:")));
                for address in service.get_addresses_v4() {
                    if local.is_none_or(|ip| !net::same_subnet(ip, address))
                        || candidates.len() >= 64
                    {
                        continue;
                    }
                    let name = service.get_property_val_str("name").unwrap_or("Компьютер");
                    let url = format!("https://{address}:{}", service.get_port());
                    candidates.insert(
                        format!("{instance}:{address}"),
                        Candidate {
                            url,
                            name: name.chars().take(64).collect(),
                        },
                    );
                }
            }
            ServiceEvent::ServiceRemoved(_, name) => {
                app.candidates
                    .lock()
                    .unwrap()
                    .retain(|key, _| !key.starts_with(&format!("{name}:")));
            }
            _ => {}
        }
    }
}

#[derive(Deserialize)]
struct Pending {
    items: Vec<Item>,
}

async fn sync(app: App, upstream: Upstream) {
    let client = match net::peer_client(&upstream.url, &upstream.ca) {
        Ok(client) => client,
        Err(error) => {
            app.db.lock().unwrap().peer_error = Some(error.to_string());
            return;
        }
    };
    let presence = tokio::spawn({
        let app = app.clone();
        let upstream = upstream.clone();
        let client = client.clone();
        async move {
            loop {
                let share_guard = app.share_gate.lock().await;
                let devices = server::published_devices(&app.db.lock().unwrap());
                let mut sharing = true;
                let mut response =
                    net::peer_request(&client, &upstream, reqwest::Method::POST, "/api/share")
                        .timeout(Duration::from_secs(4))
                        .json(&devices)
                        .send()
                        .await;
                if response
                    .as_ref()
                    .is_ok_and(|reply| reply.status() == reqwest::StatusCode::NOT_FOUND)
                {
                    sharing = false;
                    response = net::peer_request(
                        &client,
                        &upstream,
                        reqwest::Method::POST,
                        "/api/presence",
                    )
                    .timeout(Duration::from_secs(4))
                    .send()
                    .await;
                }
                drop(share_guard);
                let revoked = response
                    .as_ref()
                    .is_ok_and(|reply| reply.status() == reqwest::StatusCode::UNAUTHORIZED);
                let (roster, message) = match response {
                    Ok(reply) if reply.status().is_success() => match reply.json().await {
                        Ok(roster) => (Some(roster), None),
                        Err(_) => (None, Some("Не удалось прочитать список устройств.".into())),
                    },
                    Ok(reply) if reply.status() == reqwest::StatusCode::UNAUTHORIZED => {
                        (None, Some("Доступ отозван на ведущем компьютере.".into()))
                    }
                    _ => (None, Some("Ведущий компьютер сейчас недоступен.".into())),
                };
                let rename = {
                    let mut db = app.db.lock().unwrap();
                    if !db.config.upstream.as_ref().is_some_and(|current| {
                        current.device == upstream.device && current.url == upstream.url
                    }) {
                        return;
                    }
                    if revoked {
                        db.peer_roster = None;
                        db.peer_sharing = false;
                        let _ = std::fs::remove_file(app.root.join("peer-roster-v3.json"));
                    }
                    if let Some(roster) = roster {
                        if db.peer_roster.as_ref() != Some(&roster) {
                            if let Err(error) =
                                model::write(&app.root.join("peer-roster-v3.json"), &roster)
                            {
                                eprintln!("Список устройств: {error}");
                            }
                        }
                        db.peer_roster = Some(roster);
                        db.peer_sharing = sharing;
                    }
                    let rename = if message.is_none() && db.config.rename_pending {
                        Some(db.config.name.clone())
                    } else {
                        None
                    };
                    db.peer_error = message;
                    rename
                };
                if let Some(name) = rename {
                    sync_name(&app, &upstream, &client, name).await;
                }
                tokio::time::sleep(sleep()).await;
            }
        }
    });
    loop {
        match sync_inbox(&app, &upstream, &client).await {
            Ok(count) if count != 0 => {
                let _ = app.notifications.try_send(count);
            }
            Ok(_) => {}
            Err(err) => eprintln!("Приём с ведущего компьютера: {err}"),
        }
        if presence.is_finished() {
            break;
        }
        tokio::time::sleep(sleep()).await;
    }
}

async fn sync_name(app: &App, upstream: &Upstream, client: &reqwest::Client, name: String) {
    let result = net::peer_request(client, upstream, reqwest::Method::POST, "/api/name")
        .timeout(Duration::from_secs(4))
        .json(&serde_json::json!({"name":name}))
        .send()
        .await;
    if result.is_ok_and(|response| response.status().is_success()) {
        let mut db = app.db.lock().unwrap();
        if db.config.name == name && db.config.rename_pending {
            let mut config = db.config.clone();
            config.rename_pending = false;
            if let Err(error) = app.save_config(&mut db, config) {
                eprintln!("Имя компьютера: {error}");
            }
        }
    }
}

async fn sync_inbox(app: &App, upstream: &Upstream, client: &reqwest::Client) -> Result<usize> {
    use reqwest::Method;
    let response = net::peer_request(client, upstream, Method::GET, "/api/pending")
        .send()
        .await?
        .error_for_status()?;
    let page: Pending = response.json().await?;
    let mut receipts = Vec::new();
    let mut count = 0;
    for item in page.items {
        anyhow::ensure!(
            item.recipient == upstream.device || item.relay_to == Some(upstream.device),
            "Адресат передачи изменился."
        );
        let id = item.id;
        match receive(app, upstream, client, item).await {
            Ok(added) => {
                if added {
                    count += 1;
                }
                receipts.push(id);
            }
            Err(error) => eprintln!("Приём файла: {error}"),
        }
    }
    if !receipts.is_empty() {
        net::peer_request(client, upstream, Method::POST, "/api/delivered")
            .json(&receipts)
            .send()
            .await?
            .error_for_status()?;
    }
    Ok(count)
}

async fn receive(
    app: &App,
    upstream: &Upstream,
    client: &reqwest::Client,
    mut item: Item,
) -> Result<bool> {
    let for_pc = item.recipient == upstream.device;
    {
        let db = app.db.lock().unwrap();
        if db.local_items.contains_key(&item.id) || db.items.contains_key(&item.id) {
            return Ok(false);
        }
    }
    let temp = if let Some(text) = &item.text {
        if !for_pc {
            server::accept_relay(app, item, None)?;
            return Ok(false);
        }
        model::stage_text(&app.root, text)?
    } else {
        let temp = tempfile::Builder::new()
            .prefix(".upload-")
            .tempfile_in(app.root.join("runtime"))?
            .into_temp_path();
        let mut file = tokio::fs::OpenOptions::new()
            .write(true)
            .open(&temp)
            .await?;
        let mut response = net::peer_request(
            client,
            upstream,
            reqwest::Method::GET,
            &format!("/api/file/{}", item.id),
        )
        .send()
        .await?
        .error_for_status()?;
        let mut size = 0;
        while let Some(chunk) = response.chunk().await? {
            size += chunk.len() as u64;
            anyhow::ensure!(
                size <= item.size && size <= model::MAX_FILE,
                "Размер файла изменился."
            );
            file.write_all(&chunk).await?;
        }
        anyhow::ensure!(size == item.size, "Получен неполный файл.");
        file.sync_all().await?;
        drop(file);
        temp
    };
    if !for_pc {
        server::accept_relay(app, item, Some(&temp))?;
        return Ok(false);
    }
    item.relay_to = None;
    let mut db = app.db.lock().unwrap();
    let mut local = db.local_items.clone();
    let path = app.save_inbox_file(&mut db, &mut item, &temp)?;
    local.insert(item.id, item);
    if let Err(error) = app.save_items(&mut db, local, true) {
        let _ = std::fs::remove_file(path);
        return Err(error);
    }
    Ok(true)
}

pub async fn try_endpoint(root: &std::path::Path, client: &reqwest::Client) -> Option<Endpoint> {
    let endpoint: Endpoint = model::read(&root.join("runtime/server.json")).ok()?;
    if endpoint.port == 0 || endpoint.token.len() != 64 {
        return None;
    }
    client
        .get(format!("http://127.0.0.1:{}/local/ping", endpoint.port))
        .bearer_auth(&endpoint.token)
        .timeout(Duration::from_millis(250))
        .send()
        .await
        .ok()?
        .error_for_status()
        .ok()?;
    Some(endpoint)
}

pub async fn endpoint(root: &std::path::Path, client: &reqwest::Client) -> Result<Endpoint> {
    if let Some(endpoint) = try_endpoint(root, client).await {
        return Ok(endpoint);
    }
    std::fs::create_dir_all(root.join("runtime"))?;
    win::spawn_daemon(root)?;
    for _ in 0..60 {
        if let Some(endpoint) = try_endpoint(root, client).await {
            return Ok(endpoint);
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    anyhow::bail!("Фоновый сервер не запустился. Подробности в runtime/server.log.")
}

pub async fn stop(root: &std::path::Path) -> Result<()> {
    let client = crate::local_client();
    if let Some(endpoint) = try_endpoint(root, &client).await {
        let response = client
            .post(format!("http://127.0.0.1:{}/local/stop", endpoint.port))
            .bearer_auth(endpoint.token)
            .send()
            .await?;
        desktop::result(response).await?;
    }
    let lock_file = root.join("runtime/server.lock");
    if !lock_file.exists() {
        return Ok(());
    }
    let file = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(lock_file)?;
    for _ in 0..70 {
        match file.try_lock() {
            Ok(()) => return Ok(()),
            Err(std::fs::TryLockError::WouldBlock) => {
                tokio::time::sleep(Duration::from_millis(100)).await
            }
            Err(std::fs::TryLockError::Error(err)) => return Err(err.into()),
        }
    }
    anyhow::bail!("Фоновый сервер не завершил работу.")
}
