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
    use image::ImageDecoder;
    let decoded = (|| -> Result<image::DynamicImage> {
        let mut reader = image::ImageReader::open(path)?.with_guessed_format()?;
        let mut limits = image::Limits::default();
        limits.max_image_width = Some(16384);
        limits.max_image_height = Some(16384);
        limits.max_alloc = Some(256 * 1024 * 1024);
        reader.limits(limits);
        let mut decoder = reader.into_decoder()?;
        let (width, height) = decoder.dimensions();
        check_image_size(width, height)?;
        let orientation = decoder
            .orientation()
            .unwrap_or(image::metadata::Orientation::NoTransforms);
        let mut bitmap = image::DynamicImage::from_decoder(decoder)?;
        bitmap.apply_orientation(orientation);
        Ok(bitmap)
    })();
    #[cfg(windows)]
    let decoded = decoded.or_else(|_| decode_windows_image(path));
    decoded.context(
        "Не удалось открыть изображение. Для HEIC может потребоваться кодек Windows HEIF/HEVC.",
    )
}

fn check_image_size(width: u32, height: u32) -> Result<()> {
    anyhow::ensure!(
        width > 0 && height > 0 && u64::from(width) * u64::from(height) <= 64_000_000,
        "Изображение слишком большое для просмотра."
    );
    Ok(())
}

#[cfg(windows)]
fn decode_windows_image(path: &Path) -> Result<image::DynamicImage> {
    use std::os::windows::ffi::OsStrExt;
    use windows::{
        Win32::{
            Foundation::GENERIC_READ,
            Graphics::Imaging::*,
            System::Com::{
                CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED, CoCreateInstance, CoInitializeEx,
                CoUninitialize,
            },
        },
        core::PCWSTR,
    };
    struct ComApartment;
    impl Drop for ComApartment {
        fn drop(&mut self) {
            // The matching initialization ran on this thread.
            unsafe { CoUninitialize() };
        }
    }
    let wide = path
        .as_os_str()
        .encode_wide()
        .chain([0])
        .collect::<Vec<_>>();
    // COM interfaces stay on this thread and are dropped before the apartment.
    unsafe {
        CoInitializeEx(None, COINIT_MULTITHREADED).ok()?;
        let _apartment = ComApartment;
        let factory: IWICImagingFactory =
            CoCreateInstance(&CLSID_WICImagingFactory, None, CLSCTX_INPROC_SERVER)?;
        let decoder = factory.CreateDecoderFromFilename(
            PCWSTR(wide.as_ptr()),
            None,
            GENERIC_READ,
            WICDecodeMetadataCacheOnDemand,
        )?;
        let frame = decoder.GetFrame(0)?;
        let (mut width, mut height) = (0, 0);
        frame.GetSize(&mut width, &mut height)?;
        check_image_size(width, height)?;
        let converter = factory.CreateFormatConverter()?;
        converter.Initialize(
            &frame,
            &GUID_WICPixelFormat32bppRGBA,
            WICBitmapDitherTypeNone,
            None::<&IWICPalette>,
            0.0,
            WICBitmapPaletteTypeCustom,
        )?;
        let mut pixels = vec![0; (width * height * 4) as usize];
        converter.CopyPixels(std::ptr::null(), width * 4, &mut pixels)?;
        let bitmap = image::RgbaImage::from_raw(width, height, pixels)
            .context("Недоступны пиксели изображения.")?;
        Ok(image::DynamicImage::ImageRgba8(bitmap))
    }
}

pub fn preview_image(path: &Path, full: bool) -> Result<(&'static str, Vec<u8>)> {
    let bitmap = decode_image(path)?;
    let bitmap = if full && bitmap.width().max(bitmap.height()) > 1920 {
        bitmap.resize(1920, 1920, image::imageops::FilterType::Triangle)
    } else if !full && (bitmap.width() > 320 || bitmap.height() > 220) {
        bitmap.thumbnail(320, 220)
    } else {
        bitmap
    };
    let mut output = std::io::Cursor::new(Vec::new());
    if bitmap.color().has_alpha() && bitmap.to_rgba8().pixels().any(|pixel| pixel[3] != 255) {
        bitmap.write_to(&mut output, image::ImageFormat::Png)?;
        // Base64 is carried over the Hub worker's 8 MiB JSON-RPC line limit.
        if output.get_ref().len() > 5 * 1024 * 1024 {
            output = std::io::Cursor::new(Vec::new());
            bitmap
                .thumbnail(1024, 1024)
                .write_to(&mut output, image::ImageFormat::Png)?;
        }
        Ok(("image/png", output.into_inner()))
    } else {
        image::codecs::jpeg::JpegEncoder::new_with_quality(&mut output, 88)
            .encode_image(&bitmap.into_rgb8())?;
        Ok(("image/jpeg", output.into_inner()))
    }
}

pub fn image_url(path: &Path, full: bool) -> Result<String> {
    let (mime, bytes) = preview_image(path, full)?;
    Ok(format!("data:{mime};base64,{}", STANDARD.encode(bytes)))
}

pub fn copy_image(path: &Path) -> Result<()> {
    let rgba = decode_image(path)?.into_rgba8();
    arboard::Clipboard::new()?.set_image(arboard::ImageData {
        width: rgba.width() as usize,
        height: rgba.height() as usize,
        bytes: rgba.into_raw().into(),
    })?;
    Ok(())
}
