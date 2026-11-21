use crate::server::App;
use axum::{
    Router,
    http::header,
    response::{IntoResponse, Response},
    routing::get,
};

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
        "/icon-192.png" => "icon-192.png", "image/png";
        "/icon-512.png" => "icon-512.png", "image/png";
    }
}
