import EmployeeGuard from "@/components/EmployeeGuard";
import RfqInbox from "@/components/commerce/RfqInbox";

export default function RfqInboxPage() {
  return (
    <EmployeeGuard>
      <RfqInbox />
    </EmployeeGuard>
  );
}
