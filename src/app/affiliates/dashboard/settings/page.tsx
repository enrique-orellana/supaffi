import { redirect } from "next/navigation";
import { requireAffiliate } from "@/lib/affiliateAuth";
import { getAffiliateDisplaySettings } from "@/lib/affiliateDisplaySettings";
import { Page, PageTitle, Section } from "@/components/dashboard/Page";
import { SettingsForm } from "./SettingsForm";

export default async function AffiliateSettingsPage() {
  const { affiliateId, merchant } = await requireAffiliate();
  const settings = await getAffiliateDisplaySettings(affiliateId, merchant.id);
  if (!settings) redirect("/affiliates/login");

  return (
    <Page>
      <PageTitle title="Settings" />
      <Section title="Display currency">
        <SettingsForm
          preference={settings.preference}
          programDefault={settings.programDefault}
        />
      </Section>
    </Page>
  );
}
