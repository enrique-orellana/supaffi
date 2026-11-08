import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { getMerchantForOwnerBySlug } from "@/lib/merchant";
import { Page, PageTitle, Section } from "@/components/dashboard/Page";
import { ImportWizard } from "./ImportWizard";

export default async function AffiliateImportsPage({
  params,
}: {
  params: Promise<{ product: string }>;
}) {
  const { product } = await params;
  const session = await auth();
  if (!session?.user?.id || session.user.role !== "owner") redirect("/login");
  const ownerId = session.user.id;
  const source = await getMerchantForOwnerBySlug(ownerId, product);
  if (!source) notFound();

  const [merchants, affiliates] = await Promise.all([
    db.merchant.findMany({
      where: { ownerId },
      select: {
        id: true,
        name: true,
        programs: {
          select: { id: true, name: true },
          orderBy: { name: "asc" },
        },
      },
      orderBy: { name: "asc" },
    }),
    db.affiliate.findMany({
      where: { merchant: { ownerId } },
      select: {
        id: true,
        merchantId: true,
        programId: true,
        email: true,
        merchant: { select: { name: true } },
      },
      orderBy: { email: "asc" },
    }),
  ]);
  const targets = merchants.flatMap((merchant) =>
    merchant.programs.map((program) => ({
      merchantId: merchant.id,
      merchantName: merchant.name,
      programId: program.id,
      programName: program.name,
    })),
  );

  return (
    <Page>
      <PageTitle
        title="Affiliate imports"
        subtitle={`Review and import an affiliate bundle for ${source.name}. History stays separate from current balances and payouts.`}
        actions={
          <Link
            className="rounded-md border border-border px-3 py-2 text-sm"
            href={`/dashboard/products/${product}/imports/history`}
          >
            View import history
          </Link>
        }
      />
      <Section>
        <ImportWizard
          productSlug={product}
          targets={targets}
          affiliates={affiliates.map((affiliate) => ({
            id: affiliate.id,
            merchantId: affiliate.merchantId,
            programId: affiliate.programId,
            email: affiliate.email,
            merchantName: affiliate.merchant.name,
          }))}
        />
      </Section>
    </Page>
  );
}
