import { Command } from "commander";
import { create } from "./commands/create/index.js";

import packageJson from "../package.json" with { type: "json" };

async function main() {
  const program = new Command()
    .name("create-deepagent")
    .description("Scaffold a new Deep Agents project")
    .version(packageJson.version);

  program.addCommand(create, { isDefault: true });

  program.parse();
}

main();
