"use client";

import { useState } from "react";

export function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="btn small"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
        } catch {
          // Clipboard blocked: select the text so it can be copied by hand.
          const input = document.createElement("textarea");
          input.value = text;
          document.body.appendChild(input);
          input.select();
          document.execCommand("copy");
          input.remove();
        }
        setCopied(true);
        setTimeout(() => setCopied(false), 1800);
      }}
    >
      {copied ? "Copied ✓" : label}
    </button>
  );
}
