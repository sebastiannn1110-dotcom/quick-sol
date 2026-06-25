import fs from "node:fs";
import path from "node:path";
import XLSX from "xlsx";

const outputDir = path.join(process.cwd(), "test-files");
const outputPath = path.join(outputDir, "quiksol_perfect_upload_clean.xlsx");

fs.mkdirSync(outputDir, { recursive: true });

const headers = [
  "Line ID",
  "Customer",
  "Supplier",
  "MPN",
  "PO",
  "QTY",
  "Cost",
  "Price",
  "Total Price",
  "GP rate",
  "GP",
  "Commission",
  "Region",
  "Status",
  "Category",
  "Manufacturer",
  "Description",
  "Date Code",
  "MOQ",
  "SPQ",
  "Lead Time (wks)",
  "Transit Time (wks)",
  "Potential_Amount_USD",
  "Target_to_Vendor",
  "Shipping Point Country",
  "Delivery Point",
  "Comments"
];

const customers = ["Sanmina", "Flex", "Jabil", "Foxconn", "Celestica"];
const suppliers = ["Arrow", "Avnet", "DigiKey", "Mouser", "Future"];
const manufacturers = ["Texas Instruments", "Analog Devices", "Infineon", "STMicroelectronics", "Microchip"];
const regions = ["North America", "Europe", "Asia", "Latin America"];
const countries = ["USA", "Mexico", "Germany", "China", "Colombia"];

const rows = Array.from({ length: 1000 }, (_, index) => {
  const line = index + 1;
  const qty = 100 + (line % 900);
  const cost = Number((0.35 + (line % 50) * 0.08).toFixed(2));
  const price = Number((cost * 1.28).toFixed(2));
  const totalPrice = Number((qty * price).toFixed(2));
  const gp = Number(((price - cost) * qty).toFixed(2));
  const gpRate = Number(((price - cost) / price).toFixed(4));
  const commission = Number((gp * 0.08).toFixed(2));
  const supplier = suppliers[index % suppliers.length];
  const customer = customers[index % customers.length];
  const manufacturer = manufacturers[index % manufacturers.length];

  return {
    "Line ID": `LN-${String(line).padStart(5, "0")}`,
    Customer: customer,
    Supplier: supplier,
    MPN: `QS-${manufacturer.slice(0, 2).toUpperCase()}-${String(100000 + line)}`,
    PO: `PO-${String(700000 + line)}`,
    QTY: qty,
    Cost: cost,
    Price: price,
    "Total Price": totalPrice,
    "GP rate": gpRate,
    GP: gp,
    Commission: commission,
    Region: regions[index % regions.length],
    Status: "Clean",
    Category: "Sales Margin",
    Manufacturer: manufacturer,
    Description: `${manufacturer} component for ${customer} supplied by ${supplier}`,
    "Date Code": `24${String(index % 52).padStart(2, "0")}`,
    MOQ: 100,
    SPQ: 50,
    "Lead Time (wks)": 4 + (index % 8),
    "Transit Time (wks)": 1 + (index % 4),
    Potential_Amount_USD: Number((totalPrice * 1.15).toFixed(2)),
    Target_to_Vendor: Number((cost * 0.95).toFixed(2)),
    "Shipping Point Country": countries[index % countries.length],
    "Delivery Point": `${regions[index % regions.length]} DC`,
    Comments: "Clean generated test row"
  };
});

const workbook = XLSX.utils.book_new();
const worksheet = XLSX.utils.json_to_sheet(rows, { header: headers });
XLSX.utils.book_append_sheet(workbook, worksheet, "Sales Margin Clean");
XLSX.writeFile(workbook, outputPath);

console.log(`Generated ${outputPath}`);
