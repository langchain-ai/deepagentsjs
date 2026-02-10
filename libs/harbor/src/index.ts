/**
 * Harbor integration for deepagents-js.
 *
 * Provides an RPC-based sandbox backend that bridges deepagents-js
 * to Harbor benchmark environments via a JSON-RPC stdin/stdout protocol.
 *
 * @packageDocumentation
 */

export { RpcSandbox } from "./rpc-sandbox.js";

export type {
  InitMessage,
  ExecRequest,
  ExecResponse,
  DoneMessage,
  ErrorMessage,
  SerializedMessage,
  IncomingMessage,
  OutgoingMessage,
} from "./rpc-protocol.js";

export {
  sendMessage,
  log,
  createStdinReader,
  parseIncomingMessage,
  nextRequestId,
} from "./rpc-protocol.js";
