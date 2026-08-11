import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = process.cwd();
const required = [
  ".codex-plugin/plugin.json",
  ".mcp.json",
  ".agents/skills/create-ai-cartoon-drama/SKILL.md",
  ".agents/skills/configure-ai-cartoon-providers/SKILL.md",
  "skills/create-ai-cartoon-drama/SKILL.md",
  "skills/configure-ai-cartoon-providers/SKILL.md",
  "config/defaults.json",
  "config/providers.example.json",
  "docs/FFMPEG_DEPLOYMENT.md",
  "docs/STAGE_CONTRACTS.md",
  "output/.gitkeep",
];

for (const path of required) {
  await access(resolve(root, path));
}

const plugin = JSON.parse(
  await readFile(resolve(root, ".codex-plugin/plugin.json"), "utf8"),
);

const packageManifest = JSON.parse(
  await readFile(resolve(root, "package.json"), "utf8"),
);
if (
  packageManifest.optionalDependencies?.["ffmpeg-static"] !== "5.3.0" ||
  packageManifest.optionalDependencies?.["@derhuerst/ffprobe-static"] !== "5.3.0"
) {
  throw new Error("Managed FFmpeg and ffprobe optional dependencies must remain exactly pinned.");
}
if (plugin.name !== "ai-cartoon-workflow" || !/^\d+\.\d+\.\d+$/.test(plugin.version)) {
  throw new Error("Plugin manifest name or semantic version is invalid.");
}
if (plugin.skills !== "./skills/" || plugin.mcpServers !== "./.mcp.json") {
  throw new Error("Plugin manifest must point at the repository skills and MCP config.");
}

for (const name of ["create-ai-cartoon-drama", "configure-ai-cartoon-providers"]) {
  const text = await readFile(
    resolve(root, `.agents/skills/${name}/SKILL.md`),
    "utf8",
  );
  if (!text.startsWith("---\n") || !text.includes(`\nname: ${name}\n`)) {
    throw new Error(`Skill ${name} has invalid YAML frontmatter.`);
  }
  if (text.includes("[TODO:")) {
    throw new Error(`Skill ${name} still contains scaffold TODOs.`);
  }
}

const gitignore = await readFile(resolve(root, ".gitignore"), "utf8");
if (!gitignore.includes("output/*") || !gitignore.includes("!output/.gitkeep")) {
  throw new Error("Generated output must be ignored except output/.gitkeep.");
}

const license = await readFile(resolve(root, "LICENSE"), "utf8");
if (
  !license.includes("TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION") ||
  !license.includes("END OF TERMS AND CONDITIONS")
) {
  throw new Error("LICENSE must contain the complete Apache License 2.0 text.");
}

const locks = JSON.parse(
  await readFile(resolve(root, "integrations/skills.lock.json"), "utf8"),
);
if (locks.schemaVersion !== 1 || locks.integrations?.length !== 4) {
  throw new Error("Third-party skill lock must contain the four reviewed integrations.");
}
for (const integration of locks.integrations) {
  if (!/^[a-f0-9]{40}$/.test(integration.commit)) {
    throw new Error(`Integration ${integration.id} has an invalid commit lock.`);
  }
  if (!/^git-tree-sha1:[a-f0-9]{40}$/.test(integration.contentHash)) {
    throw new Error(`Integration ${integration.id} needs an independent Git tree content hash.`);
  }
  if (!integration.repository?.startsWith("https://github.com/")) {
    throw new Error(`Integration ${integration.id} needs an auditable GitHub source URL.`);
  }
}

const providerConfig = JSON.parse(
  await readFile(resolve(root, "config/providers.example.json"), "utf8"),
);
const localFfmpeg = providerConfig.providers?.find(
  (provider) => provider.id === "local-ffmpeg",
);
if (
  localFfmpeg?.adapter !== "local-ffmpeg" ||
  localFfmpeg.enabled !== true ||
  localFfmpeg.dataTransfer !== "local-only" ||
  (localFfmpeg.ffmpegPath !== undefined && typeof localFfmpeg.ffmpegPath !== "string") ||
  (localFfmpeg.ffprobePath !== undefined && typeof localFfmpeg.ffprobePath !== "string")
) {
  throw new Error(
    "The example provider profile must enable the secret-free local-ffmpeg route.",
  );
}
for (const provider of providerConfig.providers ?? []) {
  if (!provider.dataTransfer) {
    throw new Error(`Provider ${provider.id} must disclose its data-transfer mode.`);
  }
  if (JSON.stringify(provider).match(/"(?:apiKey|token|password|secret)"\s*:/i)) {
    throw new Error(`Provider ${provider.id} contains a resolved secret-like field.`);
  }
}

console.log("Repository, plugin, and skill structure are valid.");
