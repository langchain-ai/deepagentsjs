---
name: employee-classifier
description: Use this skill to classify employee records from CSV data into seniority levels, age groups, and promotion eligibility
---

# Employee Classifier

This skill provides the classification logic for employee records. When processing
employee data, implement this logic directly in your script (Python, Node.js, or bash).

## Input

Each employee record has: `name`, `age`, `department`, `years_at_company`.

## Classification Rules

### Seniority level

| years_at_company | seniority   |
| ---------------- | ----------- |
| >= 15            | "senior"    |
| >= 5             | "mid-level" |
| < 5              | "junior"    |

### Age group

| age   | age_group  |
| ----- | ---------- |
| >= 55 | "55+"      |
| >= 40 | "40-54"    |
| >= 30 | "30-39"    |
| < 30  | "under-30" |

### Promotion eligibility

An employee is promotion-eligible when **both** conditions are met:

- `years_at_company >= 3`
- `age >= 25`

## Output format

For each employee, produce a JSON object:

```json
{
  "name": "Alice Smith",
  "seniority": "mid-level",
  "age_group": "30-39",
  "department": "Engineering",
  "promotion_eligible": true
}
```

## Python reference implementation

```python
def classify_employee(name, age, department, years_at_company):
    seniority = "senior" if years_at_company >= 15 else "mid-level" if years_at_company >= 5 else "junior"
    age_group = "55+" if age >= 55 else "40-54" if age >= 40 else "30-39" if age >= 30 else "under-30"
    eligible = years_at_company >= 3 and age >= 25
    return {
        "name": name,
        "seniority": seniority,
        "age_group": age_group,
        "department": department,
        "promotion_eligible": eligible,
    }
```

## Node.js reference implementation

```javascript
function classifyEmployee(name, age, department, yearsAtCompany) {
  const seniority =
    yearsAtCompany >= 15
      ? "senior"
      : yearsAtCompany >= 5
        ? "mid-level"
        : "junior";
  const ageGroup =
    age >= 55 ? "55+" : age >= 40 ? "40-54" : age >= 30 ? "30-39" : "under-30";
  const eligible = yearsAtCompany >= 3 && age >= 25;
  return {
    name,
    seniority,
    age_group: ageGroup,
    department,
    promotion_eligible: eligible,
  };
}
```
