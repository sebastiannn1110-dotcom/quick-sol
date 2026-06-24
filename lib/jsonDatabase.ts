import { mkdir, readFile, writeFile } from "fs/promises";
import path from "path";
import type {
  BusinessRecord,
  DatabaseRepository,
  DatabaseShape,
  Employee,
  RecordFilters,
  Upload
} from "@/lib/types";
import { buildAnalytics } from "@/lib/analytics";

const DATA_DIR = path.join(process.cwd(), "data");
const DATABASE_PATH = path.join(DATA_DIR, "database.json");
const UPLOADS_PATH = path.join(DATA_DIR, "uploads.json");

const EMPTY_DATABASE: DatabaseShape = {
  employees: [],
  uploads: [],
  records: []
};

let writeQueue = Promise.resolve();

async function ensureDataDirectory() {
  await mkdir(DATA_DIR, { recursive: true });
}

function normalizeDatabaseShape(value: Partial<DatabaseShape> | null | undefined): DatabaseShape {
  return {
    employees: Array.isArray(value?.employees) ? value.employees : [],
    uploads: Array.isArray(value?.uploads) ? value.uploads : [],
    records: Array.isArray(value?.records) ? value.records : []
  };
}

async function writeJson(filePath: string, value: unknown) {
  await ensureDataDirectory();
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function readJson<T>(filePath: string, fallback: T): Promise<T> {
  try {
    const content = await readFile(filePath, "utf8");
    if (!content.trim()) return fallback;
    return JSON.parse(content) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      await writeJson(filePath, fallback);
      return fallback;
    }
    throw error;
  }
}

function matchesText(value: string | undefined, filter: string | undefined) {
  if (!filter) return true;
  return value?.toLowerCase().includes(filter.toLowerCase()) ?? false;
}

function filterRecords(records: BusinessRecord[], filters: RecordFilters = {}) {
  return records.filter((record) => {
    if (filters.query && !record.searchableText.toLowerCase().includes(filters.query.toLowerCase())) {
      return false;
    }
    if (filters.category && filters.category !== "All" && record.category !== filters.category) {
      return false;
    }
    if (!matchesText(record.employeeId, filters.employeeId)) return false;
    if (!matchesText(record.department, filters.department)) return false;
    if (!matchesText(record.region, filters.region)) return false;

    const createdAt = new Date(record.createdAt).getTime();
    if (filters.uploadDateFrom && createdAt < new Date(filters.uploadDateFrom).getTime()) {
      return false;
    }
    if (filters.uploadDateTo) {
      const endDate = new Date(filters.uploadDateTo);
      endDate.setHours(23, 59, 59, 999);
      if (createdAt > endDate.getTime()) return false;
    }

    return true;
  });
}

export class JsonDatabaseRepository implements DatabaseRepository {
  // Temporary repository layer. Replace this class with a Prisma/PostgreSQL
  // implementation later without changing API routes or UI consumers.
  async readDatabase(): Promise<DatabaseShape> {
    await ensureDataDirectory();
    const database = await readJson<DatabaseShape>(DATABASE_PATH, EMPTY_DATABASE);
    const normalized = normalizeDatabaseShape(database);

    if (
      normalized.employees !== database.employees ||
      normalized.uploads !== database.uploads ||
      normalized.records !== database.records
    ) {
      await this.writeDatabase(normalized);
    }

    return normalized;
  }

  async writeDatabase(database: DatabaseShape): Promise<void> {
    const normalized = normalizeDatabaseShape(database);
    writeQueue = writeQueue.then(async () => {
      await writeJson(DATABASE_PATH, normalized);
      await writeJson(UPLOADS_PATH, normalized.uploads);
    });
    await writeQueue;
  }

  async addUpload(upload: Upload): Promise<Upload> {
    const database = await this.readDatabase();
    database.uploads.unshift(upload);
    await this.writeDatabase(database);
    return upload;
  }

  async addRecords(records: BusinessRecord[]): Promise<BusinessRecord[]> {
    const database = await this.readDatabase();
    database.records.unshift(...records);
    await this.writeDatabase(database);
    return records;
  }

  async upsertEmployee(employee: Employee): Promise<Employee> {
    const database = await this.readDatabase();
    const existingIndex = database.employees.findIndex((item) => item.id === employee.id);

    if (existingIndex >= 0) {
      database.employees[existingIndex] = {
        ...database.employees[existingIndex],
        ...employee,
        createdAt: database.employees[existingIndex].createdAt
      };
    } else {
      database.employees.unshift(employee);
    }

    await this.writeDatabase(database);
    return existingIndex >= 0 ? database.employees[existingIndex] : employee;
  }

  async getRecords(filters?: RecordFilters): Promise<BusinessRecord[]> {
    const database = await this.readDatabase();
    return filterRecords(database.records, filters);
  }

  async getEmployeeById(employeeId: string): Promise<Employee | null> {
    const database = await this.readDatabase();
    return (
      database.employees.find((employee) => employee.id.toLowerCase() === employeeId.toLowerCase()) ??
      null
    );
  }

  async getRecordsByEmployeeId(employeeId: string): Promise<BusinessRecord[]> {
    const database = await this.readDatabase();
    return database.records.filter(
      (record) => record.employeeId.toLowerCase() === employeeId.toLowerCase()
    );
  }

  async getUploadsByEmployeeId(employeeId: string): Promise<Upload[]> {
    const database = await this.readDatabase();
    return database.uploads.filter(
      (upload) => upload.employeeId.toLowerCase() === employeeId.toLowerCase()
    );
  }

  async searchRecords(query: string): Promise<BusinessRecord[]> {
    if (!query.trim()) return [];
    return this.getRecords({ query });
  }

  async getAnalytics() {
    const database = await this.readDatabase();
    return buildAnalytics(database);
  }
}

export const databaseRepository = new JsonDatabaseRepository();

export async function readDatabase() {
  return databaseRepository.readDatabase();
}

export async function writeDatabase(database: DatabaseShape) {
  return databaseRepository.writeDatabase(database);
}

export async function addUpload(upload: Upload) {
  return databaseRepository.addUpload(upload);
}

export async function addRecords(records: BusinessRecord[]) {
  return databaseRepository.addRecords(records);
}

export async function getRecords(filters?: RecordFilters) {
  return databaseRepository.getRecords(filters);
}

export async function getEmployeeById(employeeId: string) {
  return databaseRepository.getEmployeeById(employeeId);
}

export async function getRecordsByEmployeeId(employeeId: string) {
  return databaseRepository.getRecordsByEmployeeId(employeeId);
}

export async function getUploadsByEmployeeId(employeeId: string) {
  return databaseRepository.getUploadsByEmployeeId(employeeId);
}

export async function searchRecords(query: string) {
  return databaseRepository.searchRecords(query);
}

export async function getAnalytics() {
  return databaseRepository.getAnalytics();
}
