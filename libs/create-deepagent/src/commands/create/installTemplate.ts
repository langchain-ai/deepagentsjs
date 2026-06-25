import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { x as tarExtract } from "tar";

import { copyDir } from "../../utils/fileUtils.js";
import { dirExists, isDirEmpty, makeDir } from "../../utils/validate.js";
import type { FrameworkConfig } from "../../registry/framework.js";
import { Address } from "../../registry/address.js";

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
  address: Extract<Address, { scheme: "github" }>,
  dest: string,
): Promise<void> {
  const tarballUrl = `https://codeload.github.com/${address.owner}/${address.repo}/tar.gz/HEAD`;
  let tmpDir;

  try {
    tmpDir = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), "create-deepagent"),
    );

    // 1. Fetch the repo tarball
    const response = await fetch(tarballUrl);
    if (!response.ok || !response.body) {
      throw new Error(
        `Failed to download template from GitHub: ${response.status} ${response.statusText}`,
      );
    }

    // 2. Extract and validate
    const extractDir = path.join(tmpDir, "extracted");
    await makeDir(extractDir);

    await pipeline(
      Readable.fromWeb(response.body as NodeReadableStream<Uint8Array>),
      tarExtract({ cwd: extractDir, strip: 1 }),
    );

    if (await isDirEmpty(extractDir)) {
      throw new Error(
        `Downloaded tarball for ${address.owner}/${address.repo} was empty.`,
      );
    }

    const sourceDir = address.subPath
      ? path.join(extractDir, address.subPath)
      : extractDir;

    if (address.subPath && !(await dirExists(sourceDir))) {
      throw new Error(
        `Subdirectory "${address.subPath}" not found in ${address.owner}/${address.repo}.`,
      );
    }

    // 3. Copy to dest
    await copyDir(sourceDir, dest);
  } catch (e) {
    throw new Error(
      `Failed to install template from ${address.owner}/${address.repo}: ${e}`, { cause: e },
    );
  } finally {
    if (tmpDir) await fs.promises.rm(tmpDir, { recursive: true, force: true });
  }
}
