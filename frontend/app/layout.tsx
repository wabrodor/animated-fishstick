import './tailwind.css';
import type { Metadata } from 'next';
import { ActionFeedback } from '@/components/ActionFeedback';

export const metadata: Metadata = {
  title: 'ApexCare Clinic',
  description: 'ApexCare chronic care clinic portal',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return <html lang="en"><body>{children}<ActionFeedback /></body></html>;
}
