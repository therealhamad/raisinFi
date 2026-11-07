import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./styles.css";

export const metadata: Metadata = {
  title: "RaisinFi | Cross-chain settlement",
  description: "Coordinate two test-token settlement obligations across Ethereum Sepolia and Base Sepolia.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" data-theme="dark" suppressHydrationWarning>
      <head>
        <script
          dangerouslySetInnerHTML={{
            __html: `(() => {
              let theme = null;
              try {
                const saved = localStorage.getItem("raisinfi-theme");
                if (saved === "light" || saved === "dark") theme = saved;
              } catch (error) {
                console.warn("RaisinFi could not read the saved theme preference.", error);
              }
              if (!theme) {
                theme = window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
              }
              document.documentElement.dataset.theme = theme;
            })();`,
          }}
        />
      </head>
      <body className="app-font" suppressHydrationWarning>{children}</body>
    </html>
  );
}
