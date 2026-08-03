import { redirect } from "next/navigation";

import { LoginView } from "@/components/login-view";
import { getOAuthConfig, readZooSession } from "@/lib/zoo-auth";

export const dynamic = "force-dynamic";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await readZooSession().catch(() => null);
  if (session) redirect("/");
  const params = await searchParams;
  const authError =
    typeof params.auth_error === "string" ? params.auth_error : null;
  return (
    <LoginView configured={getOAuthConfig().configured} error={authError} />
  );
}
