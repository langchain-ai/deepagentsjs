import { loadOolongTasksByDataset } from "../load-oolong.js";
import { makeOolongTests } from "../make-tests.js";

const tasks = (await loadOolongTasksByDataset()).get("formality") ?? [];

export function oolongFormalitySuite(): void {
  makeOolongTests(tasks);
}
