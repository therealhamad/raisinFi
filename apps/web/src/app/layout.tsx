import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./styles.css";

export const metadata: Metadata = {
  title: "RaisinFi | Cross-chain settlement",
  description: "Coordinate two test-token settlement obligations across Ethereum Sepolia and Base Sepolia.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
