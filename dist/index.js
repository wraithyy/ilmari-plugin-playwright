// ilmari-plugin-playwright — run Playwright end-to-end tests as a workflow
// step. The node runs the project's own Playwright (npx --no-install) headless
// in the task's worktree, asks for a JSON report and turns it into a Markdown
// summary an agent can act on: which tests failed, where, with which error
// and which trace/screenshot files. Shards are first-class so a `map` node can
// fan the suite out across parallel items.
//
// Zero dependencies; Node >= 20. `net` is only used by the screenshot
// step's fallback (npx download of a pinned Playwright and Chromium) and by
// its readiness poll of the app under test.

import { spawn, spawnSync } from "node:child_process";
import { createHmac } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";

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

/** Environment for child processes: the daemon's, minus node:test's own
 *  context marker (an inherited NODE_TEST_CONTEXT makes a child node wait for
 *  a test harness that never talks to it). */
function childEnv(extra) {
  const { NODE_TEST_CONTEXT: _ignored, ...env } = process.env;
  return { ...env, CI: "1", ...extra };
}

function runShell(command, ctx, timeoutSec, env) {
  const res = spawnSync(command, {
    cwd: ctx.workdir,
    shell: true,
    encoding: "utf8",
    timeout: timeoutSec * 1000,
    env: childEnv(env),
    maxBuffer: 64 * 1024 * 1024,
  });
  return { status: res.status, signal: res.signal, out: (res.stdout ?? "") + (res.stderr ?? "") };
}

const tail = (text, n) => String(text).split("\n").slice(-n).join("\n");

const FALLBACK_BIN = "npx -y playwright@1.55.0";
const DEFAULT_SCREENSHOT_BASE = "http://127.0.0.1:4173";

/** Pick the Playwright CLI: the project's own when present, else (when
 *  allowed) a pinned npx download, so screenshots work in a repo that has no
 *  Playwright dependency at all. Exported for tests. */
export function resolveBin(bin, ctx, allowFallback) {
  const probe = spawnSync(`${bin} --version`, { cwd: ctx.workdir, shell: true, encoding: "utf8", timeout: 60_000 });
  if (probe.status === 0) return { bin, fallback: false };
  if (!allowFallback || bin !== DEFAULT_BIN) {
    return { error: `playwright CLI not available via "${bin}": ${tail((probe.stdout ?? "") + (probe.stderr ?? ""), 5)}` };
  }
  return { bin: FALLBACK_BIN, fallback: true };
}

/** "/pokemon/25?x=1" -> "pokemon-25-x-1"; "/" -> "home". Exported for tests. */
export function slugForUrl(url) {
  let path = url;
  try {
    const u = new URL(url);
    path = `${u.pathname}${u.search}`;
  } catch {
    // relative path already
  }
  const slug = path.replace(/^\/+|\/+$/g, "").replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return slug || "home";
}

/** Split "1280x800 390x844" into [{w,h}]; invalid entries are reported, not guessed. */
export function parseViewports(text) {
  const out = [];
  for (const part of String(text ?? "").split(/[\s,;]+/).filter(Boolean)) {
    const m = /^(\d{2,5})x(\d{2,5})$/i.exec(part);
    if (!m) return { error: `invalid viewport "${part}", expected WIDTHxHEIGHT` };
    out.push({ w: Number(m[1]), h: Number(m[2]) });
  }
  return { viewports: out.length ? out : [{ w: 1280, h: 800 }] };
}

async function waitForHttp(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError = "";
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(3000), redirect: "manual" });
      if (res.status < 500) return { ok: true };
      lastError = `HTTP ${res.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return { ok: false, reason: lastError };
}

/** Start the app under test in its own process group so the whole tree
 *  (pnpm -> vite -> esbuild) can be stopped afterwards. */
function startServer(command, cwd) {
  const child = spawn(command, { cwd, shell: true, detached: true, stdio: ["ignore", "pipe", "pipe"], env: childEnv({}) });
  let output = "";
  const collect = (chunk) => {
    output += String(chunk);
    if (output.length > 20_000) output = output.slice(-20_000);
  };
  child.stdout.on("data", collect);
  child.stderr.on("data", collect);
  child.on("error", (e) => collect(`spawn error: ${e.message}\n`));
  return {
    child,
    output: () => output,
    stop: () => {
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {
        try {
          child.kill("SIGTERM");
        } catch {
          // already gone
        }
      }
    },
  };
}

/* ---------- login: storage state + token for the rest of the run ---------- */

const NAME = "ilmari-plugin-playwright";
const LOGIN_PACKAGE = "playwright@1.55.0";

/** Where a run's auth artefacts live: outside the worktree (a later deliver
 *  commits whatever is dirty there) and per task, so parallel runs never
 *  share a session. */
export function authDirFor(taskId) {
  return join(tmpdir(), "ilmari-playwright", taskId || "run", "auth");
}

/** RFC 6238 TOTP (SHA-1, 30 s, 6 digits) from a base32 secret, so an MFA
 *  prompt on a dedicated test account can be answered without a phone. */
export function totp(base32Secret, now = Date.now()) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const clean = String(base32Secret).toUpperCase().replace(/[^A-Z2-7]/g, "");
  let bits = "";
  for (const c of clean) bits += alphabet.indexOf(c).toString(2).padStart(5, "0");
  const key = Buffer.from(bits.match(/.{8}/g)?.map((b) => parseInt(b, 2)) ?? []);
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(now / 30_000)));
  const h = createHmac("sha1", key).update(counter).digest();
  const offset = h[h.length - 1] & 0x0f;
  const code = ((h[offset] & 0x7f) << 24) | (h[offset + 1] << 16) | (h[offset + 2] << 8) | h[offset + 3];
  return String(code % 1_000_000).padStart(6, "0");
}

/** GUI-stored login config (ctx.pluginConfig) wins per key, env is the
 *  headless fallback — the same convention as the other marketplace plugins. */
function loginConfig(ctx) {
  const fromCtx = ctx?.pluginConfig?.(NAME, ctx.project) ?? {};
  const pick = (k, env) => (fromCtx[k] !== undefined && fromCtx[k] !== "" ? String(fromCtx[k]) : process.env[env] ?? "");
  return {
    user: pick("loginUser", "PLAYWRIGHT_LOGIN_USER"),
    password: pick("loginPassword", "PLAYWRIGHT_LOGIN_PASSWORD"),
    totpSecret: pick("loginTotpSecret", "PLAYWRIGHT_LOGIN_TOTP_SECRET"),
  };
}

/** Parse the `steps` DSL: one step per line, `verb rest`. Exported for tests. */
export function parseSteps(text) {
  const steps = [];
  for (const raw of String(text ?? "").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^(goto|fill|click|press|wait|waitUrl|expect)\s+(.*)$/.exec(line);
    if (!m) return { error: `unknown step "${line}" (verbs: goto, fill, click, press, wait, waitUrl, expect)` };
    const [, verb, rest] = m;
    if (verb === "fill" || verb === "press") {
      const sp = rest.indexOf(" ");
      if (sp < 0) return { error: `"${line}" needs a selector and a value` };
      steps.push({ verb, selector: rest.slice(0, sp).trim(), value: rest.slice(sp + 1).trim() });
    } else {
      steps.push({ verb, selector: rest.trim() });
    }
  }
  return steps.length ? { steps } : { error: "no steps given" };
}

/** Where the login module comes from: the project's Playwright when it has
 *  one, else a pinned copy installed once into a temp prefix (network). */
function resolvePlaywrightModule(ctx, allowFallback) {
  const probe = spawnSync(
    `node -e "console.log(require.resolve('playwright', { paths: [process.cwd()] }))"`,
    { cwd: ctx.workdir, shell: true, encoding: "utf8", timeout: 30_000 },
  );
  if (probe.status === 0 && probe.stdout.trim()) return { module: probe.stdout.trim(), fallback: false };
  if (!allowFallback) return { error: "the project has no `playwright` package and installIfMissing is off" };
  const prefix = join(tmpdir(), "ilmari-playwright", "runtime");
  const modulePath = join(prefix, "node_modules", "playwright", "index.js");
  if (!existsSync(modulePath)) {
    const inst = spawnSync(`npm install --prefix ${q(prefix)} --no-audit --no-fund --no-save ${LOGIN_PACKAGE}`, {
      shell: true, encoding: "utf8", timeout: 600_000, env: childEnv({}),
    });
    if (inst.status !== 0) return { error: `installing ${LOGIN_PACKAGE} failed:\n${tail((inst.stdout ?? "") + (inst.stderr ?? ""), 15)}` };
    const br = spawnSync(`npx -y ${LOGIN_PACKAGE} install chromium`, { shell: true, encoding: "utf8", timeout: 600_000, env: childEnv({}) });
    if (br.status !== 0) return { error: `chromium install failed:\n${tail((br.stdout ?? "") + (br.stderr ?? ""), 15)}` };
  }
  return { module: modulePath, fallback: true };
}

/** The script that drives the browser. Written to a temp file per run and
 *  executed with plain node; secrets reach it only through its environment
 *  and never come back out (stdout carries paths and counts). */
const LOGIN_RUNNER = String.raw`
import { chromium } from process.env.ILMARI_PW_MODULE;
import { readFileSync, writeFileSync, chmodSync } from "node:fs";
const cfg = JSON.parse(readFileSync(process.argv[2], "utf8"));
const secrets = { user: process.env.ILMARI_LOGIN_USER ?? "", password: process.env.ILMARI_LOGIN_PASSWORD ?? "", totp: process.env.ILMARI_LOGIN_TOTP ?? "" };
const sub = (v) => String(v).replace(/\{(user|password|totp)\}/g, (_, k) => secrets[k]).replace(/\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, k) => process.env[k] ?? "");
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const page = await context.newPage();
page.setDefaultTimeout(cfg.stepTimeoutMs);
const done = [];
try {
  await page.goto(cfg.url, { waitUntil: "domcontentloaded" });
  for (const step of cfg.steps) {
    const sel = sub(step.selector);
    if (step.verb === "goto") await page.goto(sel, { waitUntil: "domcontentloaded" });
    else if (step.verb === "fill") await page.locator(sel).first().fill(sub(step.value));
    else if (step.verb === "press") await page.locator(sel).first().press(sub(step.value));
    else if (step.verb === "click") await page.locator(sel).first().click();
    else if (step.verb === "wait") { if (/^\d+$/.test(sel)) await page.waitForTimeout(Number(sel)); else await page.locator(sel).first().waitFor(); }
    else if (step.verb === "waitUrl") await page.waitForURL(sel.includes("*") ? new RegExp(sel.split("*").map((p) => p.replace(/[-\/\\^$*+?.()|[\]{}]/g, "\\$&")).join(".*")) : (u) => u.href.includes(sel));
    else if (step.verb === "expect") await page.locator(sel).first().waitFor({ state: "visible" });
    done.push(step.verb);
  }
  await context.storageState({ path: cfg.storageStatePath });
  chmodSync(cfg.storageStatePath, 0o600);
  let tokenWritten = false;
  if (cfg.tokenFrom) {
    const [kind, ...rest] = cfg.tokenFrom.split(":");
    const key = rest.join(":");
    let token = "";
    if (kind === "cookie") token = (await context.cookies()).find((c) => c.name === key)?.value ?? "";
    else if (kind === "localStorage") token = await page.evaluate((k) => window.localStorage.getItem(k) ?? "", key);
    else if (kind === "sessionStorage") token = await page.evaluate((k) => window.sessionStorage.getItem(k) ?? "", key);
    else throw new Error("tokenFrom must be cookie:<name>, localStorage:<key> or sessionStorage:<key>");
    if (!token) throw new Error("token not found via " + cfg.tokenFrom + " after login (final url " + page.url() + ")");
    writeFileSync(cfg.tokenPath, token);
    chmodSync(cfg.tokenPath, 0o600);
    tokenWritten = true;
  }
  console.log("ILMARI_RESULT " + JSON.stringify({ ok: true, finalUrl: page.url(), cookies: (await context.cookies()).length, steps: done.length, tokenWritten }));
} catch (error) {
  if (cfg.failureScreenshot) { try { await page.screenshot({ path: cfg.failureScreenshot, fullPage: true }); } catch {} }
  let message = String(error && error.message || error).split("\n").slice(0, 6).join("\n");
  for (const v of Object.values(secrets)) if (v) message = message.split(v).join("***");
  console.log("ILMARI_RESULT " + JSON.stringify({ ok: false, error: message, finalUrl: page.url(), stepsDone: done.length }));
} finally {
  await browser.close();
}
`;

/** Env handed to a playwright-test run so the suite can pick up what
 *  playwright-login left behind, without the workflow author wiring paths. */
export function authEnvFor(taskId) {
  const dir = authDirFor(taskId);
  const env = {};
  if (existsSync(join(dir, "storageState.json"))) env.PLAYWRIGHT_STORAGE_STATE = join(dir, "storageState.json");
  if (existsSync(join(dir, "token.txt"))) env.ILMARI_AUTH_TOKEN_FILE = join(dir, "token.txt");
  return env;
}

export default {
  name: "ilmari-plugin-playwright",
  version: "0.3.1",
  description:
    "Runs the project's Playwright end-to-end tests headless as a workflow step and turns the result into a report an agent can act on: which tests failed, where, with which error and which trace or screenshot files. Shards are a parameter, so a map node can run the suite across parallel items. A screenshot step captures app pages on demand, a login step signs into an application (SSO included) and hands the session to the tests, and an install step downloads the browsers.",
  setup:
    "The project must already depend on @playwright/test (it is run through `npx --no-install playwright`, so nothing is downloaded at run time). Browsers come from the playwright-install step or from a base image that has them. No credentials.",
  capabilities: ["exec", "fs", "net", "secrets"],
  config: {
    loginUser: {
      label: "Login user",
      description: "Account the playwright-login step signs in with; a dedicated test account, never a personal one. {user} in the steps.",
      env: "PLAYWRIGHT_LOGIN_USER",
    },
    loginPassword: {
      label: "Login password",
      description: "Its password. {password} in the steps. Reaches the browser process through its environment only and is never written to the event log.",
      secret: true,
      env: "PLAYWRIGHT_LOGIN_PASSWORD",
    },
    loginTotpSecret: {
      label: "Login TOTP secret",
      description: "Base32 seed of the account's authenticator app, when the identity provider asks for a one-time code. {totp} in the steps is the current 6-digit code.",
      secret: true,
      env: "PLAYWRIGHT_LOGIN_TOTP_SECRET",
    },
  },

  tools: [
    {
      name: "auth_token",
      description: "Returns the token a playwright-login step of this run extracted (cookie or storage value), so you can call the application's API with it, e.g. as an Authorization header. Also tells you the storageState file path when one exists. Fails when no login step ran in this task.",
      parameters: {},
      async execute(_input, ctx) {
        const dir = authDirFor(ctx.taskId);
        const tokenFile = join(dir, "token.txt");
        if (!existsSync(tokenFile)) {
          return existsSync(join(dir, "storageState.json"))
            ? `no token was extracted in this run (the login step had no tokenFrom); storage state is at ${join(dir, "storageState.json")}`
            : "no playwright-login step has run in this task";
        }
        ctx.emit?.("auth_token_read", { node: ctx.node ?? "" });
        return readFileSync(tokenFile, "utf8").trim();
      },
    },
  ],

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
        skipIfMissing: {
          type: "boolean",
          description: "When the project has no Playwright CLI (no @playwright/test dependency yet), pass the step with the result `SKIPPED: ...` instead of failing it (default false). For repositories where the e2e suite arrives later; a decide step can treat SKIPPED like PASS.",
          example: "true",
        },
        storageState: {
          type: "string",
          description: "Path to a Playwright storageState file, exported to the suite as PLAYWRIGHT_STORAGE_STATE. Empty = the file a playwright-login step of this run saved, when there is one.",
          example: "{{login.result}}",
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
        if (rendered.skipIfMissing === true || String(rendered.skipIfMissing) === "true") {
          const probe = resolveBin(bin, ctx, false);
          if (probe.error) {
            ctx.emit("playwright_result", { skipped: true, reason: probe.error });
            return { ok: true, output: `SKIPPED: Playwright is not installed in this project (${bin} not available); no tests ran.` };
          }
        }
        const args = buildArgs(rendered);
        const tmp = mkdtempSync(join(tmpdir(), "ilmari-playwright-"));
        const reportFile = join(tmp, "report.json");
        const command = `${bin} ${args.map(q).join(" ")}`;
        ctx.emit("playwright_started", { command, shard: String(rendered.shard ?? "") });
        try {
          const authEnv = authEnvFor(ctx.taskId);
          if (String(rendered.storageState ?? "").trim()) authEnv.PLAYWRIGHT_STORAGE_STATE = String(rendered.storageState).trim();
          const res = runShell(command, ctx, timeoutSec, { ...authEnv, PLAYWRIGHT_JSON_OUTPUT_FILE: reportFile });
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
      type: "playwright-screenshot",
      glyph: "",
      description:
        "Take screenshots of the application: optionally start it (a dev server command), wait until its URL answers, then capture each listed URL in each viewport with a headless Chromium and stop the server again. Works with or without Playwright in the project: when the repo has no Playwright CLI, a pinned npx download is used (and Chromium installed into the machine's Playwright cache once). Result: a Markdown list of the PNG files written plus a JSON block, ready for an agent to upload to a merge request.",
      params: {
        urls: {
          type: "string",
          required: true,
          description: "URLs or app paths to capture, separated by whitespace or newlines. Paths are resolved against baseUrl. {{<nodeId>.result}} from an agent that picked the routes works here.",
          example: "/ /pokemon/25",
        },
        baseUrl: {
          type: "string",
          description: "Where the app answers; relative urls are appended to it and readiness is polled here (default http://127.0.0.1:4173).",
          example: "http://127.0.0.1:4173",
        },
        serve: {
          type: "string",
          description: "Command that starts the app in the worktree, stopped again after the screenshots. Empty = the app is already running at baseUrl.",
          example: "pnpm dev --port 4173 --strictPort --host 127.0.0.1",
        },
        serveTimeoutSec: {
          type: "number",
          description: "How long to wait for baseUrl to answer after starting serve (default 90).",
          example: "120",
        },
        viewports: {
          type: "string",
          description: "Viewport sizes as WIDTHxHEIGHT, space separated; one screenshot per url per viewport (default 1280x800).",
          example: "1280x800 390x844",
        },
        fullPage: {
          type: "boolean",
          description: "Capture the whole scrollable page (default true) instead of the viewport only.",
          example: "true",
        },
        waitFor: {
          type: "string",
          description: "CSS selector that must be present before capturing, for pages that load data first.",
          example: "main [data-loaded]",
        },
        waitMs: {
          type: "number",
          description: "Extra settle time in milliseconds before each capture (default 1000).",
          example: "1500",
        },
        output: {
          type: "string",
          description: "Folder for the PNG files. Default: a temp folder outside the worktree (os tmpdir/ilmari-playwright/<taskId>/screens), so a later deliver never commits them; the result lists absolute paths for an upload step. A relative path lands inside the worktree instead.",
          example: "/tmp/ilmari-screens",
        },
        installIfMissing: {
          type: "boolean",
          description: "When the project has no Playwright CLI, fall back to a pinned npx download and install Chromium (default true). Set false to fail instead.",
          example: "true",
        },
        timeoutSec: {
          type: "number",
          description: "Overall deadline for the step (default 600).",
          example: "300",
        },
        bin: {
          type: "string",
          description: "Command that runs the Playwright CLI (default: npx --no-install playwright).",
          example: "pnpm exec playwright",
        },
      },
      async run(params, ctx) {
        const vars = { ...ctx.outputs, task: ctx.taskTitle };
        const p = Object.fromEntries(Object.entries(params).map(([k, v]) => [k, typeof v === "string" ? render(v, vars) : v]));
        const urls = String(p.urls ?? "").split(/\s+/).filter(Boolean);
        if (!urls.length) return { ok: false, reason: "playwright-screenshot: no urls given" };
        const vp = parseViewports(p.viewports);
        if (vp.error) return { ok: false, reason: `playwright-screenshot: ${vp.error}` };
        const baseUrl = String(p.baseUrl ?? "").trim().replace(/\/+$/, "") || DEFAULT_SCREENSHOT_BASE;
        // default lands outside the worktree: a later deliver commits whatever is
        // dirty there, and screenshots belong on the merge request, not in the repo
        const outDir = String(p.output ?? "").trim() || join(tmpdir(), "ilmari-playwright", ctx.taskId || "run", "screens");
        const dir = isAbsolute(outDir) ? outDir : join(ctx.workdir, outDir);
        const fullPage = p.fullPage !== false && String(p.fullPage) !== "false";
        const waitMs = Number(p.waitMs ?? 1000) || 1000;
        const waitFor = String(p.waitFor ?? "").trim();
        const deadline = Date.now() + (Number(p.timeoutSec ?? 600) || 600) * 1000;
        const allowFallback = p.installIfMissing !== false && String(p.installIfMissing) !== "false";

        const resolved = resolveBin(String(p.bin ?? "").trim() || DEFAULT_BIN, ctx, allowFallback);
        if (resolved.error) return { ok: false, reason: `playwright-screenshot: ${resolved.error}` };
        const bin = resolved.bin;
        if (resolved.fallback) {
          // no Playwright in the project: make sure a browser exists once, cached per machine
          const inst = runShell(`${bin} install chromium`, ctx, 600, {});
          if (inst.status !== 0) return { ok: false, reason: `playwright-screenshot: chromium install failed:\n${tail(inst.out, 15)}` };
        }
        ctx.emit("playwright_screenshot_started", { urls, baseUrl, bin, serve: String(p.serve ?? "") });

        const serveCmd = String(p.serve ?? "").trim();
        const server = serveCmd ? startServer(serveCmd, ctx.workdir) : null;
        try {
          if (server) {
            const ready = await waitForHttp(baseUrl, (Number(p.serveTimeoutSec ?? 90) || 90) * 1000);
            if (!ready.ok) {
              return { ok: false, reason: `playwright-screenshot: ${baseUrl} did not answer after starting "${serveCmd}" (${ready.reason}). Server output tail:\n${tail(server.output(), 25)}` };
            }
          }
          if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
          const files = [];
          const failures = [];
          for (const raw of urls) {
            const url = raw.startsWith("http://") || raw.startsWith("https://") ? raw : `${baseUrl}/${raw.replace(/^\/+/, "")}`;
            for (const { w, h } of vp.viewports) {
              if (Date.now() > deadline) return { ok: false, reason: `playwright-screenshot: deadline reached after ${files.length} screenshots` };
              const file = join(dir, `${slugForUrl(url)}-${w}x${h}.png`);
              const args = ["screenshot", `--viewport-size=${w},${h}`, `--wait-for-timeout=${waitMs}`];
              if (fullPage) args.push("--full-page");
              if (waitFor) args.push("--wait-for-selector", waitFor);
              args.push(url, file);
              const res = runShell(`${bin} ${args.map(q).join(" ")}`, ctx, 120, {});
              if (res.status === 0 && existsSync(file)) files.push({ url, viewport: `${w}x${h}`, path: file });
              else failures.push(`${url} @ ${w}x${h}: ${tail(res.out, 3).trim() || `exit ${res.status ?? res.signal}`}`);
            }
          }
          ctx.emit("playwright_screenshot_result", { files: files.map((f) => f.path), failures });
          if (!files.length) return { ok: false, reason: `playwright-screenshot: no screenshot captured:\n${failures.join("\n")}` };
          const lines = [`Screenshots: ${files.length} file(s) in ${dir}`, ...files.map((f) => `- ${f.path} (${f.url}, ${f.viewport})`)];
          if (failures.length) lines.push("", `Failed: ${failures.length}`, ...failures.map((f) => `- ${f}`));
          lines.push("", "```json", JSON.stringify({ files, failures }), "```");
          return { ok: true, output: lines.join("\n") };
        } finally {
          server?.stop();
        }
      },
    },
    {
      type: "playwright-login",
      glyph: "",
      description:
        "Log into an application through its real browser login (SSO included) and keep the session for the rest of the run: a headless Chromium plays the steps you list (fill, click, wait), then the cookies and localStorage are saved as a Playwright storageState file outside the worktree, and optionally one token (a cookie or a storage key) is written to a file next to it. Later playwright-test steps of the same run receive them as PLAYWRIGHT_STORAGE_STATE and ILMARI_AUTH_TOKEN_FILE. Credentials come from this plugin's config (Login user / password / TOTP secret), never from the workflow file; the result names paths and counts only, never the token.",
      params: {
        url: {
          type: "string",
          required: true,
          description: "Where the login starts: the app URL that redirects to the identity provider, or the provider's login page.",
          example: "https://youtrack.example.com/hub/auth/login",
        },
        steps: {
          type: "string",
          required: true,
          description: "One step per line: `fill <selector> <value>`, `click <selector>`, `press <selector> <key>`, `wait <selector|ms>`, `waitUrl <substring or glob with *>`, `expect <selector>`, `goto <url>`. Values may use {user}, {password}, {totp} (from plugin config) and {env:NAME}. Lines starting with # are comments.",
          example: "fill input[name=loginfmt] {user}\nclick input[type=submit]\nfill input[name=passwd] {password}\nclick input[type=submit]\nclick #idBtn_Back\nwaitUrl https://app.example.com/*",
        },
        user: {
          type: "string",
          description: "Overrides the plugin's Login user for this step: a literal, {{<node>.result}} from an earlier step, or env:NAME to read the daemon's environment. Empty = plugin config (then PLAYWRIGHT_LOGIN_USER).",
          example: "env:YOUTRACK_TEST_USER",
        },
        password: {
          type: "string",
          description: "Overrides the plugin's Login password the same way ({{<node>.result}} or env:NAME). Prefer env:NAME or the plugin config: a literal here lands in the workflow file.",
          example: "env:YOUTRACK_TEST_PASSWORD",
        },
        totpSecret: {
          type: "string",
          description: "Overrides the plugin's TOTP secret the same way ({{<node>.result}} or env:NAME).",
          example: "env:YOUTRACK_TEST_TOTP",
        },
        exposeToken: {
          type: "boolean",
          description: "When a token is extracted, make it this step's result so later steps can use it directly: an http or fetch step's headers ({ \"Authorization\": \"Bearer {{login.result}}\" }) or an agent prompt. Default false: the result names the files only. The value then appears wherever step results are shown (event log, Monitor), so keep runs with this on out of shared consoles. Agents can read the token without it through the auth_token tool.",
          example: "true",
        },
        tokenFrom: {
          type: "string",
          description: "Also extract one token after login: cookie:<name>, localStorage:<key> or sessionStorage:<key>. Written to token.txt (mode 0600) in the run's auth folder; the path is exported to later steps as ILMARI_AUTH_TOKEN_FILE. Empty = storage state only.",
          example: "localStorage:access_token",
        },
        stepTimeoutSec: {
          type: "number",
          description: "Per-step timeout for selectors and navigation (default 30).",
          example: "45",
        },
        timeoutSec: {
          type: "number",
          description: "Overall deadline for the login (default 300).",
          example: "180",
        },
        installIfMissing: {
          type: "boolean",
          description: "When the project has no `playwright` package, install a pinned copy into a temp prefix and Chromium into the machine cache once (default true).",
          example: "true",
        },
        module: {
          type: "string",
          description: "Path to the playwright package to drive the browser with. Empty = the project's own, or the pinned fallback. Mostly for tests.",
          example: "/path/to/node_modules/playwright/index.js",
        },
      },
      async run(params, ctx) {
        const vars = { ...ctx.outputs, task: ctx.taskTitle };
        const p = Object.fromEntries(Object.entries(params).map(([k, v]) => [k, typeof v === "string" ? render(v, vars) : v]));
        const url = String(p.url ?? "").trim();
        if (!url.startsWith("http://") && !url.startsWith("https://")) return { ok: false, reason: `playwright-login: url must be http(s), got "${url}"` };
        const parsed = parseSteps(p.steps);
        if (parsed.error) return { ok: false, reason: `playwright-login: ${parsed.error}` };
        const tokenFrom = String(p.tokenFrom ?? "").trim();
        if (tokenFrom && !/^(cookie|localStorage|sessionStorage):.+/.test(tokenFrom)) {
          return { ok: false, reason: `playwright-login: tokenFrom must be cookie:<name>, localStorage:<key> or sessionStorage:<key>` };
        }
        const creds = loginConfig(ctx);
        // step-level overrides win: `env:NAME` reads the daemon environment,
        // anything else is the literal (typically an earlier node's result)
        const override = (v) => {
          const t = String(v ?? "").trim();
          if (!t) return undefined;
          return t.startsWith("env:") ? (process.env[t.slice(4)] ?? "") : t;
        };
        for (const [k, pk] of [["user", "user"], ["password", "password"], ["totpSecret", "totpSecret"]]) {
          const v = override(p[pk]);
          if (v !== undefined) creds[k] = v;
        }
        const text = String(p.steps);
        if (text.includes("{user}") && !creds.user) return { ok: false, reason: "playwright-login: steps use {user} but Login user is not configured (plugin config or PLAYWRIGHT_LOGIN_USER)" };
        if (text.includes("{password}") && !creds.password) return { ok: false, reason: "playwright-login: steps use {password} but Login password is not configured (plugin config or PLAYWRIGHT_LOGIN_PASSWORD)" };
        if (text.includes("{totp}") && !creds.totpSecret) return { ok: false, reason: "playwright-login: steps use {totp} but Login TOTP secret is not configured (plugin config or PLAYWRIGHT_LOGIN_TOTP_SECRET)" };
        const allowFallback = p.installIfMissing !== false && String(p.installIfMissing) !== "false";
        const mod = String(p.module ?? "").trim() ? { module: String(p.module).trim(), fallback: false } : resolvePlaywrightModule(ctx, allowFallback);
        if (mod.error) return { ok: false, reason: `playwright-login: ${mod.error}` };

        const authDir = authDirFor(ctx.taskId);
        mkdirSync(authDir, { recursive: true, mode: 0o700 });
        const storageStatePath = join(authDir, "storageState.json");
        const tokenPath = join(authDir, "token.txt");
        const failureScreenshot = join(authDir, "login-failed.png");
        const tmp = mkdtempSync(join(tmpdir(), "ilmari-pw-login-"));
        const runner = join(tmp, "runner.mjs");
        const cfgPath = join(tmp, "login.json");
        writeFileSync(runner, LOGIN_RUNNER.replace("process.env.ILMARI_PW_MODULE", JSON.stringify(mod.module)));
        writeFileSync(cfgPath, JSON.stringify({
          url, steps: parsed.steps, storageStatePath, tokenPath: tokenFrom ? tokenPath : "", tokenFrom, failureScreenshot,
          stepTimeoutMs: (Number(p.stepTimeoutSec ?? 30) || 30) * 1000,
        }));
        ctx.emit("playwright_login_started", { url, steps: parsed.steps.length, tokenFrom, fallback: mod.fallback });
        try {
          const res = spawnSync(`node ${q(runner)} ${q(cfgPath)}`, {
            cwd: ctx.workdir, shell: true, encoding: "utf8", timeout: (Number(p.timeoutSec ?? 300) || 300) * 1000,
            env: childEnv({
              ILMARI_LOGIN_USER: creds.user,
              ILMARI_LOGIN_PASSWORD: creds.password,
              ILMARI_LOGIN_TOTP: creds.totpSecret ? totp(creds.totpSecret) : "",
            }),
            maxBuffer: 16 * 1024 * 1024,
          });
          const out = (res.stdout ?? "") + (res.stderr ?? "");
          const line = out.split("\n").find((l) => l.startsWith("ILMARI_RESULT "));
          const result = line ? JSON.parse(line.slice("ILMARI_RESULT ".length)) : null;
          if (!result) {
            return { ok: false, reason: res.signal ? `playwright-login: killed by ${res.signal}` : `playwright-login: runner produced no result (exit ${res.status}). Output tail:\n${tail(out, 20)}` };
          }
          ctx.emit("playwright_login_result", { ok: result.ok, finalUrl: result.finalUrl, steps: result.steps ?? result.stepsDone, tokenWritten: result.tokenWritten ?? false });
          if (!result.ok) {
            const shot = existsSync(failureScreenshot) ? `\nScreenshot of the page at failure: ${failureScreenshot}` : "";
            return { ok: false, reason: `playwright-login: failed after ${result.stepsDone} step(s) at ${result.finalUrl}: ${result.error}${shot}` };
          }
          const lines = [
            storageStatePath,
            "",
            `Logged in: ${result.finalUrl} (${result.cookies} cookies, ${result.steps} steps).`,
            `Storage state: ${storageStatePath} (PLAYWRIGHT_STORAGE_STATE for later playwright-test steps)`,
          ];
          if (result.tokenWritten) lines.push(`Token file: ${tokenPath} (ILMARI_AUTH_TOKEN_FILE). Agents read it with the auth_token tool.`);
          const exposeToken = p.exposeToken === true || String(p.exposeToken) === "true";
          if (exposeToken) {
            if (!result.tokenWritten) return { ok: false, reason: "playwright-login: exposeToken needs tokenFrom so there is a token to expose" };
            // the caller asked for the value itself; the descriptive lines go to the event log instead
            ctx.emit("playwright_login_summary", { lines: lines.slice(2) });
            return { ok: true, output: readFileSync(tokenPath, "utf8").trim() };
          }
          return { ok: true, output: lines.join("\n") };
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
