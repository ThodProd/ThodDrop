use anyhow::{Context, Result, bail};
use base64::{Engine, engine::general_purpose::STANDARD};
use std::{
    path::{Path, PathBuf},
    process::{Command, Stdio},
};

pub mod protected {
    use super::*;
    use serde::{Deserialize, Deserializer, Serializer, de, ser};

    pub fn serialize<S: Serializer>(
        secret: &str,
        serializer: S,
    ) -> std::result::Result<S::Ok, S::Error> {
        let bytes = transform(secret.as_bytes(), true).map_err(ser::Error::custom)?;
        serializer.serialize_str(&STANDARD.encode(bytes))
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(
        deserializer: D,
    ) -> std::result::Result<String, D::Error> {
        let encoded = String::deserialize(deserializer)?;
        let bytes = STANDARD.decode(encoded).map_err(de::Error::custom)?;
        let plaintext = transform(&bytes, false).map_err(de::Error::custom)?;
        String::from_utf8(plaintext).map_err(de::Error::custom)
    }

    #[cfg(windows)]
    fn transform(bytes: &[u8], encrypt: bool) -> std::io::Result<Vec<u8>> {
        use std::ptr::{null, null_mut};
        use windows_sys::Win32::{
            Foundation::LocalFree,
            Security::Cryptography::{
                CRYPT_INTEGER_BLOB, CRYPTPROTECT_UI_FORBIDDEN, CryptProtectData, CryptUnprotectData,
            },
        };
        let input = CRYPT_INTEGER_BLOB {
            cbData: bytes.len() as u32,
            pbData: bytes.as_ptr().cast_mut(),
        };
        let mut output = CRYPT_INTEGER_BLOB {
            cbData: 0,
            pbData: null_mut(),
        };
        // DPAPI reads the input and gives ownership of the output buffer to the caller.
        unsafe {
            let ok = if encrypt {
                CryptProtectData(
                    &input,
                    null(),
                    null(),
                    null(),
                    null(),
                    CRYPTPROTECT_UI_FORBIDDEN,
                    &mut output,
                )
            } else {
                CryptUnprotectData(
                    &input,
                    null_mut(),
                    null(),
                    null(),
                    null(),
                    CRYPTPROTECT_UI_FORBIDDEN,
                    &mut output,
                )
            };
            if ok == 0 {
                return Err(std::io::Error::last_os_error());
            }
            let value = std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec();
            LocalFree(output.pbData.cast());
            Ok(value)
        }
    }
}

pub fn data_dir() -> PathBuf {
    if let Some(path) = std::env::var_os("THODHUB_DATA_DIR") {
        return path.into();
    }
    PathBuf::from(std::env::var_os("LOCALAPPDATA").unwrap_or_else(|| ".".into()))
        .join("ThodHUB")
        .join("Data")
        .join("thoddrop")
}

#[cfg(windows)]
pub fn autostart(root: &Path, enabled: bool) -> Result<()> {
    use winreg::{
        RegKey,
        enums::{HKEY_CURRENT_USER, KEY_QUERY_VALUE, KEY_SET_VALUE},
    };
    let key = RegKey::predef(HKEY_CURRENT_USER).open_subkey_with_flags(
        r"Software\Microsoft\Windows\CurrentVersion\Run",
        KEY_QUERY_VALUE | KEY_SET_VALUE,
    )?;
    if enabled {
        let app = std::env::current_exe()?;
        let value = format!(
            "\"{}\" --start-background --data \"{}\"",
            app.display(),
            root.display()
        );
        key.set_value("ThodDrop.Rust", &value)?;
    } else if let Err(err) = key.delete_value("ThodDrop.Rust")
        && err.kind() != std::io::ErrorKind::NotFound
    {
        return Err(err.into());
    }
    Ok(())
}

pub fn spawn_daemon(root: &Path) -> Result<()> {
    let log = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(root.join("runtime").join("server.log"))?;
    let mut command = Command::new(std::env::current_exe()?);
    command
        .args(["--daemon", "--data"])
        .arg(root)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(log);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        use windows_sys::Win32::{
            Foundation::{HANDLE_FLAG_INHERIT, INVALID_HANDLE_VALUE, SetHandleInformation},
            System::Console::{
                GetStdHandle, STD_ERROR_HANDLE, STD_INPUT_HANDLE, STD_OUTPUT_HANDLE,
            },
        };
        // The independent daemon must not hold the Hub's JSON-RPC pipes open.
        for stream in [STD_INPUT_HANDLE, STD_OUTPUT_HANDLE, STD_ERROR_HANDLE] {
            unsafe {
                let handle = GetStdHandle(stream);
                if !handle.is_null() && handle != INVALID_HANDLE_VALUE {
                    SetHandleInformation(handle, HANDLE_FLAG_INHERIT, 0);
                }
            }
        }
        command.creation_flags(0x08000000 | 0x00000200);
    }
    command.spawn()?;
    Ok(())
}

pub async fn notifications(mut receiver: tokio::sync::mpsc::Receiver<usize>) {
    while let Some(mut count) = receiver.recv().await {
        tokio::time::sleep(std::time::Duration::from_millis(900)).await;
        while let Ok(next) = receiver.try_recv() {
            count += next;
        }
        let _ = tokio::task::spawn_blocking(move || notify(count)).await;
    }
}

fn notify(count: usize) {
    #[cfg(windows)]
    {
        use winrt_notification::Toast;
        let result = Toast::new(Toast::POWERSHELL_APP_ID)
            .title("ThodDrop")
            .text1(&if count == 1 {
                "Новая передача".into()
            } else {
                format!("Новые передачи · {count}")
            })
            .show();
        if let Err(error) = result {
            eprintln!("Уведомление Windows: {error}");
        }
    }
}

pub fn reveal(path: &Path) -> Result<()> {
    if !path.is_file() {
        bail!("Файл перемещён или удалён.")
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        Command::new("explorer.exe")
            .raw_arg(format!("/select,\"{}\"", path.display()))
            .spawn()?;
    }
    Ok(())
}

pub fn copy_path(path: &Path) -> Result<()> {
    if !path.is_file() {
        bail!("Файл перемещён или удалён.")
    }
    arboard::Clipboard::new()?.set().file_list(&[path])?;
    Ok(())
}

fn decode_image(path: &Path) -> Result<image::DynamicImage> {
    let mut reader = image::ImageReader::open(path)?.with_guessed_format()?;
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(8192);
    limits.max_image_height = Some(8192);
    limits.max_alloc = Some(128 * 1024 * 1024);
    reader.limits(limits);
    reader.decode().context("Не удалось открыть изображение.")
}

pub fn thumbnail(path: &Path) -> Result<Vec<u8>> {
    let mut output = std::io::Cursor::new(Vec::new());
    decode_image(path)?
        .thumbnail(300, 200)
        .write_to(&mut output, image::ImageFormat::Png)?;
    Ok(output.into_inner())
}

pub fn copy_file(path: &Path, preview: bool) -> Result<Option<String>> {
    if preview {
        return Ok(Some(format!(
            "data:image/png;base64,{}",
            STANDARD.encode(thumbnail(path)?)
        )));
    }
    let rgba = decode_image(path)?.into_rgba8();
    arboard::Clipboard::new()?.set_image(arboard::ImageData {
        width: rgba.width() as usize,
        height: rgba.height() as usize,
        bytes: rgba.into_raw().into(),
    })?;
    Ok(None)
}
