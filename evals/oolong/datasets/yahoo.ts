import { loadOolongTasksByDataset } from "../load-oolong.js";
import { makeOolongTests } from "../make-tests.js";

const tasks = (await loadOolongTasksByDataset()).get("yahoo") ?? [];

export function oolongYahooSuite(): void {
  makeOolongTests(tasks);
}
