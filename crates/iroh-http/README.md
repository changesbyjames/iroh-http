# iroh-http

HTTP messages over [Iroh](https://github.com/n0-computer/iroh) 1.0 QUIC
connections, using `http` and [`tower`](https://docs.rs/tower) types.

Servers are `tower::Service`s and bodies implement `http_body::Body`, so `axum`
routers and `tower-http` middleware compose without adaptation.

The wire protocol is specified in [`SPEC.md`](../../SPEC.md). TypeScript
packages in the same repository implement it identically, so a Rust peer
interoperates directly with a browser or Node peer.

See the [repository README](../../README.md) for the full picture.

## License

Licensed under either the Apache License 2.0 or the MIT License, at your option.
