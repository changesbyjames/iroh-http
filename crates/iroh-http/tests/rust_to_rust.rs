//! Rust-to-Rust coverage over real Iroh endpoints.
//!
//! Relays and discovery are disabled so that the suite runs offline over the
//! loopback path.

use std::convert::Infallible;

use http::{Request, Response, StatusCode};
use http_body_util::BodyExt;
use iroh::{
    Endpoint,
    endpoint::{Connection, presets},
};
use iroh_http::{ALPN, Body, Client, PeerInfo, serve_connection};

async fn bind() -> Endpoint {
    Endpoint::builder(presets::N0DisableRelay)
        .alpns(vec![ALPN.to_vec()])
        .bind()
        .await
        .expect("endpoint binds")
}

/// Bind a server serving `service`, and return a client connected to it.
///
/// The server endpoint is moved into the accept task, which keeps it alive for
/// as long as the returned client is usable.
async fn pair<S, E>(service: S) -> (Endpoint, Client)
where
    S: tower::Service<Request<Body>, Response = Response<Body>, Error = E> + Clone + Send + 'static,
    S::Future: Send,
    E: std::fmt::Display + Send + 'static,
{
    let server = bind().await;
    let address = server.addr();

    n0_future::task::spawn(async move {
        let Some(incoming) = server.accept().await else {
            return;
        };
        let connection: Connection = incoming.await.expect("handshake completes");
        serve_connection(connection, service).await;
    });

    let endpoint = bind().await;
    let client = Client::connect(&endpoint, address)
        .await
        .expect("client connects");
    (endpoint, client)
}

async fn text(response: Response<Body>) -> String {
    let bytes = response
        .into_body()
        .collect()
        .await
        .expect("body completes")
        .to_bytes();
    String::from_utf8_lossy(&bytes).into_owned()
}

#[tokio::test]
async fn get_round_trips_status_headers_and_body() {
    let (_endpoint, client) = pair(tower::service_fn(|request: Request<Body>| async move {
        assert_eq!(request.uri().path(), "/hello");
        assert_eq!(request.uri().query(), Some("name=world"));
        assert_eq!(request.headers()["x-probe"], "1");

        Ok::<_, Infallible>(
            Response::builder()
                .status(StatusCode::CREATED)
                .header("content-type", "text/plain")
                .header("set-cookie", "a=1")
                .header("set-cookie", "b=2")
                .body(Body::once("hello world"))
                .expect("response builds"),
        )
    }))
    .await;

    let response = client
        .fetch(
            Request::get("/hello?name=world")
                .header("x-probe", "1")
                .body(Body::empty())
                .expect("request builds"),
        )
        .await
        .expect("request succeeds");

    assert_eq!(response.status(), StatusCode::CREATED);
    assert_eq!(response.headers()["content-type"], "text/plain");

    let cookies: Vec<_> = response.headers().get_all("set-cookie").iter().collect();
    assert_eq!(cookies, vec!["a=1", "b=2"], "repeated headers survive");

    assert_eq!(text(response).await, "hello world");
}

#[tokio::test]
async fn request_bodies_larger_than_one_frame_reach_the_handler() {
    let (_endpoint, client) = pair(tower::service_fn(|request: Request<Body>| async move {
        let body = request
            .into_body()
            .collect()
            .await
            .expect("body completes")
            .to_bytes();
        Ok::<_, Infallible>(Response::new(Body::once(body.len().to_string())))
    }))
    .await;

    // Larger than MAX_CHUNK_SIZE, so the sender must split it across frames.
    let payload = "x".repeat(3 * 1024 * 1024);
    let response = client
        .fetch(
            Request::post("/upload")
                .body(Body::once(payload.clone()))
                .expect("request builds"),
        )
        .await
        .expect("request succeeds");

    assert_eq!(text(response).await, payload.len().to_string());
}

#[tokio::test]
async fn peer_identity_is_available_to_handlers() {
    let (endpoint, client) = pair(tower::service_fn(|request: Request<Body>| async move {
        let peer = request
            .extensions()
            .get::<PeerInfo>()
            .expect("peer info present");
        Ok::<_, Infallible>(Response::new(Body::once(peer.endpoint_id.to_string())))
    }))
    .await;

    let response = client
        .fetch(Request::get("/who").body(Body::empty()).expect("builds"))
        .await
        .expect("request succeeds");

    assert_eq!(
        text(response).await,
        endpoint.id().to_string(),
        "the handler sees the dialling endpoint's authenticated id"
    );
}

#[tokio::test]
async fn the_request_uri_authority_is_the_caller() {
    let (endpoint, client) = pair(tower::service_fn(|request: Request<Body>| async move {
        Ok::<_, Infallible>(Response::new(Body::once(
            request.uri().host().unwrap_or_default().to_owned(),
        )))
    }))
    .await;

    let response = client
        .fetch(Request::get("/host").body(Body::empty()).expect("builds"))
        .await
        .expect("request succeeds");

    assert_eq!(text(response).await, format!("{}.iroh", endpoint.id()));
}

#[tokio::test]
async fn concurrent_requests_share_one_connection() {
    let (_endpoint, client) = pair(tower::service_fn(|request: Request<Body>| async move {
        let path = request.uri().path().to_owned();
        Ok::<_, Infallible>(Response::new(Body::once(path)))
    }))
    .await;

    let mut tasks = Vec::new();
    for index in 0..16 {
        let client = client.clone();
        tasks.push(n0_future::task::spawn(async move {
            let response = client
                .fetch(
                    Request::get(format!("/item/{index}"))
                        .body(Body::empty())
                        .expect("builds"),
                )
                .await
                .expect("request succeeds");
            text(response).await
        }));
    }

    for (index, task) in tasks.into_iter().enumerate() {
        assert_eq!(task.await.expect("task joins"), format!("/item/{index}"));
    }
}

#[tokio::test]
async fn a_service_error_becomes_a_500() {
    #[derive(Debug)]
    struct Failed;
    impl std::fmt::Display for Failed {
        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            f.write_str("failed")
        }
    }

    let (_endpoint, client) = pair(tower::service_fn(|_: Request<Body>| async move {
        Err::<Response<Body>, Failed>(Failed)
    }))
    .await;

    let response = client
        .fetch(Request::get("/boom").body(Body::empty()).expect("builds"))
        .await
        .expect("request succeeds");

    assert_eq!(response.status(), StatusCode::INTERNAL_SERVER_ERROR);
    assert_eq!(text(response).await, "Internal Server Error");
}

#[tokio::test]
async fn a_status_without_a_body_round_trips() {
    let (_endpoint, client) = pair(tower::service_fn(|_: Request<Body>| async move {
        Ok::<_, Infallible>(
            Response::builder()
                .status(StatusCode::NO_CONTENT)
                .body(Body::empty())
                .expect("builds"),
        )
    }))
    .await;

    let response = client
        .fetch(
            Request::get("/nothing")
                .body(Body::empty())
                .expect("builds"),
        )
        .await
        .expect("request succeeds");

    assert_eq!(response.status(), StatusCode::NO_CONTENT);
    assert_eq!(text(response).await, "");
}

#[tokio::test]
async fn a_body_that_fails_mid_stream_surfaces_as_an_error() {
    use std::{
        pin::Pin,
        task::{Context, Poll},
    };

    use bytes::Bytes;
    use http_body::Frame;

    /// Emits one chunk, then fails, exercising the `ERROR` body frame.
    struct Flaky(bool);

    impl http_body::Body for Flaky {
        type Data = Bytes;
        type Error = String;

        fn poll_frame(
            mut self: Pin<&mut Self>,
            _cx: &mut Context<'_>,
        ) -> Poll<Option<Result<Frame<Bytes>, Self::Error>>> {
            if self.0 {
                Poll::Ready(Some(Err("disk went away".to_owned())))
            } else {
                self.0 = true;
                Poll::Ready(Some(Ok(Frame::data(Bytes::from_static(b"partial")))))
            }
        }
    }

    let server = bind().await;
    let address = server.addr();

    n0_future::task::spawn(async move {
        let Some(incoming) = server.accept().await else {
            return;
        };
        let connection = incoming.await.expect("handshake completes");
        serve_connection(
            connection,
            tower::service_fn(|_: Request<Body>| async move {
                Ok::<_, Infallible>(Response::new(Flaky(false)))
            }),
        )
        .await;
    });

    let endpoint = bind().await;
    let client = Client::connect(&endpoint, address)
        .await
        .expect("client connects");

    let response = client
        .fetch(Request::get("/flaky").body(Body::empty()).expect("builds"))
        .await
        .expect("the head arrives before the body fails");

    assert_eq!(response.status(), StatusCode::OK);

    let error = response
        .into_body()
        .collect()
        .await
        .expect_err("the body must fail rather than end cleanly");

    assert!(
        error.to_string().contains("disk went away"),
        "the remote message is preserved: {error}"
    );
}

#[tokio::test]
async fn readiness_aware_middleware_is_polled_before_being_called() {
    use std::time::Duration;

    use tower::limit::ConcurrencyLimitLayer;

    // `ConcurrencyLimit` panics with "service not ready; poll_ready must be
    // called first" if a caller invokes `call` without awaiting readiness, so
    // this suite fails loudly if the server ever regresses to a bare `call`.
    let service = tower::ServiceBuilder::new()
        .layer(ConcurrencyLimitLayer::new(2))
        .service(tower::service_fn(|request: Request<Body>| async move {
            // Held long enough that requests genuinely contend for a permit.
            tokio::time::sleep(Duration::from_millis(20)).await;
            let path = request.uri().path().to_owned();
            Ok::<_, Infallible>(Response::new(Body::once(path)))
        }));

    let (_endpoint, client) = pair(service).await;

    let mut tasks = Vec::new();
    for index in 0..8 {
        let client = client.clone();
        tasks.push(n0_future::task::spawn(async move {
            let response = client
                .fetch(
                    Request::get(format!("/limited/{index}"))
                        .body(Body::empty())
                        .expect("builds"),
                )
                .await
                .expect("request succeeds despite the concurrency limit");
            text(response).await
        }));
    }

    for (index, task) in tasks.into_iter().enumerate() {
        assert_eq!(
            task.await.expect("task joins"),
            format!("/limited/{index}"),
            "every request completes rather than panicking the service"
        );
    }
}
