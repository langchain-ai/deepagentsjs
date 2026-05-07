import { loadOolongTasksByDataset } from "../load-oolong.js";
import { makeOolongTests } from "../make-tests.js";

const tasks = (await loadOolongTasksByDataset()).get("trec_coarse") ?? [];

export function oolongTrecCoarseSuite(): void {
  makeOolongTests(tasks);
}
