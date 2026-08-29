import SourcingGuard from "@/components/sourcing/SourcingGuard";
import SourcingWorkspace from "@/components/sourcing/SourcingWorkspace";

export default function SourcingPage() {
  return (
    <SourcingGuard>
      <SourcingWorkspace />
    </SourcingGuard>
  );
}
