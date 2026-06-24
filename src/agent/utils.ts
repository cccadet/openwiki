import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { UPDATE_METADATA_PATH } from "../constants.js";
import type { OpenWikiCommand, RunContext, UpdateMetadata } from "./types.js";

const execFileAsync = promisify(execFile);

export async function createRunContext(
  command: OpenWikiCommand,
  cwd: string,
): Promise<RunContext> {
  const lastUpdate = await readLastUpdate(cwd);

  if (command === "chat") {
    return {
      lastUpdate,
      gitSummary: "Not applicable for chat.",
    };
  }

  return {
    lastUpdate,
    gitSummary: await createGitSummary(command, cwd, lastUpdate),
  };
}

export async function writeLastUpdateMetadata(
  command: OpenWikiCommand,
  cwd: string,
  modelId: string,
): Promise<void> {
  const metadataFile = path.join(cwd, UPDATE_METADATA_PATH);
  const metadata: UpdateMetadata = {
    updatedAt: new Date().toISOString(),
    command,
    gitHead: await getGitHead(cwd),
    model: modelId,
  };

  await mkdir(path.dirname(metadataFile), { recursive: true });
  await writeFile(
    metadataFile,
    `${JSON.stringify(metadata, null, 2)}\n`,
    "utf8",
  );
}

async function readLastUpdate(cwd: string): Promise<UpdateMetadata | null> {
  const metadataFile = path.join(cwd, UPDATE_METADATA_PATH);

  try {
    const rawMetadata = await readFile(metadataFile, "utf8");
    const parsedMetadata = JSON.parse(rawMetadata) as Partial<UpdateMetadata>;

    if (
      typeof parsedMetadata.updatedAt === "string" &&
      typeof parsedMetadata.command === "string" &&
      typeof parsedMetadata.model === "string"
    ) {
      return {
        updatedAt: parsedMetadata.updatedAt,
        command: parsedMetadata.command === "init" ? "init" : "update",
        gitHead:
          typeof parsedMetadata.gitHead === "string"
            ? parsedMetadata.gitHead
            : undefined,
        model: parsedMetadata.model,
      };
    }

    return null;
  } catch (error) {
    if (isFileNotFoundError(error) || error instanceof SyntaxError) {
      return null;
    }

    throw error;
  }
}

async function createGitSummary(
  command: OpenWikiCommand,
  cwd: string,
  lastUpdate: UpdateMetadata | null,
): Promise<string> {
  const sections: string[] = [];
  const status = await runGit(cwd, ["status", "--short"]);
  const head = await getGitHead(cwd);
  const recentLog = await runGit(cwd, [
    "log",
    "--max-count=20",
    "--name-status",
    "--oneline",
  ]);

  sections.push(formatGitSection("git status --short", status));
  sections.push(formatGitSection("git rev-parse HEAD", head ?? "(unknown)"));
  sections.push(
    formatGitSection(
      "git log --max-count=20 --name-status --oneline",
      recentLog,
    ),
  );

  if (command === "update" && lastUpdate?.gitHead) {
    const logSinceLastHead = await runGit(cwd, [
      "log",
      `${lastUpdate.gitHead}..HEAD`,
      "--name-status",
      "--oneline",
    ]);

    sections.push(
      formatGitSection(
        `git log ${lastUpdate.gitHead}..HEAD --name-status --oneline`,
        logSinceLastHead,
      ),
    );
  } else if (command === "update" && lastUpdate?.updatedAt) {
    const logSinceLastUpdate = await runGit(cwd, [
      "log",
      "--since",
      lastUpdate.updatedAt,
      "--name-status",
      "--oneline",
    ]);

    sections.push(
      formatGitSection(
        `git log --since ${lastUpdate.updatedAt} --name-status --oneline`,
        logSinceLastUpdate,
      ),
    );
  } else if (command === "update") {
    sections.push("No prior OpenWiki update timestamp was found.");
  }

  const diff = await runGit(cwd, ["diff", "--name-status", "HEAD"]);
  sections.push(formatGitSection("git diff --name-status HEAD", diff));

  return sections.join("\n\n");
}

async function getGitHead(cwd: string): Promise<string | undefined> {
  const head = await runGit(cwd, ["rev-parse", "HEAD"]);

  return head.length > 0 ? head : undefined;
}

async function runGit(cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout, stderr } = await execFileAsync("git", args, {
      cwd,
      maxBuffer: 1024 * 1024,
    });

    return [stdout.trim(), stderr.trim()].filter(Boolean).join("\n").trim();
  } catch (error) {
    if (isExecError(error)) {
      return [error.stdout?.trim(), error.stderr?.trim()]
        .filter(Boolean)
        .join("\n")
        .trim();
    }

    throw error;
  }
}

function formatGitSection(command: string, output: string): string {
  return [`$ ${command}`, output.length > 0 ? output : "(no output)"].join(
    "\n",
  );
}

function isFileNotFoundError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

function isExecError(
  error: unknown,
): error is Error & { stdout?: string; stderr?: string } {
  return error instanceof Error && ("stdout" in error || "stderr" in error);
}
