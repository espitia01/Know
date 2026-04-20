import { SignUp } from "@clerk/nextjs";
import Image from "next/image";
import Link from "next/link";
import { ThemeToggle } from "@/components/ThemeToggle";

export default function SignUpPage() {
  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-background text-foreground bg-mesh px-4 py-16 relative">
      <div className="absolute top-4 right-4">
        <ThemeToggle />
      </div>

      <div className="mb-8 flex flex-col items-center gap-4">
        <Link href="/" className="flex flex-col items-center gap-3 ring-focus rounded-xl">
          <Image src="/logo.png" alt="Know" width={48} height={48} priority className="rounded-xl" />
          <span className="text-[15px] font-semibold tracking-[-0.03em] text-foreground">Know</span>
        </Link>
        <div className="text-center">
          <h1 className="font-display text-[24px] font-bold tracking-[-0.03em] text-foreground">Create your account</h1>
          <p className="text-[13px] text-muted-foreground mt-1">Start learning papers the smart way</p>
        </div>
      </div>

      <SignUp
        forceRedirectUrl="/dashboard"
        appearance={{
          variables: {
            colorPrimary: "var(--primary)",
            colorBackground: "var(--card)",
            colorText: "var(--foreground)",
            colorTextSecondary: "var(--muted-foreground)",
            colorInputBackground: "var(--background)",
            colorInputText: "var(--foreground)",
            colorDanger: "var(--destructive)",
            borderRadius: "0.75rem",
            fontFamily: "var(--font-inter), system-ui, sans-serif",
          },
          elements: {
            rootBox: "w-full max-w-sm",
            card: "border border-border rounded-2xl bg-card shadow-md",
            headerTitle: "hidden",
            headerSubtitle: "hidden",
            formButtonPrimary:
              "btn-primary-glass text-sm font-medium rounded-xl",
            socialButtonsBlockButton:
              "border border-border hover:bg-accent rounded-xl font-medium text-sm text-foreground",
            footerActionLink: "text-foreground hover:opacity-80 font-medium",
            dividerLine: "bg-border",
            formFieldInput:
              "border border-border rounded-lg bg-background text-foreground",
          },
        }}
      />
    </div>
  );
}
