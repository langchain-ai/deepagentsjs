/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_RESEND_API_KEY?: string;
  readonly VITE_WAITLIST_FROM_EMAIL?: string;
  readonly VITE_WAITLIST_TO_EMAIL?: string;
  readonly VITE_RESEND_AUDIENCE_ID?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
