# Relayed connections

A proof of concept for serving peers with different trust from one endpoint and one identity. Peers allowed
`direct` holepunch to the agent; peers allowed only `relayed` reach it through the relay but never learn its IP
addresses; every other peer is refused before the handshake.

The decision is made from the peer's endpoint ID, which the relay has authenticated by the time the connection reaches
the agent's accept loop, against a fixed list (`endpoints.json`) standing in for a real source:

```json
[{ "endpointId": "…", "allow": { "relayed": true, "direct": false } }]
```

A `relayed` connection is accepted with `Incoming.acceptWithoutNatTraversal()`. NAT traversal is only negotiated when
both sides offer it, so the agent never sends that peer ADD_ADDRESS frames, and a REACH_OUT from it would be a protocol
violation: the connection cannot leave the relay.

## Running it

It needs two forks, cloned beside this repository's parent (`~/Developer/forks`):

- [changesbyjames/iroh](https://github.com/changesbyjames/iroh/tree/relayed-connections): adds
  `QuicTransportConfigBuilder::disable_nat_traversal()`. Build the relay with
  `cargo build --release -p iroh-relay --features server --bin iroh-relay`.
- [changesbyjames/iroh-ffi](https://github.com/changesbyjames/iroh-ffi/tree/relayed-connections): adds
  `Incoming.acceptWithoutNatTraversal()` to the Node binding. Build it with `yarn install && yarn build` in `iroh-js`.

The workspace overrides `@number0/iroh` with that local build. Then:

```sh
pnpm install
pnpm --filter @strangecyan/iroh-http-node build
pnpm --filter relayed-connections start
```

Set `IROH_RELAY_BIN` if the relay binary is elsewhere. The script prints, per peer, the admission decision, the
response, the selected path and any of the agent's addresses the peer learned, and exits non-zero if a peer did not
behave as the list allows.
