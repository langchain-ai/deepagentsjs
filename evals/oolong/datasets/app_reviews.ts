import { loadOolongTasksByDataset } from "../load-oolong.js";
import { makeOolongTests } from "../make-tests.js";

const tasks = (await loadOolongTasksByDataset()).get("app_reviews") ?? [];

export function oolongAppReviewsSuite(): void {
  makeOolongTests(tasks);
}
