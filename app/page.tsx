import { redirect } from "next/navigation";

export default function Home() {
  // redirect は Next.js が basePath を自動付与するため、ここでは内部パスを渡す。
  redirect("/dashboard");
}