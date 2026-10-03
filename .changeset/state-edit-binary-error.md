---
"deepagents": patch
---

`StateBackend.edit()` now returns `{ error }` for binary files instead of throwing. It previously let `fileDataToString`'s `Cannot convert binary FileData to string` escape, while `StoreBackend.edit()` returned an error result for the same input.
