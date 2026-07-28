"use client";

import EmployeeGuard from "@/components/EmployeeGuard";
import OpportunityFinder from "@/components/opportunity-finder/OpportunityFinder";

export default function OpportunityFinderPage() {
  return (
    <EmployeeGuard>
      <OpportunityFinder />
    </EmployeeGuard>
  );
}
