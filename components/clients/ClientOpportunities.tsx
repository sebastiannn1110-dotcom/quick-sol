"use client";

import OpportunitiesDashboard from "@/components/opportunities/OpportunitiesDashboard";

export default function ClientOpportunities({ clientId }: { clientId: string }) {
  return <OpportunitiesDashboard endpoint={`/api/clients/${clientId}/opportunities`} showHeader={false} compact />;
}
