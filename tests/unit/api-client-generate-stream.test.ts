import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { aiApi } from "@/lib/api-client";

const encoder = new TextEncoder();

function mockStream(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  const stream = new ReadableStream<Uint8Array>({
    start(controller): void {
      for (const chunk of chunks) {
        controller.enqueue(chunk);
      }
      controller.close();
    },
  });
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(stream)));
  return stream;
}

function mockLines(
  lines: unknown[],
  trailingNewline = true
): ReadableStream<Uint8Array> {
  return mockStream([
    encoder.encode(
      lines.map((line) => JSON.stringify(line)).join("\n") +
        (trailingNewline ? "\n" : "")
    ),
  ]);
}

describe("aiApi.generateStream", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("rejects an in-band server error instead of returning partial data", async () => {
    const stream = mockLines([
      { type: "operation", operation: { op: "setName", name: "Partial" } },
      { type: "error", error: "Model provider unavailable" },
      { type: "operation", operation: { op: "setName", name: "Ignored" } },
    ]);
    const onUpdate = vi.fn();

    await expect(
      aiApi.generateStream("Build a workflow", onUpdate)
    ).rejects.toThrow("Model provider unavailable");
    expect(onUpdate).toHaveBeenCalledTimes(1);
    expect(onUpdate).toHaveBeenCalledWith({
      nodes: [],
      edges: [],
      name: "Partial",
    });
    expect(console.error).toHaveBeenCalledExactlyOnceWith(
      "[API Client] Error:",
      "Model provider unavailable"
    );
    expect(stream.locked).toBe(false);
  });

  it("rejects an error before any operation and provides a fallback reason", async () => {
    const stream = mockLines([{ type: "error" }]);
    const onUpdate = vi.fn();

    await expect(
      aiApi.generateStream("Build a workflow", onUpdate)
    ).rejects.toThrow("Failed to generate workflow");
    expect(onUpdate).not.toHaveBeenCalled();
    expect(stream.locked).toBe(false);
  });

  it("accumulates operations across byte boundaries and a final line without newline", async () => {
    const text = [
      { type: "operation", operation: { op: "setName", name: "Café" } },
      {
        type: "operation",
        operation: { op: "setDescription", description: "Complete workflow" },
      },
      { type: "complete" },
    ]
      .map((line) => JSON.stringify(line))
      .join("\n");
    const bytes = encoder.encode(text);
    const stream = mockStream(
      Array.from(bytes, (byte) => new Uint8Array([byte]))
    );
    const onUpdate = vi.fn();

    await expect(
      aiApi.generateStream("Build a workflow", onUpdate)
    ).resolves.toEqual({
      nodes: [],
      edges: [],
      name: "Café",
      description: "Complete workflow",
    });
    expect(onUpdate).toHaveBeenCalledTimes(2);
    expect(console.error).not.toHaveBeenCalled();
    expect(stream.locked).toBe(false);
  });

  it("skips malformed and blank lines but processes subsequent valid messages", async () => {
    mockStream([
      encoder.encode(
        '\ninvalid JSON\nnull\n42\n"ignored"\n{"type":"operation","operation":{"op":"setName","name":"Recovered"}}\n{"type":"complete"}\n'
      ),
    ]);

    await expect(
      aiApi.generateStream("Build a workflow", vi.fn())
    ).resolves.toEqual({
      nodes: [],
      edges: [],
      name: "Recovered",
    });
    expect(console.error).toHaveBeenCalledExactlyOnceWith(
      "[API Client] Failed to parse JSONL line:",
      expect.any(SyntaxError)
    );
  });

  it.each([
    { label: "empty", messages: [] },
    {
      label: "partial",
      messages: [
        { type: "operation", operation: { op: "setName", name: "Partial" } },
      ],
    },
  ])(
    "rejects a $label stream without the completion message",
    async ({ messages }) => {
      const stream = mockLines(messages);

      await expect(
        aiApi.generateStream("Build a workflow", vi.fn())
      ).rejects.toThrow("Workflow generation stream ended before completion");
      expect(stream.locked).toBe(false);
    }
  );

  it("propagates an error in the final line without a newline", async () => {
    mockLines([{ type: "error", error: "Generation stopped" }], false);

    await expect(
      aiApi.generateStream("Build a workflow", vi.fn())
    ).rejects.toThrow("Generation stopped");
  });

  it("propagates update-callback failures without mislabeling them as parse errors", async () => {
    const stream = mockLines([
      { type: "operation", operation: { op: "setName", name: "Workflow" } },
      { type: "complete" },
    ]);

    await expect(
      aiApi.generateStream("Build a workflow", () => {
        throw new Error("Update failed");
      })
    ).rejects.toThrow("Update failed");
    expect(console.error).not.toHaveBeenCalled();
    expect(stream.locked).toBe(false);
  });

  it("preserves the existing workflow when the server completes without changes", async () => {
    mockLines([{ type: "complete" }]);
    const existingWorkflow = { nodes: [], edges: [], name: "Existing" };

    await expect(
      aiApi.generateStream("Keep it", vi.fn(), existingWorkflow)
    ).resolves.toEqual(existingWorkflow);
    expect(fetch).toHaveBeenCalledWith("/api/ai/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "Keep it", existingWorkflow }),
    });
  });
});
