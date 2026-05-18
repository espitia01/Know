/**
 * Server-only Supabase admin client (service role key).
 *
 * Importing this module from a client component or shared client-runtime
 * file will throw at construction time — the service role key is
 * privileged and must never reach the browser. The dynamic import in
 * `auth.ts` and the route-handler files is intentional: those run only
 * on the server.
 */

import "server-only";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

let _client: SupabaseClient | null = null;

export function getAdminSupabase(): SupabaseClient {
  if (_client) return _client;
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error(
      "Supabase admin client unavailable: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set on the server.",
    );
  }
  _client = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return _client;
}
