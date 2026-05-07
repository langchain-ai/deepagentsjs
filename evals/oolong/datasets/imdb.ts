import { loadOolongTasksByDataset } from "../load-oolong.js";
import { makeOolongTests } from "../make-tests.js";

const tasks = (await loadOolongTasksByDataset()).get("imdb") ?? [];

export function oolongImdbSuite(): void {
  makeOolongTests(tasks);
}
