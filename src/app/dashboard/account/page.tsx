import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { getOwnerDisplayCurrency } from "@/lib/ownerDisplaySettings";
import {
  availableUpdate,
  installedVersion,
  updateCheckEnabled,
} from "@/lib/version";
import { Page, PageTitle, Section } from "@/components/dashboard/Page";
import { DisplayCurrencyForm, EmailForm, PasswordForm } from "./AccountForms";

/**
 * The account itself, and the instance it runs on.
 *
 * The instance block is read only. Whether this server checks for releases is
 * a server setting, and nothing here can apply an update: that would mean
 * giving the web app control of Docker on the host. The wireframe's toggle is
 * corrected to a line of status and the environment variable that changes it.
 */

export default async function AccountPage() {
  const session = await auth();
  if (!session?.user?.id || session.user.role !== "owner") redirect("/login");

  // Answers from the cache and starts a refresh it does not wait for, so a
  // server with no outbound access does not pay for this on every visit.
  const update = availableUpdate();
  const displayCurrency = await getOwnerDisplayCurrency(session.user.id);

  return (
    <Page>
      <PageTitle title="Account" />

      <EmailForm email={session.user.email ?? ""} />
      <PasswordForm email={session.user.email ?? ""} />

      <Section title="Dashboard display currency">
        <DisplayCurrencyForm currency={displayCurrency} />
      </Section>

      <Section title="This instance">
        <div className="flex flex-col gap-2 text-sm">
          <div className="flex justify-between">
            <span>Supaffi {installedVersion()}</span>
            <span className="text-muted-foreground">
              {update ? (
                <a
                  className="cursor-pointer underline"
                  href={update.url}
                  target="_blank"
                  rel="noreferrer"
                >
                  {update.version} is out
                </a>
              ) : (
                "up to date"
              )}
            </span>
          </div>
          <div className="flex justify-between">
            <span>Update check</span>
            <span className="text-muted-foreground">
              {updateCheckEnabled()
                ? "on. Set SUPAFFI_UPDATE_CHECK=off on the server to turn it off."
                : "off"}
            </span>
          </div>
        </div>
      </Section>
    </Page>
  );
}
