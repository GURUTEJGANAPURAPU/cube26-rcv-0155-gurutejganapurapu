import { PageHeader } from "@/components/ui";
import { RecordsTable } from "@/components/records-table";

export const metadata = { title: "Evidence records · Receiving Manager" };

export default function EvidencePage() {
  return (
    <div className="max-w-6xl">
      <PageHeader title="Evidence records" subtitle="Every receiving unit with its decision, checks, images and override history." />
      <RecordsTable />
    </div>
  );
}
