import { DeepwasmBackend } from "../src/backend.js";
import { BaseDemoBackend } from "./demo-backend";

class FooBackend extends BaseDemoBackend {
  constructor() {
    super({
      "/a.txt": "i'm a text file, aaaaaaaa.",
      "/b.txt": "if you can read this, venmo me $10.",
      "/c.txt": "(now with 20% more bytes)",
    });
    this.isReadonly = true;
  }
}

class BarBackend extends BaseDemoBackend {
  constructor() {
    super({
      "/d.txt": "i'm a text file, bbbbbbbb.",
      "/e.txt": "the quick brown fox jumps over the lazy dog.",
      "/f.txt": "(now with 20% more bytes)",
    });
    this.isReadonly = false;
  }
}

async function main() {
  const backend = await DeepwasmBackend.create({
    mounts: {
      "/foo": new FooBackend(),
      "/bar": new BarBackend(),
    },
  });
  const readResult = await backend.execute(
    `(cat /foo/a.txt >> /bar/d.txt) && cat /bar/d.txt`,
  );
  console.log(readResult);
}

await main().catch((err) => {
  console.error(err);
  process.exit(1);
});
