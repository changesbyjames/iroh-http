# Iroh HTTP wire protocol, version 1

This document is normative. Every implementation in this repository — TypeScript
core, Node, browser WebAssembly, and Rust — encodes and decodes exactly what is
described here. Interoperability is defined by this document, not by any one
implementation.

## Goals

Carry HTTP _messages_ — method, target, status, headers, streaming body — between
peers over an Iroh QUIC connection, and surface them in each language's native
types. Nothing more.

This is deliberately **not** HTTP/1.1, HTTP/2, or HTTP/3. It is a minimal
framing chosen so that it can be implemented completely, and identically, in
both TypeScript and Rust.

## Layering

```
  Request / Response      (native types: fetch Request, http::Request)
  ─────────────────────
  Iroh HTTP framing       (this document)
  ─────────────────────
  Iroh QUIC bidirectional stream
  ─────────────────────
  Iroh endpoint, ALPN iroh-http/1
```

## ALPN

```
iroh-http/1
```

The ALPN encodes the framing version. A peer that speaks a future, incompatible
framing must use a different ALPN. Implementations MUST NOT negotiate a version
in-band.

## Exchanges and streams

**One HTTP exchange occupies exactly one QUIC bidirectional stream.**

- The client opens a bidirectional stream per request.
- The server accepts bidirectional streams in a loop; each is an independent
  exchange and MAY be handled concurrently.
- Requests are not ordered relative to one another. There is no request id,
  because the stream is the identity.
- A connection MAY carry any number of concurrent exchanges.

This is why there is no multiplexing layer, no `Connection: keep-alive`, and no
head-of-line blocking between requests: QUIC already provides all three.

Direction on a stream is fixed: the stream opener sends the request and reads
the response.

## Frames

All integers are unsigned big-endian. Every exchange consists of a **head
frame** followed by zero or more **body frames**.

### Head frame

```
+--------+--------+--------+--------+=================+
|             length (u32)          |  JSON (UTF-8)   |
+--------+--------+--------+--------+=================+
```

`length` MUST NOT exceed 1 048 576 (1 MiB). A receiver that reads a larger
value MUST fail the exchange without allocating.

The JSON is an object. Receivers MUST ignore unknown members so that later
revisions can add them.

Request head:

```json
{
  "method": "POST",
  "target": "/upload?flush=1",
  "headers": [
    ["content-type", "application/json"],
    ["accept", "*/*"]
  ]
}
```

Response head:

```json
{
  "status": 200,
  "headers": [["content-type", "text/plain"]]
}
```

| Member    | Type              | Notes                                                      |
| --------- | ----------------- | ---------------------------------------------------------- |
| `method`  | string            | Uppercase HTTP method token.                               |
| `target`  | string            | Origin-form path with optional query. MUST begin with `/`. |
| `status`  | number            | Integer, 200–599. See informational responses below.       |
| `headers` | array of `[k, v]` | Ordered. See below.                                        |

### Headers

Headers are an **ordered list of pairs**, not a map. A field name MAY repeat;
`Set-Cookie` in particular MUST NOT be joined into a single value.

- Field names MUST be lowercase on the wire.
- Order MUST be preserved end to end.
- Values MUST NOT contain CR, LF, or NUL.

There is no `Host` header requirement. The remote's Iroh `EndpointId` is the
authority, and it is cryptographically authenticated by the QUIC handshake
before the head frame is read.

Implementations MUST NOT send hop-by-hop or framing headers: `connection`,
`keep-alive`, `transfer-encoding`, `upgrade`, `proxy-connection`. A receiver
MUST ignore them if present. `content-length`, if present, is advisory metadata
only — body length is determined solely by the body frames.

### Body frames

```
+--------+--------+--------+--------+--------+=================+
|  tag   |             length (u32)          |    payload      |
+--------+--------+--------+--------+--------+=================+
```

| Tag    | Name    | Payload                  | Meaning                           |
| ------ | ------- | ------------------------ | --------------------------------- |
| `0x00` | `DATA`  | `length` bytes           | A body chunk. `length` MAY be 0.  |
| `0x01` | `END`   | none, `length` MUST be 0 | Body complete. Terminal.          |
| `0x02` | `ERROR` | UTF-8 message            | Body failed mid-stream. Terminal. |

`length` for `DATA` and `ERROR` MUST NOT exceed 1 048 576 (1 MiB). Senders
split larger payloads across multiple `DATA` frames.

A body MUST be terminated by exactly one `END` or one `ERROR` frame. After a
terminal frame the sender MUST NOT write further frames, and MUST close its
send side of the stream (QUIC `finish`).

An empty body is a head frame followed immediately by `END`.

`ERROR` exists because a sender can discover a failure after committing to a
status code. HTTP/1.1 cannot express this; here it is explicit. Receivers MUST
surface an `ERROR` frame as a body read failure, never as a clean end of body.

## Termination and cancellation

| Situation                                   | Action                                                  |
| ------------------------------------------- | ------------------------------------------------------- |
| Body sent completely                        | `END` frame, then `finish` the send side.               |
| Body failed after the head was sent         | `ERROR` frame, then `finish`.                           |
| Receiver abandons a body it no longer wants | QUIC `stop_sending` on its receive side.                |
| Either peer abandons the whole exchange     | QUIC `reset_stream` with code `1`.                      |
| Stream ends before a terminal frame         | Treat as a truncated body: an error, never a clean end. |

Resetting or stopping one exchange's stream MUST NOT affect other exchanges on
the same connection. Closing the connection uses QUIC error code `1`.

A peer MUST NOT wait for its response body to be consumed before serving other
streams.

## What is intentionally absent

| Omitted                         | Because                                                 |
| ------------------------------- | ------------------------------------------------------- |
| TLS, `https` semantics          | Iroh already authenticates and encrypts.                |
| `Host` / virtual hosting        | The `EndpointId` is the authority.                      |
| Keep-alive, pipelining          | QUIC streams.                                           |
| Chunked transfer-encoding       | Body frames.                                            |
| Redirects, cookies, CORS, cache | Application concerns, not transport.                    |
| Informational (1xx) responses   | Not expressible; a future minor revision may add a tag. |
| Trailers                        | Not expressible; a future minor revision may add a tag. |
| Server push                     | Use a duplex protocol; this one is request/response.    |

The last three are the known expressiveness limits of version 1. They are
listed so that implementers do not attempt to smuggle them through headers.

## Conformance

An implementation is conformant when it round-trips the corpus in
`e2e/tests/conformance.ts` and passes the cross-language suite in `e2e/tests/`
in all four peer pairings (Node↔Node, Rust↔Rust, Node↔Rust, Browser↔Rust).
