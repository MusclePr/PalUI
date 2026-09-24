import { getAuthState } from "../../lib/server/auth";
import { LoginForm } from "./LoginForm";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type LoginPageProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

export default async function LoginPage({ searchParams }: LoginPageProps) {
  const emptyParams: Record<string, string | string[] | undefined> = {};
  const [{ configured }, params] = await Promise.all([getAuthState(), searchParams ?? Promise.resolve(emptyParams)]);
  const authNotice = typeof params.authNotice === "string" ? params.authNotice : undefined;

  return <LoginForm initialConfigured={configured} initialAuthNotice={authNotice} />;
}