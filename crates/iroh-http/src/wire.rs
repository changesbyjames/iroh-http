//! Framing for the `iroh-http/1` wire protocol.
//!
//! This module is the Rust half of `SPEC.md`. Every constant and validation
//! rule here has a counterpart in `packages/shared/src/wire.ts`.

use bytes::Bytes;
use http::{
    HeaderMap, HeaderName, HeaderValue, Method, Request, Response, StatusCode, Uri,
    header::{HeaderName as Name, InvalidHeaderName, InvalidHeaderValue},
};
use http_body::Body as HttpBody;
use http_body_util::BodyExt;
use iroh::endpoint::{RecvStream, SendStream, VarInt};
use serde::{Deserialize, Serialize};

use crate::{Body, Error, PeerInfo};

/// ALPN used by every HTTP over Iroh endpoint.
pub const ALPN: &[u8] = b"iroh-http/1";

/// Byte length of the head frame's length prefix.
pub const HEAD_PREFIX_SIZE: usize = 4;
/// Byte length of a body frame header: one tag byte and a `u32` length.
pub const BODY_PREFIX_SIZE: usize = 5;
/// Maximum encoded head frame size, in bytes.
pub const MAX_HEAD_SIZE: usize = 1024 * 1024;
/// Maximum body frame payload size, in bytes.
pub const MAX_CHUNK_SIZE: usize = 1024 * 1024;
/// QUIC error code used to reset a stream or close a connection.
pub const ERROR_CODE: VarInt = VarInt::from_u32(1);

/// Body frame tag for a data chunk.
pub const TAG_DATA: u8 = 0x00;
/// Body frame tag for a clean end of body.
pub const TAG_END: u8 = 0x01;
/// Body frame tag for a body that failed mid-stream.
pub const TAG_ERROR: u8 = 0x02;

/// Synthetic origin suffix used to build absolute request URIs.
pub const ORIGIN_SUFFIX: &str = ".iroh";

/// Headers that describe a single hop and must never cross the wire.
const HOP_BY_HOP: [&str; 5] = [
    "connection",
    "keep-alive",
    "proxy-connection",
    "transfer-encoding",
    "upgrade",
];

fn is_hop_by_hop(name: &Name) -> bool {
    HOP_BY_HOP.contains(&name.as_str())
}

#[derive(Serialize, Deserialize)]
struct RequestHead {
    method: String,
    target: String,
    headers: Vec<(String, String)>,
}

#[derive(Serialize, Deserialize)]
struct ResponseHead {
    status: u16,
    headers: Vec<(String, String)>,
}

fn encode_headers(headers: &HeaderMap) -> Vec<(String, String)> {
    headers
        .iter()
        .filter(|(name, _)| !is_hop_by_hop(name))
        .filter_map(|(name, value)| {
            // A value that is not valid UTF-8 cannot be represented in JSON.
            // Dropping it is preferable to failing the whole exchange.
            value
                .to_str()
                .ok()
                .map(|value| (name.as_str().to_owned(), value.to_owned()))
        })
        .collect()
}

fn decode_headers(pairs: Vec<(String, String)>) -> Result<HeaderMap, Error> {
    let mut headers = HeaderMap::with_capacity(pairs.len());
    for (name, value) in pairs {
        let name = HeaderName::try_from(name.to_ascii_lowercase())
            .map_err(|error: InvalidHeaderName| Error::http(error))?;
        if is_hop_by_hop(&name) {
            continue;
        }
        let value =
            HeaderValue::try_from(value).map_err(|error: InvalidHeaderValue| Error::http(error))?;
        headers.append(name, value);
    }
    Ok(headers)
}

/// True for methods that cannot carry a body.
fn is_bodyless(method: &Method) -> bool {
    *method == Method::GET || *method == Method::HEAD
}

async fn write_all(send: &mut SendStream, bytes: &[u8]) -> Result<(), Error> {
    send.write_all(bytes).await.map_err(Error::transport)
}

async fn read_exact(recv: &mut RecvStream, size: usize) -> Result<Vec<u8>, Error> {
    let mut buffer = vec![0_u8; size];
    recv.read_exact(&mut buffer)
        .await
        .map_err(Error::transport)?;
    Ok(buffer)
}

/// Encode a frame payload length as the big-endian `u32` both frame kinds use.
///
/// Callers bound `length` by [`MAX_HEAD_SIZE`] or [`MAX_CHUNK_SIZE`], both of
/// which fit in a `u32`.
fn length_prefix(length: usize) -> [u8; 4] {
    u32::try_from(length)
        .expect("frame lengths are bounded well below u32::MAX")
        .to_be_bytes()
}

async fn write_head<T: Serialize>(send: &mut SendStream, head: &T) -> Result<(), Error> {
    let payload = serde_json::to_vec(head).map_err(Error::http)?;
    if payload.len() > MAX_HEAD_SIZE {
        return Err(Error::protocol(format!(
            "head frame exceeds {MAX_HEAD_SIZE} bytes"
        )));
    }

    let mut frame = Vec::with_capacity(HEAD_PREFIX_SIZE + payload.len());
    frame.extend_from_slice(&length_prefix(payload.len()));
    frame.extend_from_slice(&payload);
    write_all(send, &frame).await
}

async fn read_head<T: for<'de> Deserialize<'de>>(recv: &mut RecvStream) -> Result<T, Error> {
    let prefix = read_exact(recv, HEAD_PREFIX_SIZE).await?;
    let length = u32::from_be_bytes([prefix[0], prefix[1], prefix[2], prefix[3]]) as usize;
    if length > MAX_HEAD_SIZE {
        return Err(Error::protocol(format!(
            "head frame exceeds {MAX_HEAD_SIZE} bytes"
        )));
    }

    let payload = read_exact(recv, length).await?;
    serde_json::from_slice(&payload)
        .map_err(|error| Error::protocol(format!("head frame is not valid JSON: {error}")))
}

async fn write_frame(send: &mut SendStream, tag: u8, payload: &[u8]) -> Result<(), Error> {
    let mut frame = Vec::with_capacity(BODY_PREFIX_SIZE + payload.len());
    frame.push(tag);
    frame.extend_from_slice(&length_prefix(payload.len()));
    frame.extend_from_slice(payload);
    write_all(send, &frame).await
}

/// Truncate an `ERROR` message on a char boundary to the spec's 1 MiB frame limit.
fn error_payload(message: &str) -> &[u8] {
    &message.as_bytes()[..message.floor_char_boundary(MAX_CHUNK_SIZE)]
}

/// Stream a body as body frames, terminating with `END` or `ERROR`.
///
/// The send side is finished either way, per `SPEC.md`.
async fn write_body<B>(send: &mut SendStream, body: B) -> Result<(), Error>
where
    B: HttpBody<Data = Bytes>,
    B::Error: std::fmt::Display,
{
    let mut body = std::pin::pin!(body);
    let mut failure = None;

    while let Some(frame) = body.frame().await {
        match frame {
            // Trailers are not expressible in version 1 and are dropped.
            Ok(frame) => {
                if let Ok(data) = frame.into_data() {
                    for chunk in data.chunks(MAX_CHUNK_SIZE) {
                        write_frame(send, TAG_DATA, chunk).await?;
                    }
                }
            }
            Err(error) => {
                failure = Some(error.to_string());
                break;
            }
        }
    }

    // The head is already committed, so a body failure travels in-band.
    match failure {
        Some(message) => write_frame(send, TAG_ERROR, error_payload(&message)).await?,
        None => write_frame(send, TAG_END, &[]).await?,
    }

    send.finish().map_err(Error::transport)?;
    Ok(())
}

/// Read one body frame, returning `None` at a clean `END`.
async fn read_body_frame(recv: &mut RecvStream) -> Result<Option<Bytes>, Error> {
    let header = read_exact(recv, BODY_PREFIX_SIZE).await?;
    let tag = header[0];
    let length = u32::from_be_bytes([header[1], header[2], header[3], header[4]]) as usize;

    if tag == TAG_END {
        return if length == 0 {
            Ok(None)
        } else {
            Err(Error::protocol("END frame must have zero length"))
        };
    }

    if length > MAX_CHUNK_SIZE {
        return Err(Error::protocol(format!(
            "body frame exceeds {MAX_CHUNK_SIZE} bytes"
        )));
    }

    match tag {
        TAG_ERROR => {
            let message = String::from_utf8_lossy(&read_exact(recv, length).await?).into_owned();
            Err(Error::RemoteBody(message))
        }
        TAG_DATA => Ok(Some(Bytes::from(read_exact(recv, length).await?))),
        other => Err(Error::protocol(format!("unknown body frame tag {other}"))),
    }
}

/// Consume the body frames of a message that cannot carry a body.
///
/// Reading the terminal frame, rather than resetting, leaves the peer's write
/// of `END` succeeding and keeps the exchange a clean close on both sides.
async fn drain_body(recv: &mut RecvStream) -> Result<(), Error> {
    while read_body_frame(recv).await?.is_some() {}
    Ok(())
}

/// Read body frames into a [`Body`], surfacing `ERROR` as a failure.
fn read_body(mut recv: RecvStream) -> Body {
    let (sender, body) = Body::channel(4);
    let sender = sender.into_inner();
    n0_future::task::spawn(async move {
        loop {
            match read_body_frame(&mut recv).await {
                Ok(None) => break,
                // A zero-length DATA frame is legal but carries no data.
                Ok(Some(chunk)) if chunk.is_empty() => {}
                Ok(Some(chunk)) => {
                    if sender.send(Ok(chunk)).await.is_err() {
                        // The consumer dropped the body; abandon the read side.
                        let _ = recv.stop(ERROR_CODE);
                        break;
                    }
                }
                Err(error) => {
                    let _ = sender.send(Err(error)).await;
                    break;
                }
            }
        }
    });
    body
}

/// Write a request head and body to a stream.
pub(crate) async fn write_request<B>(
    send: &mut SendStream,
    request: Request<B>,
) -> Result<(), Error>
where
    B: HttpBody<Data = Bytes>,
    B::Error: std::fmt::Display,
{
    let (parts, body) = request.into_parts();
    let target = parts
        .uri
        .path_and_query()
        .map_or_else(|| parts.uri.path().to_owned(), ToString::to_string);

    write_head(
        send,
        &RequestHead {
            method: parts.method.as_str().to_owned(),
            target,
            headers: encode_headers(&parts.headers),
        },
    )
    .await?;

    if is_bodyless(&parts.method) {
        return write_body(send, Body::empty()).await;
    }
    write_body(send, body).await
}

/// Read a request head and body from a stream.
///
/// The peer is attached as a [`PeerInfo`] extension, and is also the URI
/// authority, so that a handler can identify its caller from the request alone.
pub(crate) async fn read_request(
    mut recv: RecvStream,
    peer: PeerInfo,
) -> Result<Request<Body>, Error> {
    let head: RequestHead = read_head(&mut recv).await?;

    if !head.target.starts_with('/') {
        return Err(Error::protocol(
            "request target must be an origin-form path",
        ));
    }

    let method = Method::try_from(head.method.as_str()).map_err(Error::http)?;
    let uri = Uri::try_from(format!(
        "http://{}{ORIGIN_SUFFIX}{}",
        peer.endpoint_id, head.target
    ))
    .map_err(Error::http)?;

    let headers = decode_headers(head.headers)?;

    let body = if is_bodyless(&method) {
        drain_body(&mut recv).await?;
        Body::empty()
    } else {
        read_body(recv)
    };

    let mut request = Request::new(body);
    *request.method_mut() = method;
    *request.uri_mut() = uri;
    *request.headers_mut() = headers;
    request.extensions_mut().insert(peer);
    Ok(request)
}

/// Write a response head and body to a stream.
pub(crate) async fn write_response<B>(
    send: &mut SendStream,
    response: Response<B>,
) -> Result<(), Error>
where
    B: HttpBody<Data = Bytes>,
    B::Error: std::fmt::Display,
{
    let (parts, body) = response.into_parts();
    write_head(
        send,
        &ResponseHead {
            status: parts.status.as_u16(),
            headers: encode_headers(&parts.headers),
        },
    )
    .await?;
    write_body(send, body).await
}

/// Read a response head and body from a stream.
pub(crate) async fn read_response(mut recv: RecvStream) -> Result<Response<Body>, Error> {
    let head: ResponseHead = read_head(&mut recv).await?;

    if !(200..=599).contains(&head.status) {
        // Informational responses are not expressible in version 1.
        return Err(Error::protocol(format!(
            "response status {} is out of range 200-599",
            head.status
        )));
    }

    let status = StatusCode::from_u16(head.status).map_err(Error::http)?;
    let headers = decode_headers(head.headers)?;

    let mut response = Response::new(read_body(recv));
    *response.status_mut() = status;
    *response.headers_mut() = headers;
    Ok(response)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn error_payload_is_bounded_on_a_char_boundary() {
        // A 3-byte char straddling the limit is dropped whole.
        let message = format!("{}€", "a".repeat(MAX_CHUNK_SIZE - 1));
        let payload = error_payload(&message);
        assert_eq!(payload.len(), MAX_CHUNK_SIZE - 1);
        assert!(std::str::from_utf8(payload).is_ok());
        assert_eq!(error_payload("short"), b"short");
    }

    #[test]
    fn hop_by_hop_headers_are_dropped_in_both_directions() {
        let mut headers = HeaderMap::new();
        headers.insert("content-type", HeaderValue::from_static("text/plain"));
        headers.insert("connection", HeaderValue::from_static("keep-alive"));

        let encoded = encode_headers(&headers);
        assert_eq!(encoded, vec![("content-type".into(), "text/plain".into())]);

        let decoded = decode_headers(vec![
            ("Content-Type".into(), "text/plain".into()),
            ("Upgrade".into(), "websocket".into()),
        ])
        .expect("headers decode");
        assert_eq!(decoded.len(), 1);
        assert_eq!(decoded["content-type"], "text/plain");
    }

    #[test]
    fn repeated_headers_keep_every_value_and_their_order() {
        let decoded = decode_headers(vec![
            ("set-cookie".into(), "a=1".into()),
            ("set-cookie".into(), "b=2".into()),
        ])
        .expect("headers decode");

        let values: Vec<_> = decoded.get_all("set-cookie").iter().collect();
        assert_eq!(values, vec!["a=1", "b=2"]);
    }
}
