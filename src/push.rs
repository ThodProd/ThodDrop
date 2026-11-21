use crate::{
    model,
    server::{Api, App, Principal},
};
use anyhow::{Context, Result, ensure};
use axum::{Json, extract::State, http::StatusCode};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use futures_util::{StreamExt, stream};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::sync::mpsc;
use uuid::Uuid;
use web_push_native::{
    Auth, WebPushBuilder,
    jwt_simple::algorithms::ES256KeyPair,
    p256::{PublicKey, elliptic_curve::sec1::ToEncodedPoint},
};

fn public_key(key: &ES256KeyPair) -> Result<Vec<u8>> {
    let public = PublicKey::from_sec1_bytes(&key.public_key().to_bytes())
        .context("Некорректный ключ уведомлений.")?;
    Ok(public.to_encoded_point(false).as_bytes().to_vec())
}

#[derive(Clone, Deserialize, Serialize, PartialEq, Eq)]
pub struct Subscription {
    endpoint: String,
    keys: Keys,
}

#[derive(Clone, Deserialize, Serialize, PartialEq, Eq)]
struct Keys {
    p256dh: String,
    auth: String,
}

impl Subscription {
    fn builder(&self) -> Result<WebPushBuilder> {
        let url = reqwest::Url::parse(&self.endpoint)
            .context("Некорректный адрес службы уведомлений.")?;
        let host = url.host_str().unwrap_or_default();
        ensure!(
            self.endpoint.len() <= 4096
                && url.scheme() == "https"
                && url.port().is_none()
                && url.username().is_empty()
                && url.password().is_none()
                && url.fragment().is_none()
                && (host.ends_with(".push.apple.com")
                    || matches!(
                        host,
                        "fcm.googleapis.com" | "updates.push.services.mozilla.com"
                    )),
            "Браузер использует неподдерживаемую службу уведомлений."
        );
        let public = URL_SAFE_NO_PAD
            .decode(&self.keys.p256dh)
            .context("Некорректный ключ подписки.")?;
        let auth = URL_SAFE_NO_PAD
            .decode(&self.keys.auth)
            .context("Некорректный ключ подписки.")?;
        ensure!(
            public.len() == 65 && auth.len() == 16,
            "Некорректный ключ подписки."
        );
        let public = PublicKey::from_sec1_bytes(&public).context("Некорректный ключ подписки.")?;
        Ok(WebPushBuilder::new(
            url.as_str().parse()?,
            public,
            Auth::clone_from_slice(&auth),
        ))
    }

    fn request(&self, key: &ES256KeyPair, alert: &Alert) -> Result<axum::http::Request<Vec<u8>>> {
        Ok(self
            .builder()?
            .with_valid_duration(Duration::from_secs(3600))
            .with_vapid(key, "https://github.com/ThodProd/ThodDrop")
            .build(serde_json::to_vec(alert)?)?)
    }
}

#[derive(Default, Deserialize, Serialize)]
struct Protected(#[serde(with = "crate::win::protected")] String);

#[derive(Deserialize, Serialize)]
struct Saved {
    private_key: String,
    subscribers: BTreeMap<Uuid, Subscription>,
}

struct Directory {
    path: PathBuf,
    key: ES256KeyPair,
    public: String,
    subscribers: Mutex<BTreeMap<Uuid, Subscription>>,
}

impl Directory {
    fn save(&self, subscribers: &BTreeMap<Uuid, Subscription>) -> Result<()> {
        let private_key = URL_SAFE_NO_PAD.encode(self.key.to_bytes());
        let payload = json!({"private_key":private_key, "subscribers":subscribers});
        model::write(&self.path, &Protected(serde_json::to_string(&payload)?))
    }

    fn replace(
        &self,
        id: Uuid,
        subscription: Option<Subscription>,
        previous: Option<&Subscription>,
    ) -> Result<()> {
        let mut current = self.subscribers.lock().unwrap();
        if previous.is_some_and(|previous| current.get(&id) != Some(previous))
            || current.get(&id) == subscription.as_ref()
        {
            return Ok(());
        }
        let mut next = current.clone();
        if let Some(subscription) = subscription {
            next.insert(id, subscription);
        } else {
            next.remove(&id);
        }
        self.save(&next)?;
        *current = next;
        Ok(())
    }
}

#[derive(Serialize)]
struct Alert {
    title: String,
    body: String,
    tag: String,
}

pub struct Push {
    directory: Arc<Directory>,
    alerts: mpsc::Sender<(Uuid, Alert)>,
}

impl Push {
    pub fn load(root: &Path) -> Result<Self> {
        let path = root.join("push-v1.json");
        let value = model::read::<Protected>(&path)?;
        let fresh = value.0.is_empty();
        let (key, subscribers) = if fresh {
            (ES256KeyPair::generate(), BTreeMap::new())
        } else {
            let saved: Saved = serde_json::from_str(&value.0)?;
            (
                ES256KeyPair::from_bytes(&URL_SAFE_NO_PAD.decode(saved.private_key)?)?,
                saved.subscribers,
            )
        };
        let public = URL_SAFE_NO_PAD.encode(public_key(&key)?);
        let directory = Arc::new(Directory {
            path,
            key,
            public,
            subscribers: Mutex::new(subscribers),
        });
        if fresh {
            directory.save(&BTreeMap::new())?;
        }
        let client = reqwest::Client::builder()
            .no_proxy()
            .https_only(true)
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(4))
            .timeout(Duration::from_secs(10))
            .build()?;
        let (alerts, receiver) = mpsc::channel(256);
        tokio::spawn(deliver(directory.clone(), client, receiver));
        Ok(Self { directory, alerts })
    }

    pub fn forget(&self, id: Uuid) -> Result<()> {
        self.directory.replace(id, None, None)
    }

    pub fn notify(&self, item: &model::Item) {
        if !self
            .directory
            .subscribers
            .lock()
            .unwrap()
            .contains_key(&item.recipient)
        {
            return;
        }
        let (kind, title, body) = if let Some(text) = &item.text {
            let mut body = text.trim().chars().take(220).collect::<String>();
            if text.trim().chars().nth(220).is_some() {
                body.push('…');
            }
            ("text", "Сообщение", body)
        } else if model::image_type(&item.name).is_some() {
            ("photo", "Получено фото", item.name.clone())
        } else {
            ("file", "Получен файл", item.name.clone())
        };
        let _ = self.alerts.try_send((
            item.recipient,
            Alert {
                title: format!("{title} · {}", item.sender),
                body,
                tag: format!("{}:{kind}", item.batch),
            },
        ));
    }
}

async fn deliver(
    directory: Arc<Directory>,
    client: reqwest::Client,
    receiver: mpsc::Receiver<(Uuid, Alert)>,
) {
    stream::unfold(receiver, |mut receiver| async {
        receiver.recv().await.map(|event| (event, receiver))
    })
    .for_each_concurrent(8, |(id, alert)| {
        let directory = &directory;
        let client = &client;
        async move {
            let subscription = directory.subscribers.lock().unwrap().get(&id).cloned();
            let Some(subscription) = subscription else {
                return;
            };
            let result = send(directory, client, &subscription, &alert).await;
            let status = match result {
                Ok(status) => status,
                Err(_) => {
                    eprintln!("Не удалось отправить мобильное уведомление.");
                    return;
                }
            };
            if matches!(status, StatusCode::NOT_FOUND | StatusCode::GONE) {
                let _ = directory.replace(id, None, Some(&subscription));
            } else if !status.is_success() {
                eprintln!("Служба мобильных уведомлений вернула {status}.");
            }
        }
    })
    .await;
}

async fn send(
    directory: &Directory,
    client: &reqwest::Client,
    subscription: &Subscription,
    alert: &Alert,
) -> Result<StatusCode> {
    let request = subscription.request(&directory.key, alert)?;
    let (parts, body) = request.into_parts();
    let response = client
        .post(parts.uri.to_string())
        .headers(parts.headers)
        .body(body)
        .send()
        .await?;
    Ok(response.status())
}

fn phone(app: &App, id: Uuid) -> Result<&Push> {
    ensure!(
        app.db
            .lock()
            .unwrap()
            .devices
            .get(&id)
            .is_some_and(|device| device.kind == "phone" && !device.web_http),
        "Уведомления доступны на телефоне по HTTPS."
    );
    app.push
        .as_ref()
        .context("Мобильные уведомления пока недоступны.")
}

pub async fn state(State(app): State<App>, Principal(id): Principal) -> Api<Json<Value>> {
    let push = phone(&app, id)?;
    Ok(Json(json!({
        "key":push.directory.public,
        "enabled":push.directory.subscribers.lock().unwrap().contains_key(&id)
    })))
}

pub async fn subscribe(
    State(app): State<App>,
    Principal(id): Principal,
    Json(subscription): Json<Subscription>,
) -> Api<StatusCode> {
    let push = phone(&app, id)?;
    subscription.builder()?;
    push.directory.replace(id, Some(subscription), None)?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn unsubscribe(State(app): State<App>, Principal(id): Principal) -> Api<StatusCode> {
    phone(&app, id)?.forget(id)?;
    Ok(StatusCode::NO_CONTENT)
}
