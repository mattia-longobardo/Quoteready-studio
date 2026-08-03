import WebSocket from "ws";

const COPILOT_ENDPOINT = "wss://api.zoo.dev/ws/ml/copilot";
const MAX_TEXT_BYTES = 256 * 1024;
// Server frames can carry rendered images as JSON byte arrays, so the
// per-frame receive limit must be far above the text we actually keep.
const MAX_FRAME_BYTES = 16 * 1024 * 1024;

/**
 * Tool result frame emitted by the copilot (`MlToolResult` in the Zoo API):
 * `outputs` maps file names to their new text contents.
 */
export interface CopilotToolResult {
  type: string;
  statusCode: number;
  error: string | null;
  outputs: Record<string, string>;
}

export interface CopilotResult {
  /** Final assistant text (whole_response when provided, else the deltas). */
  text: string;
  toolResults: CopilotToolResult[];
  /** Latest project file contents announced via project_updated frames. */
  projectFiles: Record<string, string>;
}

export interface CopilotReducerState {
  text: string;
  toolResults: CopilotToolResult[];
  projectFiles: Record<string, string>;
  conversationId: string | null;
  done: boolean;
  error: string | null;
  /**
   * `session_data.api_call_id`, which Zoo asks clients to quote when
   * reporting a stuck or failing prompt. Surfaced in every error message.
   */
  apiCallId: string | null;
  /**
   * Count of `reasoning` frames seen. The copilot emits these long before the
   * first `delta`, so they are the only proof a silent turn is still alive
   * and they turn "0 chars streamed" into an actionable diagnostic.
   */
  reasoningFrames: number;
  /** A `backend_shutdown` frame arrived: the turn must be resumed elsewhere. */
  shuttingDown: boolean;
}

export function initialCopilotState(): CopilotReducerState {
  return {
    text: "",
    toolResults: [],
    projectFiles: {},
    conversationId: null,
    done: false,
    error: null,
    apiCallId: null,
    reasoningFrames: 0,
    shuttingDown: false,
  };
}

/**
 * Fold one server frame of the ML copilot wire protocol into the running
 * state. Frames are single-key objects: `{delta:{delta}}` streams text,
 * `{tool_output:{result}}` reports a tool call, `{error:{detail}}` aborts and
 * `{end_of_stream:{whole_response}}` terminates a turn. `session_data`,
 * `reasoning` and `backend_shutdown` are recorded as liveness/diagnostic
 * signals; everything else (info, files, pong, …) is progress chatter and is
 * ignored.
 */
export function reduceCopilotFrame(
  state: CopilotReducerState,
  rawFrame: string,
): CopilotReducerState {
  if (state.done || state.error) return state;
  let frame: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(rawFrame);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return state;
    }
    frame = parsed as Record<string, unknown>;
  } catch {
    return state;
  }

  if (frame.delta && typeof frame.delta === "object") {
    const delta = (frame.delta as { delta?: unknown }).delta;
    if (typeof delta === "string") {
      const text = state.text + delta;
      if (Buffer.byteLength(text, "utf8") > MAX_TEXT_BYTES) {
        return {
          ...state,
          error: "Zoo Copilot output exceeded its safety limit.",
        };
      }
      return { ...state, text };
    }
    return state;
  }

  if (frame.tool_output && typeof frame.tool_output === "object") {
    const result = (frame.tool_output as { result?: unknown }).result;
    if (result && typeof result === "object") {
      const record = result as Record<string, unknown>;
      const outputs: Record<string, string> = {};
      if (record.outputs && typeof record.outputs === "object") {
        for (const [name, contents] of Object.entries(
          record.outputs as Record<string, unknown>,
        )) {
          if (typeof contents === "string") outputs[name] = contents;
        }
      }
      return {
        ...state,
        toolResults: [
          ...state.toolResults,
          {
            type: typeof record.type === "string" ? record.type : "unknown",
            statusCode:
              typeof record.status_code === "number" ? record.status_code : 0,
            error: typeof record.error === "string" ? record.error : null,
            outputs,
          },
        ],
      };
    }
    return state;
  }

  // Sent immediately after the in-band authentication is accepted, so it is
  // also the deterministic "the socket is ready for a prompt" signal.
  if (frame.session_data && typeof frame.session_data === "object") {
    const id = (frame.session_data as { api_call_id?: unknown }).api_call_id;
    return typeof id === "string" ? { ...state, apiCallId: id } : state;
  }

  // The copilot reasons for minutes before the first delta; counting these
  // frames distinguishes "still working" from "wedged" when a turn times out.
  if (frame.reasoning && typeof frame.reasoning === "object") {
    return { ...state, reasoningFrames: state.reasoningFrames + 1 };
  }

  // Zoo recycles copilot backends mid-turn (observed reason:
  // "zookeeper_service_refresh") and announces it on the socket. The turn
  // usually survives, so this is recorded for diagnostics only — the close
  // handler is what decides to reconnect, if the socket actually drops.
  if (frame.backend_shutdown && typeof frame.backend_shutdown === "object") {
    return { ...state, shuttingDown: true };
  }

  if (frame.conversation_id && typeof frame.conversation_id === "object") {
    const id = (frame.conversation_id as { conversation_id?: unknown })
      .conversation_id;
    return typeof id === "string" ? { ...state, conversationId: id } : state;
  }

  if (frame.project_updated && typeof frame.project_updated === "object") {
    const files = (frame.project_updated as { files?: unknown }).files;
    if (files && typeof files === "object") {
      const projectFiles = { ...state.projectFiles };
      for (const [name, contents] of Object.entries(
        files as Record<string, unknown>,
      )) {
        if (typeof contents === "string") projectFiles[name] = contents;
      }
      return { ...state, projectFiles };
    }
    return state;
  }

  if (frame.error && typeof frame.error === "object") {
    const detail = (frame.error as { detail?: unknown }).detail;
    return {
      ...state,
      error:
        typeof detail === "string" && detail.trim()
          ? detail.slice(0, 300)
          : "Zoo Copilot reported an error.",
    };
  }

  if (frame.end_of_stream && typeof frame.end_of_stream === "object") {
    const whole = (frame.end_of_stream as { whole_response?: unknown })
      .whole_response;
    return {
      ...state,
      done: true,
      text:
        typeof whole === "string" && whole.trim()
          ? whole.slice(0, MAX_TEXT_BYTES)
          : state.text,
    };
  }

  return state;
}

/**
 * True for the server's `{"pong":{}}` keepalive answer. Cheap enough to run
 * on every frame because the payload is tiny and checked before parsing.
 */
function isPongFrame(buffer: Buffer): boolean {
  if (buffer.length > 32) return false;
  try {
    const parsed: unknown = JSON.parse(buffer.toString("utf8"));
    return Boolean(
      parsed && typeof parsed === "object" && "pong" in (parsed as object),
    );
  } catch {
    return false;
  }
}

export interface CopilotPromptInput {
  token: string;
  content: string;
  projectName?: string;
  /**
   * Project files sent as context. The wire format requires byte arrays, so
   * text and binary contents are both accepted here and encoded.
   */
  currentFiles?: Record<string, Uint8Array | string>;
  /** Tools the copilot must use; an empty array requests a text-only answer. */
  forcedTools?: string[];
  /** `MlCopilotMode`: "fast" (default server-side), "thoughtful" or "auto". */
  mode?: "fast" | "thoughtful" | "auto";
  timeoutMs?: number;
  /** Invoked on every server frame so callers can trace a silent turn. */
  onProgress?: (state: CopilotReducerState) => void;
}

function encodeFiles(
  files: Record<string, Uint8Array | string>,
): Record<string, number[]> {
  const encoded: Record<string, number[]> = {};
  for (const [name, contents] of Object.entries(files)) {
    encoded[name] = Array.from(
      typeof contents === "string" ? Buffer.from(contents, "utf8") : contents,
    );
  }
  return encoded;
}

/**
 * Minimal MsgPack decoder covering the types Zoo's Replay frame uses (maps,
 * arrays, strings, binary blobs, numbers, booleans, nil). Throws on anything
 * outside that subset; callers treat that as "replay not decodable".
 */
export function decodeMsgPack(buffer: Buffer): unknown {
  let offset = 0;
  const read = (): unknown => {
    const byte = buffer[offset];
    if (byte === undefined) throw new Error("Truncated MsgPack document.");
    offset += 1;
    if (byte <= 0x7f) return byte;
    if (byte >= 0xe0) return byte - 0x100;
    if (byte >= 0x80 && byte <= 0x8f) return readMap(byte - 0x80);
    if (byte >= 0x90 && byte <= 0x9f) return readArray(byte - 0x90);
    if (byte >= 0xa0 && byte <= 0xbf) return readString(byte - 0xa0);
    switch (byte) {
      case 0xc0:
        return null;
      case 0xc2:
        return false;
      case 0xc3:
        return true;
      case 0xc4:
        return readBinary(readUint(1));
      case 0xc5:
        return readBinary(readUint(2));
      case 0xc6:
        return readBinary(readUint(4));
      case 0xca: {
        const value = buffer.readFloatBE(offset);
        offset += 4;
        return value;
      }
      case 0xcb: {
        const value = buffer.readDoubleBE(offset);
        offset += 8;
        return value;
      }
      case 0xcc:
        return readUint(1);
      case 0xcd:
        return readUint(2);
      case 0xce:
        return readUint(4);
      case 0xcf:
        return Number(buffer.readBigUInt64BE((offset += 8) - 8));
      case 0xd0:
        return buffer.readInt8((offset += 1) - 1);
      case 0xd1:
        return buffer.readInt16BE((offset += 2) - 2);
      case 0xd2:
        return buffer.readInt32BE((offset += 4) - 4);
      case 0xd3:
        return Number(buffer.readBigInt64BE((offset += 8) - 8));
      case 0xd9:
        return readString(readUint(1));
      case 0xda:
        return readString(readUint(2));
      case 0xdb:
        return readString(readUint(4));
      case 0xdc:
        return readArray(readUint(2));
      case 0xdd:
        return readArray(readUint(4));
      case 0xde:
        return readMap(readUint(2));
      case 0xdf:
        return readMap(readUint(4));
      default:
        throw new Error(`Unsupported MsgPack type 0x${byte.toString(16)}.`);
    }
  };
  const readUint = (bytes: number): number => {
    const value = buffer.readUIntBE(offset, bytes);
    offset += bytes;
    return value;
  };
  const readString = (length: number): string => {
    const value = buffer.toString("utf8", offset, offset + length);
    offset += length;
    return value;
  };
  const readBinary = (length: number): Buffer => {
    const value = buffer.subarray(offset, offset + length);
    offset += length;
    return value;
  };
  const readArray = (length: number): unknown[] => {
    const items: unknown[] = [];
    for (let index = 0; index < length; index += 1) items.push(read());
    return items;
  };
  const readMap = (length: number): Record<string, unknown> => {
    const map: Record<string, unknown> = {};
    for (let index = 0; index < length; index += 1) {
      const key = read();
      map[String(key)] = read();
    }
    return map;
  };
  return read();
}

/**
 * Fold a binary Replay frame (`{replay:{messages:[bytes…]}}`, MsgPack) into
 * the state by re-playing each recorded message through the JSON reducer.
 * Undecodable replays leave the state untouched.
 */
export function reduceReplayFrame(
  state: CopilotReducerState,
  frame: Buffer,
): CopilotReducerState {
  try {
    const document = decodeMsgPack(frame);
    if (!document || typeof document !== "object") return state;
    const replay = (document as Record<string, unknown>).replay;
    if (!replay || typeof replay !== "object") return state;
    const messages = (replay as Record<string, unknown>).messages;
    if (!Array.isArray(messages)) return state;
    for (const message of messages) {
      const bytes = Buffer.isBuffer(message)
        ? message
        : Array.isArray(message)
          ? Buffer.from(message as number[])
          : null;
      if (!bytes) continue;
      state = reduceCopilotFrame(state, bytes.toString("utf8"));
      // Recorded "reconnect and retry" interrupts and backend shutdowns are
      // history, not a fatal outcome — clear them so the rest of the replay
      // is consumed and the resumed turn is not immediately torn down again.
      if (state.error && RECONNECTABLE_ERROR.test(state.error)) {
        state = { ...state, error: null };
      }
      if (state.shuttingDown) {
        state = { ...state, shuttingDown: false };
      }
    }
    return state;
  } catch {
    return state;
  }
}

// Zoo periodically recycles copilot backends mid-prompt (backend_shutdown
// frames, socket close). The prompt keeps running server-side, so the client
// reconnects with replay to pick the stream back up. The replacement backend
// can take a while to accept connections, so retries back off exponentially
// (2s, 4s, 8s, … capped at 30s) and the counter resets once frames flow.
const MAX_RECONNECTS = 6;
const RECONNECT_DELAY_MS = 2_000;
const MAX_RECONNECT_DELAY_MS = 30_000;
// The copilot protocol has an explicit ping/pong keepalive. Long turns run
// for many minutes with gaps between frames, and an idle socket is otherwise
// free to be dropped by any intermediary before the answer arrives.
const PING_INTERVAL_MS = 30_000;
// A turn that produces no frame at all for this long is wedged rather than
// slow (a healthy turn emits reasoning frames continuously). Dropping the
// socket makes the close handler resume it with replay + `continue`.
const STALL_TIMEOUT_MS = 5 * 60_000;
// After a replay reconnect Zoo needs to be told to resume the interrupted
// turn; without it the resumed socket stays silent until the client's budget
// runs out ("conversation established, 0 chars streamed").
const CONTINUE_FALLBACK_MS = 5_000;
// Zookeeper drops long-running sessions with an explicit "please reconnect
// and retry" error frame; the prompt keeps running server-side and must be
// resumed on the same conversation, not restarted.
const RECONNECTABLE_ERROR = /reconnect and retry|connection interrupted/i;

/**
 * Run one prompt against Zoo's ML copilot websocket and resolve with the
 * final text, tool results and project files once the server signals
 * end_of_stream. Transparently reconnects (with replay) when Zoo drops the
 * connection before the answer completes.
 */
export async function runCopilotPrompt(
  input: CopilotPromptInput,
): Promise<CopilotResult> {
  return new Promise((resolve, reject) => {
    let state = initialCopilotState();
    let settled = false;
    // Budget for consecutive failures; reset once frames flow again.
    let reconnects = 0;
    // Never reset, so the diagnostics report how unstable the turn really was.
    let totalReconnects = 0;
    let socket: WebSocket | null = null;
    let pingTimer: ReturnType<typeof setInterval> | null = null;
    let stallTimer: ReturnType<typeof setTimeout> | null = null;

    // A replay reconnect rebuilds the state from scratch, so anything the
    // copilot already produced is kept here: a replay that arrives truncated
    // (or not at all) must never discard a program that was already written.
    const harvested: {
      toolResults: CopilotToolResult[];
      projectFiles: Record<string, string>;
    } = { toolResults: [], projectFiles: {} };
    const harvest = () => {
      if (state.toolResults.length > harvested.toolResults.length) {
        harvested.toolResults = state.toolResults;
      }
      Object.assign(harvested.projectFiles, state.projectFiles);
    };

    /** Human-readable trace of how far the turn got, for every error path. */
    const diagnostics = () =>
      [
        `conversation ${state.conversationId ? "established" : "not established"}`,
        `${state.reasoningFrames} reasoning frames`,
        `${state.text.length} chars streamed`,
        `${Math.max(state.toolResults.length, harvested.toolResults.length)} tool results`,
        `${totalReconnects} reconnects`,
        state.apiCallId ? `api call ${state.apiCallId}` : "no api call id",
      ].join(", ");

    const clearTimers = () => {
      if (pingTimer) clearInterval(pingTimer);
      if (stallTimer) clearTimeout(stallTimer);
      pingTimer = null;
      stallTimer = null;
    };

    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      clearTimers();
      socket?.close();
      if (error) reject(error);
      else {
        harvest();
        resolve({
          text: state.text,
          toolResults: harvested.toolResults,
          projectFiles: harvested.projectFiles,
        });
      }
    };
    const timeout = setTimeout(() => {
      // Tool output or project files that already arrived — on this socket or
      // on a superseded one — are a usable answer even when the closing frame
      // never came.
      harvest();
      if (
        harvested.toolResults.length > 0 ||
        Object.keys(harvested.projectFiles).length > 0
      ) {
        finish();
        return;
      }
      finish(new Error(`Zoo Copilot timed out (${diagnostics()}).`));
    }, input.timeoutMs ?? 60_000);

    /**
     * Restart the stall watchdog. Any frame — including a `reasoning` frame
     * or a `pong` — counts as liveness, so only a genuinely wedged turn trips
     * it and gets resumed on a fresh socket.
     */
    const armStallWatchdog = () => {
      if (stallTimer) clearTimeout(stallTimer);
      stallTimer = setTimeout(() => {
        if (settled) return;
        if (state.conversationId && reconnects < MAX_RECONNECTS) {
          // The close handler reconnects with replay and resumes the turn.
          socket?.close();
          return;
        }
        finish(new Error(`Zoo Copilot stalled (${diagnostics()}).`));
      }, STALL_TIMEOUT_MS);
    };

    let promptSent = false;
    const sendPrompt = () => {
      if (settled || promptSent) return;
      promptSent = true;
      socket?.send(
        JSON.stringify({
          type: "user",
          content: input.content,
          project_name: input.projectName || null,
          forced_tools: input.forcedTools ?? [],
          ...(input.mode ? { mode: input.mode } : {}),
          ...(input.currentFiles
            ? { current_files: encodeFiles(input.currentFiles) }
            : {}),
        }),
      );
      armStallWatchdog();
    };

    const connect = (replay: boolean) => {
      const url = replay
        ? `${COPILOT_ENDPOINT}?replay=true&conversation_id=${encodeURIComponent(state.conversationId ?? "")}`
        : COPILOT_ENDPOINT;
      // Handlers and timers below target *this* connection, so a delayed
      // callback from a superseded socket can never write to its replacement.
      const active = new WebSocket(url, {
        headers: {
          Authorization: `Bearer ${input.token}`,
          "User-Agent": "QuoteReady-Studio/1.0",
        },
        maxPayload: MAX_FRAME_BYTES,
      });
      socket = active;

      // Per-connection resume bookkeeping: the `continue` system command is
      // sent exactly once on each replay socket.
      let continueSent = false;
      const sendContinue = () => {
        if (settled || continueSent || !replay || state.done) return;
        if (active.readyState !== WebSocket.OPEN) return;
        continueSent = true;
        active.send(JSON.stringify({ type: "system", command: "continue" }));
      };
      active.on("unexpected-response", (_request, response) => {
        finish(
          new Error(
            `Zoo Copilot connection failed (HTTP ${response.statusCode}).`,
          ),
        );
      });
      active.on("open", () => {
        // Zoo requires in-band websocket authentication: the first message
        // must carry the bearer token, otherwise the server answers with
        // "Please send `{ headers: … }`" error frames (or silently closes)
        // regardless of the HTTP Authorization header.
        active.send(
          JSON.stringify({
            headers: { Authorization: `Bearer ${input.token}` },
          }),
        );
        // Keep the socket warm for the whole turn: the copilot can go a
        // minute or more between frames while it renders and reasons.
        pingTimer = setInterval(() => {
          if (active.readyState === WebSocket.OPEN) {
            active.send(JSON.stringify({ type: "ping" }));
          }
        }, PING_INTERVAL_MS);
        armStallWatchdog();
        // The prompt is sent once; replay connections resume the same
        // conversation without creating a new prompt. Messages sent before
        // the in-band auth is processed can be dropped, so the prompt waits
        // for the first server frame (or a short grace period).
        if (replay) {
          // The server re-plays the conversation from the start, so the
          // streamed state is rebuilt from scratch to avoid duplication —
          // but not before banking whatever it already produced.
          harvest();
          state = {
            ...initialCopilotState(),
            conversationId: state.conversationId,
            apiCallId: state.apiCallId,
          };
          // A replay socket that is never told to `continue` sits silent
          // until the caller's budget expires, so ask for the resume even if
          // the replay frame never arrives.
          setTimeout(sendContinue, CONTINUE_FALLBACK_MS);
          return;
        }
        setTimeout(sendPrompt, 3_000);
      });
      active.on("message", (data, isBinary) => {
        if (!promptSent) sendPrompt();
        const buffer = Array.isArray(data)
          ? Buffer.concat(data)
          : Buffer.isBuffer(data)
            ? data
            : Buffer.from(data);
        // Only work done on the turn counts as liveness. The `pong` answers
        // to our own keepalive prove the socket is up but say nothing about
        // the prompt, and re-arming on them would make the watchdog unable
        // to ever fire on a wedged turn.
        if (isBinary || !isPongFrame(buffer)) armStallWatchdog();
        // The connection is alive again: allow a full reconnect budget for
        // the next backend recycle.
        reconnects = 0;
        state = isBinary
          ? reduceReplayFrame(state, buffer)
          : reduceCopilotFrame(state, buffer.toString("utf8"));
        input.onProgress?.(state);
        // The replay frame is the end of the resumed history: whatever was
        // not finished server-side must now be explicitly continued.
        if (isBinary) sendContinue();
        if (state.error) {
          // An explicit "reconnect and retry" interrupt is not fatal: the
          // prompt keeps running server-side. Resume via the close handler.
          if (
            RECONNECTABLE_ERROR.test(state.error) &&
            state.conversationId &&
            reconnects < MAX_RECONNECTS
          ) {
            state = { ...state, error: null };
            harvest();
            // Resuming an interrupted zookeeper turn is unreliable — it often
            // goes silent for the rest of the budget. If the copilot already
            // wrote the files, take them now rather than risk the whole turn.
            if (
              harvested.toolResults.length > 0 ||
              Object.keys(harvested.projectFiles).length > 0
            ) {
              finish();
              return;
            }
            active.close();
            return;
          }
          finish(new Error(state.error));
        } else if (state.done) finish();
      });
      active.on("error", () => {
        // The close handler decides between reconnecting and failing.
      });
      active.on("close", () => {
        if (settled) return;
        clearTimers();
        if (state.conversationId && reconnects < MAX_RECONNECTS) {
          reconnects += 1;
          totalReconnects += 1;
          const delay = Math.min(
            MAX_RECONNECT_DELAY_MS,
            RECONNECT_DELAY_MS * 2 ** (reconnects - 1),
          );
          setTimeout(() => {
            if (!settled) connect(true);
          }, delay);
          return;
        }
        // A close after streamed text or completed tool activity still
        // counts as an answer — some turns end without end_of_stream.
        harvest();
        if (
          state.text ||
          harvested.toolResults.length > 0 ||
          Object.keys(harvested.projectFiles).length > 0
        ) {
          finish();
          return;
        }
        finish(
          new Error(
            `Zoo Copilot closed without a response (${diagnostics()}).`,
          ),
        );
      });
    };

    connect(false);
  });
}
