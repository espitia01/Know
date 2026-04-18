"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { api } from "@/lib/api";

interface BibtexModalProps {
  open: boolean;
  onClose: () => void;
  paperIds?: string[];
  folder?: string;
  workspaceId?: string;
  label?: string;
}

export function BibtexModal({ open, onClose, paperIds, folder, workspaceId, label }: BibtexModalProps) {
  const [bibtex, setBibtex] = useState("");
  const [count, setCount] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const wasOpen = useRef(false);

  useEffect(() => {
    if (open && !wasOpen.current) {
      setBibtex("");
      setCount(0);
      setError("");
      setCopied(false);
      setLoading(true);

      const opts: Record<string, unknown> = {};
      if (workspaceId) opts.workspace_id = workspaceId;
      else if (folder !== undefined) opts.folder = folder;
      else if (paperIds?.length) opts.paper_ids = paperIds;

      api
        .exportBibtex(opts as { paper_ids?: string[]; folder?: string; workspace_id?: string })
        .then((res) => {
          setBibtex(res.bibtex);
          setCount(res.count);
        })
        .catch((e) => {
          setError(e instanceof Error ? e.message : "Export failed");
        })
        .finally(() => setLoading(false));
    }
    wasOpen.current = open;
  }, [open, paperIds, folder, workspaceId]);

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(bibtex).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }, [bibtex]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center">
      <div className="absolute inset-0 bg-black/30 backdrop-blur-sm" onClick={onClose} />
      <div className="relative bg-white rounded-2xl shadow-2xl border border-gray-200 w-full max-w-lg mx-4 flex flex-col max-h-[80vh] animate-fade-in">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
          <div>
            <h3 className="text-[14px] font-semibold text-gray-900">BibTeX Export</h3>
            {label && <p className="text-[11px] text-gray-400 mt-0.5">{label}</p>}
          </div>
          <button
            onClick={onClose}
            className="w-7 h-7 rounded-lg text-gray-400 hover:text-gray-700 hover:bg-gray-100 flex items-center justify-center transition-all"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-5 py-4">
          {loading ? (
            <div className="flex items-center justify-center py-12">
              <div className="w-5 h-5 border-2 border-gray-200 border-t-gray-500 rounded-full animate-spin" />
            </div>
          ) : error ? (
            <div className="text-center py-8">
              <p className="text-[13px] text-red-500">{error}</p>
              <button
                onClick={onClose}
                className="mt-3 text-[12px] text-gray-500 hover:text-gray-700 transition-colors"
              >
                Close
              </button>
            </div>
          ) : (
            <>
              <p className="text-[11px] text-gray-400 mb-2">
                {count} {count === 1 ? "entry" : "entries"}
              </p>
              <pre className="text-[12px] leading-relaxed text-gray-700 bg-gray-50 border border-gray-100 rounded-xl p-4 whitespace-pre-wrap font-mono overflow-x-auto select-all">
                {bibtex}
              </pre>
            </>
          )}
        </div>

        {/* Footer */}
        {!loading && !error && bibtex && (
          <div className="px-5 py-3 border-t border-gray-100 flex items-center justify-end gap-2">
            <button
              onClick={onClose}
              className="text-[12px] text-gray-500 hover:text-gray-700 px-3 py-1.5 rounded-lg transition-colors"
            >
              Close
            </button>
            <button
              onClick={handleCopy}
              className="text-[12px] font-semibold px-4 py-1.5 rounded-lg bg-gray-900 text-white hover:bg-gray-800 transition-colors flex items-center gap-1.5"
            >
              {copied ? (
                <>
                  <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
                  </svg>
                  Copied
                </>
              ) : (
                <>
                  <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M15.666 3.888A2.25 2.25 0 0013.5 2.25h-3c-1.03 0-1.9.693-2.166 1.638m7.332 0c.055.194.084.4.084.612v0a.75.75 0 01-.75.75H9.75a.75.75 0 01-.75-.75v0c0-.212.03-.418.084-.612m7.332 0c.646.049 1.288.11 1.927.184 1.1.128 1.907 1.077 1.907 2.185V19.5a2.25 2.25 0 01-2.25 2.25H6.75A2.25 2.25 0 014.5 19.5V6.257c0-1.108.806-2.057 1.907-2.185a48.208 48.208 0 011.927-.184" />
                  </svg>
                  Copy to Clipboard
                </>
              )}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
