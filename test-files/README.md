# Quiksol Perfect Upload Test File

Run:

```bash
node scripts/generate-perfect-quiksol-excel.mjs
```

Generated file:

`test-files/quiksol_perfect_upload_clean.xlsx`

Upload guidance:

- Upload type: `Sales Margin` or `Auto Detect`
- Expected records: `1000`
- Expected errors: near `0`
- Expected category: `Sales Margin`
- Expected metrics populated: `QTY`, `Total Price`, `GP`, `Commission`, `Potential_Amount_USD`

This file is intentionally clean and should be used as a baseline before testing messy real-world Excel files.
