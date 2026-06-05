---
name: charts
description: ASCII chart and visualization helpers
ptcTools: []
---

# Charts

Render ASCII charts and visualizations inside the interpreter. All functions
return plain strings — write them into markdown fenced code blocks for
best results.

## API

### `barChart(items, labelKey, valueKey, opts?)`

Horizontal bar chart. Each item becomes one row.

```javascript
import { barChart } from "charts";

const data = [
  { name: "Rust", score: 8.2 },
  { name: "Go", score: 7.1 },
  { name: "Python", score: 6.3 },
];

barChart(data, "name", "score");
// Rust     ████████████████████ 8.2
// Go       ████████████████░░░░ 7.1
// Python   ██████████████░░░░░░ 6.3
```

Options: `{ width: 20, maxValue: 10, fillChar: "█", emptyChar: "░" }`

### `comparisonMatrix(items, labelKey, criteriaKeys)`

Grid comparing items across multiple criteria. Values are displayed in
a padded table with header row.

```javascript
import { comparisonMatrix } from "charts";

comparisonMatrix(data, "name", ["perf", "dx", "ecosystem"]);
//            perf  dx    ecosystem
// Rust       9     7     7
// Go         8     8     8
// Python     5     9     9
```

### `sparkline(values)`

Inline sparkline using Unicode block elements.

```javascript
import { sparkline } from "charts";

sparkline([1, 3, 7, 4, 2, 8, 5]);
// "▁▃▇▄▂█▅"
```
