import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

if (!process.argv[2]) throw new Error("Usage: node smoke.mjs /absolute/path/to/pi/dist/bundle/cli.js [--ui]");
const sandbox = mkdtempSync(join(tmpdir(), "pi-zcode-smoke-"));
const cli = resolve(process.argv[2]), source = dirname(fileURLToPath(import.meta.url));
const extension = join(sandbox, "package", "index.ts");
const agent = join(sandbox, "agent");
const env = {
  HOME: sandbox, PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
  PI_CODING_AGENT_DIR: agent, PI_OFFLINE: "1", PI_TELEMETRY: "0",
};
try {
  // No development node_modules or symlinks: exercise only the SDK modules Pi actually exposes.
  mkdirSync(dirname(extension), { mode: 0o700 });
  for (const file of ["index.ts", "core.ts", "package.json"]) copyFileSync(join(source, file), join(dirname(extension), file));
  mkdirSync(agent, { mode: 0o700 });
  writeFileSync(join(agent, "auth.json"), JSON.stringify(Object.fromEntries(["cn", "intl"].map(region => [
    `zcode-${region}`, { type: "oauth", access: `${region}-synthetic-id.synthetic-secret`, refresh: "", expires: Number.MAX_SAFE_INTEGER, loginMethod: "zcode-browser", region, organizationId: "org", projectId: "project" },
  ]))), { mode: 0o600 });
  const result = spawnSync("unshare", ["-Urn", "--", process.execPath,
    "--import", 'data:text/javascript,globalThis.fetch=async()=>{throw new Error("NETWORK_DISABLED")}',
    cli, "--no-extensions", "-e", extension, "--list-models",
  ], { cwd: sandbox, encoding: "utf8", timeout: 30_000, env });
  assert.equal(result.status, 0, result.error?.message ?? result.stderr);
  assert.match(result.stdout, /^zcode-cn\s/m, result.stderr);
  assert.match(result.stdout, /^zcode-intl\s/m, result.stderr);
  assert(!/NETWORK_DISABLED|failed to load|error loading/i.test(result.stderr), result.stderr);
  console.log("PASS: bundled Pi loaded both browser-only providers with synthetic OAuth records inside a network-disabled namespace.");

  if (process.argv.includes("--ui")) {
    // Optional Linux/PTY acceptance check. All browser launchers are harmless local stubs.
    rmSync(join(agent, "auth.json"));
    const bin = join(sandbox, "bin"), browserLog = join(sandbox, "browser.log"), audit = join(sandbox, "requests.log");
    mkdirSync(bin);
    for (const name of ["xdg-open", "gio", "open", "sensible-browser", "x-www-browser"]) {
      writeFileSync(join(bin, name), '#!/bin/sh\nprintf "blocked\\n" >> "$BROWSER_LOG"\n', { mode: 0o700 });
    }
    writeFileSync(join(sandbox, "mock.mjs"), String.raw`
import { appendFileSync } from "node:fs";
let provider, bearer, polls = 0;
const json = data => new Response(JSON.stringify({ code: 0, data }), { headers: { "Content-Type": "application/json" } });
const record = slot => appendFileSync(process.env.SYNTHETIC_AUDIT, slot + "\n");
export const mockFetch = async (input, init = {}) => {
  const url = new URL(String(input));
  if (url.href === "https://zcode.z.ai/api/v1/oauth/cli/init" && init.method === "POST") {
    record("init"); provider = JSON.parse(init.body).provider;
    if (!["bigmodel", "zai"].includes(provider)) throw new Error("unexpected provider");
    bearer = new Headers(init.headers).get("authorization");
    const authorize = new URL(provider === "bigmodel" ? "https://bigmodel.cn/login" : "https://chat.z.ai/api/oauth/authorize");
    authorize.searchParams.set("state", "synthetic-state");
    authorize.searchParams.set(provider === "bigmodel" ? "redirect" : "redirect_uri", "https://zcode.z.ai/api/v1/oauth/cli/callback/" + provider);
    return json({ flow_id: "synthetic-flow", authorize_url: authorize.toString(), expires_at: Math.floor(Date.now() / 1000) + 60, poll_interval_sec: 1 });
  }
  if (url.href === "https://zcode.z.ai/api/v1/oauth/cli/poll/synthetic-flow" && init.method === "GET") {
    record("poll");
    if (new Headers(init.headers).get("authorization") !== bearer) throw new Error("poll bearer changed");
    return json(polls++ === 0 ? { status: "pending" } : { status: "ready", token: "synthetic-session", user: { user_id: "synthetic-user" }, [provider]: { access_token: "synthetic-account" } });
  }
  const origin = provider === "bigmodel" ? "https://bigmodel.cn" : "https://api.z.ai";
  if (url.origin === origin) {
    if (provider === "zai" && url.pathname === "/api/auth/z/login" && init.method === "POST") { record("exchange"); return json({ access_token: "synthetic-business" }); }
    if (url.pathname === "/api/biz/customer/getCustomerInfo" && init.method === "GET") { record("customer"); return json({ organizations: [{ organizationId: "org", projects: [{ projectId: "project" }] }] }); }
    if (url.pathname === "/api/biz/v1/organization/org/projects/project/api_keys" && init.method === "GET") { record("keys"); return json([]); }
  }
  record("unexpected-or-creation");
  throw new Error("NETWORK_DISABLED");
};
`);
    // Pi replaces preload globals during startup; install the mock at registration, where providers capture fetch.
    const wrapper = join(sandbox, "extension.ts");
    writeFileSync(wrapper, `import register from ${JSON.stringify(extension)};\nimport { mockFetch } from "./mock.mjs";\nexport default pi => { globalThis.fetch = mockFetch; register(pi); };\n`);
    const ui = spawnSync("unshare", ["-Urn", "--", "python3", "-c", String.raw`
import fcntl, json, os, pty, select, signal, struct, subprocess, sys, termios, time
node, cli, extension, sandbox = sys.argv[1:]
for region in ("cn", "intl"):
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 45, 140, 0, 0))
    command = [node, "--import", os.path.join(sandbox, "mock.mjs"), cli, "--no-session", "--no-extensions", "--no-skills", "--no-prompt-templates", "-e", extension]
    process = subprocess.Popen(command, stdin=slave, stdout=slave, stderr=slave, cwd=sandbox, start_new_session=True)
    os.close(slave)
    output = bytearray()
    def read_for(seconds):
        end = time.monotonic() + seconds
        while time.monotonic() < end:
            if select.select([master], [], [], min(0.1, max(0, end - time.monotonic())))[0]:
                try:
                    chunk = os.read(master, 65536)
                except OSError:
                    break
                if not chunk: break
                output.extend(chunk)
    def wait_text(text):
        end = time.monotonic() + 15
        while text not in output.decode("utf-8", "replace") and time.monotonic() < end and process.poll() is None:
            read_for(0.1)
        assert text in output.decode("utf-8", "replace"), "Missing UI text: " + text + "\n" + output.decode("utf-8", "replace")[-3000:]
    def type_text(text):
        for character in text:
            os.write(master, character.encode())
            read_for(0.04)
    try:
        read_for(2)
        type_text("/login zcode")
        wait_text("zcode-cn"); wait_text("zcode-intl")
        type_text("-" + region)
        os.write(master, b"\x1b"); read_for(0.2)
        os.write(master, b"\r")
        wait_text("无需复制令牌")
        wait_text("允许创建"); wait_text("取消，不创建")
        # Default selection must deny the side effect. No secret or manual-code prompt is submitted.
        os.write(master, b"\r")
        wait_text("未创建 API key")
        auth_path = os.path.join(sandbox, "agent", "auth.json")
        if os.path.exists(auth_path):
            with open(auth_path) as file: assert not any(k.startswith("zcode-") for k in json.load(file))
        print("PASS: " + region + " native /login displayed browser authorization and explicit key consent; default cancel saved no credential.")
    finally:
        if process.poll() is None:
            os.killpg(process.pid, signal.SIGTERM)
            try: process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGKILL); process.wait()
        os.close(master)
`, process.execPath, cli, wrapper, sandbox], {
      cwd: sandbox, encoding: "utf8", timeout: 75_000,
      env: { ...env, PATH: `${bin}:${env.PATH}`, TERM: "xterm-256color", BROWSER: join(bin, "xdg-open"), BROWSER_LOG: browserLog, SYNTHETIC_AUDIT: audit },
    });
    assert.equal(ui.status, 0, (ui.error?.message ?? ui.stderr) + "\nMock audit: " + (existsSync(audit) ? readFileSync(audit, "utf8") : "no mock calls"));
    assert(!readFileSync(audit, "utf8").includes("unexpected-or-creation"));
    assert.equal(readFileSync(browserLog, "utf8").trim().split("\n").length, 2);
    console.log(ui.stdout.trim());
    console.log("PASS: both browser launches were intercepted; no real network or key-creation request occurred.");
  }
} finally {
  rmSync(sandbox, { recursive: true, force: true });
}
