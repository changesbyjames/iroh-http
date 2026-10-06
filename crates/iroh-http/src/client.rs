//! The `fetch`-shaped client side of HTTP over Iroh.

use std::{
    future::Future,
    pin::Pin,
    task::{Context, Poll},
};

use bytes::Bytes;
use http::{Request, Response};
use http_body::Body as HttpBody;
use iroh::{Endpoint, EndpointAddr, EndpointId, endpoint::Connection};
use n0_future::FutureExt;
use tokio::sync::oneshot;

use crate::{Body, Error, PeerInfo, wire};

/// A client bound to one Iroh connection.
///
/// Each request opens its own bidirectional QUIC stream, so requests are
/// independent and may be issued concurrently from cloned handles.
#[derive(Debug, Clone)]
pub struct Client {
    connection: Connection,
}

impl Client {
    /// Wrap an established connection that negotiated [`wire::ALPN`].
    #[must_use]
    pub fn new(connection: Connection) -> Self {
        Self { connection }
    }

    /// Connect to a remote endpoint and return a client for it.
    pub async fn connect(
        endpoint: &Endpoint,
        address: impl Into<EndpointAddr>,
    ) -> Result<Self, Error> {
        let connection = endpoint
            .connect(address.into(), wire::ALPN)
            .await
            .map_err(Error::transport)?;
        Ok(Self::new(connection))
    }

    /// The remote endpoint id, authenticated by the QUIC handshake.
    #[must_use]
    pub fn endpoint_id(&self) -> EndpointId {
        self.connection.remote_id()
    }

    /// The remote peer's identity, as handed to server-side handlers.
    #[must_use]
    pub fn peer(&self) -> PeerInfo {
        PeerInfo {
            endpoint_id: self.endpoint_id(),
        }
    }

    /// Issue a request and await its response head.
    ///
    /// Returns as soon as the response head has arrived; the response body
    /// streams afterwards. The request body is uploaded concurrently, so a
    /// server may answer before the upload completes.
    pub async fn fetch<B>(&self, request: Request<B>) -> Result<Response<Body>, Error>
    where
        B: HttpBody<Data = Bytes> + Send + 'static,
        B::Error: std::fmt::Display + Send,
    {
        let (mut send, recv) = self.connection.open_bi().await.map_err(Error::transport)?;

        // Fired if no response will arrive, so the upload stops. A stream
        // dropped mid-write would finish cleanly, so it must be reset instead.
        let (cancel, cancelled) = oneshot::channel::<()>();
        n0_future::task::spawn(async move {
            let written = async { wire::write_request(&mut send, request).await.is_ok() };
            let cancelled = async {
                // A dropped sender means the response arrived: keep uploading.
                if cancelled.await.is_err() {
                    std::future::pending::<()>().await;
                }
                false
            };
            if !written.or(cancelled).await {
                let _ = send.reset(wire::ERROR_CODE);
            }
        });

        // Cancel the upload if reading fails or the caller drops this future
        // before the response head arrives; disarm once it has arrived.
        let mut cancel = CancelOnDrop(Some(cancel));
        let response = wire::read_response(recv).await;
        if response.is_ok() {
            cancel.0 = None;
        }
        response
    }

    /// Close the underlying connection.
    pub fn close(&self) {
        self.connection.close(wire::ERROR_CODE, &[]);
    }
}

/// Signals its channel when dropped, unless the sender was taken first.
struct CancelOnDrop(Option<oneshot::Sender<()>>);

impl Drop for CancelOnDrop {
    fn drop(&mut self) {
        if let Some(cancel) = self.0.take() {
            let _ = cancel.send(());
        }
    }
}

/// `Client` is a `tower::Service`, so `tower` layers apply to outbound calls.
impl<B> tower::Service<Request<B>> for Client
where
    B: HttpBody<Data = Bytes> + Send + 'static,
    B::Error: std::fmt::Display + Send,
{
    type Response = Response<Body>;
    type Error = Error;
    type Future = Pin<Box<dyn Future<Output = Result<Self::Response, Self::Error>> + Send>>;

    fn poll_ready(&mut self, _cx: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
        Poll::Ready(Ok(()))
    }

    fn call(&mut self, request: Request<B>) -> Self::Future {
        let client = self.clone();
        Box::pin(async move { client.fetch(request).await })
    }
}
