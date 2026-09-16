import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const { default: plugin, buildArgs, parseReport, formatSummary } = await import("../dist/index.js");

const nodeType = (type) => plugin.nodeTypes.find((n) => n.type === type);

function nodeCtx(overrides = {}) {
  const events = [];
  return {
    taskId: "t1",
    taskTitle: "task",
    workdir: mkdtempSync(join(tmpdir(), "ilmari-pw-work-")),
    outputs: {},
    emit: (type, data) => events.push({ type, data }),
    waitForEvent: async () => null,
    pluginConfig: () => ({}),
    events,
    ...overrides,
  };
}

/** A stand-in for the Playwright CLI: writes the given JSON report to the
 *  file ilmari asked for and exits with the given code. Exercises the real
 *  spawn, env and report-reading path without a browser. */
function fakePlaywright(report, exitCode = 0) {
  const dir = mkdtempSync(join(tmpdir(), "ilmari-pw-bin-"));
  const script = join(dir, "pw.mjs");
  writeFileSync(
    script,
    `import { writeFileSync } from "node:fs";
     const out = process.env.PLAYWRIGHT_JSON_OUTPUT_FILE;
     console.log("argv:", JSON.stringify(process.argv.slice(2)));
     ${report === null ? "" : `writeFileSync(out, ${JSON.stringify(JSON.stringify(report))});`}
     process.exit(${exitCode});`,
  );
  chmodSync(script, 0o755);
  return `node ${script}`;
}

const PASSING = {
  stats: { expected: 3, unexpected: 0, flaky: 0, skipped: 1, duration: 4210.5 },
  suites: [
    {
      title: "list.spec.ts",
      file: "e2e/list.spec.ts",
      line: 0,
      column: 0,
      specs: [
        {
          title: "shows first page",
          ok: true,
          file: "e2e/list.spec.ts",
          line: 4,
          tests: [{ status: "expected", projectName: "chromium", results: [] }],
        },
      ],
    },
  ],
};

const FAILING = {
  stats: { expected: 1, unexpected: 2, flaky: 1, skipped: 0, duration: 9000 },
  suites: [
    {
      title: "detail.spec.ts",
      file: "e2e/detail.spec.ts",
      line: 0,
      column: 0,
      specs: [],
      suites: [
        {
          title: "detail page",
          file: "e2e/detail.spec.ts",
          line: 3,
          column: 1,
          specs: [
            {
              title: "renders stats",
              ok: false,
              file: "e2e/detail.spec.ts",
              line: 12,
              tests: [
                {
                  status: "unexpected",
                  projectName: "chromium",
                  results: [
                    {
                      status: "failed",
                      error: { message: "[31mExpected: 6[39m\nReceived: 0" },
                      attachments: [
                        { name: "trace", path: "test-results/detail-renders/trace.zip", contentType: "application/zip" },
                        { name: "stdout", body: "x", contentType: "text/plain" },
                      ],
                    },
                  ],
                },
                {
                  status: "unexpected",
                  projectName: "mobile",
                  results: [{ status: "timedOut", errors: [{ message: "Test timeout of 30000ms exceeded." }], attachments: [] }],
                },
              ],
            },
            {
              title: "flaky one",
              ok: true,
              file: "e2e/detail.spec.ts",
              line: 30,
              tests: [{ status: "flaky", projectName: "chromium", results: [{ status: "passed", attachments: [] }] }],
            },
          ],
        },
      ],
    },
  ],
};

test("buildArgs maps params to the Playwright CLI and derives a per-shard output dir", () => {
  assert.deepEqual(buildArgs({}), ["test", "--reporter", "list,json"]);
  assert.deepEqual(
    buildArgs({ shard: "2/4", project: "chromium, mobile", workers: 2, grep: "@smoke", spec: "e2e/a.spec.ts e2e/b.spec.ts" }),
    [
      "test",
      "--project", "chromium",
      "--project", "mobile",
      "--shard=2/4",
      "--workers", "2",
      "--grep", "@smoke",
      "--output", "test-results/shard-2-4",
      "--reporter", "list,json",
      "e2e/a.spec.ts",
      "e2e/b.spec.ts",
    ],
  );
  // an explicit output dir wins over the derived one
  assert.ok(buildArgs({ shard: "1/2", output: "out" }).includes("out"));
  assert.ok(!buildArgs({ shard: "1/2", output: "out" }).join(" ").includes("shard-1-2"));
});

test("parseReport walks nested suites and keeps only unexpected/flaky tests", () => {
  const parsed = parseReport(FAILING);
  assert.equal(parsed.unexpected, 2);
  assert.equal(parsed.flaky, 1);
  assert.equal(parsed.failures.length, 3);
  const [first, second, flaky] = parsed.failures;
  assert.equal(first.title, "detail page > renders stats");
  assert.equal(first.location, "e2e/detail.spec.ts:12");
  assert.equal(first.project, "chromium");
  assert.equal(first.error, "Expected: 6\nReceived: 0", "ANSI codes are stripped");
  assert.deepEqual(first.attachments, ["trace: test-results/detail-renders/trace.zip"], "inline attachments are skipped");
  assert.equal(second.error, "Test timeout of 30000ms exceeded.", "falls back to errors[]");
  assert.equal(flaky.status, "flaky");
  assert.equal(parseReport(PASSING).failures.length, 0);
});

test("formatSummary starts with the verdict line and ends with a JSON block", () => {
  const text = formatSummary(parseReport(FAILING), { shard: "1/2", exitCode: 1 });
  assert.match(text, /^FAIL: 1 passed, 2 failed, 1 flaky, 0 skipped \(9\.0s, shard 1\/2\)/);
  assert.match(text, /### detail page > renders stats \[chromium\]/);
  const json = JSON.parse(text.slice(text.lastIndexOf("```json") + 7, text.lastIndexOf("```")));
  assert.equal(json.failed, 3);
  assert.equal(json.exitCode, 1);
  assert.match(formatSummary(parseReport(PASSING), {}), /^PASS: 3 passed/);
});

test("playwright-test passes on a green report and returns the summary", async () => {
  const ctx = nodeCtx();
  const res = await nodeType("playwright-test").run({ bin: fakePlaywright(PASSING), shard: "1/1" }, ctx);
  assert.equal(res.ok, true);
  assert.match(res.output, /^PASS: 3 passed/);
  const started = ctx.events.find((e) => e.type === "playwright_started");
  assert.match(started.data.command, /--shard=1\/1/);
  assert.equal(ctx.events.find((e) => e.type === "playwright_result").data.unexpected, 0);
});

test("playwright-test fails the step on red tests, with the report as the reason", async () => {
  const ctx = nodeCtx();
  const res = await nodeType("playwright-test").run({ bin: fakePlaywright(FAILING, 1) }, ctx);
  assert.equal(res.ok, false);
  assert.match(res.reason, /^FAIL: 1 passed, 2 failed/);
  assert.match(res.reason, /e2e\/detail\.spec\.ts:12/);
});

test("failOnTestFailure=false turns red tests into a successful step with a FAIL: result", async () => {
  const res = await nodeType("playwright-test").run(
    { bin: fakePlaywright(FAILING, 1), failOnTestFailure: false },
    nodeCtx(),
  );
  assert.equal(res.ok, true);
  assert.match(res.output, /^FAIL:/);
});

test("playwright-test reports the CLI's output tail when no JSON report appears", async () => {
  const res = await nodeType("playwright-test").run({ bin: fakePlaywright(null, 1) }, nodeCtx());
  assert.equal(res.ok, false);
  assert.match(res.reason, /no JSON report produced \(exit 1\)/);
  assert.match(res.reason, /argv:/);
});

test("template params render from earlier node outputs", async () => {
  const ctx = nodeCtx({ outputs: { item: "3/4" } });
  const res = await nodeType("playwright-test").run({ bin: fakePlaywright(PASSING), shard: "{{item}}" }, ctx);
  assert.equal(res.ok, true);
  assert.match(ctx.events[0].data.command, /--shard=3\/4/);
  assert.match(ctx.events[0].data.command, /test-results\/shard-3-4/);
});

test("playwright-install refuses odd browser names and runs the install command", async () => {
  const bad = await nodeType("playwright-install").run({ browsers: "chromium; rm -rf /" }, nodeCtx());
  assert.equal(bad.ok, false);
  const ctx = nodeCtx();
  const ok = await nodeType("playwright-install").run(
    { bin: fakePlaywright(null, 0), browsers: "chromium webkit", withDeps: true },
    ctx,
  );
  assert.equal(ok.ok, true);
  assert.equal(ok.output, "installed: chromium, webkit");
  assert.match(ctx.events[0].data.command, /install --with-deps chromium webkit$/);
});

test("entry is statically inspectable with the declared capabilities", async () => {
  const src = process.env.ILMARI_SRC;
  if (!src) {
    console.log("ILMARI_SRC not set, skipping static inspect");
    return;
  }
  const { inspectPluginSource } = await import(`${src}/src/plugin-static.ts`);
  const result = inspectPluginSource(readFileSync(new URL("../dist/index.js", import.meta.url), "utf8"));
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(result.meta.capabilities, ["exec", "fs", "net"]);
  assert.deepEqual(result.meta.nodeTypes.map((n) => n.type), ["playwright-test", "playwright-screenshot", "playwright-install"]);
});

const { resolveBin, slugForUrl, parseViewports } = await import("../dist/index.js");

/** Fake CLI that also answers --version and writes an empty PNG for `screenshot`. */
function fakePlaywrightCli() {
  const dir = mkdtempSync(join(tmpdir(), "ilmari-pw-cli-"));
  const script = join(dir, "pw.mjs");
  writeFileSync(
    script,
    `import { writeFileSync, mkdirSync } from "node:fs";
     import { dirname } from "node:path";
     const [cmd, ...rest] = process.argv.slice(2);
     if (cmd === "--version") { console.log("Version 1.55.0"); process.exit(0); }
     if (cmd === "screenshot") {
       const file = rest.at(-1);
       mkdirSync(dirname(file), { recursive: true });
       writeFileSync(file, "png");
       console.log("shot", JSON.stringify(rest));
       process.exit(0);
     }
     process.exit(2);`,
  );
  return `node ${script}`;
}

test("slugForUrl and parseViewports", () => {
  assert.equal(slugForUrl("http://127.0.0.1:4173/"), "home");
  assert.equal(slugForUrl("http://x/pokemon/25?tab=stats"), "pokemon-25-tab-stats");
  assert.equal(slugForUrl("/"), "home");
  assert.deepEqual(parseViewports("1280x800 390x844").viewports, [{ w: 1280, h: 800 }, { w: 390, h: 844 }]);
  assert.deepEqual(parseViewports("").viewports, [{ w: 1280, h: 800 }]);
  assert.match(parseViewports("big").error, /invalid viewport/);
});

test("resolveBin keeps a working CLI and falls back to npx only for the default bin", () => {
  const ctx = nodeCtx();
  const good = resolveBin(fakePlaywrightCli(), ctx, true);
  assert.equal(good.fallback, false);
  const explicit = resolveBin("node -e 'process.exit(1)'", ctx, true);
  assert.match(explicit.error, /not available/);
  // a non-default bin never falls back, whatever the flag says
  const noFallback = resolveBin("node -e 'process.exit(1)'", ctx, false);
  assert.match(noFallback.error, /not available/);
});

test("playwright-screenshot starts the server, captures every url x viewport and stops the server", async () => {
  const ctx = nodeCtx();
  const port = 4190 + Math.floor(Math.random() * 100);
  const serve = `node -e "require('node:http').createServer((q,s)=>s.end('ok')).listen(${port})"`;
  const res = await nodeType("playwright-screenshot").run(
    {
      bin: fakePlaywrightCli(),
      serve,
      baseUrl: `http://127.0.0.1:${port}`,
      urls: "/ /pokemon/25",
      viewports: "1280x800 390x844",
      output: "shots",
      waitMs: 10,
    },
    ctx,
  );
  assert.equal(res.ok, true, res.reason);
  assert.match(res.output, /^Screenshots: 4 file\(s\) in shots/);
  assert.match(res.output, /shots\/home-1280x800\.png/);
  assert.match(res.output, /shots\/pokemon-25-390x844\.png/);
  assert.ok(existsSync(join(ctx.workdir, "shots", "pokemon-25-1280x800.png")));
  // server was stopped: the port no longer answers
  await new Promise((r) => setTimeout(r, 300));
  await assert.rejects(fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1500) }));
});

test("playwright-screenshot fails with the server output when the app never answers", async () => {
  const res = await nodeType("playwright-screenshot").run(
    { bin: fakePlaywrightCli(), serve: "node -e \"console.error('boom: port in use'); setTimeout(()=>{}, 100000)\"", baseUrl: "http://127.0.0.1:4599", urls: "/", serveTimeoutSec: 2 },
    nodeCtx(),
  );
  assert.equal(res.ok, false);
  assert.match(res.reason, /did not answer/);
  assert.match(res.reason, /boom: port in use/);
});

test("playwright-screenshot refuses an empty url list and bad viewports", async () => {
  const none = await nodeType("playwright-screenshot").run({ bin: fakePlaywrightCli(), urls: "" }, nodeCtx());
  assert.match(none.reason, /no urls/);
  const bad = await nodeType("playwright-screenshot").run({ bin: fakePlaywrightCli(), urls: "/", viewports: "wide" }, nodeCtx());
  assert.match(bad.reason, /invalid viewport/);
});
