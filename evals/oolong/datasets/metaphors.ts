import { loadOolongTasksByDataset } from "../load-oolong.js";
import { makeOolongTests } from "../make-tests.js";

const tasks = (await loadOolongTasksByDataset()).get("metaphors") ?? [];

export function oolongMetaphorsSuite(): void {
  makeOolongTests(tasks);
}
