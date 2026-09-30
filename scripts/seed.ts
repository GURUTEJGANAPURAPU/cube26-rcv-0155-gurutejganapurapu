/**
 * Seeds two DEMO organisations from the synthetic sample CSV (data/receiving_sample.csv)
 * plus one operator account per organisation, for the tenancy test.
 *
 * Only purchase orders and lines are seeded. No receiving records, images, verdicts
 * or evaluation results are fabricated: those come from real captures.
 *
 * Usage: SEED_DEMO_PASSWORD=... npm run seed   (reads .env.local)
 */
import { readFileSync } from "node:fs";
import { config } from "dotenv";
import { createClient } from "@supabase/supabase-js";

import { importFromCsv } from "../src/lib/po/import";

config({ path: ".env.local" });

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const password = process.env.SEED_DEMO_PASSWORD;
if (!url || !serviceKey) throw new Error("Set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env.local.");
if (!password || password.length < 10) throw new Error("Set SEED_DEMO_PASSWORD (10+ characters) for the demo operator accounts.");

const db = createClient(url, serviceKey, { auth: { persistSession: false } });

const ORGS = [
  { csv: "org_demo_alpha", slug: "demo-alpha", name: "Demo Warehouse Alpha", email: "operator.alpha@demo.invalid" },
  // NOTE: the csv value must match the org_id column in data/receiving_sample.csv exactly.
  { csv: "org_demo_bravo", slug: "demo-bravo", name: "Demo Warehouse Bravo", email: "operator.bravo@demo.invalid" },
];

async function must<T>(p: PromiseLike<{ data: T; error: { message: string } | null }>, what: string): Promise<NonNullable<T>> {
  const { data, error } = await p;
  if (error) throw new Error(`${what}: ${error.message}`);
  if (data == null) throw new Error(`${what}: no data`);
  return data as NonNullable<T>;
}

async function main() {
  const text = readFileSync("data/receiving_sample.csv", "utf8");
  const raw = text.split(/\r?\n/).slice(1).filter(Boolean);
  const { lines, issues } = importFromCsv(text);
  if (issues.length) console.log(`Import findings (${issues.length}):`, issues.slice(0, 10));

  // org_id column in the CSV decides tenancy; rows are matched by record_id.
  const orgOfRecord = new Map<string, string>();
  for (const row of raw) {
    const cols = row.split(",");
    orgOfRecord.set(cols[0], cols[2]);
  }

  for (const org of ORGS) {
    const [orgRow] = await must(
      db.from("organizations").upsert({ slug: org.slug, name: org.name, is_demo: true }, { onConflict: "slug" }).select("id"),
      "organisation",
    );

    let userId: string | undefined;
    const created = await db.auth.admin.createUser({ email: org.email, password, email_confirm: true });
    if (created.data.user) userId = created.data.user.id;
    else {
      const list = await db.auth.admin.listUsers({ perPage: 200 });
      userId = list.data.users.find((u) => u.email === org.email)?.id;
    }
    if (!userId) throw new Error(`Could not create or find ${org.email}`);
    await must(db.from("profiles").upsert({ id: userId, organization_id: orgRow.id, display_name: `${org.name} operator`, operator_label: `op_${org.slug}` }).select("id"), "profile");
    await must(db.from("user_roles").upsert({ user_id: userId, role: "operator" }, { onConflict: "user_id,role" }).select("id"), "role");

    const mine = lines.filter((l) => orgOfRecord.get(l.record_id ?? "") === org.csv);
    const groups = new Map<string, typeof mine>();
    for (const l of mine) {
      const k = `${l.po_number}|${l.supplier}`;
      groups.set(k, [...(groups.get(k) ?? []), l]);
    }
    for (const [, group] of groups) {
      const [po] = await must(
        db.from("purchase_orders")
          .upsert({ organization_id: orgRow.id, po_number: group[0].po_number, supplier: group[0].supplier, is_demo: true }, { onConflict: "organization_id,po_number,supplier" })
          .select("id"),
        "purchase order",
      );
      await must(
        db.from("purchase_order_lines").upsert(
          group.map((l) => ({
            organization_id: orgRow.id, purchase_order_id: po.id, po_line: l.po_line, unit_id: l.unit_id ?? null,
            source_record_id: l.record_id ?? null, sku: l.sku, asin: l.asin ?? null, product_title: l.product_title,
            spec_colour: l.spec_colour ?? null, spec_variant: l.spec_variant ?? null, spec_components: l.spec_components,
            cartons_ordered: l.cartons_ordered, units_per_carton_ordered: l.units_per_carton_ordered, qty_ordered: l.qty_ordered, is_demo: true,
          })),
          { onConflict: "organization_id,purchase_order_id,po_line" },
        ).select("id"),
        "purchase order lines",
      );
    }
    console.log(`${org.slug}: ${groups.size} purchase orders, ${mine.length} lines, operator ${org.email}`);
  }
  console.log("Done. All seeded data is marked DEMO (synthetic reference data).");
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
