//! The server side of HTTP over Iroh.

use bytes::Bytes;
use http::{Request, Response, StatusCode};
use http_body::Body as HttpBody;
use iroh::{
    Endpoint, EndpointId,
    endpoint::{Connection, RecvStream, SendStream},
};
use tower::{Service, ServiceExt};

use crate::{Body, wire};

/// Identity of the peer on the other end of an exchange.
///
/// Inserted into every served request's extensions. Unlike an HTTP header this
/// cannot be spoofed: it is the endpoint id QUIC authenticated during the
/// handshake, available before the first byte of the request is read.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PeerInfo {
    /// The remote Iroh endpoint id.
    pub endpoint_id: EndpointId,
}

/// Serve `service` on `endpoint` until the endpoint is closed.
///
/// Every accepted connection is handled concurrently, and every bidirectional
/// stream on a connection is one independent request.
pub async fn serve<S, B>(endpoint: Endpoint, service: S)
where
    S: Service<Request<Body>, Response = Response<B>> + Clone + Send + 'static,
    S::Error: std::fmt::Display + Send,
    S::Future: Send,
    B: HttpBody<Data = Bytes> + Send + 'static,
    B::Error: std::fmt::Display + Send,
{
    while let Some(incoming) = endpoint.accept().await {
        let service = service.clone();
        n0_future::task::spawn(async move {
            // A failed handshake only rejects that incoming connection.
            if let Ok(connection) = incoming.await {
                serve_connection(connection, service).await;
            }
        });
    }
}

/// Serve every exchange on one already-accepted connection.
pub async fn serve_connection<S, B>(connection: Connection, service: S)
where
    S: Service<Request<Body>, Response = Response<B>> + Clone + Send + 'static,
    S::Error: std::fmt::Display + Send,
    S::Future: Send,
    B: HttpBody<Data = Bytes> + Send + 'static,
    B::Error: std::fmt::Display + Send,
{
    let peer = PeerInfo {
        endpoint_id: connection.remote_id(),
    };

    // Accept exchanges until the peer stops opening streams or goes away.
    while let Ok((send, recv)) = connection.accept_bi().await {
        let service = service.clone();
        let peer = peer.clone();
        n0_future::task::spawn(async move {
            serve_exchange(send, recv, service, peer).await;
        });
    }
}

/// Serve one exchange: read the request, run the service, write the response.
async fn serve_exchange<S, B>(mut send: SendStream, recv: RecvStream, service: S, peer: PeerInfo)
where
    S: Service<Request<Body>, Response = Response<B>>,
    S::Error: std::fmt::Display + Send,
    B: HttpBody<Data = Bytes> + Send + 'static,
    B::Error: std::fmt::Display + Send,
{
    let Ok(request) = wire::read_request(recv, peer).await else {
        // The request could not be parsed, so no status can be attributed to
        // it. Resetting is the only honest signal.
        let _ = send.reset(wire::ERROR_CODE);
        return;
    };

    // `oneshot` awaits readiness before calling, which the `tower::Service`
    // contract requires. Calling without it panics readiness-aware middleware
    // such as `ConcurrencyLimit`.
    //
    // Nothing has been written yet, so a status is still available if the
    // service fails. Details stay local rather than leaking to the caller.
    let outcome = if let Ok(response) = service.oneshot(request).await {
        wire::write_response(&mut send, response).await
    } else {
        let mut response = Response::new(Body::once("Internal Server Error"));
        *response.status_mut() = StatusCode::INTERNAL_SERVER_ERROR;
        wire::write_response(&mut send, response).await
    };

    if outcome.is_err() {
        let _ = send.reset(wire::ERROR_CODE);
    }
}
