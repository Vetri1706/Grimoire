import './grimoire-logo.css';

/** Brand artwork beside the visible Grimoire name; decorative to screen readers. */
export default function GrimoireLogo({ size = 32 }: { size?: number }) {
  return <span className="grimoire-logo" style={{ width: size, height: size }} aria-hidden="true"><img src="/grimoire-logo.png" width={1254} height={1254} alt="" draggable={false} /></span>;
}
