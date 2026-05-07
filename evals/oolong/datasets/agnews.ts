import { loadOolongTasksByDataset } from "../load-oolong.js";
import { makeOolongTests } from "../make-tests.js";

const tasks = (await loadOolongTasksByDataset()).get("agnews") ?? [];

export function oolongAgnewsSuite(): void {
  makeOolongTests(tasks);
}
