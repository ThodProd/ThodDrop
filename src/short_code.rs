use anyhow::{Context, Result, anyhow, bail, ensure};
use axum::{Json, extract::State};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use ring::aead::{Aad, CHACHA20_POLY1305, LessSafeKey, Nonce, UnboundKey};
use serde::{Deserialize, Serialize};
use spake2_conflux::{Identity, Password, RistrettoGroup, Spake2};
use std::time::{Duration, Instant};
use uuid::Uuid;

use crate::{
    model::Invite,
    net,
    server::{Api, App},
};

const ALPHABET: &[u8; 32] = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const ATTEMPTS: u8 = 8;
const MESSAGE_LEN: usize = 33;
const MAX_REPLY: usize = 8192;
const DOMAIN: &[u8] = b"ThodDrop PC invitation v1";
type Exchange = Spake2<RistrettoGroup>;

pub struct Pending {
    code: String,
    invite: Invite,
    expires: Instant,
    attempts: u8,
}

impl Pending {
    pub fn new(invite: Invite, expires: Instant) -> Self {
        let random = Uuid::new_v4();
        let code = random.as_bytes()[..5]
            .iter()
            .map(|byte| ALPHABET[usize::from(byte & 31)] as char)
            .collect();
        Self {
            code,
            invite,
            expires,
            attempts: ATTEMPTS,
        }
    }

    pub fn code(&self) -> &str {
        &self.code
    }
}

pub fn normalize(input: &str) -> Option<String> {
    let code = input.trim().to_ascii_uppercase();
    (code.len() == 5 && code.bytes().all(|byte| ALPHABET.contains(&byte))).then_some(code)
}

#[derive(Deserialize, Serialize)]
pub struct Request {
    message: String,
}

#[derive(Deserialize, Serialize)]
pub struct Reply {
    message: String,
    encrypted: String,
}

pub async fn exchange(State(app): State<App>, Json(body): Json<Request>) -> Api<Json<Reply>> {
    let inbound = decode_message(&body.message)?;
    let (code, invite) = {
        let mut db = app.db.lock().unwrap();
        let pending = db
            .pc_code
            .as_mut()
            .filter(|pending| pending.expires > Instant::now())
            .context("На ведущем ПК создайте новый код приглашения.")?;
        ensure_attempt(pending)?;
        (pending.code.clone(), pending.invite.clone())
    };
    let (state, message) = Exchange::start_b(
        &Password::new(code.as_bytes()),
        &Identity::new(DOMAIN),
        &Identity::new(invite.url.as_bytes()),
    )
    .map_err(|_| anyhow!("Не удалось начать проверку кода."))?;
    let key = state.finish(&inbound).map_err(|_| invalid_code())?;
    let mut encrypted =
        serde_json::to_vec(&invite).context("Не удалось сформировать приглашение.")?;
    // SPAKE2 derives a fresh key for each exchange. This key seals exactly one reply.
    cipher(key.expose())?
        .seal_in_place_append_tag(nonce(), Aad::from(DOMAIN), &mut encrypted)
        .map_err(|_| anyhow!("Не удалось защитить приглашение."))?;
    Ok(Json(Reply {
        message: URL_SAFE_NO_PAD.encode(message),
        encrypted: URL_SAFE_NO_PAD.encode(encrypted),
    }))
}

fn ensure_attempt(pending: &mut Pending) -> Result<()> {
    if pending.attempts == 0 {
        bail!("Слишком много попыток. Создайте новый код на ведущем ПК.")
    }
    pending.attempts -= 1;
    Ok(())
}

pub async fn redeem(url: &str, code: &str) -> Result<Invite> {
    net::private_endpoint(url)?;
    let (state, message) = Exchange::start_a(
        &Password::new(code.as_bytes()),
        &Identity::new(DOMAIN),
        &Identity::new(url.as_bytes()),
    )
    .map_err(|_| anyhow!("Не удалось начать проверку кода."))?;
    // The first exchange contains only PAKE messages. The recovered certificate is
    // authenticated by the shared key and is pinned before sending any credentials.
    let client = reqwest::Client::builder()
        .use_rustls_tls()
        .danger_accept_invalid_certs(true)
        .redirect(reqwest::redirect::Policy::none())
        .no_proxy()
        .timeout(Duration::from_secs(5))
        .build()?;
    let mut reply = client
        .post(format!("{url}/api/pc-code"))
        .header("x-thoddrop", "1")
        .json(&Request {
            message: URL_SAFE_NO_PAD.encode(message),
        })
        .send()
        .await
        .context("Не удалось связаться с ведущим ПК.")?;
    let status = reply.status();
    let mut bytes = Vec::new();
    while let Some(chunk) = reply.chunk().await? {
        ensure!(
            bytes.len() + chunk.len() <= MAX_REPLY,
            "Ответ ведущего ПК слишком длинный."
        );
        bytes.extend_from_slice(&chunk);
    }
    if status == reqwest::StatusCode::NOT_FOUND {
        bail!("Обновите ThodDrop на ведущем ПК или используйте полное приглашение.")
    }
    if !status.is_success() {
        let error = serde_json::from_slice::<serde_json::Value>(&bytes).unwrap_or_default();
        bail!(
            "{}",
            error["error"]
                .as_str()
                .unwrap_or("Ведущий ПК не принял приглашение.")
        );
    }
    let reply: Reply = serde_json::from_slice(&bytes).context("Некорректный ответ ведущего ПК.")?;
    let inbound = decode_message(&reply.message)?;
    let key = state.finish(&inbound).map_err(|_| invalid_code())?;
    let mut encrypted = URL_SAFE_NO_PAD
        .decode(reply.encrypted)
        .context("Некорректный ответ ведущего ПК.")?;
    let plaintext = cipher(key.expose())?
        .open_in_place(nonce(), Aad::from(DOMAIN), &mut encrypted)
        .map_err(|_| invalid_code())?;
    let invite: Invite = serde_json::from_slice(plaintext).context("Приглашение повреждено.")?;
    ensure!(
        invite.url == url,
        "Приглашение создано для другого компьютера."
    );
    Ok(invite)
}

fn decode_message(message: &str) -> Result<Vec<u8>> {
    ensure!(message.len() == 44, "Некорректное сообщение привязки.");
    let message = URL_SAFE_NO_PAD
        .decode(message)
        .context("Некорректное сообщение привязки.")?;
    ensure!(
        message.len() == MESSAGE_LEN,
        "Некорректное сообщение привязки."
    );
    Ok(message)
}

fn cipher(key: &[u8]) -> Result<LessSafeKey> {
    Ok(LessSafeKey::new(
        UnboundKey::new(&CHACHA20_POLY1305, key)
            .map_err(|_| anyhow!("Некорректный ключ привязки."))?,
    ))
}

fn nonce() -> Nonce {
    Nonce::assume_unique_for_key([0; 12])
}

fn invalid_code() -> anyhow::Error {
    anyhow!("Код не подошёл. Сверьте его с кодом на ведущем ПК.")
}
