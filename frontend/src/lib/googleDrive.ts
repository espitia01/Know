/**
 * Google Drive integration — client-side Picker flow.
 *
 * Lazy-loads Google's `gapi.client` + `gis` (Identity Services) + Picker
 * SDKs from `apis.google.com` on first use. We never request a refresh
 * token; the short-lived access token lives only in memory until the
 * user closes the tab. Scope is `drive.file` so the consent screen lets
 * the user pick a single PDF without granting full Drive read access
 * (per Google's recommended least-privilege pattern).
 *
 * Public surface:
 *   isGoogleDriveConfigured()  → boolean (feature flag based on env)
 *   pickAndDownloadDriveFile() → Promise<File | null>
 *
 * Env vars (all NEXT_PUBLIC_*):
 *   NEXT_PUBLIC_GOOGLE_CLIENT_ID — OAuth 2.0 web client ID
 *   NEXT_PUBLIC_GOOGLE_API_KEY   — Picker API key (browser-restricted)
 *   NEXT_PUBLIC_GOOGLE_APP_ID    — Google Cloud project number
 */

declare global {
  interface Window {
    gapi?: GapiNamespace;
    google?: GoogleNamespace;
  }
}

interface GapiNamespace {
  load: (name: string, cb: () => void) => void;
}

interface GoogleNamespace {
  accounts: {
    oauth2: {
      initTokenClient: (config: TokenClientConfig) => TokenClient;
      hasGrantedAllScopes: (token: TokenResponse, ...scopes: string[]) => boolean;
      revoke: (token: string, cb?: () => void) => void;
    };
  };
  picker: PickerNamespace;
}

interface PickerNamespace {
  PickerBuilder: new () => PickerBuilderInstance;
  DocsView: new (id?: unknown) => DocsViewInstance;
  Feature: { NAV_HIDDEN: unknown; MULTISELECT_ENABLED: unknown };
  ViewId: { PDFS: unknown; DOCS: unknown };
  Action: { PICKED: string; CANCEL: string };
  Response: { ACTION: string; DOCUMENTS: string };
  Document: { ID: string; NAME: string; SIZE_BYTES: string; MIME_TYPE: string };
}

interface PickerBuilderInstance {
  addView: (view: DocsViewInstance) => PickerBuilderInstance;
  enableFeature: (feature: unknown) => PickerBuilderInstance;
  setOAuthToken: (token: string) => PickerBuilderInstance;
  setDeveloperKey: (key: string) => PickerBuilderInstance;
  setAppId: (id: string) => PickerBuilderInstance;
  setOrigin: (origin: string) => PickerBuilderInstance;
  setTitle: (title: string) => PickerBuilderInstance;
  setCallback: (cb: (data: PickerResponse) => void) => PickerBuilderInstance;
  build: () => PickerInstance;
}

interface PickerInstance {
  setVisible: (visible: boolean) => void;
}

interface DocsViewInstance {
  setMimeTypes: (mime: string) => DocsViewInstance;
  setIncludeFolders: (include: boolean) => DocsViewInstance;
  setSelectFolderEnabled: (enabled: boolean) => DocsViewInstance;
  setOwnedByMe?: (owned: boolean) => DocsViewInstance;
}

interface PickerResponse {
  action: string;
  docs?: PickerDocument[];
}

interface PickerDocument {
  id: string;
  name: string;
  mimeType: string;
  sizeBytes?: number | string;
}

interface TokenClientConfig {
  client_id: string;
  scope: string;
  callback: (response: TokenResponse) => void;
  error_callback?: (err: { type?: string; message?: string }) => void;
  prompt?: string;
}

interface TokenClient {
  requestAccessToken: (overrides?: { prompt?: string }) => void;
}

interface TokenResponse {
  access_token?: string;
  error?: string;
  scope?: string;
  expires_in?: number;
}

const DRIVE_FILE_SCOPE = "https://www.googleapis.com/auth/drive.file";
const GAPI_SRC = "https://apis.google.com/js/api.js";
const GIS_SRC = "https://accounts.google.com/gsi/client";

const env = () => ({
  clientId: process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID || "",
  apiKey: process.env.NEXT_PUBLIC_GOOGLE_API_KEY || "",
  appId: process.env.NEXT_PUBLIC_GOOGLE_APP_ID || "",
});

export function isGoogleDriveConfigured(): boolean {
  if (typeof window === "undefined") return false;
  const { clientId, apiKey, appId } = env();
  return Boolean(clientId && apiKey && appId);
}

let gapiPickerLoaded: Promise<void> | null = null;
let gisLoaded: Promise<void> | null = null;
let cachedToken: { value: string; expiresAt: number } | null = null;

function loadScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(
      `script[src="${src}"]`,
    );
    if (existing) {
      if (existing.dataset.loaded === "1") resolve();
      else {
        existing.addEventListener("load", () => resolve());
        existing.addEventListener("error", () =>
          reject(new Error(`Failed to load ${src}`)),
        );
      }
      return;
    }
    const s = document.createElement("script");
    s.src = src;
    s.async = true;
    s.defer = true;
    s.addEventListener("load", () => {
      s.dataset.loaded = "1";
      resolve();
    });
    s.addEventListener("error", () =>
      reject(new Error(`Failed to load ${src}`)),
    );
    document.head.appendChild(s);
  });
}

function ensureGapiPicker(): Promise<void> {
  if (gapiPickerLoaded) return gapiPickerLoaded;
  gapiPickerLoaded = (async () => {
    await loadScript(GAPI_SRC);
    if (!window.gapi) throw new Error("gapi failed to initialize");
    await new Promise<void>((resolve) =>
      window.gapi!.load("picker", () => resolve()),
    );
  })();
  return gapiPickerLoaded;
}

function ensureGis(): Promise<void> {
  if (gisLoaded) return gisLoaded;
  gisLoaded = loadScript(GIS_SRC).then(() => {
    if (!window.google?.accounts?.oauth2) {
      throw new Error("Google Identity Services failed to initialize");
    }
  });
  return gisLoaded;
}

function requestAccessToken(): Promise<string> {
  const { clientId } = env();
  if (!clientId) {
    return Promise.reject(
      new Error("NEXT_PUBLIC_GOOGLE_CLIENT_ID is not configured"),
    );
  }
  return new Promise<string>((resolve, reject) => {
    if (!window.google?.accounts?.oauth2) {
      reject(new Error("Google Identity Services not loaded"));
      return;
    }
    const tokenClient = window.google.accounts.oauth2.initTokenClient({
      client_id: clientId,
      scope: DRIVE_FILE_SCOPE,
      callback: (response) => {
        if (response.error || !response.access_token) {
          reject(
            new Error(response.error || "Failed to obtain Google access token"),
          );
          return;
        }
        const ttlMs = (response.expires_in ?? 3600) * 1000;
        cachedToken = {
          value: response.access_token,
          expiresAt: Date.now() + ttlMs - 60_000,
        };
        resolve(response.access_token);
      },
      error_callback: (err) => {
        reject(new Error(err.message || "Google sign-in cancelled"));
      },
    });
    tokenClient.requestAccessToken({ prompt: cachedToken ? "" : "consent" });
  });
}

async function getAccessToken(): Promise<string> {
  await ensureGis();
  if (cachedToken && cachedToken.expiresAt > Date.now()) {
    return cachedToken.value;
  }
  return requestAccessToken();
}

function openPicker(token: string): Promise<PickerDocument | null> {
  const { apiKey, appId } = env();
  return new Promise((resolve, reject) => {
    if (!window.google?.picker) {
      reject(new Error("Picker SDK not loaded"));
      return;
    }
    const picker = window.google.picker;
    const view = new picker.DocsView()
      .setMimeTypes("application/pdf")
      .setIncludeFolders(true)
      .setSelectFolderEnabled(false);
    const builder = new picker.PickerBuilder()
      .addView(view)
      .setOAuthToken(token)
      .setDeveloperKey(apiKey)
      .setAppId(appId)
      .setOrigin(window.location.origin)
      .setTitle("Open a paper from Google Drive")
      .setCallback((data: PickerResponse) => {
        if (data.action === picker.Action.PICKED) {
          const doc = data.docs?.[0];
          if (!doc) {
            resolve(null);
            return;
          }
          resolve(doc);
        } else if (data.action === picker.Action.CANCEL) {
          resolve(null);
        }
      });
    builder.build().setVisible(true);
  });
}

async function downloadDriveFile(
  doc: PickerDocument,
  token: string,
): Promise<File> {
  const url = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(doc.id)}?alt=media`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `Drive download failed (${res.status}): ${text.slice(0, 200) || res.statusText}`,
    );
  }
  const blob = await res.blob();
  const filename = (doc.name || "drive.pdf").toLowerCase().endsWith(".pdf")
    ? doc.name || "drive.pdf"
    : `${doc.name || "drive"}.pdf`;
  return new File([blob], filename, {
    type: doc.mimeType || "application/pdf",
    lastModified: Date.now(),
  });
}

export interface PickAndDownloadOptions {
  /** Max bytes the picked file may be (e.g. 50 MB). Matches the upload cap. */
  maxBytes?: number;
}

/**
 * End-to-end "open from Drive" helper. Resolves to a `File` ready for
 * `api.uploadPaper(...)`, or `null` if the user cancelled the picker.
 * Throws on any other failure (network, missing config, scope refused,
 * size cap exceeded).
 */
export async function pickAndDownloadDriveFile(
  { maxBytes }: PickAndDownloadOptions = {},
): Promise<File | null> {
  if (!isGoogleDriveConfigured()) {
    throw new Error("Google Drive is not configured for this deployment.");
  }
  await Promise.all([ensureGapiPicker(), ensureGis()]);
  const token = await getAccessToken();
  const picked = await openPicker(token);
  if (!picked) return null;

  if (maxBytes != null && picked.sizeBytes != null) {
    const size = Number(picked.sizeBytes);
    if (Number.isFinite(size) && size > maxBytes) {
      throw new Error(
        `"${picked.name}" is ${(size / 1024 / 1024).toFixed(1)} MB — exceeds the ${(maxBytes / 1024 / 1024).toFixed(0)} MB limit.`,
      );
    }
  }
  if (picked.mimeType && picked.mimeType !== "application/pdf") {
    throw new Error("Only PDF files are accepted from Drive.");
  }
  return downloadDriveFile(picked, token);
}
