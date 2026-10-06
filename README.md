# HTTP over Iroh

Carry HTTP requests and responses over [Iroh](https://github.com/n0-computer/iroh)
1.0 QUIC connections, and surface them in each language's native types: `fetch`,
`Request`, and `Response` in TypeScript; `http::Request`, `http::Response`, and
[`tower::Service`](https://docs.rs/tower) in Rust.

There is no schema, no IDL, and no code generation. The interoperable layer is
the HTTP message itself, which both ecosystems already model.

```ts
// Browser or Node
const response = await client.fetch('/cameras/1/snapshot');
```

```rust
// Rust, including embedded targets such as an Axis ACAP application
serve(endpoint, tower::service_fn(handle)).await;
```

## Packages

| Package                          | Runtime  | Purpose                                                    |
| -------------------------------- | -------- | ---------------------------------------------------------- |
| `@strangecyan/iroh-http-core`    | any      | Wire codec, client, and server, over an abstract transport |
| `@strangecyan/iroh-http-node`    | Node.js  | Client and server over native `@number0/iroh`              |
| `@strangecyan/iroh-http-browser` | browsers | Client and server over Iroh in WebAssembly                 |
| `iroh-http`                      | Rust     | `http` and `tower` client and server                       |

The client and server live in core, written against small `Connection` and
`Listener` interfaces; the Node and browser packages only adapt their Iroh
bindings to them, and re-export every API from core. The TypeScript packages are
ESM-only.

```sh
npm install @strangecyan/iroh-http-node @number0/iroh
npm install @strangecyan/iroh-http-browser
cargo add iroh-http
```

## Why this and not Cap'n Web, gRPC, or HTTP/3

- **Not Cap'n Web.** Cap'n Web's ergonomics come from `Proxy`, structural
  typing, and no schema — all bets on JavaScript. Porting them to Rust means
  reintroducing an IDL and a nominal value model, losing the thing that made it
  worth having. HTTP is the layer both languages already agree on.
- **Not gRPC or Connect.** Those need a schema and code generation. If you want
  that, put it _on top_ of this.
- **Not HTTP/3.** `h3` over Iroh's QUIC would work in Rust, but there is no
  usable HTTP/3 implementation for browsers to talk back with. A small framing
  that can be implemented twice beats a real specification that can only be
  implemented once.

What you give up relative to Cap'n Web: capability passing, promise pipelining,
and server-initiated calls. This is request/response only. See
[SPEC.md](./SPEC.md#what-is-intentionally-absent).

## Protocol

Fully specified in [SPEC.md](./SPEC.md). In brief:

- ALPN `iroh-http/1`
- **One HTTP exchange per QUIC bidirectional stream**, so requests are
  concurrent and independent with no multiplexing layer and no head-of-line
  blocking
- A JSON head frame with a four-byte, unsigned, big-endian length prefix
- Body frames tagged `DATA`, `END`, or `ERROR`, capped at 1 MiB each
- Headers are an ordered list of pairs, so repeated fields such as `set-cookie`
  survive intact
- No TLS, `Host`, keep-alive, or chunked encoding: Iroh and QUIC already provide
  encryption, authentication, addressing, and framing

The `ERROR` body frame is the one thing HTTP/1.1 cannot express: a failure
discovered _after_ the status code was committed. It surfaces as a body read
error, never as a clean end of body.

## Peer identity

The remote's Iroh `EndpointId` is authenticated by the QUIC handshake before the
first byte of the request is read, so it cannot be spoofed the way a header can.

- Rust: a `PeerInfo` request extension
- TypeScript: the second argument to a handler
- Either: the reconstructed request URL's authority, `http://<endpoint-id>.iroh/…`

## Node.js

```ts
import { getTicket, serve, ALPN } from '@strangecyan/iroh-http-node';
import { Endpoint } from '@number0/iroh';

const endpoint = await Endpoint.bind({ alpns: [ALPN] });
await using server = serve(endpoint, async (request, peer) => {
  if (new URL(request.url).pathname === '/ping') return new Response('pong');
  return new Response('not found', { status: 404 });
});

console.log(await getTicket(endpoint));
```

```ts
import { connect, getAddressFromString } from '@strangecyan/iroh-http-node';

const endpoint = await Endpoint.bind({ alpns: [ALPN] });
const client = await connect(endpoint, getAddressFromString(ticket));

const response = await client.fetch('/ping');
console.log(await response.text());
```

`serve()` owns the endpoint's accept loop. Disposing it stops accepting, closes
active connections, and closes the endpoint. The server's `closed` promise
resolves once the listener closes, without waiting for in-flight exchanges, and
rejects if accepting fails first; disposal reports the same failure. The browser
`serve()` behaves the same way. Pass `{ online: false }` to
`getTicket()` when relays are disabled, otherwise it waits for a home relay that
never arrives.

A handler must read the request body before its response finishes, by awaiting
it or by streaming it into the response. Once the response is written, any body
still unread is abandoned and the peer is told to stop sending, so answering an
upload early (with a `413`, say) does not leave the client blocked.

## Browser

The browser package creates its own Iroh endpoint; WebAssembly initialization is
lazy and happens on the first API call.

```ts
import { connect, createEndpoint, getAddressFromString } from '@strangecyan/iroh-http-browser';

const endpoint = await createEndpoint();
const client = await connect(endpoint, await getAddressFromString(ticket));

const response = await client.fetch('/cameras/1/snapshot');
const blob = await response.blob();
```

Browsers can also serve, using the same `serve(endpoint, handler)` API as Node;
`endpoint.ticket()` returns a dialable ticket once a home relay is reached.
Relay configuration mirrors Iroh's: `"default"`, `"staging"`, or a custom list
with optional per-relay authentication tokens.

## Rust

```rust
use http::{Request, Response};
use iroh::{Endpoint, endpoint::presets};
use iroh_http::{ALPN, Body, PeerInfo, serve};

let endpoint = Endpoint::builder(presets::N0)
    .alpns(vec![ALPN.to_vec()])
    .bind()
    .await?;

serve(endpoint, tower::service_fn(|request: Request<Body>| async move {
    let peer = request.extensions().get::<PeerInfo>().expect("peer info");
    Ok::<_, std::convert::Infallible>(Response::new(Body::once(format!("hello {}", peer.endpoint_id))))
}))
.await;
```

```rust
use http_body_util::BodyExt;
use iroh_http::{Body, Client};

let client = Client::connect(&endpoint, address).await?;
let response = client.fetch(Request::get("/ping").body(Body::empty())?).await?;
let body = response.into_body().collect().await?.to_bytes();
```

Because the server is a `tower::Service` and `Body` implements
`http_body::Body`, `axum` routers and `tower-http` middleware compose without
adaptation. `Client` is also a `tower::Service`, so layers apply to outbound
calls. Streaming producers use `Body::channel`.

## Interoperability

Interoperability is defined by [SPEC.md](./SPEC.md) and enforced by a single
suite of assertions run against every peer pairing.

`e2e/api.ts` and `crates/iroh-http/examples/testserver.rs` implement the same
conformance API in TypeScript and Rust. `e2e/api.ts`'s `conformance()` exports
23 assertions — status codes, repeated headers, hop-by-hop stripping,
multi-frame bodies, streamed downloads, peer identity, concurrent exchanges, and
mid-stream body failure — which run unchanged against both.

| Pairing        | Suite                         | Status   |
| -------------- | ----------------------------- | -------- |
| Rust ↔ Rust    | `crates/iroh-http/tests/`     | 12 tests |
| Node ↔ Node    | `e2e/tests/node-node.test.ts` | 23 tests |
| Node ↔ Rust    | `e2e/tests/node-rust.test.ts` | 23 tests |
| Browser ↔ Rust | not yet written               | —        |

## Development

The browser build requires the `wasm32-unknown-unknown` Rust target,
`wasm-pack` 0.15.0, and Clang with a WebAssembly backend. On macOS,
`brew install llvm` supplies a compatible compiler.

```sh
pnpm install
rustup target add wasm32-unknown-unknown
cargo install wasm-pack --version 0.15.0 --locked
pnpm ready
```

`pnpm ready` builds all three packages, checks formatting, lints and type
checks the TypeScript, runs `cargo fmt --check`, `cargo clippy -D warnings`, and
`cargo test`, validates the npm and crates.io packages, then runs the end-to-end
suite.

The local suites disable relays so they run offline over the loopback path.

GitHub Releases publish all three npm packages. Publishing the `iroh-http` Rust
crate is optional. See [RELEASING.md](./RELEASING.md) for registry setup and the
release checklist.

## Status

A first pass. Known gaps, in rough priority order:

1. **No browser end-to-end coverage.** The browser package builds and shares the
   core framing with Node, but nothing yet proves a browser peer against Rust.
   This needs the Playwright harness and relay networking.
2. **No trailers, no informational responses, no server push.** The known
   expressiveness limits of version 1; see
   [SPEC.md](./SPEC.md#what-is-intentionally-absent).
3. **Cancellation is only partly tested.** `core.test.ts` covers body
   cancellation and truncation against the codec, and the browser stream can
   now interrupt a stalled read, but none of that is yet exercised against a
   real stalled QUIC peer.
4. **No frozen frame corpus.** The suites exercise live peers and the codec, but
   there is no fixed corpus of encoded bytes that would catch both
   implementations drifting from the specification together.
5. **`Client` holds one connection** and does not reconnect or pool.
6. **Per-exchange service cloning.** The server clones the `tower::Service` per
   exchange and drives it with `oneshot`, which honours the readiness contract
   but means middleware holding per-clone state sees one clone per request.
   Middleware sharing state behind an `Arc`, such as `ConcurrencyLimit`, behaves
   correctly; middleware that does not may not apply as expected.

## License

Licensed under either the [Apache License 2.0](./LICENSE-APACHE) or the
[MIT License](./LICENSE-MIT), at your option.
