import type { ComponentChildren } from "preact";

interface Props {
  label: string;
  value: string | number;
  unit?: string;
  sub?: string;
  color?: string;
  href?: string;
  children?: ComponentChildren;
}

export function MetricCard({ label, value, unit, sub, color, href, children }: Props) {
  const inner = (
    <>
      <div class="label">
        <span style={color ? `width:6px;height:6px;background:${color};display:inline-block;border-radius:50%` : undefined} />
        {label}
      </div>
      <div class="value" style={color ? { color } : undefined}>
        {value}
        {unit && <span class="unit">{unit}</span>}
      </div>
      {sub && <div class="sub">{sub}</div>}
      <div class="spacer" />
      {children}
    </>
  );

  if (href) {
    return (
      <a href={href} class="card card-link">
        {inner}
      </a>
    );
  }

  return <div class="card">{inner}</div>;
}
