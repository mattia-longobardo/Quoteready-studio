import { describe, expect, it } from "vitest";

import {
  decodeMsgPack,
  initialCopilotState,
  reduceCopilotFrame,
  reduceReplayFrame,
  type CopilotReducerState,
} from "../src/zoo-copilot";

function play(frames: string[]): CopilotReducerState {
  return frames.reduce(reduceCopilotFrame, initialCopilotState());
}

describe("reduceCopilotFrame", () => {
  it("accumulates delta frames into text", () => {
    const state = play([
      JSON.stringify({ delta: { delta: "Hello " } }),
      JSON.stringify({ delta: { delta: "world" } }),
    ]);
    expect(state.text).toBe("Hello world");
    expect(state.done).toBe(false);
    expect(state.error).toBeNull();
  });

  it("prefers whole_response over accumulated deltas at end_of_stream", () => {
    const state = play([
      JSON.stringify({ delta: { delta: "partial" } }),
      JSON.stringify({ end_of_stream: { whole_response: "complete answer" } }),
    ]);
    expect(state.done).toBe(true);
    expect(state.text).toBe("complete answer");
  });

  it("keeps streamed text when end_of_stream has no whole_response", () => {
    const state = play([
      JSON.stringify({ delta: { delta: "streamed" } }),
      JSON.stringify({ end_of_stream: {} }),
    ]);
    expect(state.done).toBe(true);
    expect(state.text).toBe("streamed");
  });

  it("captures the error detail from error frames", () => {
    const state = play([
      JSON.stringify({ error: { detail: "quota exceeded" } }),
    ]);
    expect(state.error).toBe("quota exceeded");
    expect(state.done).toBe(false);
  });

  it("collects tool_output results with their file outputs", () => {
    const state = play([
      JSON.stringify({
        tool_output: {
          result: {
            type: "edit_kcl_code",
            status_code: 200,
            error: null,
            outputs: { "main.kcl": "sketch001 = startSketchOn(XY)" },
          },
        },
      }),
      JSON.stringify({ end_of_stream: { whole_response: "done" } }),
    ]);
    expect(state.toolResults).toHaveLength(1);
    expect(state.toolResults[0].type).toBe("edit_kcl_code");
    expect(state.toolResults[0].statusCode).toBe(200);
    expect(state.toolResults[0].outputs["main.kcl"]).toContain("startSketchOn");
  });

  it("ignores progress chatter and malformed frames", () => {
    const state = play([
      JSON.stringify({ session_data: { api_call_id: "x" } }),
      JSON.stringify({ conversation_id: { conversation_id: "y" } }),
      JSON.stringify({ reasoning: { type: "text", content: "thinking" } }),
      JSON.stringify({ attachments_loaded: {} }),
      "not json at all",
      JSON.stringify({ delta: { delta: "kept" } }),
    ]);
    expect(state.text).toBe("kept");
    expect(state.error).toBeNull();
  });

  it("stops folding frames after the stream terminates", () => {
    const state = play([
      JSON.stringify({ end_of_stream: { whole_response: "final" } }),
      JSON.stringify({ delta: { delta: "late" } }),
    ]);
    expect(state.text).toBe("final");
  });

  it("fails safely when the streamed text exceeds the safety limit", () => {
    const big = "x".repeat(300 * 1024);
    const state = play([JSON.stringify({ delta: { delta: big } })]);
    expect(state.error).toContain("safety limit");
  });

  it("captures the conversation id and project file updates", () => {
    const state = play([
      JSON.stringify({ conversation_id: { conversation_id: "conv-1" } }),
      JSON.stringify({
        project_updated: { files: { "main.kcl": "cube = 1" } },
      }),
      JSON.stringify({
        project_updated: { files: { "main.kcl": "cube = 2" } },
      }),
    ]);
    expect(state.conversationId).toBe("conv-1");
    expect(state.projectFiles["main.kcl"]).toBe("cube = 2");
  });

  it("captures the api call id from session_data", () => {
    const state = play([
      JSON.stringify({ session_data: { api_call_id: "call-42" } }),
    ]);
    expect(state.apiCallId).toBe("call-42");
    expect(state.done).toBe(false);
    expect(state.error).toBeNull();
  });

  it("counts reasoning frames as liveness without ending the turn", () => {
    const state = play([
      JSON.stringify({ reasoning: { type: "text", content: "thinking" } }),
      JSON.stringify({ reasoning: { type: "markdown", content: "more" } }),
    ]);
    expect(state.reasoningFrames).toBe(2);
    expect(state.text).toBe("");
    expect(state.error).toBeNull();
  });

  it("records a backend shutdown without failing the turn", () => {
    const state = play([
      JSON.stringify({ backend_shutdown: { reason: "service_refresh" } }),
      JSON.stringify({ delta: { delta: "still streaming" } }),
    ]);
    expect(state.shuttingDown).toBe(true);
    expect(state.error).toBeNull();
    expect(state.text).toBe("still streaming");
  });
});

/** Encode the subset of MsgPack the Replay decoder must understand. */
function packReplay(messages: Buffer[]): Buffer {
  const parts: Buffer[] = [];
  parts.push(Buffer.from([0x81])); // fixmap(1)
  const key = Buffer.from("replay", "utf8");
  parts.push(Buffer.from([0xa0 + key.length]), key); // fixstr
  parts.push(Buffer.from([0x81]));
  const inner = Buffer.from("messages", "utf8");
  parts.push(Buffer.from([0xa0 + inner.length]), inner);
  parts.push(Buffer.from([0x90 + messages.length])); // fixarray
  for (const message of messages) {
    const header = Buffer.alloc(2);
    header[0] = 0xc4; // bin8
    header[1] = message.length;
    parts.push(header, message);
  }
  return Buffer.concat(parts);
}

describe("reduceReplayFrame", () => {
  it("replays recorded JSON messages through the reducer", () => {
    const frame = packReplay([
      Buffer.from(JSON.stringify({ delta: { delta: "replayed " } })),
      Buffer.from(
        JSON.stringify({
          tool_output: {
            result: {
              type: "edit_kcl_code",
              status_code: 200,
              outputs: { "main.kcl": "cube = 3" },
            },
          },
        }),
      ),
      Buffer.from(JSON.stringify({ end_of_stream: {} })),
    ]);
    const state = reduceReplayFrame(initialCopilotState(), frame);
    expect(state.done).toBe(true);
    expect(state.text).toBe("replayed ");
    expect(state.toolResults[0].outputs["main.kcl"]).toBe("cube = 3");
  });

  it("ignores undecodable replay frames", () => {
    const state = reduceReplayFrame(
      initialCopilotState(),
      Buffer.from([0xc1, 0xff, 0x00]),
    );
    expect(state).toEqual(initialCopilotState());
  });
});

describe("decodeMsgPack", () => {
  it("decodes nested maps, arrays, strings and numbers", () => {
    const encoded = Buffer.concat([
      Buffer.from([0x82]), // fixmap(2)
      Buffer.from([0xa1]),
      Buffer.from("a"),
      Buffer.from([0x92, 0x01, 0xcc, 0xff]), // [1, 255]
      Buffer.from([0xa1]),
      Buffer.from("b"),
      Buffer.from([0xc3]), // true
    ]);
    expect(decodeMsgPack(encoded)).toEqual({ a: [1, 255], b: true });
  });
});
