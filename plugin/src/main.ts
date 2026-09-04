import {
  createTraceClient,
  defineWorkbenchPlugin,
  encodeBase64,
  type JsonValue,
  type TraceResource,
} from "@ora-space/plugin-sdk";

/** Keep page responses comfortably below Ora's one-mebibyte workbench bridge limit. */
const PAGE_READ_MAX_BYTES = 512 * 1024;

/** Validates a page-supplied trace id without allowing it to influence host file resolution. */
function traceId(input: JsonValue): string {
  if (
    typeof input !== "object" || input === null || Array.isArray(input) ||
    typeof input.traceId !== "string" || input.traceId.length === 0
  ) {
    throw new Error("traceId is required");
  }
  return input.traceId;
}

function readInput(input: JsonValue): {
  traceId: string;
  offset: number;
  cursor: string | undefined;
} {
  const id = traceId(input);
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error("trace read input is invalid");
  }
  const offset = input.offset === undefined ? 0 : input.offset;
  if (typeof offset !== "number") {
    throw new Error("offset must be a number");
  }
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw new Error("offset must be a non-negative safe integer");
  }
  if (input.cursor !== undefined && typeof input.cursor !== "string") {
    throw new Error("cursor must be a string");
  }
  return {
    traceId: id,
    offset,
    cursor: typeof input.cursor === "string" ? input.cursor : undefined,
  };
}

/** Converts SDK-only interfaces into the JSON values a workbench RPC may return. */
function resourceJson(resource: TraceResource): JsonValue {
  return {
    traceId: resource.traceId,
    providerId: resource.providerId,
    format: resource.format,
    sizeBytes: resource.sizeBytes,
    modifiedAtMs: resource.modifiedAtMs,
    cursor: resource.cursor,
    label: resource.label,
    isCurrent: resource.isCurrent,
  };
}

/**
 * A zero-permission workbench process. It only relays bounded, context-authorized trace bytes;
 * parsing runs in the packaged WebAssembly module loaded by the page, never in a Rust server.
 */
const dashboard = defineWorkbenchPlugin({
  methods: {
    "dashboard/list": async (call) => {
      const trace = createTraceClient(dashboard.plugin, call.context);
      return { traces: (await trace.list()).map(resourceJson) };
    },
    "dashboard/stat": async (call) => {
      const trace = createTraceClient(dashboard.plugin, call.context);
      return resourceJson(await trace.stat(traceId(call.input)));
    },
    "dashboard/read": async (call) => {
      const trace = createTraceClient(dashboard.plugin, call.context);
      const request = readInput(call.input);
      const chunk = await trace.read(
        request.traceId,
        request.offset,
        PAGE_READ_MAX_BYTES,
        request.cursor,
      );
      return {
        bytesBase64: encodeBase64(chunk.bytes),
        offset: chunk.offset,
        nextOffset: chunk.nextOffset,
        eof: chunk.eof,
        cursor: chunk.cursor,
      };
    },
  },
});

await dashboard.run();
