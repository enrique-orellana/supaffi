import { redirect } from "next/navigation";
import { requireAffiliate } from "@/lib/affiliateAuth";
import { getAffiliatePayoutDetails } from "@/lib/affiliate";
import { getAffiliateDisplaySettings } from "@/lib/affiliateDisplaySettings";
import { Page, PageTitle } from "@/components/dashboard/Page";
import { SettingsForm } from "./SettingsForm";

export default async function AffiliateSettingsPage() {
  const { affiliateId, merchant } = await requireAffiliate();
  const [settings, payoutDetails] = await Promise.all([
    getAffiliateDisplaySettings(affiliateId, merchant.id),
    getAffiliatePayoutDetails(affiliateId),
  ]);
  if (!settings) redirect("/affiliates/login");

  return (
    <Page>
      <PageTitle title="Settings" />
      <SettingsForm
        payoutDetails={payoutDetails ?? ""}
        preference={settings.preference}
        programDefault={settings.programDefault}
      />
    </Page>
  );
}
