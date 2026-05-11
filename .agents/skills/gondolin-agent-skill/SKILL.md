---
name: gondolin-agent-sandbox
description: Use this skill when an agent needs to run commands, code, tests, tooling, or networked workflows inside Gondolin, a programmable Linux micro-VM sandbox for AI-agent workloads. Covers all current Gondolin docs pages: CLI, SDK, VM lifecycle, VFS, network policy, secrets, ingress, SSH, snapshots, custom images, security, architecture, QEMU/libkrun backends, debugging, and limitations.
---

# Gondolin Agent Sandbox Skill

## Purpose

Use Gondolin when you need an AI agent to execute code or tools inside an isolated Linux micro-VM while keeping the host in control of filesystem persistence, network egress, and secrets.

Gondolin is best for short-lived agent workloads: create a VM, run commands, persist useful results, then discard the VM. Treat the VM as disposable unless you intentionally create a disk checkpoint.

## Core Mental Model

Gondolin is a small system with three main parts:

1. Host control plane: the Node.js/TypeScript library and CLI, plus policy enforcement for network, filesystem, secrets, and VM lifecycle.
2. Guest Linux VM: a minimal Linux environment running guest daemons such as `sandboxd`, `sandboxfs`, `sandboxssh`, and `sandboxingress`.
3. VM backend: `qemu` by default, with experimental `krun` support.

The important design rule is: untrusted code runs inside the VM, but the host remains the enforcement point for networking and persistence.

## When To Use This Skill

Use this skill for:

- Running shell commands, tests, package managers, builds, formatters, linters, or scripts in a sandbox.
- Building an agent runtime where `bash`, `read`, `write`, or `edit` tools should execute inside a micro-VM instead of on the host.
- Running networked tools with tight host allowlists.
- Letting code use API keys without putting real secret values inside the guest.
- Mounting a project into `/workspace` with controlled read/write access.
- Exposing an HTTP server from inside the guest to the host for previews or dev servers.
- Creating custom images with preinstalled languages and tools.
- Debugging VM, exec, network, or VFS behavior.

Avoid using Gondolin as a long-running stateful desktop or server VM. It is designed for short-lived, controlled agent turns.

## Installation And Requirements

Typical CLI use:

```bash
npx @earendil-works/gondolin bash
```

Global install:

```bash
npm install -g @earendil-works/gondolin
gondolin bash
```

Requirements:

- Node.js >= 23.6.0
- QEMU installed
  - macOS: `brew install qemu`
  - Linux: install the appropriate `qemu-system-*` package

Gondolin resolves guest assets automatically on first use and caches them under `~/.cache/gondolin/images/`.

## Default Agent Lifecycle

For most LLM-agent integrations:

1. Start a VM at the beginning of a task or conversation turn.
2. Mount needed workspace paths explicitly.
3. Configure network allowlists and secrets explicitly.
4. Run commands with `vm.exec(...)` or the CLI.
5. Persist important results to a VFS-mounted path, object storage, Git, or another external system.
6. Close the VM.

Do not rely on long-running in-guest background processes after VM close. Do not assume `/tmp`, `/root`, `/var/log`, `/var/tmp`, or `/var/cache` survive.

## CLI Recipes

### Open an interactive sandbox shell

```bash
gondolin bash
```

### Mount the current project into `/workspace`

```bash
gondolin bash --mount-hostfs "$PWD:/workspace"
```

### Mount a read-only dataset plus an ephemeral scratch path

```bash
gondolin exec \
  --mount-hostfs /data:/data:ro \
  --mount-memfs /scratch \
  -- ls -la /data
```

### Run tests in a mounted project

```bash
gondolin exec \
  --mount-hostfs "$PWD:/workspace" \
  -- sh -lc 'cd /workspace && npm test'
```

### Allow a specific HTTP host

```bash
gondolin exec \
  --allow-host api.github.com \
  -- curl -sS https://api.github.com/rate_limit
```

### Use host-side secret injection

```bash
export GITHUB_TOKEN='...'

gondolin exec \
  --allow-host api.github.com \
  --host-secret GITHUB_TOKEN@api.github.com \
  -- curl -sS -H 'Authorization: Bearer $GITHUB_TOKEN' https://api.github.com/user
```

The guest sees only a placeholder value. The host substitutes the real value only for allowed matching hosts.

### Allow multiple HTTP hosts

```bash
gondolin bash \
  --allow-host "*.github.com" \
  --allow-host api.openai.com
```

### Map a non-HTTP TCP service

```bash
gondolin bash \
  --tcp-map pg.internal=127.0.0.1:5432
```

Use mapped TCP narrowly. It is raw forwarding and does not use HTTP hooks or HTTP secret substitution.

### Allow outbound SSH from the guest

```bash
gondolin bash \
  --ssh-allow-host github.com \
  --ssh-agent \
  --ssh-known-hosts ~/.ssh/known_hosts
```

For non-interactive tools such as Git, suppress prompts:

```bash
export GIT_SSH_COMMAND='ssh \
  -o BatchMode=yes \
  -o StrictHostKeyChecking=no \
  -o UserKnownHostsFile=/dev/null \
  -o GlobalKnownHostsFile=/dev/null \
  -o LogLevel=ERROR'
```

### Start ingress for a guest HTTP server

```bash
gondolin bash --listen 127.0.0.1:3000
```

Inside the VM, configure `/etc/gondolin/listeners` to route host requests to guest-local services.

### List and attach to sessions

```bash
gondolin list
gondolin attach <SESSION_ID>
```

### Snapshot a running session

```bash
gondolin snapshot <SESSION_ID>
```

### Resume from a snapshot

```bash
gondolin bash --resume <SNAPSHOT_ID_OR_QCOW2_PATH>
```

### Build a custom image

```bash
gondolin build --init-config > build-config.json
# edit build-config.json
gondolin build --config build-config.json --output ./my-assets
GONDOLIN_GUEST_DIR=./my-assets gondolin bash
```

## SDK Recipes

### Minimal VM

```ts
import { VM } from "@earendil-works/gondolin";

const vm = await VM.create();
try {
  const result = await vm.exec("uname -a");
  console.log(result.exitCode, result.stdout, result.stderr);
} finally {
  await vm.close();
}
```

Always close the VM. If it is not closed, the QEMU process can keep running.

### `vm.exec(...)` forms

String form uses `/bin/sh -lc`:

```ts
await vm.exec("echo $HOME | wc -c");
```

Array form directly executes a binary and does not search `$PATH`, so use an absolute executable path:

```ts
await vm.exec(["/bin/echo", "hello"]);
```

Check command results through:

- `result.exitCode`
- `result.ok`
- `result.stdout`
- `result.stderr`
- `result.stdoutBuffer`
- `result.stderrBuffer`
- `result.json<T>()`
- `result.lines()`

Non-zero exit codes return an `ExecResult`; they do not throw by default.

### Stream output safely

```ts
const proc = vm.exec("for i in 1 2 3; do echo $i; sleep 1; done", {
  stdout: "pipe",
  stderr: "pipe",
});

for await (const { stream, text } of proc.output()) {
  process.stdout.write(`[${stream}] ${text}`);
}

const result = await proc;
```

Use streaming or `buffer: false` for commands that may produce large output.

### Abort waiting for a command

```ts
const ac = new AbortController();
setTimeout(() => ac.abort(), 1000);

try {
  await vm.exec(["/bin/sleep", "10"], { signal: ac.signal });
} catch (err) {
  console.error(String(err));
}
```

Aborting rejects the local promise but may not guarantee that the guest process is terminated.

### Mount host filesystem and memory filesystem

```ts
import { VM, RealFSProvider, MemoryProvider } from "@earendil-works/gondolin";

const vm = await VM.create({
  vfs: {
    mounts: {
      "/workspace": new RealFSProvider("/host/workspace"),
      "/scratch": new MemoryProvider(),
    },
  },
});
```

### Use secret placeholders with HTTP hooks

```ts
import { VM, createHttpHooks } from "@earendil-works/gondolin";

const { httpHooks, env } = createHttpHooks({
  allowedHosts: ["api.github.com"],
  secrets: {
    GITHUB_TOKEN: {
      hosts: ["api.github.com"],
      value: process.env.GITHUB_TOKEN!,
    },
  },
});

const vm = await VM.create({ httpHooks, env });
```

Security note: request hooks may run after secrets have been expanded, so do not log full request headers unless sanitized.

### Configure network policy hooks

```ts
import { VM, createHttpHooks } from "@earendil-works/gondolin";

const { httpHooks, env } = createHttpHooks({
  allowedHosts: ["api.example.com", "*.github.com"],
  allowedInternalHosts: ["litellm.corp.example"],
  blockInternalRanges: true,
  isRequestAllowed: (req) => req.method !== "DELETE",
  onRequest: async (req) => {
    console.log(req.url);
    return req;
  },
  onResponse: async (res, req) => {
    console.log(req.url, res.status);
    return res;
  },
});

const vm = await VM.create({ httpHooks, env });
```

### Configure mapped TCP egress

```ts
import { VM } from "@earendil-works/gondolin";

const vm = await VM.create({
  dns: {
    mode: "synthetic",
    syntheticHostMapping: "per-host",
  },
  tcp: {
    hosts: {
      "pg.internal": "127.0.0.1:5432",
      "redis.internal:6379": "127.0.0.1:6379",
    },
  },
});
```

### Enable ingress for guest HTTP previews

```ts
import { VM } from "@earendil-works/gondolin";

const vm = await VM.create();
const ingress = await vm.enableIngress({
  listenHost: "127.0.0.1",
  listenPort: 0,
});

vm.setIngressRoutes([{ prefix: "/", port: 8000, stripPrefix: true }]);

const server = vm.exec("python -m http.server 8000", {
  buffer: false,
  stdout: "inherit",
  stderr: "inherit",
});

console.log(ingress.url);
```

Note: long-running `vm.exec()` calls can block additional exec requests because the guest currently executes one command at a time.

### Enable SSH into the guest for debugging

```ts
const ssh = await vm.enableSsh({
  listenHost: "127.0.0.1",
  listenPort: 0,
  user: "root",
});

console.log(ssh.command);
```

SSH is primarily for debugging, ad-hoc inspection, or tools that require SSH. Normal automation should use `vm.exec(...)`.

### Use VM filesystem helpers

```ts
await vm.fs.mkdir("/tmp/workspace/nested", { recursive: true });
const entries = await vm.fs.listDir("/tmp/workspace");
const text = await vm.fs.readFile("/etc/os-release", { encoding: "utf-8" });
await vm.fs.writeFile("/tmp/hello.txt", "hello from host\n");
await vm.fs.rename("/tmp/hello.txt", "/tmp/renamed.txt");
await vm.fs.deleteFile("/tmp/renamed.txt");
```

## VFS Guidance

Use VFS mounts for any data that must survive VM close.

Common providers:

- `MemoryProvider`: ephemeral in-memory filesystem.
- `RealFSProvider`: mount a host directory into the guest.
- `ReadonlyProvider`: wrap another provider as read-only.
- `ShadowProvider`: overlay behavior for hiding/blocking paths such as `.env` or `node_modules` while allowing selected writes.

Important rules:

- Do not accidentally hide CA certificates or other required system files.
- Disk checkpoints do not include VFS-mounted data.
- Rootfs and tmpfs-backed paths are not a reliable persistence mechanism for agent outputs.
- Prefer `/workspace` for project mounts and `/scratch` for temporary generated state.

## Secrets Handling Rules

Real secrets should stay on the host.

Use `createHttpHooks({ secrets })` or CLI `--host-secret` to pass placeholders into the guest. The host substitutes placeholders with real values only for matching allowed hosts.

Rules:

- Never bake real secrets into custom image `env`.
- Never mount host home directories wholesale if they contain credentials.
- Scope each secret to the narrowest host list possible.
- Treat hook logs as sensitive because secrets may have been expanded before `onRequest` executes.
- If a placeholder is sent to a disallowed host, expect the request to be blocked.

## Network Policy Rules

Default mediated network behavior:

- HTTP and TLS traffic are mediated by host code.
- Non-HTTP/TLS TCP is dropped unless explicitly enabled through SSH egress or mapped TCP.
- DNS is available in modes such as synthetic, trusted, and open.
- The host enforces policy against HTTP hostnames and performs its own resolution to reduce DNS rebinding risk.
- Redirects are resolved on the host and should not escape the allowlist.
- WebSockets are supported after the HTTP/1.1 upgrade handshake, but only the handshake is hookable.

Use `allowedHosts` for normal internet access. Use `allowedInternalHosts` only when a known internal host is intentionally allowed. Keep `blockInternalRanges: true` unless you have a specific reason to relax it.

## Ingress Rules

Ingress exposes guest HTTP services to the host through a host-side gateway. It is not generic port forwarding.

Use ingress for:

- dev server previews
- temporary local web UIs
- debugging HTTP apps running inside the VM

Ingress routes are based on `/etc/gondolin/listeners` or `vm.setIngressRoutes(...)`.

Use ingress hooks for:

- path or client-IP allow/deny decisions
- header/path rewrites
- response header edits
- optional response body buffering and rewriting

## SSH Rules

Inbound SSH into the guest:

- Intended for debugging and tools that expect SSH.
- `enableSsh()` starts `sshd` bound to guest loopback, starts a helper, creates a host-local listener, and injects an ephemeral authorized key.
- Prefer `vm.exec(...)` for normal automation.

Outbound SSH from guest to upstream:

- Use only explicitly allowlisted hosts.
- Host verifies upstream host keys via OpenSSH `known_hosts`.
- Interactive shells/subsystems are restricted for egress.
- Prefer host ssh-agent or host-side private key credentials.

## Snapshots And Checkpoints

Gondolin supports disk-only snapshots/checkpoints as `.qcow2` files.

Use snapshots when you need to preserve root disk state between runs. Do not expect snapshots to capture:

- RAM
- process state
- long-running services
- tmpfs-backed paths such as `/tmp`, `/root`, `/run`, `/var/log`, `/var/tmp`, `/var/cache`
- VFS-mounted data

Resume requires compatible guest assets and backend metadata. Cross-backend resume requires compatible boot artifacts.

For typical agents, prefer rebuilding state from durable external sources over relying heavily on long-lived snapshots.

## Custom Images

Build custom images when the default Alpine image lacks required packages or language runtimes.

Common reasons:

- Add Rust, Go, Python, Ruby, Node, uv, npm, or project-specific tools.
- Preinstall dependencies.
- Customize boot behavior.
- Reduce startup time with a smaller image.

Basic workflow:

```bash
gondolin build --init-config > build-config.json
gondolin build --config build-config.json --output ./my-assets
GONDOLIN_GUEST_DIR=./my-assets gondolin bash
```

Build requirements include Zig 0.15.2, `cpio`, `lz4`, and `e2fsprogs`. Docker or Podman is optional for OCI-rootfs builds.

Do not store secrets in image `env`. Those variables are baked into the image.

Gondolin currently supports Alpine as the base build distro. OCI support can use a different userspace rootfs such as Debian, but Gondolin still assembles boot artifacts from Alpine components.

## Debugging

Enable debug channels with:

```bash
export GONDOLIN_DEBUG=net,exec
export GONDOLIN_DEBUG=all
```

Programmatic debug:

```ts
const vm = await VM.create({
  sandbox: {
    debug: ["net", "exec"],
    // debug: true,
  },
});
```

Debug channels:

- `net`: network stack and HTTP bridge
- `exec`: exec, stdin, PTY control messages
- `vfs`: FUSE/RPC filesystem operations
- `protocol`: virtio/control-protocol traffic and QEMU log forwarding
- `all`: everything

When debugging agents, capture debug output into the agent trace or task log, but sanitize secrets and headers.

## Backends

Default backend: `qemu`.

Experimental backend: `krun`.

Use QEMU by default because it has broader feature support and is the primary documented backend. Use `krun` only after checking backend parity and runtime caveats.

Select backend:

```bash
gondolin bash --vmm qemu
gondolin bash --vmm krun
```

Programmatic shape:

```ts
const vm = await VM.create({
  sandbox: {
    vmm: "qemu",
  },
});
```

## Security Checklist For Agent Integrations

Before giving an agent Gondolin-backed execution:

- Mount only the exact host paths needed.
- Prefer `/workspace` over host home directory mounts.
- Use read-only mounts for source/reference data when possible.
- Put temporary work in `/scratch` or `/tmp`, but persist final outputs to `/workspace` or external storage.
- Explicitly allow only required network hosts.
- Avoid broad wildcards unless necessary.
- Keep `blockInternalRanges` enabled unless intentionally accessing internal services.
- Use host-scoped secret placeholders, not real guest env vars.
- Sanitize request/response logging.
- Use mapped TCP only for narrow local services such as a specific database port.
- Use SSH mainly for debugging.
- Close the VM after task completion.
- Prefer disposable VMs over long-lived mutable VM state.

## Known Limitations To Respect

- No full VM save/restore with RAM and in-VM process state.
- Adding extra packages normally requires building a new image.
- Base image building is Alpine-oriented.
- No HTTP/2 or HTTP/3 support in the mediated HTTP bridge.
- No QUIC or WebRTC support.
- QEMU and krun have backend parity gaps.
- No Windows support.
- Disk checkpoints exclude tmpfs paths and VFS data.
- The guest currently executes one command at a time, so long-running commands can block other exec requests.

## Suggested Agent Tool Mapping

If adapting an existing coding agent:

- `bash` tool -> `vm.exec(command)` or CLI `gondolin exec`.
- `read` tool -> `vm.fs.readFile(path)` for guest-visible paths.
- `write` tool -> `vm.fs.writeFile(path, content)`.
- `edit` tool -> read file through `vm.fs`, patch on host, write back through `vm.fs`.
- workspace mount -> `RealFSProvider(projectRoot)` mounted at `/workspace`.
- scratch mount -> `MemoryProvider()` mounted at `/scratch`.
- network policy -> `createHttpHooks({ allowedHosts, secrets, hooks })`.
- preview URLs -> `vm.enableIngress()` with route table.
- debug shell -> `vm.enableSsh()` or `gondolin attach`.

## Minimal Agent Runtime Pattern

```ts
import {
  VM,
  RealFSProvider,
  MemoryProvider,
  createHttpHooks,
} from "@earendil-works/gondolin";

export async function runAgentTask(command: string) {
  const { httpHooks, env } = createHttpHooks({
    allowedHosts: ["api.github.com"],
    secrets: process.env.GITHUB_TOKEN
      ? {
          GITHUB_TOKEN: {
            hosts: ["api.github.com"],
            value: process.env.GITHUB_TOKEN,
          },
        }
      : {},
  });

  const vm = await VM.create({
    httpHooks,
    env,
    vfs: {
      mounts: {
        "/workspace": new RealFSProvider(process.cwd()),
        "/scratch": new MemoryProvider(),
      },
    },
  });

  try {
    const result = await vm.exec(`cd /workspace && ${command}`);
    return {
      ok: result.ok,
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  } finally {
    await vm.close();
  }
}
```

## Source Map

Official Gondolin pages covered by this skill:

- Home: https://earendil-works.github.io/gondolin/
- Workloads and Lifecycle: https://earendil-works.github.io/gondolin/workloads/
- CLI: https://earendil-works.github.io/gondolin/cli/
- Secrets Handling: https://earendil-works.github.io/gondolin/secrets/
- Ingress and Listening: https://earendil-works.github.io/gondolin/ingress/
- SSH: https://earendil-works.github.io/gondolin/ssh/
- Debug Logging: https://earendil-works.github.io/gondolin/debug/
- SDK Overview: https://earendil-works.github.io/gondolin/sdk/
- SDK VM Control: https://earendil-works.github.io/gondolin/sdk-vm/
- SDK Network Access: https://earendil-works.github.io/gondolin/sdk-network/
- SDK Storage Snapshots: https://earendil-works.github.io/gondolin/sdk-storage/
- VFS Providers: https://earendil-works.github.io/gondolin/vfs/
- Snapshots: https://earendil-works.github.io/gondolin/snapshots/
- Custom Images: https://earendil-works.github.io/gondolin/custom-images/
- Architecture Overview: https://earendil-works.github.io/gondolin/architecture/
- Security Design: https://earendil-works.github.io/gondolin/security/
- Network Stack: https://earendil-works.github.io/gondolin/network/
- VM Backends: QEMU vs libkrun: https://earendil-works.github.io/gondolin/backends/
- QEMU Backend: https://earendil-works.github.io/gondolin/qemu/
- Current Limitations: https://earendil-works.github.io/gondolin/limitations/

