/** The settings sign-in cannot work without. Names only — values are never shown. */
const REQUIRED = ['APP_URL', 'API_URL', 'OIDC_ISSUER', 'OIDC_CLIENT_ID'] as const;
export const missingConfig = (): string[] => REQUIRED.filter((k) => !process.env[k]);
/** Public base URL of this app: APP_URL when set, otherwise the address the request came to. */
export const baseUrl = (reqOrigin: string): string => (process.env.APP_URL ? process.env.APP_URL.replace(/\/$/, '') : reqOrigin);
