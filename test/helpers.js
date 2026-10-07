import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const shop = JSON.parse(fs.readFileSync(path.join(root, "config/shop.json"), "utf8"));
// Wednesday 7 October 2026, 11:00 in Dublin.
export const fixedClock = () => new Date("2026-10-07T10:00:00Z");
export const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "abc-"));

// Stands in for the Anthropic client: plays back scripted responses as streams.
export function fakeClient(script) {
  const calls = [];
  return {
    calls,
    beta: {
      messages: {
        stream(params) {
          calls.push(structuredClone(params));
          const next = script.shift();
          if (!next) throw new Error("fake client ran out of scripted responses");
          const handlers = { text: [], streamEvent: [] };
          return {
            on(ev, cb) { handlers[ev]?.push(cb); return this; },
            abort() {},
            async finalMessage() {
              for (const block of next.content) {
                handlers.streamEvent.forEach((cb) => cb({ type: "content_block_start", content_block: block }));
                if (block.type === "text") handlers.text.forEach((cb) => cb(block.text));
              }
              return { stop_reason: next.content.some((b) => b.type === "tool_use") ? "tool_use" : "end_turn", ...next };
            },
          };
        },
      },
    },
  };
}

export const toolUse = (id, name, input) => ({ type: "tool_use", id, name, input });
export const text = (t) => ({ type: "text", text: t });
