// "Playing on <device>" bar with Watch here: shown while another device holds the stream.
import { displayName } from '@shared/domain.ts';
import { img } from '../env.ts';
import { t } from '../i18n.ts';
import { lease } from '../ws.ts';
import { myDeviceId } from '../api.ts';
import { current, takeover } from '../playback.ts';
import { Logo } from '../ui/common.tsx';
import { deviceName } from '../ws.ts';

export function MiniPlayer() {
  const l = lease.value;
  if (!l || l.deviceId === myDeviceId.value || current.value) return null;
  const dev = deviceName(l.deviceId);
  const pct = l.duration > 0 ? (l.position / l.duration) * 100 : 0;
  return (
    <div class="miniplayer" role="status">
      <div class="mp-art">{l.item.kind === 'live' ? <Logo src={l.item.icon} name={l.item.name} size={40} /> : <img src={img(l.item.icon, 92)} alt="" />}</div>
      <div class="mp-txt">
        <b>{displayName(l.item.name)}</b>
        <span>{t('Playing on {name}', { name: dev })}</span>
      </div>
      <button class="btn primary small" onClick={() => takeover()}><span class="keydot green" />{t('Watch here')}</button>
      {pct > 0 && <div class="mp-bar"><i style={{ width: `${pct}%` }} /></div>}
    </div>
  );
}
