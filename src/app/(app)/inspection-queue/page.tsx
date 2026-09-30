import { PageHeader } from "@/components/ui";
import { RecordsTable } from "@/components/records-table";

export const metadata = { title: "Inspection queue · Receiving Manager" };

export default function QueuePage() {
  return (
    <div className="max-w-6xl">
      <PageHeader title="Inspection queue" subtitle="Exceptions, uncertain checks and pending inspections waiting for an operator." />
      <RecordsTable queueOnly />
    </div>
  );
}
