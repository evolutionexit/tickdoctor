import type { Metadata } from "next";
import { ForgotPasswordForm } from "@/components/auth/forms";

export const metadata: Metadata = { title: "Forgot your password?", robots: { index: false, follow: false } };

export default function Page() {
  return <ForgotPasswordForm />;
}
