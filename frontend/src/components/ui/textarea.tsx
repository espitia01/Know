import * as React from "react"

import { cn } from "@/lib/utils"

function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        "flex field-sizing-content min-h-[4.25rem] w-full rounded-[var(--radius-md)] border border-input bg-muted/35 px-3 py-2.5 text-sm leading-relaxed transition-[color,background-color,border-color,box-shadow] duration-150 outline-none placeholder:text-muted-foreground/65 focus-visible:border-ring focus-visible:bg-background focus-visible:ring-2 focus-visible:ring-ring/35 disabled:cursor-not-allowed disabled:bg-muted/25 disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-2 aria-invalid:ring-destructive/25 dark:bg-input/35 dark:focus-visible:bg-card/95 dark:disabled:bg-input/20 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/35",
        className
      )}
      {...props}
    />
  )
}

export { Textarea }
