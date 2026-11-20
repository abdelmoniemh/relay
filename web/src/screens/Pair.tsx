import { useEffect, useState } from 'preact/hooks';
import { api, server, setServer, setCredentials } from '../api.ts';
import { connect } from '../ws.ts';
import { defaultName, deviceKind } from '../env.ts';
import { t } from '../i18n.ts';

export function Pair({ onDone }: { onDone: () => void }) {
  const [url, setUrl] = useState(server.value);
  const [code, setCode] = useState('');
  const [name, setName] = useState(defaultName);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const needUrl = !server.value || !location.protocol.startsWith('http');

  const go = async (c: string) => {
    setBusy(true); setErr(null);
    try {
      if (needUrl) setServer(url);
      const r = await api.pair(c, name, deviceKind);
      setCredentials(r.token, r.deviceId);
      connect(); onDone();
    } catch (e) { setErr((e as Error).message === 'Failed to fetch' ? t('Can’t reach the server at {url}. Check the address and that this device is on the same network.', { url: server.value }) : (e as Error).message); }
    finally { setBusy(false); }
  };

  // On the server machine itself, pairing needs no code.
  useEffect(() => { if (/^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname)) go(''); }, []);
  const q = new URLSearchParams(location.search);
  useEffect(() => { const c = q.get('code'); if (c) { setCode(c); go(c); } }, []);

  return (
    <div class="pair">
      <div class="pair-card">
        <div class="pair-brand">
          <svg viewBox="0 0 64 64" aria-hidden="true"><rect width="64" height="64" rx="14" /><path d="M24 18v28l22-14z" /></svg>
          <h1>Relay</h1>
        </div>
        <p class="sheet-hint">{t('Enter the 6-digit pairing code from Settings on a device that is already paired.')}</p>
        {needUrl && <label class="field-label">{t('Server address')}<input id="pair-url" class="field" value={url} onInput={(e) => setUrl((e.target as HTMLInputElement).value)} placeholder="http://192.168.1.10:8787" /></label>}
        <label class="field-label">{t('Pairing code')}<input id="pair-code" class="field code-input tnum" value={code} inputMode="numeric" maxLength={6} autoFocus onInput={(e) => setCode((e.target as HTMLInputElement).value.replace(/\D/g, ''))} onKeyDown={(e) => e.key === 'Enter' && go(code)} /></label>
        <label class="field-label">{t('Name this device')}<input id="pair-name" class="field" value={name} onInput={(e) => setName((e.target as HTMLInputElement).value)} /></label>
        <button class="btn primary block" disabled={busy || code.length !== 6} onClick={() => go(code)}>{busy ? t('Pairing…') : t('Pair')}</button>
        {err && <p class="form-err" role="alert">{err}</p>}
      </div>
    </div>
  );
}
