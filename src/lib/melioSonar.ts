type SonarEnv = 'sandbox' | 'production';

declare global {
  interface Window {
    MelioSonar?: {
      createSession: (
        publishableKey: string,
        options?: { businessEntityId?: string }
      ) => Promise<{ token?: string }>;
    };
  }
}

const loaded = new Map<SonarEnv, Promise<void>>();

function scriptUrl(environment: SonarEnv): string {
  return environment === 'production'
    ? 'https://sonar.melio.com/v1/sonar-sdk.js'
    : 'https://sonar.staging01.melio.com/v1/sonar-sdk.js';
}

function loadSonar(environment: SonarEnv): Promise<void> {
  const existing = loaded.get(environment);
  if (existing) return existing;
  const pending = new Promise<void>((resolve, reject) => {
    if (window.MelioSonar?.createSession) {
      resolve();
      return;
    }
    const script = document.createElement('script');
    script.src = scriptUrl(environment);
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error('Melio Sonar could not load.'));
    document.head.appendChild(script);
  });
  loaded.set(environment, pending);
  pending.catch(() => loaded.delete(environment));
  return pending;
}

/** Mint a Sonar session on the same click that will call Melio. */
export async function mintMelioSonarToken(params: {
  publishableKey: string;
  environment: SonarEnv;
  businessEntityId?: string | null;
}): Promise<string> {
  const key = params.publishableKey.trim();
  if (!key) throw new Error('Melio Sonar publishable key is not set.');
  await loadSonar(params.environment);
  const api = window.MelioSonar;
  if (!api?.createSession) throw new Error('Melio Sonar did not load.');
  const session = await api.createSession(key, {
    ...(params.businessEntityId ? { businessEntityId: params.businessEntityId } : {})
  });
  const token = String(session?.token || '').trim();
  if (!token) throw new Error('Melio Sonar did not return a session token.');
  return token;
}
