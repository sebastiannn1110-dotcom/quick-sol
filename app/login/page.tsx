import { Suspense } from "react";
import LoginFallback from "@/components/LoginFallback";
import LoginForm from "@/components/LoginForm";

export default function LoginPage() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-[#f3f6fa] px-4 py-8 sm:px-6 lg:px-10">
      <Suspense fallback={<LoginFallback />}>
        <LoginForm />
      </Suspense>
    </div>
  );
}
