//! Browser Iroh bindings for HTTP over Iroh.
//!
//! This crate exposes endpoints, connections, and raw byte streams shaped to
//! match the `Listener`, `Connection`, and `ExchangeStream` interfaces of
//! `@strangecyan/iroh-http-core`, which owns the `iroh-http/1` framing, client,
//! and server. Node and browser peers therefore share one TypeScript
//! implementation of `SPEC.md`.

use std::{
    cell::Cell,
    str::FromStr,
    sync::atomic::{AtomicBool, Ordering},
};

use iroh::{
    Endpoint, EndpointAddr, RelayConfig, RelayMap, RelayMode, RelayUrl, SecretKey,
    endpoint::{Connection, Incoming, RecvStream, SendStream, VarInt, presets},
};
use iroh_tickets::endpoint::EndpointTicket;
use tokio::sync::{Mutex, Notify};
use wasm_bindgen::{JsError, prelude::wasm_bindgen};

/// ALPN used by every HTTP over Iroh endpoint.
const ALPN: &[u8] = b"iroh-http/1";
/// QUIC error code used to reset a stream or close a connection.
const ERROR_CODE: VarInt = VarInt::from_u32(1);

#[wasm_bindgen(start)]
fn start() {
    console_error_panic_hook::set_once();
}

/// An address parsed from an Iroh endpoint ticket.
#[wasm_bindgen]
pub struct IrohHttpAddress(EndpointAddr);

/// Parse an endpoint ticket into a dialable address.
#[wasm_bindgen(js_name = getAddressFromString)]
pub fn get_address_from_string(ticket: String) -> Result<IrohHttpAddress, JsError> {
    let ticket = EndpointTicket::from_str(&ticket).map_err(to_js_error)?;
    Ok(IrohHttpAddress(ticket.endpoint_addr().clone()))
}

/// A browser Iroh endpoint configured for the HTTP ALPN.
#[wasm_bindgen]
pub struct IrohHttpEndpoint(Endpoint);

/// Create and bind a browser Iroh endpoint.
#[wasm_bindgen(js_name = createEndpoint)]
pub async fn create_endpoint(
    relay_mode: String,
    relay_urls: Vec<String>,
    relay_auth_tokens: Vec<String>,
    secret_key: Option<Vec<u8>>,
) -> Result<IrohHttpEndpoint, JsError> {
    let mut builder = Endpoint::builder(presets::N0).alpns(vec![ALPN.to_vec()]);

    builder = match relay_mode.as_str() {
        "default" => builder,
        "staging" => builder.relay_mode(RelayMode::Staging),
        "custom" => {
            if relay_urls.len() != relay_auth_tokens.len() {
                return Err(JsError::new(
                    "Each custom relay must have an authentication entry",
                ));
            }
            if relay_urls.is_empty() {
                return Err(JsError::new("A custom relay list cannot be empty"));
            }
            let relays = relay_urls
                .into_iter()
                .zip(relay_auth_tokens)
                .map(|(url, auth_token)| -> Result<RelayConfig, JsError> {
                    let url = RelayUrl::from_str(&url).map_err(to_js_error)?;
                    let config = RelayConfig::from(url);
                    Ok(if auth_token.is_empty() {
                        config
                    } else {
                        config.with_auth_token(auth_token)
                    })
                })
                .collect::<Result<RelayMap, _>>()?;
            builder.relay_mode(RelayMode::Custom(relays))
        }
        _ => return Err(JsError::new("Unknown relay mode")),
    };

    if let Some(secret_key) = secret_key {
        let bytes: [u8; 32] = secret_key
            .try_into()
            .map_err(|_| JsError::new("secretKey must contain exactly 32 bytes"))?;
        builder = builder.secret_key(SecretKey::from_bytes(&bytes));
    }

    Ok(IrohHttpEndpoint(builder.bind().await.map_err(to_js_error)?))
}

#[wasm_bindgen]
impl IrohHttpEndpoint {
    /// Connect to a parsed remote endpoint address.
    pub async fn connect(&self, address: &IrohHttpAddress) -> Result<IrohHttpConnection, JsError> {
        let connection = self
            .0
            .connect(address.0.clone(), ALPN)
            .await
            .map_err(to_js_error)?;
        Ok(IrohHttpConnection(connection))
    }

    /// Wait for the next inbound connection, or `undefined` once the endpoint
    /// closes. The handshake completes in [`IrohHttpIncoming::connect`].
    pub async fn accept(&self) -> Option<IrohHttpIncoming> {
        let incoming = self.0.accept().await?;
        Some(IrohHttpIncoming(Cell::new(Some(incoming))))
    }

    /// A dialable ticket for this endpoint.
    pub async fn ticket(&self) -> Result<String, JsError> {
        self.0.online().await;
        Ok(EndpointTicket::new(self.0.addr()).to_string())
    }

    /// This endpoint's own id, in base32 form.
    #[wasm_bindgen(js_name = endpointId)]
    pub fn endpoint_id(&self) -> String {
        self.0.id().to_string()
    }

    /// Close the endpoint and stop accepting connections.
    pub async fn close(&self) {
        self.0.close().await;
    }
}

/// An inbound connection whose handshake has not completed yet.
#[wasm_bindgen]
pub struct IrohHttpIncoming(Cell<Option<Incoming>>);

#[wasm_bindgen]
impl IrohHttpIncoming {
    /// Complete the handshake. Only the first call may do so; later calls reject.
    pub async fn connect(&self) -> Result<IrohHttpConnection, JsError> {
        let incoming = self
            .0
            .take()
            .ok_or_else(|| JsError::new("Incoming connection was already accepted"))?;
        Ok(IrohHttpConnection(incoming.await.map_err(to_js_error)?))
    }
}

/// An active Iroh connection carrying HTTP exchanges.
#[wasm_bindgen]
pub struct IrohHttpConnection(Connection);

#[wasm_bindgen]
impl IrohHttpConnection {
    /// The remote endpoint id, authenticated by the QUIC handshake.
    #[wasm_bindgen(js_name = remoteId)]
    pub fn remote_id(&self) -> String {
        self.0.remote_id().to_string()
    }

    /// Open a stream for one outbound exchange.
    #[wasm_bindgen(js_name = openStream)]
    pub async fn open_stream(&self) -> Result<IrohHttpStream, JsError> {
        let (send, recv) = self.0.open_bi().await.map_err(to_js_error)?;
        Ok(IrohHttpStream::new(send, recv))
    }

    /// Accept a stream carrying one inbound exchange.
    #[wasm_bindgen(js_name = acceptStream)]
    pub async fn accept_stream(&self) -> Result<IrohHttpStream, JsError> {
        let (send, recv) = self.0.accept_bi().await.map_err(to_js_error)?;
        Ok(IrohHttpStream::new(send, recv))
    }

    /// Close the connection.
    pub fn close(&self) {
        self.0.close(ERROR_CODE, &[]);
    }
}

/// A cancellation flag that an in-flight await can observe.
///
/// A stalled read or write holds its stream's mutex for as long as it is
/// pending, so cancellation cannot be delivered by taking the same lock. The
/// waiting side observes this flag instead, then releases the lock so that the
/// canceller can issue the actual QUIC `stop_sending` or `reset_stream`.
#[derive(Default)]
struct Cancel {
    flag: AtomicBool,
    notify: Notify,
}

impl Cancel {
    fn trigger(&self) {
        self.flag.store(true, Ordering::Release);
        self.notify.notify_waiters();
    }

    fn is_triggered(&self) -> bool {
        self.flag.load(Ordering::Acquire)
    }

    /// Resolve once cancelled, including when cancellation already happened.
    async fn wait(&self) {
        // The waiter is registered before the flag is read, so a `trigger`
        // racing with this call cannot be missed.
        let notified = self.notify.notified();
        if self.is_triggered() {
            return;
        }
        notified.await;
    }
}

/// One bidirectional QUIC stream, carrying exactly one HTTP exchange.
#[wasm_bindgen]
pub struct IrohHttpStream {
    send: Mutex<SendStream>,
    recv: Mutex<RecvStream>,
    send_cancel: Cancel,
    recv_cancel: Cancel,
}

impl IrohHttpStream {
    fn new(send: SendStream, recv: RecvStream) -> Self {
        Self {
            send: Mutex::new(send),
            recv: Mutex::new(recv),
            send_cancel: Cancel::default(),
            recv_cancel: Cancel::default(),
        }
    }
}

#[wasm_bindgen]
impl IrohHttpStream {
    /// Write every byte of `bytes`.
    pub async fn write(&self, bytes: Vec<u8>) -> Result<(), JsError> {
        if self.send_cancel.is_triggered() {
            return Err(JsError::new("Stream was reset"));
        }

        let mut stream = self.send.lock().await;
        tokio::select! {
            biased;
            () = self.send_cancel.wait() => Err(JsError::new("Stream was reset")),
            result = stream.write_all(&bytes) => result.map_err(to_js_error),
        }
    }

    /// Read exactly `size` bytes, or fail if the stream ends or is cancelled.
    ///
    /// A zero-length read always succeeds, even after cancellation, as the
    /// `ExchangeStream` contract requires.
    #[wasm_bindgen(js_name = readExact)]
    pub async fn read_exact(&self, size: usize) -> Result<Vec<u8>, JsError> {
        if size == 0 {
            return Ok(Vec::new());
        }
        if self.recv_cancel.is_triggered() {
            return Err(JsError::new("Stream read was cancelled"));
        }

        let mut buffer = vec![0_u8; size];
        let mut stream = self.recv.lock().await;
        tokio::select! {
            biased;
            () = self.recv_cancel.wait() => {
                return Err(JsError::new("Stream read was cancelled"));
            }
            result = stream.read_exact(&mut buffer) => result.map_err(to_js_error)?,
        }
        Ok(buffer)
    }

    /// Close the send side cleanly.
    pub async fn finish(&self) -> Result<(), JsError> {
        self.send.lock().await.finish().map_err(to_js_error)
    }

    /// Ask the peer to stop sending, interrupting any read in flight.
    pub async fn stop(&self) {
        self.recv_cancel.trigger();
        // A pending read observes the cancellation and releases the mutex, so
        // this cannot block behind a stalled read.
        let _ = self.recv.lock().await.stop(ERROR_CODE);
    }

    /// Abort the exchange in both directions, interrupting work in flight.
    pub async fn reset(&self) {
        self.send_cancel.trigger();
        self.recv_cancel.trigger();
        let _ = self.send.lock().await.reset(ERROR_CODE);
        let _ = self.recv.lock().await.stop(ERROR_CODE);
    }
}

fn to_js_error(error: impl std::fmt::Display) -> JsError {
    JsError::new(&error.to_string())
}
