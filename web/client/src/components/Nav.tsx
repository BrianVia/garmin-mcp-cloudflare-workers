import { useLocation } from "preact-iso";

const links = [
  { path: "/", label: "Overview" },
  { path: "/sleep", label: "Sleep" },
  { path: "/heart-rate", label: "Heart" },
  { path: "/stress", label: "Stress" },
  { path: "/activities", label: "Activities" },
  { path: "/training", label: "Training" },
  { path: "/trends", label: "Trends" },
];

export function Nav() {
  const { path } = useLocation();
  const year = new Date().getFullYear();

  return (
    <header class="masthead">
      <a href="/" class="brand" aria-label="givemydata home">
        <span class="brand-mark">
          give<span class="amp">my</span>data
        </span>
        <span class="brand-tag">
          PERSONAL HEALTH ALMANAC<span class="dot">●</span>VOL. {year}
        </span>
      </a>
      <nav class="links">
        {links.map((link) => (
          <a
            key={link.path}
            href={link.path}
            class={path === link.path ? "active" : ""}
          >
            {link.label}
          </a>
        ))}
      </nav>
    </header>
  );
}
