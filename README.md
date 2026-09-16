# ilmari-plugin-playwright

Runs a project's [Playwright](https://playwright.dev) end-to-end tests as an
[ilmari](https://github.com/wraithyy/ilmari) workflow step, headless, and
turns the outcome into a report an agent can act on: which tests failed,
where, with which error, and which trace or screenshot files were written.
Shards are a parameter, so a `map` node fans the suite out across parallel
items. A second step installs the browsers.

A third step takes screenshots of the running app on demand, with or
without Playwright in the project, so a workflow can attach pictures of a
feature to its merge request from the first commit on.

No agent browsing tool is included on purpose: for an agent that needs to
drive a browser mid-run, point the project's `ilmari.json` `mcp` array at
`@playwright/mcp`.

## Capabilities

- `exec` - runs the project's own Playwright CLI (`npx --no-install playwright`)
  in the task's worktree, unsandboxed, as the ilmari server's user.
- `fs` - reads the JSON report Playwright writes to a temp file and lets
  Playwright write traces and screenshots under the worktree.
- `net` - only the screenshot step: polls the app under test until it
  answers, and, when the project has no Playwright CLI, downloads a pinned
  `playwright` package through npx plus Chromium into the machine's
  Playwright cache (once).

No credentials, no config fields.

## Requirements

- The project depends on `@playwright/test` (any 1.x). Nothing is downloaded
  at run time; `--no-install` refuses to fetch a missing CLI.
- Browsers: run the `playwright-install` step once per machine, or run
  ilmari in an image that ships them (`mcr.microsoft.com/playwright`).

## Node type: `playwright-test`

Runs `playwright test` with `--reporter list,json` and reads the JSON report.
Result (`{{<id>.result}}`) is Markdown:

```
FAIL: 12 passed, 2 failed, 0 flaky, 1 skipped (41.3s, shard 2/4)

### detail page > renders stats [chromium]
- e2e/detail.spec.ts:12 (unexpected)

```
Expected: 6
Received: 0
```
- trace: test-results/shard-2-4/detail-renders/trace.zip
- screenshot: test-results/shard-2-4/detail-renders/test-failed-1.png

```json
{"expected":12,"unexpected":2,"flaky":0,"skipped":1,"durationMs":41300,"failed":2,"shard":"2/4","exitCode":1}
```
```

| Param | Required | Description |
|---|---|---|
| `spec` | no | Test files or directories, space separated. Empty = whole suite. |
| `project` | no | Playwright project name(s), comma separated. |
| `shard` | no | `current/total`. Artifacts go to `test-results/shard-<n>-<m>` unless `output` is set. |
| `workers` | no | `--workers`. Empty = Playwright default. |
| `retries` | no | `--retries`. Empty = config value. |
| `grep` | no | Only titles matching this regex. |
| `config` | no | Path to the Playwright config. |
| `output` | no | Artifact folder (`--output`). |
| `failOnTestFailure` | no | Default `true`: red tests fail the step. `false`: step succeeds, report starts with `FAIL:`, route with a `decide` node. |
| `timeoutSec` | no | Kill and fail after this many seconds (default 1200). |
| `bin` | no | CLI command (default `npx --no-install playwright`, e.g. `pnpm exec playwright`). |

All string params interpolate `{{task}}`, `{{item}}` and `{{<nodeId>.result}}`.

Failure modes: red tests -> step fails with the report as the reason (or
succeeds with `FAIL:` when `failOnTestFailure` is false); no JSON report
(missing config, missing browsers, syntax error) -> step fails with the CLI's
output tail; timeout -> step fails naming the signal.

### Serial run

```json
{ "id": "e2e", "type": "playwright-test", "needs": ["build"], "project": "chromium" }
```

### Four shards in parallel, then one fix agent

```json
{
  "id": "e2e",
  "type": "map",
  "needs": ["build"],
  "over": "[\"1/4\",\"2/4\",\"3/4\",\"4/4\"]",
  "concurrency": 4,
  "node": { "id": "shard", "type": "playwright-test", "shard": "{{item}}", "failOnTestFailure": false }
},
{
  "id": "e2e-verdict",
  "type": "decide",
  "needs": ["e2e"],
  "choices": ["green", "red"],
  "prompt": "Shard reports:\n{{e2e.result}}\n\nAnswer green when every report starts with PASS:, otherwise red."
},
{
  "id": "e2e-fix",
  "type": "agent",
  "needs": ["e2e-verdict", "e2e"],
  "when": { "node": "e2e-verdict", "is": "red" },
  "prompt": "These Playwright failures came back:\n{{e2e.result}}\n\nFix the root cause (app or test), run the failing specs locally, commit."
}
```

`failOnTestFailure: false` inside the map keeps all shards running so the
agent sees every failure at once instead of the first shard that broke.

## Node type: `playwright-screenshot`

Starts the app (optional `serve` command, stopped afterwards), waits until
`baseUrl` answers, captures every url in every viewport with headless
Chromium, and returns the file list:

```
Screenshots: 4 file(s) in /tmp/ilmari-playwright/9333ff5153e49093/screens
- /tmp/ilmari-playwright/9333ff5153e49093/screens/home-1280x800.png (http://127.0.0.1:4173/, 1280x800)
- /tmp/ilmari-playwright/9333ff5153e49093/screens/home-390x844.png (http://127.0.0.1:4173/, 390x844)
- /tmp/ilmari-playwright/9333ff5153e49093/screens/pokemon-25-1280x800.png (http://127.0.0.1:4173/pokemon/25, 1280x800)
- /tmp/ilmari-playwright/9333ff5153e49093/screens/pokemon-25-390x844.png (http://127.0.0.1:4173/pokemon/25, 390x844)

```json
{"files":[{"url":"http://127.0.0.1:4173/","viewport":"1280x800","path":"/tmp/ilmari-playwright/9333ff5153e49093/screens/home-1280x800.png"}, ...],"failures":[]}
```
```

| Param | Required | Description |
|---|---|---|
| `urls` | yes | URLs or app paths, whitespace separated; paths resolve against `baseUrl`. Templates allowed, e.g. an agent's route list. |
| `baseUrl` | no | Default `http://127.0.0.1:4173`. Readiness is polled here. |
| `serve` | no | Command starting the app in the worktree, e.g. `pnpm dev --port 4173 --strictPort --host 127.0.0.1`. Stopped with its whole process group afterwards. Empty = app already running. |
| `serveTimeoutSec` | no | Wait for readiness (default 90). |
| `viewports` | no | `WIDTHxHEIGHT` list (default `1280x800`). |
| `fullPage` | no | Default true. |
| `waitFor` | no | CSS selector to wait for before capturing. |
| `waitMs` | no | Settle time before each capture (default 1000). |
| `output` | no | Folder for PNGs. Default: a temp folder outside the worktree (`<tmpdir>/ilmari-playwright/<taskId>/screens`), so a later `deliver` never commits screenshots into the branch; the result lists absolute paths for an upload step. A relative path lands inside the worktree. |
| `installIfMissing` | no | Default true: no Playwright CLI in the project -> `npx -y playwright@1.55.0` and `install chromium`. |
| `timeoutSec` | no | Overall deadline (default 600). |
| `bin` | no | CLI command, as above. |

Failure modes: app never answers -> step fails with the server's output
tail; no screenshot captured -> step fails listing each url's error; a
subset failing -> step succeeds and lists the failures. Wrap the node in a
`fallback` when a missing app must not fail the task (a scaffold-only repo).

### Route list from an agent, screenshots to the MR

```json
{ "id": "routes", "type": "agent", "readOnly": true,
  "prompt": "From this plan, list the app paths a reviewer should see, one per line, / first:\n{{plan.result}}" },
{ "id": "shots", "type": "playwright-screenshot", "needs": ["routes"],
  "serve": "pnpm dev --port 4173 --strictPort --host 127.0.0.1",
  "urls": "{{routes.result}}", "viewports": "1280x800 390x844",
  "fallback": { "id": "no-shots", "type": "shell", "command": "echo 'screenshots unavailable: {{error}}'" } },
{ "id": "post", "type": "agent", "readOnly": true, "needs": ["shots"],
  "tools": ["mcp__gitlab__upload_markdown", "mcp__gitlab__create_merge_request_note"],
  "prompt": "Upload these files to the MR and post them as one comment:\n{{shots.result}}" }
```

## Node type: `playwright-install`

Runs `playwright install [--with-deps] <browsers>`. Idempotent.

| Param | Required | Description |
|---|---|---|
| `browsers` | no | Space separated: `chromium`, `firefox`, `webkit`. Default `chromium`. |
| `withDeps` | no | Also install OS libraries. Needs root on Linux. |
| `timeoutSec` | no | Default 900. |
| `bin` | no | CLI command, as above. |

```json
{ "id": "browsers", "type": "playwright-install", "browsers": "chromium" }
```

## Events

`playwright_started {command, shard}`, `playwright_result {exitCode,
expected, unexpected, flaky, skipped, failed[]}` (or `{exitCode, report:
false, outputTail}` when no report was produced),
`playwright_screenshot_started {urls, baseUrl, bin, serve}`,
`playwright_screenshot_result {files[], failures[]}`, `playwright_install
{command, exitCode, outputTail}`. They show up in the task's event log and
Monitor.

## Install

```sh
ilmari plugin add https://github.com/wraithyy/ilmari-plugin-playwright.git
```

Approve `exec`, `fs` and `net` when asked. For local development:

```sh
ilmari plugin add /abs/path/ilmari-plugin-playwright/dist/index.js
```

## Development

```sh
npm test                                            # unit tests with a fake CLI
ILMARI_SRC=/path/to/ilmari npm test                 # also runs ilmari's static inspect
```

Release: bump `version` in `dist/index.js` and `package.json`, commit, tag
`vX.Y.Z`, push tags. The newest tag is what installs.

## License

Apache-2.0
