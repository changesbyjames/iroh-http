//! A Rust peer implementing the shared conformance API from `e2e/api.ts`.
//!
//! Prints a dialable ticket on the first line of stdout, then serves until
//! stdin closes. The TypeScript end-to-end suite drives this binary to prove
//! that the Rust and TypeScript implementations of `SPEC.md` interoperate.
//!
//! Relays are disabled so the suite runs offline: the ticket carries only the
//! direct addresses known at bind time (the host's interface addresses, with
//! loopback as a fallback), which the Node peers on the same machine can dial.

use std::convert::Infallible;

use bytes::Bytes;

use http::{Request, Response, StatusCode, header};
use http_body_util::BodyExt;
use iroh::{Endpoint, endpoint::presets};
use iroh_http::{ALPN, Body, PeerInfo, serve};
use iroh_tickets::endpoint::EndpointTicket;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let endpoint = Endpoint::builder(presets::N0DisableRelay)
        .alpns(vec![ALPN.to_vec()])
        .bind()
        .await?;

    println!("{}", EndpointTicket::new(endpoint.addr()));

    let serving = n0_future::task::spawn(serve(endpoint, tower::service_fn(handle)));

    // Exit when the parent test closes stdin.
    let mut line = String::new();
    let _ = std::io::stdin().read_line(&mut line);
    serving.abort();
    Ok(())
}

fn query(request: &Request<Body>, key: &str) -> Option<String> {
    request.uri().query().and_then(|query| {
        query.split('&').find_map(|pair| {
            let (name, value) = pair.split_once('=')?;
            (name == key).then(|| value.to_owned())
        })
    })
}

#[expect(clippy::too_many_lines, reason = "a flat routing table reads better")]
async fn handle(request: Request<Body>) -> Result<Response<Body>, Infallible> {
    let path = request.uri().path().to_owned();

    let response = match path.as_str() {
        "/ping" => Response::builder()
            .header(header::CONTENT_TYPE, "text/plain")
            .body(Body::once("pong")),

        // Echoes the request body back, proving streamed uploads arrive intact.
        "/echo" => {
            if let Some(message) = query(&request, "msg") {
                Response::builder().body(Body::once(message))
            } else {
                let bytes = request
                    .into_body()
                    .collect()
                    .await
                    .map_or_else(|_| Bytes::new(), http_body_util::Collected::to_bytes);
                Response::builder().body(Body::once(bytes))
            }
        }

        // Reflects the received header list, in order, as JSON.
        "/headers" => {
            let pairs: Vec<[String; 2]> = request
                .headers()
                .iter()
                .map(|(name, value)| {
                    [
                        name.as_str().to_owned(),
                        value.to_str().unwrap_or_default().to_owned(),
                    ]
                })
                .collect();
            Response::builder()
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::once(
                    serde_json::to_vec(&pairs).unwrap_or_else(|_| b"[]".to_vec()),
                ))
        }

        // Reports the authenticated caller, which no header could prove.
        "/peer" => {
            let id = request
                .extensions()
                .get::<PeerInfo>()
                .map(|peer| peer.endpoint_id.to_string())
                .unwrap_or_default();
            Response::builder().body(Body::once(id))
        }

        // Reports the URI the server reconstructed, authority included.
        "/uri" => Response::builder().body(Body::once(request.uri().to_string())),

        // Two distinct set-cookie values, which a header map must not join.
        "/cookies" => Response::builder()
            .header(header::SET_COOKIE, "first=1")
            .header(header::SET_COOKIE, "second=2")
            .body(Body::once("ok")),

        // An arbitrary status code, with and without a body.
        "/status" => {
            let code = query(&request, "code")
                .and_then(|code| code.parse::<u16>().ok())
                .unwrap_or(200);
            let status = StatusCode::from_u16(code).unwrap_or(StatusCode::OK);
            let body = if matches!(code, 204 | 205 | 304) {
                Body::empty()
            } else {
                Body::once("body")
            };
            Response::builder().status(status).body(body)
        }

        // A chunked body delivered over time, exercising streamed downloads.
        "/stream" => {
            let count = query(&request, "chunks")
                .and_then(|count| count.parse::<usize>().ok())
                .unwrap_or(3);
            let (sender, body) = Body::channel(1);
            n0_future::task::spawn(async move {
                for index in 0..count {
                    if sender.send(format!("chunk-{index};")).await.is_err() {
                        return;
                    }
                }
            });
            Response::builder()
                .header(header::CONTENT_TYPE, "text/plain")
                .body(body)
        }

        // A body larger than MAX_CHUNK_SIZE, forcing multi-frame transfer.
        "/large" => {
            let size = query(&request, "bytes")
                .and_then(|size| size.parse::<usize>().ok())
                .unwrap_or(3 * 1024 * 1024);
            Response::builder().body(Body::once(vec![b'x'; size]))
        }

        // Fails after the head is committed, exercising the ERROR body frame.
        "/fail-midway" => {
            let (sender, body) = Body::channel(1);
            n0_future::task::spawn(async move {
                if sender.send("partial").await.is_ok() {
                    sender
                        .fail(iroh_http::Error::Body("deliberate failure".to_owned()))
                        .await;
                }
            });
            Response::builder().status(StatusCode::OK).body(body)
        }

        _ => Response::builder()
            .status(StatusCode::NOT_FOUND)
            .body(Body::once("not found")),
    };

    Ok(response.unwrap_or_else(|_| {
        Response::builder()
            .status(StatusCode::INTERNAL_SERVER_ERROR)
            .body(Body::once("build failed"))
            .expect("a minimal response always builds")
    }))
}
