import "./globals.css";

export const metadata = { title: "Context - Board Knowledge Hub" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <script src="/vendor/tailwindcdn.js" defer></script>
      </head>
      <body className="bg-[#F6F7FB] text-gray-800">{children}</body>
    </html>
  );
}
