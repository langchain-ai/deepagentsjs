import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";

import { copyDir } from "../../utils/fileUtils.js";
import type { FrameworkConfig } from "../../registry/framework.js";

export async function installTemplate(
  projectPath: string,
  framework: FrameworkConfig,
) {
  const { address } = framework;

  switch (address.scheme) {
    case "github":
      await downloadGithubTemplate(address, projectPath);
      break;
    case "local":
      await copyDir(address.path, projectPath);
      break;
    default:
      throw new Error(`Invalid address scheme. This should not happen`);
  }
}

/**
 * Download a GitHub template by fetching the repo tarball and extracting it
 * into the project directory.
 */
async function downloadGithubTemplate(
  address: { owner: string; repo: string; subPath?: string },
  dest: string,
): Promise<void> {
  const execFileAsync = promisify(execFile);
  const tarballUrl = `https://codeload.github.com/${address.owner}/${address.repo}/tar.gz/HEAD`;
  const response = await fetch(tarballUrl, {
    headers: { "User-Agent": "create-deepagent" },
  });

  if (!response.ok) {
    throw new Error(
      `Failed to download template from GitHub: ${response.status} ${response.statusText}`,
    );
  }

  const tarball = await response.arrayBuffer();
  const tmpDir = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), "create-deepagent-"),
  );

  try {
    const tarballPath = path.join(tmpDir, "template.tar.gz");
    await fs.promises.writeFile(tarballPath, Buffer.from(tarball));

    const extractDir = path.join(tmpDir, "extracted");
    await fs.promises.mkdir(extractDir, { recursive: true });

    await execFileAsync("tar", ["-xzf", tarballPath, "-C", extractDir]);

    // GitHub tarballs extract to a top-level dir named `{repo}-{sha}/`
    const extractedContents = await fs.promises.readdir(extractDir);
    const rootDir = extractedContents.find((entry) =>
      fs.statSync(path.join(extractDir, entry)).isDirectory(),
    );

    if (!rootDir) {
      throw new Error("Downloaded tarball did not contain a root directory.");
    }

    // If a subPath is specified, copy from that subdirectory; otherwise copy root
    const sourceDir = address.subPath
      ? path.join(extractDir, rootDir, address.subPath)
      : path.join(extractDir, rootDir);

    if (address.subPath && !fs.existsSync(sourceDir)) {
      throw new Error(
        `Subdirectory "${address.subPath}" not found in ${address.owner}/${address.repo}.`,
      );
    }

    await copyDir(sourceDir, dest);
  } finally {
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
  }
}
