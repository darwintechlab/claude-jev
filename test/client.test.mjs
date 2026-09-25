import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { decide, resolveBackend, MAX_STATE_CHARS } from "../mcp-server/dist/client.js";

const realFetch = globalThis.fetch;
const q = { q: { type: "noul", instructions: "Is this urgent?" } };
const opts = { apiKey: "test-key", baseURL: "http://jev.test", maxRetries: 2 };
const ok = () => new Response(JSON.stringify({ model: "m", answers: { q: { type: "noul", noul: 0.9 } } }), { status: 200 });

/** Stub fetch with `handler(callNumber)`; returns the list of parsed request bodies. */
function stubFetch(handler) {
  const bodies = [];
  globalThis.fetch = async (_url, init) => {
    bodies.push(JSON.parse(init.body));
    return handler(bodies.length);
  };
  return bodies;
}

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("decide — state", () => {
  it("sends oversized state truncated to the cap", async () => {
    const bodies = stubFetch(ok);
    await decide("x".repeat(MAX_STATE_CHARS + 10_000), q, opts);
    assert.ok(bodies[0].state.length <= MAX_STATE_CHARS, `sent ${bodies[0].state.length} chars`);
    assert.match(bodies[0].state, /truncated/);
  });
  it("sends object state unchanged when under the cap", async () => {
    const bodies = stubFetch(ok);
    await decide({ ticket: "payouts failing" }, q, opts);
    assert.deepEqual(bodies[0].state, { ticket: "payouts failing" });
  });
});

describe("decide — retries", () => {
  it("retries 5xx and succeeds", async () => {
    const bodies = stubFetch((n) => (n < 2 ? new Response("down", { status: 503 }) : ok()));
    await decide("s", q, opts);
    assert.equal(bodies.length, 2);
  });
  it("retries network errors and gives up after maxRetries", async () => {
    const bodies = stubFetch(() => {
      throw new TypeError("fetch failed");
    });
    await assert.rejects(decide("s", q, opts), /fetch failed/);
    assert.equal(bodies.length, 3);
  });
  it("does not retry a 400", async () => {
    const bodies = stubFetch(() => new Response("bad", { status: 400 }));
    await assert.rejects(decide("s", q, opts), /400/);
    assert.equal(bodies.length, 1);
  });
  it("does not retry a 200 with an unparseable body", async () => {
    const bodies = stubFetch(() => new Response("not json", { status: 200 }));
    await assert.rejects(decide("s", q, opts));
    assert.equal(bodies.length, 1);
  });
  it("does not retry a 200 missing answers", async () => {
    const bodies = stubFetch(() => new Response("{}", { status: 200 }));
    await assert.rejects(decide("s", q, opts), /missing answers/);
    assert.equal(bodies.length, 1);
  });
});

describe("resolveBackend", () => {
  it("treats an empty TYPESAFE_API_KEY as unset and falls back to JEV_API_KEY", () => {
    const saved = { t: process.env.TYPESAFE_API_KEY, j: process.env.JEV_API_KEY };
    try {
      process.env.TYPESAFE_API_KEY = "";
      process.env.JEV_API_KEY = "jev-key";
      assert.equal(resolveBackend().apiKey, "jev-key");
      delete process.env.JEV_API_KEY;
      assert.throws(() => resolveBackend(), /TYPESAFE_API_KEY is required/);
    } finally {
      for (const [k, v] of [["TYPESAFE_API_KEY", saved.t], ["JEV_API_KEY", saved.j]]) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });
});
