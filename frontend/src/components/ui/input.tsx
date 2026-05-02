import * as React from "react"
import { Input as InputPrimitive } from "@base-ui/react/input"

import { cn } from "@/lib/utils"

function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <InputPrimitive
      type={type}
      data-slot="input"
      className={cn(
        "h-9 w-full min-w-0 rounded-[var(--radius-md)] border border-input bg-muted/35 px-3 py-1.5 text-sm transition-[color,background-color,border-color,box-shadow] duration-150 outline-none file:inline-flex file:h-6 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground/65 focus-visible:border-ring focus-visible:bg-background focus-visible:ring-2 focus-visible:ring-ring/35 disabled:pointer-events-none disabled:cursor-not-allowed disabled:bg-muted/25 disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-2 aria-invalid:ring-destructive/25 dark:bg-input/35 dark:focus-visible:bg-card/95 dark:disabled:bg-input/20 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/35",
        className
      )}
      {...props}
    />
  )
}

export { Input }
