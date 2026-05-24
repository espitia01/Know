"use client";

import { Streamdown } from "streamdown";
import { createMathPlugin } from "@streamdown/math";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { PaperFrontMatterData } from "@/lib/api";

const math = createMathPlugin({ singleDollarTextMath: true });

function affiliationForTag(
  affiliations: PaperFrontMatterData["affiliations"],
  tag: string,
): string {
  const match = affiliations.find((a) => a.tag === tag);
  return match?.text ?? tag;
}

function AuthorSuperscripts({
  name,
  superscripts,
  affiliations,
}: {
  name: string;
  superscripts: string[];
  affiliations: PaperFrontMatterData["affiliations"];
}) {
  return (
    <sup>
      {superscripts.map((tag, ti) => (
        <span key={`${name}-${tag}`}>
          {ti > 0 ? "," : null}
          <Tooltip>
            <TooltipTrigger
              type="button"
              className="cursor-help underline decoration-dotted underline-offset-2"
            >
              {tag}
            </TooltipTrigger>
            <TooltipContent side="top" className="max-w-sm text-left">
              {affiliationForTag(affiliations, tag)}
            </TooltipContent>
          </Tooltip>
        </span>
      ))}
    </sup>
  );
}

export function PaperFrontMatter({ frontMatter }: { frontMatter: PaperFrontMatterData }) {
  const { title, venue, authors, affiliations, abstract } = frontMatter;

  return (
    <TooltipProvider delay={200}>
      <header className="reader-front-matter mb-8 space-y-4 text-center">
        {venue ? (
          <p className="text-[var(--text-xs)] uppercase tracking-[0.12em] text-muted-foreground">
            {venue}
          </p>
        ) : null}
        <h1>{title}</h1>
        {authors.length > 0 ? (
          <p className="reader-byline mx-auto max-w-[52ch]">
            {authors.map((author, idx) => (
              <span key={`${author.name}-${idx}`}>
                {idx > 0 ? ", " : null}
                {author.name}
                {author.superscripts && author.superscripts.length > 0 ? (
                  <AuthorSuperscripts
                    name={author.name}
                    superscripts={author.superscripts}
                    affiliations={affiliations}
                  />
                ) : null}
              </span>
            ))}
          </p>
        ) : null}
        {affiliations.length > 0 ? (
          <ul className="reader-affiliations mx-auto max-w-[58ch] list-none space-y-1 p-0 text-left">
            {affiliations.map((aff, idx) => (
              <li key={`${aff.tag ?? idx}-${idx}`}>
                {aff.tag ? (
                  <sup className="mr-1 text-[0.75em]">{aff.tag}</sup>
                ) : null}
                {aff.text}
              </li>
            ))}
          </ul>
        ) : null}
        {abstract ? (
          <div className="reader-abstract mx-auto max-w-[62ch] text-left">
            <p className="reader-abstract-label mb-2">Abstract</p>
            <Streamdown plugins={{ math }} mode="static" controls={false} parseIncompleteMarkdown={false}>
              {abstract}
            </Streamdown>
          </div>
        ) : null}
      </header>
    </TooltipProvider>
  );
}
