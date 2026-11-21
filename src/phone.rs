use crate::{
    net,
    server::{Api, App, WebHttp},
};
use axum::{
    Router,
    extract::{Extension, State},
    http::header,
    response::{Html, IntoResponse, Response},
    routing::get,
};
use base64::{Engine, engine::general_purpose::STANDARD};
use uuid::Uuid;

fn asset(mime: &'static str, bytes: &'static [u8]) -> Response {
    ([(header::CONTENT_TYPE, mime)], bytes).into_response()
}

macro_rules! files {
    ($($path:literal => $file:literal, $mime:literal);* $(;)?) => {{
        Router::new()$(.route($path, get(|| async { asset($mime, include_bytes!(concat!("../web/", $file))) })))*
    }};
}

pub fn routes() -> Router<App> {
    files! {
        "/" => "phone.html", "text/html; charset=utf-8";
        "/style.css" => "style.css", "text/css; charset=utf-8";
        "/phone.js" => "phone.js", "text/javascript; charset=utf-8";
        "/common.js" => "common.js", "text/javascript; charset=utf-8";
        "/manifest.webmanifest" => "manifest.webmanifest", "application/manifest+json";
        "/sw.js" => "sw.js", "text/javascript; charset=utf-8";
        "/icon-180.png" => "icon-180.png", "image/png";
        "/apple-touch-icon.png" => "icon-180.png", "image/png";
        "/apple-touch-icon-precomposed.png" => "icon-180.png", "image/png";
        "/icon-192.png" => "icon-192.png", "image/png";
        "/icon-512.png" => "icon-512.png", "image/png";
    }
    .route(
        "/join/{code}",
        get(|| async {
            asset(
                "text/html; charset=utf-8",
                include_bytes!("../web/phone.html"),
            )
        }),
    )
    .route("/ThodDrop-WebClip.mobileconfig", get(webclip))
    .merge(certificate_routes())
}

async fn webclip(
    State(app): State<App>,
    Extension(WebHttp(plain)): Extension<WebHttp>,
) -> Api<Response> {
    let (host, https) = {
        let db = app.db.lock().unwrap();
        (db.config.host, net::url(&db.config))
    };
    let url = if plain {
        app.phone_http_url.lock().unwrap().clone()
    } else {
        https
    };
    let url = url.ok_or_else(|| anyhow::anyhow!("Адрес ThodDrop пока недоступен."))?;
    let profile_id = Uuid::new_v5(&host, url.as_bytes());
    let payload_id = Uuid::new_v5(&profile_id, b"ThodDrop Web Clip");
    let icon = STANDARD.encode(include_bytes!("../web/icon-180.png"));
    let xml = format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>PayloadType</key><string>Configuration</string>
<key>PayloadVersion</key><integer>1</integer>
<key>PayloadUUID</key><string>{profile_id}</string>
<key>PayloadIdentifier</key><string>local.thoddrop.webclip.{profile_id}</string>
<key>PayloadDisplayName</key><string>Значок ThodDrop</string>
<key>PayloadContent</key><array><dict>
<key>PayloadType</key><string>com.apple.webClip.managed</string>
<key>PayloadVersion</key><integer>1</integer>
<key>PayloadUUID</key><string>{payload_id}</string>
<key>PayloadIdentifier</key><string>local.thoddrop.webclip.{profile_id}.icon</string>
<key>PayloadDisplayName</key><string>ThodDrop</string>
<key>Label</key><string>ThodDrop</string>
<key>URL</key><string>{url}/</string>
<key>Icon</key><data>{icon}</data>
<key>FullScreen</key><true/>
<key>IsRemovable</key><true/>
<key>Precomposed</key><true/>
</dict></array></dict></plist>"#
    );
    Ok((
        [(header::CONTENT_TYPE, "application/x-apple-aspen-config")],
        xml,
    )
        .into_response())
}

pub fn certificate_routes() -> Router<App> {
    Router::new()
        .route("/certificate", get(certificate_page))
        .route("/ThodDrop.cer", get(certificate))
        .route("/ThodDrop.mobileconfig", get(profile))
}

pub fn certificate_bootstrap() -> Router<App> {
    certificate_routes().merge(files! {
        "/style.css" => "style.css", "text/css; charset=utf-8";
    })
}

async fn certificate_page(State(app): State<App>) -> Api<Html<String>> {
    let config = &app.db.lock().unwrap().config;
    let url = net::url(config).unwrap_or_default();
    Ok(Html(
        include_str!("../web/certificate.html")
            .replace("{HTTPS_URL}", &url)
            .replace("{FINGERPRINT}", &app.ca.fingerprint()?),
    ))
}

async fn certificate(State(app): State<App>) -> Api<Response> {
    Ok((
        [
            (header::CONTENT_TYPE, "application/x-x509-ca-cert"),
            (
                header::CONTENT_DISPOSITION,
                "attachment; filename=ThodDrop.cer",
            ),
        ],
        app.ca.der()?,
    )
        .into_response())
}

async fn profile(State(app): State<App>) -> Api<Response> {
    let host = app.db.lock().unwrap().config.host;
    let payload = Uuid::new_v5(&host, b"ThodDrop root certificate");
    let data = STANDARD.encode(app.ca.der()?);
    let xml = format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>PayloadType</key><string>Configuration</string>
<key>PayloadVersion</key><integer>1</integer>
<key>PayloadIdentifier</key><string>local.thoddrop.{host}</string>
<key>PayloadUUID</key><string>{host}</string>
<key>PayloadDisplayName</key><string>ThodDrop</string>
<key>PayloadContent</key><array><dict>
<key>PayloadType</key><string>com.apple.security.root</string>
<key>PayloadVersion</key><integer>1</integer>
<key>PayloadIdentifier</key><string>local.thoddrop.{host}.root</string>
<key>PayloadUUID</key><string>{payload}</string>
<key>PayloadDisplayName</key><string>ThodDrop CA</string>
<key>PayloadCertificateFileName</key><string>ThodDrop.cer</string>
<key>PayloadContent</key><data>{data}</data>
</dict></array></dict></plist>"#
    );
    // Safari recognizes configuration profiles by MIME type and extension.
    Ok((
        [(header::CONTENT_TYPE, "application/x-apple-aspen-config")],
        xml,
    )
        .into_response())
}
