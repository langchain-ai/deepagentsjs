import { loadOolongTasksByDataset } from "../load-oolong.js";
import { makeOolongTests } from "../make-tests.js";

const tasks = (await loadOolongTasksByDataset()).get("spam") ?? [];

export function oolongSpamSuite(): void {
  makeOolongTests(tasks);
}
