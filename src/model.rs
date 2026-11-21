use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, io::Write, net::Ipv4Addr, path::Path};
use uuid::Uuid;

pub const PORT: u16 = 47776;
pub const MAX_FILE: u64 = 2 * 1024 * 1024 * 1024;
pub const MAX_STORAGE: u64 = 20 * 1024 * 1024 * 1024;
pub const MAX_ITEMS: usize = 10_000;

#[derive(Clone, Serialize, Deserialize)]
pub struct Config {
    pub host: Uuid,
    pub name: String,
    pub address: Option<Ipv4Addr>,
    pub port: u16,
    pub discovery: bool,
    pub autostart: bool,
    pub upstream: Option<Upstream>,
}
impl Default for Config {
    fn default() -> Self {
        Self {
            host: Uuid::new_v4(),
            name: std::env::var("COMPUTERNAME").unwrap_or_else(|_| "Этот компьютер".into()),
            address: None,
            port: PORT,
            discovery: true,
            autostart: true,
            upstream: None,
        }
    }
}

#[derive(Clone, Serialize, Deserialize)]
pub struct Invite {
    pub url: String,
    pub ca: String,
    pub code: String,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct Upstream {
    pub url: String,
    pub ca: String,
    #[serde(with = "crate::win::protected")]
    pub token: String,
    pub device: Uuid,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct Device {
    pub id: Uuid,
    pub name: String,
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub token_hash: Option<String>,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct Item {
    pub id: Uuid,
    pub batch: Uuid,
    pub sender: String,
    pub recipient: Uuid,
    pub name: String,
    pub time: u64,
    pub size: u64,
    pub text: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sender_id: Option<Uuid>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub inbox_folder: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stored_name: Option<String>,
    #[serde(default)]
    pub delivered: bool,
}

pub type Items = BTreeMap<Uuid, Item>;
pub type Devices = BTreeMap<Uuid, Device>;

pub fn read<T: serde::de::DeserializeOwned + Default>(path: &Path) -> Result<T> {
    match std::fs::read(path) {
        Ok(bytes) => {
            serde_json::from_slice(&bytes).with_context(|| format!("Повреждён {}", path.display()))
        }
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(T::default()),
        Err(err) => Err(err.into()),
    }
}

pub fn write<T: Serialize>(path: &Path, value: &T) -> Result<()> {
    let mut file = atomic_write_file::AtomicWriteFile::open(path)?;
    serde_json::to_writer(&mut file, value)?;
    file.flush()?;
    file.commit()?;
    Ok(())
}

pub fn instant() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

pub fn stage_text(root: &Path, text: &str) -> Result<tempfile::TempPath> {
    let mut temp = tempfile::Builder::new()
        .prefix(".upload-")
        .tempfile_in(root.join("runtime"))?;
    temp.write_all(text.as_bytes())?;
    temp.as_file().sync_all()?;
    Ok(temp.into_temp_path())
}

pub fn secret() -> String {
    format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple())
}

pub fn digest(value: &str) -> String {
    format!("{:x}", Sha256::digest(value.as_bytes()))
}

pub fn name(value: &str) -> Result<String> {
    let value = value.trim();
    if value.is_empty() || value.chars().count() > 64 || value.chars().any(char::is_control) {
        bail!("Введите имя длиной от 1 до 64 символов.")
    }
    Ok(value.to_owned())
}

pub fn file_name(input: &str) -> String {
    let name: String = input
        .chars()
        .take(100)
        .map(|c| {
            if c.is_control() || "<>:\"/\\|?*".contains(c) {
                '_'
            } else {
                c
            }
        })
        .collect();
    let name = name.trim_matches([' ', '.']);
    if name.is_empty() {
        return "Файл".into();
    }
    let stem = name
        .split('.')
        .next()
        .unwrap_or("")
        .trim_end()
        .to_ascii_uppercase();
    if ["CON", "PRN", "AUX", "NUL", "CONIN$", "CONOUT$"].contains(&stem.as_str())
        || ["COM", "LPT"].iter().any(|prefix| {
            stem.strip_prefix(prefix).is_some_and(|suffix| {
                suffix.chars().count() == 1 && "0123456789¹²³".contains(suffix)
            })
        })
    {
        format!("_{name}")
    } else {
        name.into()
    }
}

pub fn image_type(name: &str) -> Option<&'static str> {
    match name.rsplit('.').next()?.to_ascii_lowercase().as_str() {
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "webp" => Some("image/webp"),
        "gif" => Some("image/gif"),
        "bmp" => Some("image/bmp"),
        "tif" | "tiff" => Some("image/tiff"),
        "ico" => Some("image/x-icon"),
        "heic" | "heif" => Some("image/heif"),
        "avif" => Some("image/avif"),
        _ => None,
    }
}
