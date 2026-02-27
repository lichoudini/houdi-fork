import fs from "node:fs/promises";
import path from "node:path";
import type { AgentProfile } from "../agents.js";
import type { ExecutedCommand } from "./types.js";

const MAX_DEPTH = 3;
const MAX_ITEMS = 250;
const SKIP_NAMES = new Set([
  ".git",
  ".cache",
  "node_modules",
  "dist",
  "runtime",
  "proc",
  "sys",
  "dev",
  "etc",
  "usr",
  "var",
  "lib",
  "lib64",
  "boot",
  "run",
  "sbin",
  "bin",
  "opt",
  "tmp",
  "mnt",
  "media",
  "srv",
]);

function toHashtagToken(rawPath: string): string {
  const normalized = rawPath
    .replace(/\/+$/g, "")
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return normalized || "archivo";
}

type TaggedWorkspaceEntry = {
  tag: string;
  legacyTag: string;
  path: string;
};

function buildTaggedWorkspaceEntries(paths: string[]): TaggedWorkspaceEntry[] {
  return paths.map((relPath) => {
    const tagBase = relPath.replace(/\/+$/g, "");
    const tag = /\s/.test(tagBase) || !tagBase ? toHashtagToken(relPath) : tagBase;
    const legacyTag = toHashtagToken(relPath);
    return { tag, legacyTag, path: relPath };
  });
}

function formatListingWithHashtags(paths: string[]): string[] {
  return buildTaggedWorkspaceEntries(paths).map((entry) => `${entry.path} #${entry.tag}`);
}

function addTagAlias(
  byTag: Map<string, string>,
  byTagLower: Map<string, string>,
  alias: string,
  targetPath: string,
): void {
  const cleanAlias = alias.trim();
  if (!cleanAlias) {
    return;
  }
  if (!byTag.has(cleanAlias)) {
    byTag.set(cleanAlias, targetPath);
  }
  const lowerAlias = cleanAlias.toLowerCase();
  if (!byTagLower.has(lowerAlias)) {
    byTagLower.set(lowerAlias, targetPath);
  }
}

export function looksLikeDirectoryListCommand(raw: string): boolean {
  const normalized = raw.trim().toLowerCase();
  return /^(ls|find|tree|dir)(\s|$)/.test(normalized);
}

async function collectWorkspaceTree(
  absoluteDir: string,
  relativePrefix: string,
  depth: number,
  output: string[],
): Promise<void> {
  if (depth > MAX_DEPTH || output.length >= MAX_ITEMS) {
    return;
  }

  let entries = await fs.readdir(absoluteDir, { withFileTypes: true });
  entries = entries.sort((a, b) => a.name.localeCompare(b.name));

  for (const entry of entries) {
    if (output.length >= MAX_ITEMS) {
      return;
    }
    if (!entry.name || entry.name.startsWith(".")) {
      continue;
    }
    if (SKIP_NAMES.has(entry.name)) {
      continue;
    }

    const relPath = relativePrefix ? `${relativePrefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      output.push(`${relPath}/`);
      await collectWorkspaceTree(path.join(absoluteDir, entry.name), relPath, depth + 1, output);
      continue;
    }

    output.push(relPath);
  }
}

async function buildCleanWorkspaceListing(agent: AgentProfile): Promise<string> {
  const paths = await collectWorkspacePaths(agent);
  if (paths.length === 0) {
    return "(workspace vacio)";
  }
  const taggedLines = formatListingWithHashtags(paths);
  if (taggedLines.length >= MAX_ITEMS) {
    return `${taggedLines.join("\n")}\n...[truncado]`;
  }
  return taggedLines.join("\n");
}

async function collectWorkspacePaths(agent: AgentProfile): Promise<string[]> {
  const workspaceRoot = path.resolve(process.cwd(), agent.cwd);
  await fs.mkdir(workspaceRoot, { recursive: true });
  const lines: string[] = [];
  await collectWorkspaceTree(workspaceRoot, "", 0, lines);
  return lines;
}

export async function resolveWorkspaceHashtagsInText(
  text: string,
  agent: AgentProfile,
): Promise<{ text: string; replacements: Array<{ tag: string; path: string }> }> {
  if (!text.includes("#")) {
    return { text, replacements: [] };
  }
  const paths = await collectWorkspacePaths(agent);
  if (paths.length === 0) {
    return { text, replacements: [] };
  }

  const byTag = new Map<string, string>();
  const byTagLower = new Map<string, string>();
  for (const entry of buildTaggedWorkspaceEntries(paths)) {
    addTagAlias(byTag, byTagLower, entry.tag, entry.path);
    addTagAlias(byTag, byTagLower, entry.legacyTag, entry.path);

    const cleanPath = entry.path.replace(/\/+$/g, "");
    const isDirectory = entry.path.endsWith("/");
    if (!cleanPath || isDirectory) {
      continue;
    }

    const baseName = path.basename(cleanPath);
    addTagAlias(byTag, byTagLower, baseName, entry.path);
    addTagAlias(byTag, byTagLower, toHashtagToken(baseName), entry.path);

    const extension = path.extname(baseName);
    const stem = extension ? baseName.slice(0, -extension.length) : baseName;
    if (stem) {
      addTagAlias(byTag, byTagLower, stem, entry.path);
      addTagAlias(byTag, byTagLower, toHashtagToken(stem), entry.path);
    }

    if (extension) {
      const pathWithoutExt = cleanPath.slice(0, -extension.length);
      addTagAlias(byTag, byTagLower, pathWithoutExt, entry.path);
      addTagAlias(byTag, byTagLower, toHashtagToken(pathWithoutExt), entry.path);
    }
  }

  const replacements: Array<{ tag: string; path: string }> = [];
  const replaced = text.replace(/#([^\s#]+)/g, (fullMatch, rawTag: string) => {
    const candidateRaw = String(rawTag ?? "").trim();
    const resolvedPath = byTag.get(candidateRaw) ?? byTagLower.get(candidateRaw.toLowerCase());
    if (!resolvedPath) {
      return fullMatch;
    }
    replacements.push({ tag: `#${candidateRaw}`, path: resolvedPath });
    return resolvedPath;
  });

  return { text: replaced, replacements };
}

export async function presentListingResultForWorkspace(
  result: ExecutedCommand,
  agent: AgentProfile,
): Promise<ExecutedCommand> {
  if (!looksLikeDirectoryListCommand(result.command)) {
    return result;
  }
  if (result.exitCode !== 0 || result.timedOut) {
    return result;
  }
  try {
    const cleanListing = await buildCleanWorkspaceListing(agent);
    return {
      ...result,
      stdout: cleanListing,
      stderr: "",
    };
  } catch {
    return result;
  }
}
