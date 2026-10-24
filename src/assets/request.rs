use std::path::Path;

use gtk4::{gio::MemoryInputStream, glib::Bytes};
use webkit6::{
    URISchemeRequest, URISchemeResponse,
    soup::{MessageHeaders, MessageHeadersType},
};

use super::{mime::mime_type, path, rewrite::rewrite, scheme::Scheme};

pub(super) fn serve(request: &URISchemeRequest, project_dir: &Path, scheme: Scheme) {
    let request_path = request.path().unwrap_or_default();
    let file_path = path::resolve(project_dir, &request_path, scheme);
    let response = match std::fs::read(&file_path) {
        Ok(contents) => asset_response(&file_path, contents),
        Err(error) => {
            eprintln!(
                "{} request failed for {}: {error}",
                scheme.name(),
                file_path.display()
            );
            error_response(&file_path, &error)
        }
    };
    request.finish_with_response(&response);
}

fn asset_response(path: &Path, contents: Vec<u8>) -> URISchemeResponse {
    let response = response(rewrite(path, contents), mime_type(path));
    let headers = MessageHeaders::new(MessageHeadersType::Response);
    headers.append("Access-Control-Allow-Origin", "vsc-light://app");
    headers.append("Vary", "Origin");
    response.set_http_headers(headers);
    response
}

fn error_response(path: &Path, error: &std::io::Error) -> URISchemeResponse {
    let message = format!("Unable to load {}: {error}", path.display());
    let response = response(message.into_bytes(), "text/plain; charset=utf-8");
    response.set_status(404, Some("Not Found"));
    response
}

fn response(contents: Vec<u8>, content_type: &str) -> URISchemeResponse {
    let bytes = Bytes::from_owned(contents);
    let stream = MemoryInputStream::from_bytes(&bytes);
    let response = URISchemeResponse::new(&stream, bytes.len() as i64);
    response.set_content_type(content_type);
    response
}
