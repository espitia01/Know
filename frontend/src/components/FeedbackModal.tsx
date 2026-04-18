"use client";

import { useState, useRef, useEffect } from "react";
import Link from "next/link";
import { api, getAuthHeadersSync } from "@/lib/api";

interface FeedbackModalProps {
  open: boolean;
  onClose: () => void;
}

export function FeedbackModal({ open, onClose }: FeedbackModalProps) {
  const [message, setMessage] = useState("");
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const wasOpen = useRef(false);

  const isAuthed = !!getAuthHeadersSync().Authorization;

  useEffect(() => {
    if (open && !wasOpen.current) {
      setMessage("");
      setSending(false);
      setSent(false);
      setError("");
      setTimeout(() => textareaRef.current?.focus(), 100);
    }
    wasOpen.current = open;
  }, [open]);

  const handleSubmit = async () => {
    if (!message.trim()) return;
    setSending(true);
    setError("");
    try {
      await api.submitFeedback(message.trim());
      setSent(true);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Failed to send feedback");
    } finally {
      setSending(false);
    }
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div
        className="absolute inset-0 bg-black/30 backdrop-blur-sm"
        onClick={onClose}
      />
      <div className="relative bg-white rounded-2xl shadow-2xl border border-gray-100 max-w-md w-full mx-4 overflow-hidden animate-fade-in">
        <button
          onClick={onClose}
          className="absolute top-4 right-4 text-gray-300 hover:text-gray-500 transition-colors"
        >
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>

        {!sent ? (
          <>
            <div className="px-6 pt-7 pb-4">
              <div className="w-10 h-10 rounded-xl bg-gray-50 border border-gray-100 flex items-center justify-center mb-4">
                <svg className="w-5 h-5 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M7.5 8.25h9m-9 3H12m-9.75 1.51c0 1.6 1.123 2.994 2.707 3.227 1.129.166 2.27.293 3.423.379.35.026.67.21.865.501L12 21l2.755-4.133a1.14 1.14 0 01.865-.501 48.172 48.172 0 003.423-.379c1.584-.233 2.707-1.626 2.707-3.228V6.741c0-1.602-1.123-2.995-2.707-3.228A48.394 48.394 0 0012 3c-2.392 0-4.744.175-7.043.513C3.373 3.746 2.25 5.14 2.25 6.741v6.018z" />
                </svg>
              </div>
              <h2 className="text-[17px] font-bold text-gray-900">Send us feedback</h2>
              <p className="text-[13px] text-gray-500 mt-1">
                {isAuthed
                  ? "We'd love to hear your thoughts, ideas, or anything you think we can improve."
                  : "Please sign in to send feedback."}
              </p>
            </div>

            {isAuthed ? (
              <>
                <div className="px-6 pb-3">
                  <textarea
                    ref={textareaRef}
                    value={message}
                    onChange={(e) => setMessage(e.target.value)}
                    placeholder="What's on your mind?"
                    className="w-full text-[13px] border border-gray-100 rounded-xl px-4 py-3 resize-none h-32 focus:outline-none focus:ring-1 focus:ring-gray-300 focus:border-gray-300 placeholder:text-gray-400"
                  />
                </div>

                {error && (
                  <p className="px-6 pb-2 text-[12px] text-red-500">{error}</p>
                )}

                <div className="px-6 pb-6 flex gap-3">
                  <button
                    onClick={onClose}
                    className="flex-1 text-[13px] font-medium py-3 rounded-xl border border-gray-200 text-gray-700 hover:bg-gray-50 transition-colors"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={handleSubmit}
                    disabled={!message.trim() || sending}
                    className="flex-1 text-[13px] font-semibold py-3 rounded-xl bg-gray-900 text-white hover:bg-gray-800 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    {sending ? "Sending..." : "Send Feedback"}
                  </button>
                </div>
              </>
            ) : (
              <div className="px-6 pb-6 flex gap-3">
                <button
                  onClick={onClose}
                  className="flex-1 text-[13px] font-medium py-3 rounded-xl border border-gray-200 text-gray-700 hover:bg-gray-50 transition-colors"
                >
                  Close
                </button>
                <Link
                  href="/sign-in"
                  className="flex-1 text-[13px] font-semibold py-3 rounded-xl bg-gray-900 text-white hover:bg-gray-800 transition-colors text-center"
                >
                  Sign In
                </Link>
              </div>
            )}
          </>
        ) : (
          <div className="px-6 py-12 text-center">
            <div className="w-11 h-11 rounded-full bg-emerald-50 flex items-center justify-center mx-auto mb-4">
              <svg className="w-5 h-5 text-emerald-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
              </svg>
            </div>
            <h2 className="text-[17px] font-bold text-gray-900">Thank you!</h2>
            <p className="text-[13px] text-gray-500 mt-1.5">
              Your feedback has been received. We read every message.
            </p>
            <button
              onClick={onClose}
              className="mt-8 text-[13px] font-semibold px-6 py-3 rounded-xl bg-gray-900 text-white hover:bg-gray-800 transition-colors"
            >
              Done
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
