import { existsSync } from "node:fs";
import path from "node:path";
import type {
  BashOperations,
  EditOperations,
  ExtensionAPI,
  ExtensionFactory,
  ReadOperations,
  WriteOperations,
} from "@mariozechner/pi-coding-agent";
import {
  createBashTool,
  createEditTool,
  createReadTool,
  createWriteTool,
} from "@mariozechner/pi-coding-agent";
import { RealFSProvider, VM } from "@earendil-works/gondolin";
import { isBashCommandAllowed, type RuntimeToolState } from "./tools.js";

const GUEST_WORKSPACE = "/workspace";
export const DEFAULT_GONDOLIN_PROFILE = "base";
const profilePattern = /^[a-z0-9._-]+$/;
const safeGuestEnv = {
  HOME: "/root",
  PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
  TMPDIR: "/tmp",
};

export type GondolinRuntimeOptions = {
  profile?: string | null;
  imagePath?: string | null;
  profileAssetsDir?: string | null;
  profilePaths?: Record<string, string>;
};

function shQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

export function normalizeGondolinProfile(profile?: string | null): string {
  const normalized = profile?.trim().toLowerCase() || DEFAULT_GONDOLIN_PROFILE;
  if (!profilePattern.test(normalized)) {
    throw new Error(`invalid Gondolin profile ${JSON.stringify(profile)}; use lowercase letters, numbers, dots, underscores, or dashes`);
  }
  return normalized;
}

function parseProfilePaths(value?: string): Record<string, string> {
  if (!value?.trim()) return {};
  const raw = value.trim();
  if (raw.startsWith("{")) {
    const decoded = JSON.parse(raw) as unknown;
    if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) {
      throw new Error("GONDOLIN_PROFILE_PATHS must be a JSON object or profile=/path list");
    }
    const output: Record<string, string> = {};
    for (const [key, item] of Object.entries(decoded)) {
      if (typeof item === "string" && item.trim()) {
        output[normalizeGondolinProfile(key)] = item.trim();
      }
    }
    return output;
  }
  const output: Record<string, string> = {};
  for (const part of raw.split(",")) {
    const [key, ...pathParts] = part.split("=");
    const itemPath = pathParts.join("=").trim();
    if (key?.trim() && itemPath) {
      output[normalizeGondolinProfile(key)] = itemPath;
    }
  }
  return output;
}

function resolveGondolinImagePath(profile: string, options: GondolinRuntimeOptions): string | undefined {
  if (options.imagePath?.trim()) return options.imagePath.trim();
  const profilePaths = {
    ...parseProfilePaths(process.env.GONDOLIN_PROFILE_PATHS),
    ...(options.profilePaths ?? {}),
  };
  const configuredPath = profilePaths[profile]?.trim();
  if (configuredPath) return configuredPath;

  const assetsDir = options.profileAssetsDir?.trim() || process.env.GONDOLIN_PROFILE_ASSETS_DIR?.trim();
  if (assetsDir) {
    const candidate = path.resolve(assetsDir, profile);
    if (existsSync(candidate)) return candidate;
  }

  if (profile === DEFAULT_GONDOLIN_PROFILE) return undefined;
  throw new Error(
    `Gondolin profile ${profile} is not configured. Mount its guest image assets and set GONDOLIN_PROFILE_ASSETS_DIR or GONDOLIN_PROFILE_PATHS.`,
  );
}

export class GondolinRuntime {
  #vm: VM | null = null;
  #starting: Promise<VM> | null = null;
  readonly profile: string;
  readonly imagePath?: string;

  constructor(
    private readonly workspaceRoot: string = process.cwd(),
    options: GondolinRuntimeOptions = {},
  ) {
    this.profile = normalizeGondolinProfile(options.profile);
    this.imagePath = resolveGondolinImagePath(this.profile, options);
  }

  async ensureVm(): Promise<VM> {
    if (this.#vm) return this.#vm;
    if (this.#starting) return this.#starting;
    const createOptions = {
      sandbox: {
        ...(this.imagePath ? { imagePath: this.imagePath } : {}),
        netEnabled: false,
      },
      vfs: {
        mounts: {
          [GUEST_WORKSPACE]: new RealFSProvider(this.workspaceRoot),
        },
      },
    };
    this.#starting = VM.create(createOptions)
      .then((vm) => {
        this.#vm = vm;
        return vm;
      })
      .catch((error: unknown) => {
        this.#starting = null;
        throw error;
      });
    return this.#starting;
  }

  async close(): Promise<void> {
    const vm = this.#vm;
    this.#vm = null;
    this.#starting = null;
    if (vm) {
      await vm.close();
    }
  }

  toGuestPath(localPath: string): string {
    const rel = path.relative(this.workspaceRoot, localPath);
    if (rel === "") return GUEST_WORKSPACE;
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
      throw new Error(`path escapes workspace: ${localPath}`);
    }
    return path.posix.join(GUEST_WORKSPACE, rel.split(path.sep).join(path.posix.sep));
  }

  createReadOps(): ReadOperations {
    return {
      readFile: async (p) => {
        const guestPath = this.toGuestPath(p);
        const r = await (await this.ensureVm()).exec(["/bin/cat", guestPath]);
        if (!r.ok) {
          throw new Error(`cat failed (${r.exitCode}): ${r.stderr}`);
        }
        return r.stdoutBuffer;
      },
      access: async (p) => {
        const guestPath = this.toGuestPath(p);
        const r = await (await this.ensureVm()).exec([
          "/bin/sh",
          "-lc",
          `test -r ${shQuote(guestPath)}`,
        ]);
        if (!r.ok) {
          throw new Error(`not readable: ${p}`);
        }
      },
      detectImageMimeType: async (p) => {
        const guestPath = this.toGuestPath(p);
        try {
          const r = await (await this.ensureVm()).exec([
            "/bin/sh",
            "-lc",
            `file --mime-type -b ${shQuote(guestPath)}`,
          ]);
          if (!r.ok) return null;
          const mimeType = r.stdout.trim();
          return ["image/jpeg", "image/png", "image/gif", "image/webp"].includes(mimeType)
            ? mimeType
            : null;
        } catch {
          return null;
        }
      },
    };
  }

  createWriteOps(): WriteOperations {
    return {
      writeFile: async (p, content) => {
        const guestPath = this.toGuestPath(p);
        const dir = path.posix.dirname(guestPath);
        const vm = await this.ensureVm();
        const mkdir = await vm.exec(["/bin/mkdir", "-p", dir]);
        if (!mkdir.ok) {
          throw new Error(`mkdir failed (${mkdir.exitCode}): ${mkdir.stderr}`);
        }
        const r = await vm.exec(["/bin/sh", "-c", "cat > \"$1\"", "sh", guestPath], {
          env: safeGuestEnv,
          stdin: Buffer.from(content, "utf8"),
        });
        if (!r.ok) {
          throw new Error(`write failed (${r.exitCode}): ${r.stderr}`);
        }
      },
      mkdir: async (dir) => {
        const guestDir = this.toGuestPath(dir);
        const r = await (await this.ensureVm()).exec(["/bin/mkdir", "-p", guestDir]);
        if (!r.ok) {
          throw new Error(`mkdir failed (${r.exitCode}): ${r.stderr}`);
        }
      },
    };
  }

  createEditOps(): EditOperations {
    const read = this.createReadOps();
    const write = this.createWriteOps();
    return {
      readFile: read.readFile,
      access: read.access,
      writeFile: write.writeFile,
    };
  }

  createBashOps(state: RuntimeToolState, allowlist: string[]): BashOperations {
    const allowedPrefixes = allowlist.map((item) => item.trim().toLowerCase()).filter(Boolean);
    return {
      exec: async (command, cwd, { onData, signal, timeout }) => {
        const startedAt = Date.now();
        const trimmedCommand = command.trim();
        if (!isBashCommandAllowed(trimmedCommand, allowedPrefixes)) {
          const stderr = `Command is not allowed. Allowed prefixes: ${allowedPrefixes.join(", ")}`;
          state.results.push({
            name: "bash",
            ok: false,
            stdout: "",
            stderr,
            timed_out: false,
            duration_ms: Date.now() - startedAt,
            details: {
              command: trimmedCommand,
              allowlist: allowedPrefixes,
              runtime: "gondolin",
              gondolin_profile: this.profile,
              exit_code: null,
            },
          });
          throw new Error(stderr);
        }

        const vm = await this.ensureVm();
        const guestCwd = this.toGuestPath(cwd);
        const ac = new AbortController();
        const onAbort = () => ac.abort();
        signal?.addEventListener("abort", onAbort, { once: true });
        let timedOut = false;
        const timer =
          timeout && timeout > 0
            ? setTimeout(() => {
                timedOut = true;
                ac.abort();
              }, timeout * 1000)
            : undefined;
        let stdout = "";
        let stderr = "";
        try {
          const proc = vm.exec(["/bin/bash", "-lc", trimmedCommand], {
            cwd: guestCwd,
            signal: ac.signal,
            env: safeGuestEnv,
            stdout: "pipe",
            stderr: "pipe",
          });

          for await (const chunk of proc.output()) {
            const data = Buffer.from(chunk.text);
            onData(data);
            if (chunk.stream === "stdout") {
              stdout += chunk.text;
            } else {
              stderr += chunk.text;
            }
          }

          const result = await proc;
          state.results.push({
            name: "bash",
            ok: result.ok,
            stdout,
            stderr,
            timed_out: false,
            duration_ms: Date.now() - startedAt,
            details: {
              command: trimmedCommand,
              runtime: "gondolin",
              gondolin_profile: this.profile,
              exit_code: result.exitCode,
            },
          });
          return { exitCode: result.exitCode };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          state.results.push({
            name: "bash",
            ok: false,
            stdout,
            stderr: stderr || message,
            timed_out: timedOut,
            duration_ms: Date.now() - startedAt,
            details: { command: trimmedCommand, runtime: "gondolin", gondolin_profile: this.profile },
          });
          if (signal?.aborted) throw new Error("aborted");
          if (timedOut) throw new Error(`timeout:${timeout}`);
          throw error;
        } finally {
          if (timer) clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
        }
      },
    };
  }

  createPiSandboxExtension(state: RuntimeToolState, bashAllowlist: string[]): ExtensionFactory {
    return (pi: ExtensionAPI) => {
      const cwd = this.workspaceRoot;
      const read = createReadTool(cwd, { operations: this.createReadOps() });
      const write = createWriteTool(cwd, { operations: this.createWriteOps() });
      const edit = createEditTool(cwd, { operations: this.createEditOps() });
      const bash = createBashTool(cwd, { operations: this.createBashOps(state, bashAllowlist) });

      pi.registerTool(read);
      pi.registerTool(write);
      pi.registerTool(edit);
      pi.registerTool(bash);
      pi.on("user_bash", () => ({
        operations: this.createBashOps(state, bashAllowlist),
      }));
      pi.on("before_agent_start", (event) => ({
        systemPrompt: event.systemPrompt.replace(
          `Current working directory: ${cwd}`,
          `Current working directory: ${GUEST_WORKSPACE} (Gondolin VM profile: ${this.profile}, mounted from host: ${cwd})`,
        ),
      }));
    };
  }
}
