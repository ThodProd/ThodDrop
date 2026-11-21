#![cfg_attr(windows, windows_subsystem = "windows")]

mod agent;
mod desktop;
mod model;
mod net;
mod phone;
mod server;
mod short_code;
mod win;

use anyhow::{Context, Result, bail};
use serde_json::{Value, json};
use std::{
    path::{Path, PathBuf},
    time::Duration,
};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

#[tokio::main]
async fn main() {
    if let Err(error) = run().await {
        eprintln!("{error:#}");
        std::process::exit(1);
    }
}

async fn run() -> Result<()> {
    let _ = rustls::crypto::ring::default_provider().install_default();
    let mut args = std::env::args_os().skip(1);
    let command = args.next();
    let root = match args.next().as_deref() {
        Some(flag) if flag == "--data" => {
            PathBuf::from(args.next().context("Укажите каталог данных.")?)
        }
        None => win::data_dir(),
        _ => bail!("Неизвестный аргумент."),
    };
    match command.as_deref().and_then(|arg| arg.to_str()) {
        Some("--daemon") => agent::run(root).await,
        Some("--start-background") => {
            std::fs::create_dir_all(root.join("runtime"))?;
            win::spawn_daemon(&root)
        }
        Some("--stop-background") => agent::stop(&root).await,
        Some("--cleanup") => {
            agent::stop(&root).await?;
            win::autostart(&root, false)
        }
        Some("--register") => {
            let config: model::Config = model::read(&root.join("network-v2.json"))?;
            win::autostart(&root, config.autostart)
        }
        None => rpc(&root).await,
        _ => bail!("Неизвестная команда."),
    }
}

pub fn local_client() -> reqwest::Client {
    reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(2))
        .build()
        .expect("loopback HTTP client")
}

async fn rpc(root: &Path) -> Result<()> {
    let client = local_client();
    let mut input = BufReader::new(tokio::io::stdin()).lines();
    let mut output = tokio::io::stdout();
    while let Some(line) = input.next_line().await? {
        let Ok(request) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        let id = request["id"].clone();
        let result = dispatch(
            root,
            &client,
            request["method"].as_str().unwrap_or(""),
            &request["params"],
        )
        .await;
        let response = match result {
            Ok(value) => json!({"jsonrpc":"2.0","id":id,"result":value}),
            Err(error) => {
                json!({"jsonrpc":"2.0","id":id,"error":{"code":-32000,"message":error.to_string()}})
            }
        };
        output.write_all(&serde_json::to_vec(&response)?).await?;
        output.write_all(b"\n").await?;
        output.flush().await?;
    }
    Ok(())
}

async fn dispatch(
    root: &Path,
    client: &reqwest::Client,
    method: &str,
    params: &Value,
) -> Result<Value> {
    let id = || -> Result<uuid::Uuid> {
        Ok(params["id"]
            .as_str()
            .context("Не указан идентификатор.")?
            .parse()?)
    };
    let (post, path) = match method {
        "status" => (false, "/local/status".into()),
        "config" => (true, "/local/config".into()),
        "freePort" => (true, "/local/free-port".into()),
        "invite" => (true, "/local/invite".into()),
        "scan" => (true, "/local/scan".into()),
        "certificate" => (true, "/local/certificate".into()),
        "join" => (true, "/local/join".into()),
        "leave" => (true, "/local/leave".into()),
        "peerAddress" => (true, "/local/peer-address".into()),
        "device" => (true, format!("/local/device/{}", id()?)),
        "inbox" => (
            false,
            format!(
                "/local/inbox?offset={}",
                params["offset"].as_u64().unwrap_or(0)
            ) + &params["known"]
                .as_str()
                .filter(|value| {
                    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
                })
                .map_or_else(String::new, |value| format!("&known={value}")),
        ),
        "item" => (true, format!("/local/inbox/{}/action", id()?)),
        "pick" => (true, "/local/pick".into()),
        "send" => (true, "/local/send".into()),
        "job" => (false, format!("/local/job/{}", id()?)),
        "dialogJob" => (false, format!("/local/dialog/{}", id()?)),
        _ => bail!("Неизвестное действие."),
    };
    let endpoint = agent::endpoint(root, client).await?;
    let address = format!("http://127.0.0.1:{}{path}", endpoint.port);
    let request = if post {
        client.post(address).json(params)
    } else {
        client.get(address)
    };
    desktop::result(
        request
            .bearer_auth(endpoint.token)
            .timeout(Duration::from_secs(27))
            .send()
            .await
            .context("Фоновый сервер не ответил.")?,
    )
    .await
}
