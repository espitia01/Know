/**
 * Client-side summary stream consumer for `/api/papers/[id]/summary-stream`.
 * Page-level auto-kickstart uses this instead of `useObject` inside SummaryPanel
 * so mount/unmount during paper switches cannot abort or duplicate requests.
 */

import { isDeepEqualData, parsePartialJson } from "ai";
import { getAuthHeadersSync } from "@/lib/api";
import { PaperSummarySchema, type PaperSummary } from "@/lib/server/schemas";
import { useStore } from "@/lib/store";

export class SummaryStreamError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SummaryStreamError";
  }
}

function readApiErrorMessage(body: string, status: number): string {
  try {
    const parsed = JSON.parse(body) as { detail?: { message?: string } };
    if (parsed.detail?.message) return parsed.detail.message;
  } catch {
    /* not JSON */
  }
  return body || `Summary request failed (${status})`;
}

/**
 * Stream a paper summary. Updates `summaryStreamingByPaper` on each partial parse.
 * Returns the validated final object, or null if aborted / empty.
 */
export async function streamSummaryForPaper(
  paperId: string,
  signal?: AbortSignal,
): Promise<PaperSummary | null> {
  try {
    const response = await fetch(`/api/papers/${paperId}/summary-stream`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...getAuthHeadersSync(),
      },
      credentials: "include",
      body: "{}",
      signal,
    });

    if (!response.ok) {
      const text = await response.text();
      throw new SummaryStreamError(readApiErrorMessage(text, response.status));
    }
    if (!response.body) {
      throw new SummaryStreamError("The summary response body is empty.");
    }

    let accumulatedText = "";
    let latestObject: Partial<PaperSummary> | undefined;

    await response.body.pipeThrough(new TextDecoderStream()).pipeTo(
      new WritableStream({
        async write(chunk) {
          accumulatedText += chunk;
          const { value } = await parsePartialJson(accumulatedText);
          const current = value as Partial<PaperSummary> | undefined;
          if (!isDeepEqualData(latestObject, current)) {
            latestObject = current;
            useStore.getState().setSummaryStreamingPartial(paperId, current ?? null);
          }
        },
      }),
    );

    if (!latestObject || Object.keys(latestObject).length === 0) {
      useStore.getState().clearSummaryStreamingPartial(paperId);
      return null;
    }

    const parsed = PaperSummarySchema.safeParse(latestObject);
    if (!parsed.success) {
      useStore.getState().clearSummaryStreamingPartial(paperId);
      return null;
    }

    useStore.getState().clearSummaryStreamingPartial(paperId);
    return parsed.data;
  } catch (e) {
    useStore.getState().clearSummaryStreamingPartial(paperId);
    if (e instanceof Error && e.name === "AbortError") return null;
    throw e;
  }
}
