function serializeArguments(value: unknown): string {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return JSON.stringify(value);
  }
  if (
    typeof value === "number" &&
    Number.isFinite(value) &&
    !Object.is(value, -0)
  ) {
    return JSON.stringify(value);
  }
  if (typeof value !== "object" || value === null) {
    throw new Error("Unsupported permission argument");
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    Object.getOwnPropertySymbols(value).length ||
    Object.values(descriptors).some(
      (descriptor) => !Object.hasOwn(descriptor, "value"),
    )
  ) {
    throw new Error("Unsupported permission argument");
  }
  if (Array.isArray(value)) {
    if (Object.keys(descriptors).length !== value.length + 1) {
      throw new Error("Unsupported permission argument");
    }
    return `[${Array.from({ length: value.length }, (_, index) => {
      if (!Object.hasOwn(descriptors, index)) {
        throw new Error("Unsupported permission argument");
      }
      return serializeArguments(descriptors[index].value);
    }).join(",")}]`;
  }
  if (
    Object.getPrototypeOf(value) !== Object.prototype &&
    Object.getPrototypeOf(value) !== null
  ) {
    throw new Error("Unsupported permission argument");
  }
  return `{${Object.keys(descriptors)
    .sort()
    .map(
      (key) =>
        `${JSON.stringify(key)}:${serializeArguments(descriptors[key].value)}`,
    )
    .join(",")}}`;
}

export function permissionArgumentsKey(
  args: Record<string, unknown>,
): string | undefined {
  try {
    return serializeArguments(args);
  } catch {
    return undefined;
  }
}

export function executePermissionKey(
  args: Record<string, unknown>,
): string | undefined {
  const command = Object.getOwnPropertyDescriptor(args, "command")?.value;
  if (typeof command !== "string" || !command.trim()) return undefined;
  return permissionArgumentsKey(args);
}
