/**
 * Messages between a tab and the shared worker that owns an endpoint.
 *
 * Every call carries an id, and the worker answers each with exactly one reply
 * bearing the same id. Connections and streams live in the worker and are
 * named by numeric handles, which are scoped to the session that opened them.
 */

import type { EndpointOptions } from './index.ts';

/** One call's input and output. */
interface Rpc<Input, Output> {
  input: Input;
  output: Output;
}

export interface ConnectInput {
  ticket: string;
}

export interface Connected {
  connection: number;
  remoteId: string;
}

export interface ConnectionInput {
  connection: number;
}

export interface StreamInput {
  stream: number;
}

export interface WriteInput {
  stream: number;
  bytes: Uint8Array;
}

export interface ReadInput {
  stream: number;
  size: number;
}

export interface HandleInput {
  handle: number;
}

/** What a tab attaches with. */
export interface AttachInput extends EndpointOptions {
  /**
   * The name of a Web Lock the tab holds for as long as it is attached. The
   * worker queues for the same lock, and is granted it once the tab lets go or
   * goes away, which is how it learns of a tab that never detached.
   */
  liveness?: string;
}

/** Every call the worker answers. */
export interface SharedProtocol {
  /** Join the worker's endpoint, binding it if needed. Outputs the endpoint id. */
  attach: Rpc<AttachInput, string>;
  /** Abandon the session's exchanges and connections. */
  detach: Rpc<undefined, undefined>;
  ticket: Rpc<undefined, string>;
  connect: Rpc<ConnectInput, Connected>;
  /** Outputs the new stream's handle. */
  openStream: Rpc<ConnectionInput, number>;
  closeConnection: Rpc<ConnectionInput, undefined>;
  write: Rpc<WriteInput, undefined>;
  readExact: Rpc<ReadInput, Uint8Array>;
  finish: Rpc<StreamInput, undefined>;
  stop: Rpc<StreamInput, undefined>;
  reset: Rpc<StreamInput, undefined>;
  /** Outputs whether the peer gave up on what the stream sends, once that is known. */
  stopped: Rpc<StreamInput, boolean>;
  /** Forget a connection or stream the tab can no longer reach. */
  release: Rpc<HandleInput, undefined>;
}

export type SharedOp = keyof SharedProtocol;
export type SharedInput<Op extends SharedOp> = SharedProtocol[Op]['input'];
export type SharedOutput<Op extends SharedOp> = SharedProtocol[Op]['output'];

export interface SharedCall<Op extends SharedOp = SharedOp> {
  id: number;
  op: Op;
  input: SharedInput<Op>;
}

export interface SharedSuccess {
  id: number;
  output: SharedOutput<SharedOp>;
}

export interface SharedFailure {
  id: number;
  error: string;
}

export type SharedReply = SharedSuccess | SharedFailure;
