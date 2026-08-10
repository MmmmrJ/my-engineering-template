import { cp, readdir, readFile, rm } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

const root = resolve(process.cwd());
const packageManifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
if (packageManifest.name !== "ai-cartoon-workflow") {
  throw new Error("Run skill synchronization from the ai-cartoon-workflow repository root.");
}
const source = join(root, ".agents", "skills");
const destination = join(root, "skills");
const mode = process.argv[2];

if (mode === "--write") {
  await rm(destination, { recursive: true, force: true });
  await cp(source, destination, { recursive: true });
  console.log("Generated plugin skills mirror from .agents/skills.");
} else if (mode === "--check") {
  const sourceFiles = await files(source);
  const destinationFiles = await files(destination);
  if (JSON.stringify(sourceFiles) !== JSON.stringify(destinationFiles)) {
    throw new Error("skills/ is stale; run `npm run skills:sync`.");
  }
  for (const path of sourceFiles) {
    const [left, right] = await Promise.all([
      readFile(join(source, path)),
      readFile(join(destination, path)),
    ]);
    if (!left.equals(right)) {
      throw new Error(`skills/${path} differs from its canonical .agents source.`);
    }
  }
  console.log("Generated plugin skills mirror is current.");
} else {
  throw new Error("Use --write or --check.");
}

async function files(root) {
  const found = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) found.push(relative(root, path).replaceAll("\\", "/"));
    }
  }
  await visit(root);
  return found.sort();
}
