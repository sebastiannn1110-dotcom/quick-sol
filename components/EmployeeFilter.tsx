"use client";

import type { Employee } from "@/lib/types";

interface EmployeeFilterProps {
  employees: Employee[];
  value: string;
  onChange: (value: string) => void;
}

export default function EmployeeFilter({ employees, value, onChange }: EmployeeFilterProps) {
  return (
    <select
      value={value}
      onChange={(event) => onChange(event.target.value)}
      className="focus-ring w-full rounded-md border border-slate-300 bg-white px-3 py-2.5 text-sm text-slate-950 shadow-sm"
    >
      <option value="">All employees</option>
      {employees.map((employee) => (
        <option key={employee.id} value={employee.id}>
          {employee.name} ({employee.id})
        </option>
      ))}
    </select>
  );
}
