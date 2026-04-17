import { useState } from "preact/hooks";

interface Props<T> {
  data: T;
  buildMarkdown: (data: T) => string;
  align?: "flex-end" | "flex-start" | "center";
}

const BTN_STYLE =
  "background:var(--bg);color:var(--text);border:1px solid var(--border-strong);" +
  "border-radius:6px;padding:0.3rem 0.65rem;font-size:0.75rem;cursor:pointer;" +
  "font-family:var(--font);transition:background 0.15s";

export function CopyButtons<T>({ data, buildMarkdown, align = "flex-end" }: Props<T>) {
  const [copied, setCopied] = useState<string | null>(null);

  const copy = async (label: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(label);
      setTimeout(() => setCopied(null), 1500);
    } catch {
      setCopied("failed");
      setTimeout(() => setCopied(null), 1500);
    }
  };

  return (
    <div style={`display:flex;gap:0.5rem;margin-bottom:1rem;justify-content:${align};align-items:center`}>
      {copied && (
        <span style="font-size:0.7rem;color:var(--text-dim)">
          {copied === "failed" ? "Copy failed" : `Copied ${copied}`}
        </span>
      )}
      <button
        type="button"
        style={BTN_STYLE}
        onClick={(e) => { e.stopPropagation(); copy("Markdown", buildMarkdown(data)); }}
      >
        Copy as Markdown
      </button>
      <button
        type="button"
        style={BTN_STYLE}
        onClick={(e) => { e.stopPropagation(); copy("JSON", JSON.stringify(data, null, 2)); }}
      >
        Copy as JSON
      </button>
    </div>
  );
}
