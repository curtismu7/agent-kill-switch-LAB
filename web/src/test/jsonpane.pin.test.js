// The vendored shared/json files (JsonPane.jsx, JsonPane.css) match their pin files byte for byte, and the pins match the canonical hashes.
// They come from curtismu7/AI-DEMO-Standalone shared/json: change them there, re-pin, re-vendor; never edit them here.
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

const CANONICAL = {
  "JsonPane.jsx": "23b77832335718e30b6f62322f520ac6ada3d84be703316fa805b72bede4b48b",
  "JsonPane.css": "1e794d9470cf3b42d82b99927fcdcc41e5f61024afac92c926cae7afb66a8fbc",
};
const sha = (file) => createHash("sha256").update(fs.readFileSync(path.join(process.cwd(), "src", "components", file))).digest("hex");

describe("vendored json pane", () => {
  it("matches JsonPane.sha256 and JsonPane.css.sha256, and the canonical hashes", () => {
    const jsx = fs.readFileSync(path.join(process.cwd(), "src", "components", "JsonPane.sha256"), "utf8").trim().split(/\s+/);
    expect(jsx[0]).toBe(sha("JsonPane.jsx"));
    expect(jsx[0]).toBe(CANONICAL["JsonPane.jsx"]);
    const css = fs.readFileSync(path.join(process.cwd(), "src", "components", "JsonPane.css.sha256"), "utf8").trim().split(/\s+/);
    expect(css[0]).toBe(sha("JsonPane.css"));
    expect(css[0]).toBe(CANONICAL["JsonPane.css"]);
  });
});
