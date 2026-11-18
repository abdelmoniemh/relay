import { useEffect, useState } from 'preact/hooks';
import { api, server, setServer, setCredentials } from '../api.ts';
import { connect } from '../ws.ts';
import { defaultName, deviceKind } from '../env.ts';

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
    } catch (e) { setErr((e as Error).message === 'Failed to fetch' ? `Can't reach the server at ${server.value}` : (e as Error).message); }
    finally { setBusy(false); }
  };

  // On the server machine itself, pairing needs no code.
  useEffect(() => { if (/^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname)) go(''); }, []);
  const q = new URLSearchParams(location.search);
  useEffect(() => { const c = q.get('code'); if (c) { setCode(c); go(c); } }, []);

  return (
    <div class="pair">
      <h1>Relay</h1>
      <p class="muted">Pair this device. Find the code in Settings on a paired device, or in the server's terminal.</p>
      {needUrl && <label>Server address<input value={url} onInput={(e) => setUrl((e.target as HTMLInputElement).value)} placeholder="http://192.168.1.160:8787" /></label>}
      <label>Pairing code<input value={code} inputMode="numeric" maxLength={6} autoFocus onInput={(e) => setCode((e.target as HTMLInputElement).value.replace(/\D/g, ''))} onKeyDown={(e) => e.key === 'Enter' && go(code)} /></label>
      <label>Device name<input value={name} onInput={(e) => setName((e.target as HTMLInputElement).value)} /></label>
      <button disabled={busy || code.length !== 6} onClick={() => go(code)}>{busy ? 'Pairing…' : 'Pair'}</button>
      {err && <p class="err">{err}</p>}
    </div>
  );
}
