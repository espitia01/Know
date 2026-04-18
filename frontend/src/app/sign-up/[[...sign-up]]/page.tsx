import { SignUp } from "@clerk/nextjs";
import Image from "next/image";
import Link from "next/link";

export default function SignUpPage() {
  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-white px-4">
      <div className="mb-8 flex flex-col items-center gap-4">
        <Link href="/" className="flex flex-col items-center gap-3">
          <Image src="/logo.png" alt="Know" width={48} height={48} priority className="rounded-xl" />
          <span className="text-[15px] font-semibold tracking-[-0.03em] text-gray-900">Know</span>
        </Link>
        <div className="text-center">
          <h1 className="text-[22px] font-bold tracking-[-0.03em] text-gray-900">Create your account</h1>
          <p className="text-[13px] text-gray-400 mt-1">Start learning papers the smart way</p>
        </div>
      </div>
      <SignUp
        forceRedirectUrl="/dashboard"
        appearance={{
          elements: {
            rootBox: "w-full max-w-sm",
            card: "shadow-none border border-gray-100 rounded-2xl bg-white",
            headerTitle: "hidden",
            headerSubtitle: "hidden",
            formButtonPrimary:
              "bg-gray-900 hover:bg-gray-800 text-sm font-medium rounded-xl shadow-sm shadow-gray-900/10",
            socialButtonsBlockButton:
              "border border-gray-100 hover:bg-gray-50 rounded-xl font-medium text-sm",
            footerActionLink: "text-gray-900 hover:text-gray-700 font-medium",
          },
        }}
      />
    </div>
  );
}
