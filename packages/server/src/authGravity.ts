/** AuthGravity `/v1/whoami` client used to validate a caller's session. */
export interface AuthGravityIdentity {
  /** Stable AuthGravity user UUID; never sent to note recipients. */
  subject: string;
}

export interface AuthGravityRequestCredentials {
  authorization?: string | string[] | undefined;
  cookie?: string | string[] | undefined;
}

export interface AuthGravityVerifier {
  verify(credentials: AuthGravityRequestCredentials): Promise<AuthGravityIdentity | null>;
}

export const PRODUCTION_AUTHGRAVITY_WHOAMI_URL = 'https://authgravity.app.olaink.com/v1/whoami';

export class AuthGravityWhoAmIVerifier implements AuthGravityVerifier {
  constructor(
    private readonly whoAmIUrl: string | undefined = process.env.AUTHGRAVITY_WHOAMI_URL ?? PRODUCTION_AUTHGRAVITY_WHOAMI_URL,
  ) {}

  async verify(credentials: AuthGravityRequestCredentials): Promise<AuthGravityIdentity | null> {
    if (!this.whoAmIUrl) return null;
    const authorization = firstHeader(credentials.authorization);
    const cookie = firstHeader(credentials.cookie);
    if (!authorization && !cookie) return null;
    try {
      // AuthGravity sessions are httpOnly cookies. Forwarding the browser's
      // cookie is the documented server-side validation flow; bearer session
      // IDs are also supported for non-browser clients.
      const response = await fetch(this.whoAmIUrl, {
        headers: {
          ...(authorization ? { Authorization: authorization } : {}),
          ...(cookie ? { Cookie: cookie } : {}),
        },
      });
      if (!response.ok) return null;
      const body = await response.json() as { user_id?: unknown };
      return typeof body.user_id === 'string' && body.user_id.length > 0 && body.user_id.length <= 512
        ? { subject: body.user_id }
        : null;
    } catch {
      return null;
    }
  }
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  return typeof value === 'string' ? value : value?.[0];
}
