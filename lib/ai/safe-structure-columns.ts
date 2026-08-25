const SAFE_STRUCTURAL_COLUMNS = new Map<string, string>([
  ["mpn", "MPN"],
  ["partnumber", "Part Number"],
  ["item", "Item"],
  ["quantity", "Quantity"],
  ["qty", "Qty"],
  ["requiredqty", "RequiredQty"],
  ["stockqty", "STOCK QTY"],
  ["requireddate", "RequiredDate"],
  ["startdate", "StartDate"],
  ["date", "Date"],
  ["status", "status"],
  ["moq", "MOQ"],
  ["spq", "SPQ"]
]);

function normalizedColumn(value: string) {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9]/g, "")
    .toLowerCase();
}

export function allowlistedStructuralColumnNames(
  values: Array<string | null | undefined>,
  limit = 30
) {
  const output: string[] = [];
  for (const value of values) {
    if (!value) continue;
    const safe = SAFE_STRUCTURAL_COLUMNS.get(normalizedColumn(value));
    if (safe && !output.includes(safe)) output.push(safe);
    if (output.length >= limit) break;
  }
  return output;
}
