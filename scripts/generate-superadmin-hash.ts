import { createScryptPasswordHash } from "../lib/superadmin/auth";

const password = process.argv[2];

if (!password) {
  console.error("Usage: npm run superadmin:hash -- \"your-strong-password\"");
  process.exit(1);
}

console.log(createScryptPasswordHash(password));
