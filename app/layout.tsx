// app/layout.tsx
import './globals.css';
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'PDF Translator - Professional Document Translation',
  description:
    'AI-powered PDF translation service specialized in relational psychoanalysis and academic texts. Translate PDFs to DOCX with OpenAI technology.',
  keywords:
    'PDF translator, document translation, OpenAI, psychoanalysis, academic translation, AI translation',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      {/* системный стек шрифтов через Tailwind (или убери класс, если не используешь Tailwind) */}
      <body className="font-sans antialiased">{children}</body>
    </html>
  );
}