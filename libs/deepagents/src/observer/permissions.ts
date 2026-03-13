import type {
  AttachedClientInfo,
  ControlCommandKind,
  ControlCommandPayload,
  SteerAgentInput,
} from "./types.js";

export function makeAttachedClient(
  client?: Partial<AttachedClientInfo>,
): AttachedClientInfo {
  return {
    id: client?.id ?? "anonymous-client",
    name: client?.name,
    transport: client?.transport ?? "acp",
    capabilities: client?.capabilities,
  };
}

export function makeCreatedBy(client: AttachedClientInfo): string {
  const prefix = client.transport ?? "acp";
  return `${prefix}:${client.id}`;
}

export function normalizeSteeringInput(input: SteerAgentInput): {
  kind: ControlCommandKind;
  payload: ControlCommandPayload;
} {
  return {
    kind: input.kind,
    payload: input.payload,
  };
}
