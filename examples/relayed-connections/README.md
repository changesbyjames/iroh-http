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

`Incoming.acceptWithoutNatTraversal()` comes from [`@strangecyan/iroh`](https://www.npmjs.com/package/@strangecyan/iroh),
a fork of the Node binding built on [an iroh fork](https://github.com/changesbyjames/iroh/tree/relayed-connections) that
adds `QuicTransportConfigBuilder::disable_nat_traversal()`. This repository aliases `@number0/iroh` to it.

The relay is unchanged, so any `iroh-relay` 1.x works: `cargo install iroh-relay --features server`, or set
`IROH_RELAY_BIN` to a binary. Then:

```sh
pnpm install
pnpm --filter @strangecyan/iroh-http-node build
pnpm --filter relayed-connections start
```

The script prints, per peer, the admission decision, the
response, the selected path and any of the agent's addresses the peer learned, and exits non-zero if a peer did not
behave as the list allows.
