// ilmari-plugin-playwright — run Playwright end-to-end tests as a workflow
// step. The node runs the project's own Playwright (npx --no-install) headless
// in the task's worktree, asks for a JSON report and turns it into a Markdown
// summary an agent can act on: which tests failed, where, with which error
// and which trace/screenshot files. Shards are first-class so a `map` node can
// fan the suite out across parallel items.
//
// Zero dependencies; Node >= 20.

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DEFAULT_BIN = "npx --no-install playwright";
const DEFAULT_TIMEOUT_SEC = 1200;
const MAX_ERROR_CHARS = 1200;
const MAX_FAILURES_LISTED = 25;
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

/** `{{var}}` interpolation over a flat context; unknown keys stay verbatim so a
 *  typo is visible in the output instead of silently blank. */
export function render(template, vars) {
  return String(template ?? "").replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (m, key) =>
    vars[key] === undefined ? m : String(vars[key]),
  );
}

/** Shell-quote one argument (POSIX single quotes); the command runs through
 *  a shell so npx/pnpm resolution works the same way it does for a human. */
function q(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

/** Build the `playwright test` argv from node params. Exported for tests. */
export function buildArgs(params) {
  const args = ["test"];
  const str = (k) => String(params[k] ?? "").trim();
  if (str("config")) args.push("--config", str("config"));
  if (str("project")) {
    for (const p of str("project").split(/[,\s]+/).filter(Boolean)) args.push("--project", p);
  }
  if (str("shard")) args.push(`--shard=${str("shard")}`);
  if (str("workers")) args.push("--workers", str("workers"));
  if (str("retries")) args.push("--retries", str("retries"));
  if (str("grep")) args.push("--grep", str("grep"));
  if (str("output")) args.push("--output", str("output"));
  else if (str("shard")) {
    args.push("--output", `test-results/shard-${str("shard").replace(/[^0-9a-zA-Z]+/g, "-")}`);
  }
  args.push("--reporter", "list,json");
  if (str("spec")) for (const s of str("spec").split(/\s+/).filter(Boolean)) args.push(s);
  return args;
}

/** Walk the JSON report and collect every test whose outcome was not the
 *  expected one. Exported for tests. */
export function parseReport(report) {
  const stats = report?.stats ?? {};
  const failures = [];
  const isFile = (t) => /\.[cm]?[jt]sx?$/.test(t);
  const walk = (suite, path) => {
    const here = suite.title && !isFile(suite.title) ? [...path, suite.title] : path;
    for (const spec of suite.specs ?? []) {
      for (const test of spec.tests ?? []) {
        if (test.status === "expected" || test.status === "skipped") continue;
        const last = (test.results ?? []).at(-1) ?? {};
        const err = last.error?.message ?? last.errors?.[0]?.message ?? "";
        failures.push({
          title: [...here, spec.title].join(" > "),
          project: test.projectName ?? "",
          location: `${spec.file}:${spec.line}`,
          status: test.status,
          error: String(err).replace(ANSI, "").slice(0, MAX_ERROR_CHARS),
          attachments: (last.attachments ?? [])
            .filter((a) => a.path)
            .map((a) => `${a.name}: ${a.path}`),
        });
      }
    }
    for (const child of suite.suites ?? []) walk(child, here);
  };
  for (const suite of report?.suites ?? []) walk(suite, []);
  return {
    expected: stats.expected ?? 0,
    unexpected: stats.unexpected ?? 0,
    flaky: stats.flaky ?? 0,
    skipped: stats.skipped ?? 0,
    durationMs: Math.round(stats.duration ?? 0),
    failures,
  };
}

/** Markdown the fix agent reads; a fenced JSON block at the end keeps the
 *  numbers machine-readable for a decide node or a later http step. */
export function formatSummary(parsed, meta) {
  const verdict = parsed.unexpected === 0 ? "PASS" : "FAIL";
  const seconds = (parsed.durationMs / 1000).toFixed(1);
  const shard = meta.shard ? `, shard ${meta.shard}` : "";
  const lines = [
    `${verdict}: ${parsed.expected} passed, ${parsed.unexpected} failed, ${parsed.flaky} flaky, ${parsed.skipped} skipped (${seconds}s${shard})`,
  ];
  for (const f of parsed.failures.slice(0, MAX_FAILURES_LISTED)) {
    lines.push("", `### ${f.title}${f.project ? ` [${f.project}]` : ""}`, `- ${f.location} (${f.status})`);
    if (f.error) lines.push("", "```", f.error, "```");
    for (const a of f.attachments) lines.push(`- ${a}`);
  }
  if (parsed.failures.length > MAX_FAILURES_LISTED) {
    lines.push("", `... and ${parsed.failures.length - MAX_FAILURES_LISTED} more failures`);
  }
  const { failures, ...numbers } = parsed;
  lines.push("", "```json", JSON.stringify({ ...numbers, failed: failures.length, ...meta }), "```");
  return lines.join("\n");
}

function runShell(command, ctx, timeoutSec, env) {
  const res = spawnSync(command, {
    cwd: ctx.workdir,
    shell: true,
    encoding: "utf8",
    timeout: timeoutSec * 1000,
    env: { ...process.env, CI: "1", ...env },
    maxBuffer: 64 * 1024 * 1024,
  });
  return { status: res.status, signal: res.signal, out: (res.stdout ?? "") + (res.stderr ?? "") };
}

const tail = (text, n) => String(text).split("\n").slice(-n).join("\n");

export default {
  name: "ilmari-plugin-playwright",
  version: "0.1.0",
  description:
    "Runs the project's Playwright end-to-end tests headless as a workflow step and turns the result into a report an agent can act on: which tests failed, where, with which error and which trace or screenshot files. Shards are a parameter, so a map node can run the suite across parallel items. A second step installs the browsers.",
  setup:
    "The project must already depend on @playwright/test (it is run through `npx --no-install playwright`, so nothing is downloaded at run time). Browsers come from the playwright-install step or from a base image that has them. No credentials.",
  capabilities: ["exec", "fs"],

  nodeTypes: [
    {
      type: "playwright-test",
      glyph: "",
      description:
        "Run Playwright tests headless in the task's worktree and produce a Markdown report: a PASS/FAIL line with counts, then every failed test with file:line, the error and its trace/screenshot paths, and a JSON block with the numbers. By default a failing test fails the step (and the task); set failOnTestFailure to false to get the report as {{<id>.result}} instead and route on it with a decide node. Runs unsandboxed with the ilmari server's own user, like the shell step.",
      params: {
        spec: {
          type: "string",
          description:
            "Test files or directories to run, space separated. Empty = the whole suite from the config.",
          example: "e2e/list.spec.ts e2e/detail.spec.ts",
        },
        project: {
          type: "string",
          description: "Playwright project name(s) from the config, comma separated. Empty = all projects.",
          example: "chromium",
        },
        shard: {
          type: "string",
          description:
            'Run one shard of the suite as current/total. Inside a map node use {{item}} over a list like ["1/4","2/4","3/4","4/4"] to run shards in parallel; each shard writes its artifacts to test-results/shard-<n>-<m>.',
          example: "{{item}}",
        },
        workers: {
          type: "number",
          description:
            "Parallel workers inside this run (Playwright --workers). Empty = Playwright's default, half the cores.",
          example: "4",
        },
        retries: {
          type: "number",
          description: "Retries per failing test (Playwright --retries). Empty = the config's value.",
          example: "1",
        },
        grep: {
          type: "string",
          description: "Only run tests whose title matches this regular expression.",
          example: "@smoke",
        },
        config: {
          type: "string",
          description: "Path to the Playwright config. Empty = Playwright's default lookup.",
          example: "playwright.config.ts",
        },
        output: {
          type: "string",
          description:
            "Folder for traces and screenshots. Empty = test-results, or test-results/shard-<n>-<m> when sharding.",
          example: "test-results",
        },
        failOnTestFailure: {
          type: "boolean",
          description:
            "true (default): a failing test fails this step. false: the step succeeds and the report is its result, first line PASS: or FAIL:, for a decide node to route on.",
          example: "false",
        },
        timeoutSec: {
          type: "number",
          description: "Kill the run and fail the step after this many seconds (default 1200).",
          example: "900",
        },
        bin: {
          type: "string",
          description: "Command that runs the Playwright CLI (default: npx --no-install playwright).",
          example: "pnpm exec playwright",
        },
      },
      async run(params, ctx) {
        const vars = { ...ctx.outputs, task: ctx.taskTitle };
        const rendered = Object.fromEntries(
          Object.entries(params).map(([k, v]) => [k, typeof v === "string" ? render(v, vars) : v]),
        );
        const bin = String(rendered.bin ?? "").trim() || DEFAULT_BIN;
        const timeoutSec = Number(rendered.timeoutSec ?? DEFAULT_TIMEOUT_SEC) || DEFAULT_TIMEOUT_SEC;
        const failOnTestFailure =
          rendered.failOnTestFailure !== false && String(rendered.failOnTestFailure) !== "false";
        const args = buildArgs(rendered);
        const tmp = mkdtempSync(join(tmpdir(), "ilmari-playwright-"));
        const reportFile = join(tmp, "report.json");
        const command = `${bin} ${args.map(q).join(" ")}`;
        ctx.emit("playwright_started", { command, shard: String(rendered.shard ?? "") });
        try {
          const res = runShell(command, ctx, timeoutSec, { PLAYWRIGHT_JSON_OUTPUT_FILE: reportFile });
          let report;
          try {
            report = JSON.parse(readFileSync(reportFile, "utf8"));
          } catch {
            // no report: the CLI itself failed (no config, no browsers, syntax
            // error) or was killed — surface its tail instead of a bare exit code
            ctx.emit("playwright_result", {
              exitCode: res.status ?? -1,
              report: false,
              outputTail: tail(res.out, 30),
            });
            return {
              ok: false,
              reason: res.signal
                ? `playwright-test: killed by ${res.signal} after ${timeoutSec}s`
                : `playwright-test: no JSON report produced (exit ${res.status}). Output tail:\n${tail(res.out, 30)}`,
            };
          }
          const parsed = parseReport(report);
          const summary = formatSummary(parsed, {
            shard: String(rendered.shard ?? ""),
            exitCode: res.status ?? -1,
          });
          ctx.emit("playwright_result", {
            exitCode: res.status ?? -1,
            expected: parsed.expected,
            unexpected: parsed.unexpected,
            flaky: parsed.flaky,
            skipped: parsed.skipped,
            failed: parsed.failures.map((f) => f.location),
          });
          if (parsed.unexpected > 0 && failOnTestFailure) return { ok: false, reason: summary };
          if (parsed.unexpected === 0 && res.status !== 0) {
            return {
              ok: false,
              reason: `playwright-test: exit ${res.status ?? res.signal} with no failing tests. Output tail:\n${tail(res.out, 20)}`,
            };
          }
          return { ok: true, output: summary };
        } finally {
          rmSync(tmp, { recursive: true, force: true });
        }
      },
    },
    {
      type: "playwright-install",
      glyph: "",
      description:
        "Download the browsers Playwright needs (and, with withDeps, their system libraries) into the machine's Playwright cache. Idempotent: a second run is a quick no-op. Put it before playwright-test on a fresh machine; skip it when the base image already ships browsers.",
      params: {
        browsers: {
          type: "string",
          description:
            "Browsers to install, space separated: chromium, firefox, webkit. Empty = chromium only.",
          example: "chromium",
        },
        withDeps: {
          type: "boolean",
          description:
            "Also install operating-system libraries (--with-deps). Needs root on Linux; leave off on a developer machine.",
          example: "false",
        },
        timeoutSec: {
          type: "number",
          description: "Fail the step after this many seconds (default 900).",
          example: "600",
        },
        bin: {
          type: "string",
          description: "Command that runs the Playwright CLI (default: npx --no-install playwright).",
          example: "pnpm exec playwright",
        },
      },
      async run(params, ctx) {
        const bin = String(params.bin ?? "").trim() || DEFAULT_BIN;
        const browsers = String(params.browsers ?? "").trim() || "chromium";
        const names = browsers.split(/[\s,]+/).filter(Boolean);
        if (names.some((n) => !/^[a-z-]+$/.test(n))) {
          return { ok: false, reason: `playwright-install: invalid browser name in "${browsers}"` };
        }
        const withDeps = params.withDeps === true || String(params.withDeps) === "true";
        const command = `${bin} install${withDeps ? " --with-deps" : ""} ${names.join(" ")}`;
        const res = runShell(command, ctx, Number(params.timeoutSec ?? 900) || 900, {});
        ctx.emit("playwright_install", {
          command,
          exitCode: res.status ?? -1,
          outputTail: tail(res.out, 10),
        });
        if (res.status !== 0) {
          return {
            ok: false,
            reason: `"${command}" exited ${res.status ?? res.signal}:\n${tail(res.out, 20)}`,
          };
        }
        return { ok: true, output: `installed: ${names.join(", ")}` };
      },
    },
  ],
};
