import { resolveExternalCommand, externalCommandCandidates } from "./externalCommand.mjs";
import { homedir } from "node:os";
import { join } from "node:path";

// 统一维护新旧 App 内置程序路径，供初始化扫描和运行时查找共同使用。
function codexAppBundleCandidates() {
  return ["/Applications", join(homedir(), "Applications")].flatMap(root =>
    ["Codex", "ChatGPT"].flatMap(name => {
      const resources = join(root, `${name}.app`, "Contents", "Resources");
      return ["codex", join("codex-cli", "CodexCLI.app", "Contents", "MacOS", "codex")]
        .map(binary => ({ path: join(resources, binary), source: name }));
    }));
}

export function controlledCodexCommand() {
  return process.env.CORPTIE_CODEX_PATH || process.env.CORPTIE_CODEX_REAL_PATH || null;
}

export function codexExecutableCandidates() {
  return [...externalCommandCandidates("codex").map(path => ({ path, source: "cli" })),
    ...codexAppBundleCandidates()];
}

export function resolveCodexCommand(requestedCommand = "") {
  return resolveExternalCommand("codex", {
    requested: requestedCommand,
    environmentVariables: ["CORPTIE_CODEX_PATH", "CORPTIE_CODEX_REAL_PATH"],
    extraCandidates: codexAppBundleCandidates().map(candidate => candidate.path)
  });
}
