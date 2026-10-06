//! HTTP messages over Iroh QUIC connections.
//!
//! Requests and responses are the `http` crate's own types, servers are
//! [`tower::Service`]s, and the wire protocol is documented in `SPEC.md` at the
//! root of the repository. The TypeScript packages in the same repository
//! implement the identical protocol, so a Rust peer and a browser or Node peer
//! interoperate directly.
//!
//! # Serving
//!
//! ```no_run
//! use http::{Request, Response};
//! use iroh::Endpoint;
//! use iroh_http::{Body, PeerInfo, serve, wire::ALPN};
//!
//! # async fn run() -> Result<(), Box<dyn std::error::Error>> {
//! let endpoint = Endpoint::builder(iroh::endpoint::presets::N0)
//!     .alpns(vec![ALPN.to_vec()])
//!     .bind()
//!     .await?;
//!
//! serve(
//!     endpoint,
//!     tower::service_fn(|request: Request<Body>| async move {
//!         let peer = request.extensions().get::<PeerInfo>().expect("peer info");
//!         Ok::<_, std::convert::Infallible>(Response::new(Body::once(format!(
//!             "hello {}",
//!             peer.endpoint_id
//!         ))))
//!     }),
//! )
//! .await;
//! # Ok(())
//! # }
//! ```
//!
//! # Requesting
//!
//! ```no_run
//! use http::Request;
//! use http_body_util::BodyExt;
//! use iroh::{Endpoint, EndpointAddr};
//! use iroh_http::{Body, Client};
//!
//! # async fn run(endpoint: Endpoint, address: EndpointAddr) -> Result<(), Box<dyn std::error::Error>> {
//! let client = Client::connect(&endpoint, address).await?;
//! let response = client
//!     .fetch(Request::get("/hello").body(Body::empty())?)
//!     .await?;
//!
//! let body = response.into_body().collect().await?.to_bytes();
//! # Ok(())
//! # }
//! ```

#![forbid(unsafe_code)]

mod body;
mod client;
mod error;
mod server;

pub mod wire;

pub use self::{
    body::Body,
    client::Client,
    error::{BoxError, Error},
    server::{PeerInfo, serve, serve_connection},
};

/// The ALPN every HTTP over Iroh endpoint must advertise.
pub use self::wire::ALPN;
